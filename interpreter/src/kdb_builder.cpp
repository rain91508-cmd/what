#include "kdb_builder.h"
#include <iostream>
#include <vector>
#include <functional>

#ifdef USE_PROTOBUF
#include "kdb.pb.h"
#include <google/protobuf/io/zero_copy_stream_impl.h>
#include <google/protobuf/io/coded_stream.h>
#include <google/protobuf/util/json_util.h>
#endif

#ifdef USE_ZSTD
#include <zstd.h>
#endif

#include <fstream>
#include <sstream>
#include <chrono>
#include <iomanip>

namespace hwda {
namespace interpreter {

KdbBuilder::KdbBuilder()
    : nextFileId_(1)
    , nextModuleId_(1)
    , nextSignalId_(1)
    , nextInstanceId_(1) {
}

uint32_t KdbBuilder::addModule(const ModuleInfo& module) {
    auto it = moduleNameToId_.find(module.fullName);
    if (it != moduleNameToId_.end()) {
        return it->second;
    }
    
    auto mod = std::make_unique<ModuleInfo>(module);
    mod->id = nextModuleId_++;
    
    for (auto& sig : mod->signals) {
        sig.id = nextSignalId_++;
        sig.parentModuleId = mod->id;
        signalFullNameToId_[sig.fullName] = sig.id;
        signalIdToIndex_[sig.id] = mod->signals.size() - 1;
    }
    
    uint32_t id = mod->id;
    uint32_t parentModuleId = mod->parentModuleId;  // Save before move
    
    moduleNameToId_[mod->fullName] = id;
    moduleIdToIndex_[id] = modules_.size();
    modules_.push_back(std::move(mod));
    
    // Update parent's childModuleIds if this module has a parent
    if (parentModuleId != 0) {
        auto* parentMod = const_cast<ModuleInfo*>(findModuleById(parentModuleId));
        if (parentMod) {
            parentMod->childModuleIds.push_back(id);
        }
    }
    
    return id;
}

KdbBuilder::~KdbBuilder() = default;

void KdbBuilder::setProjectName(const std::string& name) {
    projectName_ = name;
}

void KdbBuilder::setTopModule(uint32_t moduleId) {
    topModuleIds_.clear();
    topModuleIds_.push_back(moduleId);
}

void KdbBuilder::addHierarchy(uint32_t topModuleId) {
    // Check if this topModuleId already exists
    for (const auto& existing : hierarchies_) {
        if (existing.topModuleId == topModuleId) {
            return;
        }
    }
    
    HierarchyInfo hierarchy;
    hierarchy.topModuleId = topModuleId;
    
    std::function<void(uint32_t)> collectModules = [&](uint32_t moduleId) {
        hierarchy.moduleIds.push_back(moduleId);
        auto children = getChildModules(moduleId);
        for (const auto* child : children) {
            collectModules(child->id);
        }
    };
    collectModules(topModuleId);
    
    hierarchies_.push_back(hierarchy);
}

uint32_t KdbBuilder::addSourceFile(const std::string& path, const std::string& content) {
    auto file = std::make_unique<SourceFileInfo>();
    file->id = nextFileId_++;
    file->path = path;
    file->content = content;
    
    uint32_t id = file->id;
    filePathToId_[path] = id;
    fileIdToIndex_[id] = files_.size();
    files_.push_back(std::move(file));
    
    return id;
}

bool KdbBuilder::setSourceFileContent(uint32_t fileId, const std::string& content) {
    auto* file = const_cast<SourceFileInfo*>(findFileById(fileId));
    if (!file) return false;
    
    file->content = content;
    
    return true;
}

std::string KdbBuilder::getSourceLine(uint32_t fileId, uint32_t line) const {
    const auto* file = findFileById(fileId);
    if (!file || line == 0 || line > file->getLineCount()) return "";
    
    return file->getLine(line);
}

std::string KdbBuilder::getSourceRange(uint32_t fileId, uint32_t startLine, uint32_t startCol,
                                        uint32_t endLine, uint32_t endCol) const {
    const auto* file = findFileById(fileId);
    if (!file) return "";
    
    return file->getRange(startLine, startCol, endLine, endCol);
}

std::string KdbBuilder::getSourceFileContent(uint32_t fileId) const {
    const auto* file = findFileById(fileId);
    return file ? file->content : "";
}

std::string SourceFileInfo::getLine(uint32_t lineNum) const {
    if (content.empty() || lineNum == 0) return "";
    
    size_t currentLine = 1;
    size_t lineStart = 0;
    
    for (size_t i = 0; i < content.size(); ++i) {
        if (currentLine == lineNum) {
            lineStart = i;
            break;
        }
        if (content[i] == '\n') {
            currentLine++;
        }
    }
    
    if (currentLine != lineNum) return "";
    
    size_t lineEnd = lineStart;
    while (lineEnd < content.size() && content[lineEnd] != '\n' && content[lineEnd] != '\r') {
        lineEnd++;
    }
    
    return content.substr(lineStart, lineEnd - lineStart);
}

std::string SourceFileInfo::getRange(uint32_t startLine, uint32_t startCol, 
                                      uint32_t endLine, uint32_t endCol) const {
    if (content.empty() || startLine == 0 || endLine == 0) return "";
    if (startLine > endLine) return "";
    
    size_t currentLine = 1;
    size_t startPos = 0;
    
    for (size_t i = 0; i < content.size(); ++i) {
        if (currentLine == startLine) {
            startPos = i + (startCol > 0 ? startCol - 1 : 0);
            break;
        }
        if (content[i] == '\n') {
            currentLine++;
        }
    }
    
    currentLine = 1;
    size_t endPos = content.size();
    
    for (size_t i = 0; i < content.size(); ++i) {
        if (currentLine == endLine) {
            if (endCol > 0) {
                endPos = i + endCol;
            } else {
                while (i < content.size() && content[i] != '\n') i++;
                endPos = i;
            }
            break;
        }
        if (content[i] == '\n') {
            currentLine++;
        }
    }
    
    if (startPos >= endPos || startPos >= content.size()) return "";
    return content.substr(startPos, endPos - startPos);
}

uint64_t SourceFileInfo::getLineCount() const {
    if (content.empty()) return 0;
    uint64_t count = 1;
    for (size_t i = 0; i < content.size(); ++i) {
        if (content[i] == '\n') {
            count++;
        }
    }
    return count;
}

bool KdbBuilder::hasModule(const std::string& fullName) const {
    return moduleNameToId_.find(fullName) != moduleNameToId_.end();
}

uint64_t KdbBuilder::addSignal(uint32_t moduleId, const SignalInfo& signal) {
    auto* mod = const_cast<ModuleInfo*>(findModuleById(moduleId));
    if (!mod) return 0;
    
    SignalInfo sig = signal;
    sig.id = nextSignalId_++;
    sig.parentModuleId = moduleId;
    
    uint64_t id = sig.id;
    signalFullNameToId_[sig.fullName] = id;
    signalIdToIndex_[id] = mod->signals.size();
    mod->signals.push_back(std::move(sig));
    
    return id;
}

uint32_t KdbBuilder::addInstance(const ModuleInstanceInfo& instance) {
    auto inst = std::make_unique<ModuleInstanceInfo>(instance);
    inst->id = nextInstanceId_++;
    
    uint32_t id = inst->id;
    instances_.push_back(std::move(inst));
    
    return id;
}

void KdbBuilder::buildIndices() {
}

const ModuleInfo* KdbBuilder::findModuleByName(const std::string& name) const {
    auto it = moduleNameToId_.find(name);
    if (it != moduleNameToId_.end()) {
        return findModuleById(it->second);
    }
    return nullptr;
}

const ModuleInfo* KdbBuilder::findModuleById(uint32_t id) const {
    auto it = moduleIdToIndex_.find(id);
    if (it != moduleIdToIndex_.end() && it->second < modules_.size()) {
        return modules_[it->second].get();
    }
    return nullptr;
}

const SignalInfo* KdbBuilder::findSignalByName(const std::string& fullName) const {
    auto it = signalFullNameToId_.find(fullName);
    if (it != signalFullNameToId_.end()) {
        return findSignalById(it->second);
    }
    return nullptr;
}

const SignalInfo* KdbBuilder::findSignalById(uint64_t id) const {
    for (const auto& mod : modules_) {
        for (const auto& sig : mod->signals) {
            if (sig.id == id) {
                return &sig;
            }
        }
    }
    return nullptr;
}

const SourceFileInfo* KdbBuilder::findFileByPath(const std::string& path) const {
    auto it = filePathToId_.find(path);
    if (it != filePathToId_.end()) {
        return findFileById(it->second);
    }
    return nullptr;
}

const SourceFileInfo* KdbBuilder::findFileById(uint32_t id) const {
    auto it = fileIdToIndex_.find(id);
    if (it != fileIdToIndex_.end() && it->second < files_.size()) {
        return files_[it->second].get();
    }
    return nullptr;
}

std::vector<const ModuleInfo*> KdbBuilder::getAllModules() const {
    std::vector<const ModuleInfo*> result;
    result.reserve(modules_.size());
    for (const auto& mod : modules_) {
        result.push_back(mod.get());
    }
    return result;
}

std::vector<const SignalInfo*> KdbBuilder::getAllSignals() const {
    std::vector<const SignalInfo*> result;
    for (const auto& mod : modules_) {
        for (const auto& sig : mod->signals) {
            result.push_back(&sig);
        }
    }
    return result;
}

size_t KdbBuilder::getTotalSignalCount() const {
    size_t count = 0;
    for (const auto& mod : modules_) {
        count += mod->signals.size();
    }
    return count;
}

std::vector<const SignalInfo*> KdbBuilder::getDrivers(uint64_t signalId) const {
    std::vector<const SignalInfo*> result;
    const SignalInfo* signal = findSignalById(signalId);
    if (signal) {
        for (uint64_t driverId : signal->driverSignalIds) {
            const SignalInfo* driver = findSignalById(driverId);
            if (driver) {
                result.push_back(driver);
            }
        }
    }
    return result;
}

std::vector<const SignalInfo*> KdbBuilder::getLoads(uint64_t signalId) const {
    // Note: loadSignalIds removed - this function now returns empty result
    // Loads can be computed by finding all signals that have this signal as driver
    std::vector<const SignalInfo*> result;
    // TODO: Implement load calculation by scanning all signals' driverSignalIds
    return result;
}

std::vector<const ModuleInfo*> KdbBuilder::getChildModules(uint32_t parentModuleId) const {
    std::vector<const ModuleInfo*> result;
    for (const auto& mod : modules_) {
        if (mod->parentModuleId == parentModuleId) {
            result.push_back(mod.get());
        }
    }
    return result;
}

#ifdef USE_PROTOBUF

static hwda::kdb::SignalType toProtoSignalType(SignalType type) {
    switch (type) {
        case SignalType::WIRE: return hwda::kdb::SIGNAL_TYPE_WIRE;
        case SignalType::REG: return hwda::kdb::SIGNAL_TYPE_REG;
        case SignalType::LOGIC: return hwda::kdb::SIGNAL_TYPE_LOGIC;
        case SignalType::BIT: return hwda::kdb::SIGNAL_TYPE_BIT;
        case SignalType::INTEGER: return hwda::kdb::SIGNAL_TYPE_INTEGER;
        case SignalType::REAL: return hwda::kdb::SIGNAL_TYPE_REAL;
        case SignalType::PARAMETER: return hwda::kdb::SIGNAL_TYPE_PARAMETER;
        case SignalType::LOCALPARAM: return hwda::kdb::SIGNAL_TYPE_LOCALPARAM;
        default: return hwda::kdb::SIGNAL_TYPE_UNKNOWN;
    }
}

static SignalType fromProtoSignalType(hwda::kdb::SignalType type) {
    switch (type) {
        case hwda::kdb::SIGNAL_TYPE_WIRE: return SignalType::WIRE;
        case hwda::kdb::SIGNAL_TYPE_REG: return SignalType::REG;
        case hwda::kdb::SIGNAL_TYPE_LOGIC: return SignalType::LOGIC;
        case hwda::kdb::SIGNAL_TYPE_BIT: return SignalType::BIT;
        case hwda::kdb::SIGNAL_TYPE_INTEGER: return SignalType::INTEGER;
        case hwda::kdb::SIGNAL_TYPE_REAL: return SignalType::REAL;
        case hwda::kdb::SIGNAL_TYPE_PARAMETER: return SignalType::PARAMETER;
        case hwda::kdb::SIGNAL_TYPE_LOCALPARAM: return SignalType::LOCALPARAM;
        default: return SignalType::UNKNOWN;
    }
}

static hwda::kdb::PortDirection toProtoPortDirection(PortDirection dir) {
    switch (dir) {
        case PortDirection::INPUT: return hwda::kdb::PORT_DIR_INPUT;
        case PortDirection::OUTPUT: return hwda::kdb::PORT_DIR_OUTPUT;
        case PortDirection::INOUT: return hwda::kdb::PORT_DIR_INOUT;
        default: return hwda::kdb::PORT_DIR_UNKNOWN;
    }
}

static PortDirection fromProtoPortDirection(hwda::kdb::PortDirection dir) {
    switch (dir) {
        case hwda::kdb::PORT_DIR_INPUT: return PortDirection::INPUT;
        case hwda::kdb::PORT_DIR_OUTPUT: return PortDirection::OUTPUT;
        case hwda::kdb::PORT_DIR_INOUT: return PortDirection::INOUT;
        default: return PortDirection::UNKNOWN;
    }
}

void KdbBuilder::toProtobuf(hwda::kdb::KnowledgeBase* kdb) const {
    auto* header = kdb->mutable_header();
    header->set_version("1.0");
    header->set_project_name(projectName_);
    
    auto now = std::chrono::system_clock::now();
    auto time = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&time), "%Y-%m-%d %H:%M:%S");
    header->set_created_at(ss.str());
    
    for (const auto& file : files_) {
        auto* protoFile = kdb->add_files();
        protoFile->set_id(file->id);
        protoFile->set_path(file->path);
        protoFile->set_content(file->content);
    }
    
    for (const auto& mod : modules_) {
        auto* protoMod = kdb->add_modules();
        protoMod->set_id(mod->id);
        protoMod->set_name(mod->name);
        protoMod->set_full_name(mod->fullName);
        protoMod->set_parent_module_id(mod->parentModuleId);
        protoMod->set_file_id(mod->fileId);
        protoMod->set_is_instance(mod->isInstance);
        
        if (mod->definition.fileId != 0) {
            auto* decl = protoMod->mutable_definition();
            decl->set_file_id(mod->definition.fileId);
            decl->set_start_line(mod->definition.startLine);
            decl->set_end_line(mod->definition.endLine);
        }
        
        for (const auto& sig : mod->signals) {
            auto* protoSig = protoMod->add_signals();
            protoSig->set_id(sig.id);
            protoSig->set_name(sig.name);
            protoSig->set_full_name(sig.fullName);
            protoSig->set_type(toProtoSignalType(sig.type));
            protoSig->set_msb(sig.msb);
            protoSig->set_lsb(sig.lsb);
            protoSig->set_parent_module_id(sig.parentModuleId);
            protoSig->set_direction(toProtoPortDirection(sig.direction));
            
            if (sig.declaration.fileId != 0) {
                auto* decl = protoSig->mutable_declaration();
                decl->set_file_id(sig.declaration.fileId);
                decl->set_line(sig.declaration.line);
                // Note: column_start and column_end removed - not needed
            }
            
            for (uint64_t driverId : sig.driverSignalIds) {
                protoSig->add_driver_signal_ids(driverId);
            }
            // Note: load_signal_ids removed - not needed
            
            // Add driver lines
            for (const auto& driverLine : sig.driverLines) {
                auto* protoDriverLine = protoSig->add_driver_lines();
                protoDriverLine->set_file_id(driverLine.fileId);
                protoDriverLine->set_line(driverLine.line);
                // Note: column_start and column_end removed - not needed for driver location
            }
        }
        
        // Add child module IDs
        for (uint32_t childId : mod->childModuleIds) {
            protoMod->add_child_module_ids(childId);
        }
    }
    
    for (const auto& hierarchyInfo : hierarchies_) {
        auto* hierarchy = kdb->add_hierarchies();
        hierarchy->set_top_module_id(hierarchyInfo.topModuleId);
        for (uint64_t moduleId : hierarchyInfo.moduleIds) {
            hierarchy->add_module_ids(moduleId);
        }
    }
}

void KdbBuilder::fromProtobuf(const hwda::kdb::KnowledgeBase& kdb) {
    files_.clear();
    modules_.clear();
    instances_.clear();
    filePathToId_.clear();
    moduleNameToId_.clear();
    signalFullNameToId_.clear();
    fileIdToIndex_.clear();
    moduleIdToIndex_.clear();
    signalIdToIndex_.clear();
    
    projectName_ = kdb.header().project_name();
    
    for (const auto& protoFile : kdb.files()) {
        auto file = std::make_unique<SourceFileInfo>();
        file->id = protoFile.id();
        file->path = protoFile.path();
        file->content = protoFile.content();
        
        nextFileId_ = std::max(nextFileId_, file->id + 1);
        filePathToId_[file->path] = file->id;
        fileIdToIndex_[file->id] = files_.size();
        files_.push_back(std::move(file));
    }
    
    for (const auto& protoMod : kdb.modules()) {
        auto mod = std::make_unique<ModuleInfo>();
        mod->id = protoMod.id();
        mod->name = protoMod.name();
        mod->fullName = protoMod.full_name();
        mod->parentModuleId = protoMod.parent_module_id();
        mod->fileId = protoMod.file_id();
        mod->isInstance = protoMod.is_instance();
        
        if (protoMod.has_definition()) {
            mod->definition.fileId = protoMod.definition().file_id();
            mod->definition.startLine = protoMod.definition().start_line();
            mod->definition.endLine = protoMod.definition().end_line();
        }
        
        for (const auto& protoSig : protoMod.signals()) {
            SignalInfo sig;
            sig.id = protoSig.id();
            sig.name = protoSig.name();
            sig.fullName = protoSig.full_name();
            sig.type = fromProtoSignalType(protoSig.type());
            sig.direction = fromProtoPortDirection(protoSig.direction());
            sig.msb = protoSig.msb();
            sig.lsb = protoSig.lsb();
            sig.parentModuleId = protoSig.parent_module_id();
            
            if (protoSig.has_declaration()) {
                sig.declaration.fileId = protoSig.declaration().file_id();
                sig.declaration.line = protoSig.declaration().line();
                // Note: column_start and column_end removed - not needed
            }
            
            for (uint64_t driverId : protoSig.driver_signal_ids()) {
                sig.driverSignalIds.push_back(driverId);
            }
            // Note: load_signal_ids removed - not needed
            
            // Load driver lines
            for (const auto& protoDriverLine : protoSig.driver_lines()) {
                KdbSourceLocation driverLine;
                driverLine.fileId = protoDriverLine.file_id();
                driverLine.line = protoDriverLine.line();
                // Note: column_start and column_end removed - not needed
                sig.driverLines.push_back(driverLine);
            }
            
            nextSignalId_ = std::max(nextSignalId_, sig.id + 1);
            signalFullNameToId_[sig.fullName] = sig.id;
            signalIdToIndex_[sig.id] = mod->signals.size();
            mod->signals.push_back(std::move(sig));
        }
        
        // Load child module IDs
        for (uint32_t childId : protoMod.child_module_ids()) {
            mod->childModuleIds.push_back(childId);
        }
        
        nextModuleId_ = std::max(nextModuleId_, mod->id + 1);
        moduleNameToId_[mod->fullName] = mod->id;
        moduleIdToIndex_[mod->id] = modules_.size();
        modules_.push_back(std::move(mod));
    }
    
    topModuleIds_.clear();
    hierarchies_.clear();
    for (const auto& protoHierarchy : kdb.hierarchies()) {
        HierarchyInfo hierarchy;
        hierarchy.topModuleId = protoHierarchy.top_module_id();
        topModuleIds_.push_back(hierarchy.topModuleId);
        for (uint64_t moduleId : protoHierarchy.module_ids()) {
            hierarchy.moduleIds.push_back(moduleId);
        }
        hierarchies_.push_back(hierarchy);
    }
}

bool KdbBuilder::serializeToFile(const std::string& filepath) const {
#ifdef USE_PROTOBUF
    hwda::kdb::KnowledgeBase kdb;
    toProtobuf(&kdb);
    
    std::cerr << "Debug: toProtobuf done, modules: " << kdb.modules_size() << "\n";
    
    std::string serialized;
    if (!kdb.SerializeToString(&serialized)) {
        std::cerr << "Debug: SerializeToString failed\n";
        return false;
    }
    
    std::cerr << "Debug: SerializeToString success, size: " << serialized.size() << "\n";
    
#ifdef USE_ZSTD
    if (compressionEnabled_) {
        std::cerr << "Debug: Compression enabled\n";
        return serializeToFileCompressed(filepath, compressionLevel_);
    }
#endif
    
    std::ofstream output(filepath, std::ios::binary);
    if (!output) {
        std::cerr << "Debug: Cannot open output file\n";
        return false;
    }
    
    output.write(serialized.data(), serialized.size());
    output.flush();
    if (!output.good()) {
        std::cerr << "Debug: Write failed\n";
        return false;
    }
    
    std::cerr << "Debug: Write success\n";
    return true;
#else
    (void)filepath;
    return false;
#endif
}

bool KdbBuilder::serializeToString(std::string* output) const {
#ifdef USE_PROTOBUF
    hwda::kdb::KnowledgeBase kdb;
    toProtobuf(&kdb);
    return kdb.SerializeToString(output);
#else
    (void)output;
    return false;
#endif
}

bool KdbBuilder::serializeToFileCompressed(const std::string& filepath, int compressionLevel) const {
#ifdef USE_PROTOBUF
#ifdef USE_ZSTD
    hwda::kdb::KnowledgeBase kdb;
    toProtobuf(&kdb);
    
    std::string serialized;
    if (!kdb.SerializeToString(&serialized)) {
        return false;
    }
    
    size_t bound = ZSTD_compressBound(serialized.size());
    std::vector<char> compressed(bound);
    
    size_t result = ZSTD_compress(compressed.data(), bound,
                                   serialized.data(), serialized.size(),
                                   compressionLevel);
    
    if (ZSTD_isError(result)) {
        return false;
    }
    
    compressed.resize(result);
    
    std::ofstream output(filepath, std::ios::binary);
    if (!output) {
        return false;
    }
    
    uint32_t magic = 0x4B445743;
    uint32_t origSize = static_cast<uint32_t>(serialized.size());
    output.write(reinterpret_cast<const char*>(&magic), sizeof(magic));
    output.write(reinterpret_cast<const char*>(&origSize), sizeof(origSize));
    output.write(compressed.data(), compressed.size());
    
    return true;
#else
    (void)filepath;
    (void)compressionLevel;
    return false;
#endif
#else
    (void)filepath;
    (void)compressionLevel;
    return false;
#endif
}

bool KdbBuilder::deserializeFromFile(const std::string& filepath) {
#ifdef USE_PROTOBUF
    std::ifstream input(filepath, std::ios::binary);
    if (!input) {
        std::cerr << "Debug: Cannot open file\n";
        return false;
    }
    
    input.seekg(0, std::ios::end);
    size_t fileSize = input.tellg();
    input.seekg(0, std::ios::beg);
    
    std::cerr << "Debug: File size in deserialize = " << fileSize << "\n";
    
    if (fileSize < sizeof(uint32_t)) {
        std::cerr << "Debug: File too small\n";
        return false;
    }
    
    uint32_t magic;
    input.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    input.seekg(0, std::ios::beg);
    
    std::cerr << "Debug: Magic in deserialize = 0x" << std::hex << magic << std::dec << "\n";
    
    if (magic == 0x4B445743) {
#ifdef USE_ZSTD
        std::cerr << "Debug: It's a compressed file\n";
        return deserializeFromFileCompressed(filepath);
#else
        return false;
#endif
    }
    
    std::cerr << "Debug: Trying to parse as protobuf\n";
    
    std::vector<char> buffer(fileSize);
    input.read(buffer.data(), fileSize);
    
    hwda::kdb::KnowledgeBase kdb;
    if (!kdb.ParseFromArray(buffer.data(), static_cast<int>(fileSize))) {
        std::cerr << "Debug: ParseFromArray failed\n";
        return false;
    }
    
    std::cerr << "Debug: ParseFromArray success\n";
    fromProtobuf(kdb);
    return true;
#else
    (void)filepath;
    return false;
#endif
}

bool KdbBuilder::deserializeFromFileCompressed(const std::string& filepath) {
#ifdef USE_PROTOBUF
#ifdef USE_ZSTD
    std::ifstream input(filepath, std::ios::binary);
    if (!input) {
        return false;
    }
    
    uint32_t magic;
    uint32_t origSize;
    input.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    input.read(reinterpret_cast<char*>(&origSize), sizeof(origSize));
    
    if (magic != 0x4B445743) {
        return false;
    }
    
    input.seekg(0, std::ios::end);
    size_t fileSize = input.tellg();
    size_t compressedSize = fileSize - sizeof(magic) - sizeof(origSize);
    input.seekg(sizeof(magic) + sizeof(origSize), std::ios::beg);
    
    std::vector<char> compressed(compressedSize);
    input.read(compressed.data(), compressedSize);
    
    std::vector<char> decompressed(origSize);
    size_t result = ZSTD_decompress(decompressed.data(), origSize,
                                    compressed.data(), compressedSize);
    
    if (ZSTD_isError(result)) {
        return false;
    }
    
    hwda::kdb::KnowledgeBase kdb;
    if (!kdb.ParseFromArray(decompressed.data(), static_cast<int>(result))) {
        return false;
    }
    
    fromProtobuf(kdb);
    return true;
#else
    (void)filepath;
    return false;
#endif
#else
    (void)filepath;
    return false;
#endif
}

bool KdbBuilder::deserializeFromString(const std::string& data) {
#ifdef USE_PROTOBUF
    hwda::kdb::KnowledgeBase kdb;
    if (!kdb.ParseFromString(data)) {
        return false;
    }
    
    fromProtobuf(kdb);
    return true;
#else
    (void)data;
    return false;
#endif
}

#else

bool KdbBuilder::serializeToFile(const std::string& filepath) const {
    (void)filepath;
    return false;
}

bool KdbBuilder::serializeToString(std::string* output) const {
    (void)output;
    return false;
}

bool KdbBuilder::deserializeFromFile(const std::string& filepath) {
    (void)filepath;
    return false;
}

bool KdbBuilder::deserializeFromString(const std::string& data) {
    (void)data;
    return false;
}

#endif

}
}
