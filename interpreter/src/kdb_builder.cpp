#include "kdb_builder.h"

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
    : topModuleId_(0)
    , nextFileId_(1)
    , nextModuleId_(1)
    , nextSignalId_(1)
    , nextInstanceId_(1) {
}

KdbBuilder::~KdbBuilder() = default;

void KdbBuilder::setProjectName(const std::string& name) {
    projectName_ = name;
}

void KdbBuilder::setSourcePath(const std::string& path) {
    sourcePath_ = path;
}

uint64_t KdbBuilder::addSourceFile(const std::string& path, const std::string& hash, uint64_t lineCount) {
    auto file = std::make_unique<SourceFileInfo>();
    file->id = nextFileId_++;
    file->path = path;
    file->hash = hash;
    file->lineCount = lineCount;
    
    uint64_t id = file->id;
    filePathToId_[path] = id;
    fileIdToIndex_[id] = files_.size();
    files_.push_back(std::move(file));
    
    return id;
}

uint64_t KdbBuilder::addSourceFile(const std::string& path, const std::string& content) {
    auto file = std::make_unique<SourceFileInfo>();
    file->id = nextFileId_++;
    file->path = path;
    file->content = content;
    file->lineCount = 0;
    
    // 计算行偏移量
    file->lineOffsets.push_back(0);
    for (size_t i = 0; i < content.size(); ++i) {
        if (content[i] == '\n') {
            file->lineOffsets.push_back(i + 1);
        }
    }
    file->lineCount = file->lineOffsets.size();
    
    uint64_t id = file->id;
    filePathToId_[path] = id;
    fileIdToIndex_[id] = files_.size();
    files_.push_back(std::move(file));
    
    return id;
}

bool KdbBuilder::setSourceFileContent(uint64_t fileId, const std::string& content) {
    auto* file = const_cast<SourceFileInfo*>(findFileById(fileId));
    if (!file) return false;
    
    file->content = content;
    file->lineOffsets.clear();
    file->lineOffsets.push_back(0);
    
    for (size_t i = 0; i < content.size(); ++i) {
        if (content[i] == '\n') {
            file->lineOffsets.push_back(i + 1);
        }
    }
    file->lineCount = file->lineOffsets.size();
    
    return true;
}

std::string KdbBuilder::getSourceLine(uint64_t fileId, uint32_t line) const {
    const auto* file = findFileById(fileId);
    if (!file || line == 0 || line > file->lineCount) return "";
    
    return file->getLine(line);
}

std::string KdbBuilder::getSourceRange(uint64_t fileId, uint32_t startLine, uint32_t startCol,
                                        uint32_t endLine, uint32_t endCol) const {
    const auto* file = findFileById(fileId);
    if (!file) return "";
    
    return file->getRange(startLine, startCol, endLine, endCol);
}

std::string KdbBuilder::getSourceFileContent(uint64_t fileId) const {
    const auto* file = findFileById(fileId);
    return file ? file->content : "";
}

// SourceFileInfo 方法实现
std::string SourceFileInfo::getLine(uint32_t lineNum) const {
    if (lineNum == 0 || lineNum > lineOffsets.size()) return "";
    
    size_t start = lineOffsets[lineNum - 1];
    size_t end = (lineNum < lineOffsets.size()) ? lineOffsets[lineNum] : content.size();
    
    std::string line = content.substr(start, end - start);
    // 移除行尾换行符
    while (!line.empty() && (line.back() == '\n' || line.back() == '\r')) {
        line.pop_back();
    }
    return line;
}

std::string SourceFileInfo::getRange(uint32_t startLine, uint32_t startCol, 
                                      uint32_t endLine, uint32_t endCol) const {
    if (startLine == 0 || startLine > lineOffsets.size()) return "";
    if (endLine == 0 || endLine > lineOffsets.size()) return "";
    if (startLine > endLine) return "";
    
    size_t start = lineOffsets[startLine - 1] + (startCol > 0 ? startCol - 1 : 0);
    size_t end = (endLine < lineOffsets.size()) 
                 ? lineOffsets[endLine] 
                 : content.size();
    if (endCol > 0 && endLine < lineOffsets.size()) {
        end = lineOffsets[endLine - 1] + endCol;
    }
    
    if (start >= end || start >= content.size()) return "";
    return content.substr(start, end - start);
}

uint64_t KdbBuilder::addModule(const ModuleInfo& module) {
    auto mod = std::make_unique<ModuleInfo>(module);
    mod->id = nextModuleId_++;
    
    uint64_t id = mod->id;
    moduleNameToId_[mod->fullName] = id;
    moduleIdToIndex_[id] = modules_.size();
    modules_.push_back(std::move(mod));
    
    return id;
}

uint64_t KdbBuilder::addSignal(const SignalInfo& signal) {
    auto sig = std::make_unique<SignalInfo>(signal);
    sig->id = nextSignalId_++;
    
    uint64_t id = sig->id;
    signalFullNameToId_[sig->fullName] = id;
    signalIdToIndex_[id] = signals_.size();
    signals_.push_back(std::move(sig));
    
    return id;
}

uint64_t KdbBuilder::addInstance(const ModuleInstanceInfo& instance) {
    auto inst = std::make_unique<ModuleInstanceInfo>(instance);
    inst->id = nextInstanceId_++;
    
    uint64_t id = inst->id;
    instances_.push_back(std::move(inst));
    
    return id;
}

void KdbBuilder::setTopModule(uint64_t moduleId) {
    topModuleId_ = moduleId;
}

void KdbBuilder::buildIndices() {
    // 构建信号驱动/负载关系索引
    for (const auto& signal : signals_) {
        // 清理旧的驱动/负载关系
        signal->driverSignalIds.clear();
        signal->loadSignalIds.clear();
    }
    
    // 这里可以添加更多复杂的连接分析逻辑
}

const ModuleInfo* KdbBuilder::findModuleByName(const std::string& name) const {
    auto it = moduleNameToId_.find(name);
    if (it != moduleNameToId_.end()) {
        return findModuleById(it->second);
    }
    return nullptr;
}

const ModuleInfo* KdbBuilder::findModuleById(uint64_t id) const {
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
    auto it = signalIdToIndex_.find(id);
    if (it != signalIdToIndex_.end() && it->second < signals_.size()) {
        return signals_[it->second].get();
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

const SourceFileInfo* KdbBuilder::findFileById(uint64_t id) const {
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
    result.reserve(signals_.size());
    for (const auto& sig : signals_) {
        result.push_back(sig.get());
    }
    return result;
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
    std::vector<const SignalInfo*> result;
    const SignalInfo* signal = findSignalById(signalId);
    if (signal) {
        for (uint64_t loadId : signal->loadSignalIds) {
            const SignalInfo* load = findSignalById(loadId);
            if (load) {
                result.push_back(load);
            }
        }
    }
    return result;
}

#ifdef USE_PROTOBUF

// 辅助函数：SignalType 转换
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
        case SignalType::INPUT: return hwda::kdb::SIGNAL_TYPE_INPUT;
        case SignalType::OUTPUT: return hwda::kdb::SIGNAL_TYPE_OUTPUT;
        case SignalType::INOUT: return hwda::kdb::SIGNAL_TYPE_INOUT;
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
        case hwda::kdb::SIGNAL_TYPE_INPUT: return SignalType::INPUT;
        case hwda::kdb::SIGNAL_TYPE_OUTPUT: return SignalType::OUTPUT;
        case hwda::kdb::SIGNAL_TYPE_INOUT: return SignalType::INOUT;
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
    // 设置头部信息
    auto* header = kdb->mutable_header();
    header->set_version("1.0");
    header->set_project_name(projectName_);
    
    auto now = std::chrono::system_clock::now();
    auto time = std::chrono::system_clock::to_time_t(now);
    std::stringstream ss;
    ss << std::put_time(std::localtime(&time), "%Y-%m-%d %H:%M:%S");
    header->set_created_at(ss.str());
    
    header->set_source_path(sourcePath_);
    header->set_module_count(modules_.size());
    header->set_signal_count(signals_.size());
    header->set_file_count(files_.size());
    
    // 添加源文件
    for (const auto& file : files_) {
        auto* protoFile = kdb->add_files();
        protoFile->set_id(file->id);
        protoFile->set_path(file->path);
        protoFile->set_hash(file->hash);
        protoFile->set_line_count(file->lineCount);
        protoFile->set_content(file->content);
        for (uint64_t offset : file->lineOffsets) {
            protoFile->add_line_offsets(offset);
        }
    }
    
    // 添加模块
    for (const auto& mod : modules_) {
        auto* protoMod = kdb->add_modules();
        protoMod->set_id(mod->id);
        protoMod->set_name(mod->name);
        protoMod->set_full_name(mod->fullName);
        protoMod->set_parent_module_id(mod->parentModuleId);
        protoMod->set_file_id(mod->fileId);
        protoMod->set_description(mod->description);
        
        // 源代码位置
        if (mod->declaration.fileId != 0) {
            auto* decl = protoMod->mutable_declaration();
            decl->set_file_id(mod->declaration.fileId);
            decl->set_line(mod->declaration.line);
            decl->set_column_start(mod->declaration.columnStart);
            decl->set_column_end(mod->declaration.columnEnd);
        }
        
        // 端口
        for (const auto& port : mod->ports) {
            auto* protoPort = protoMod->add_ports();
            protoPort->set_id(port.id);
            protoPort->set_name(port.name);
            protoPort->set_direction(toProtoPortDirection(port.direction));
            protoPort->set_type(toProtoSignalType(port.type));
            protoPort->set_msb(port.msb);
            protoPort->set_lsb(port.lsb);
            protoPort->set_is_vector(port.isVector);
            protoPort->set_connected_signal_id(port.connectedSignalId);
        }
        
        // 信号ID列表
        for (uint64_t sigId : mod->signalIds) {
            protoMod->add_signal_ids(sigId);
        }
    }
    
    // 添加信号
    for (const auto& sig : signals_) {
        auto* protoSig = kdb->add_signals();
        protoSig->set_id(sig->id);
        protoSig->set_name(sig->name);
        protoSig->set_full_name(sig->fullName);
        protoSig->set_type(toProtoSignalType(sig->type));
        protoSig->set_msb(sig->msb);
        protoSig->set_lsb(sig->lsb);
        protoSig->set_is_vector(sig->isVector);
        protoSig->set_parent_module_id(sig->parentModuleId);
        protoSig->set_description(sig->description);
        
        // 源代码位置
        if (sig->declaration.fileId != 0) {
            auto* decl = protoSig->mutable_declaration();
            decl->set_file_id(sig->declaration.fileId);
            decl->set_line(sig->declaration.line);
            decl->set_column_start(sig->declaration.columnStart);
            decl->set_column_end(sig->declaration.columnEnd);
        }
        
        // 驱动和负载
        for (uint64_t driverId : sig->driverSignalIds) {
            protoSig->add_driver_signal_ids(driverId);
        }
        for (uint64_t loadId : sig->loadSignalIds) {
            protoSig->add_load_signal_ids(loadId);
        }
    }
    
    // 设计层次
    auto* hierarchy = kdb->mutable_hierarchy();
    hierarchy->set_top_module_id(topModuleId_);
    for (const auto& mod : modules_) {
        hierarchy->add_module_ids(mod->id);
    }
}

void KdbBuilder::fromProtobuf(const hwda::kdb::KnowledgeBase& kdb) {
    // 清理现有数据
    files_.clear();
    modules_.clear();
    signals_.clear();
    instances_.clear();
    filePathToId_.clear();
    moduleNameToId_.clear();
    signalFullNameToId_.clear();
    fileIdToIndex_.clear();
    moduleIdToIndex_.clear();
    signalIdToIndex_.clear();
    
    // 恢复头部信息
    projectName_ = kdb.header().project_name();
    sourcePath_ = kdb.header().source_path();
    
    // 恢复源文件
    for (const auto& protoFile : kdb.files()) {
        auto file = std::make_unique<SourceFileInfo>();
        file->id = protoFile.id();
        file->path = protoFile.path();
        file->hash = protoFile.hash();
        file->lineCount = protoFile.line_count();
        file->content = protoFile.content();
        
        for (uint64_t offset : protoFile.line_offsets()) {
            file->lineOffsets.push_back(offset);
        }
        
        nextFileId_ = std::max(nextFileId_, file->id + 1);
        filePathToId_[file->path] = file->id;
        fileIdToIndex_[file->id] = files_.size();
        files_.push_back(std::move(file));
    }
    
    // 恢复模块
    for (const auto& protoMod : kdb.modules()) {
        auto mod = std::make_unique<ModuleInfo>();
        mod->id = protoMod.id();
        mod->name = protoMod.name();
        mod->fullName = protoMod.full_name();
        mod->parentModuleId = protoMod.parent_module_id();
        mod->fileId = protoMod.file_id();
        mod->description = protoMod.description();
        
        // 源代码位置
        if (protoMod.has_declaration()) {
            mod->declaration.fileId = protoMod.declaration().file_id();
            mod->declaration.line = protoMod.declaration().line();
            mod->declaration.columnStart = protoMod.declaration().column_start();
            mod->declaration.columnEnd = protoMod.declaration().column_end();
        }
        
        // 端口
        for (const auto& protoPort : protoMod.ports()) {
            PortInfo port;
            port.id = protoPort.id();
            port.name = protoPort.name();
            port.direction = fromProtoPortDirection(protoPort.direction());
            port.type = fromProtoSignalType(protoPort.type());
            port.msb = protoPort.msb();
            port.lsb = protoPort.lsb();
            port.isVector = protoPort.is_vector();
            port.connectedSignalId = protoPort.connected_signal_id();
            mod->ports.push_back(port);
        }
        
        // 信号ID列表
        for (uint64_t sigId : protoMod.signal_ids()) {
            mod->signalIds.push_back(sigId);
        }
        
        nextModuleId_ = std::max(nextModuleId_, mod->id + 1);
        moduleNameToId_[mod->fullName] = mod->id;
        moduleIdToIndex_[mod->id] = modules_.size();
        modules_.push_back(std::move(mod));
    }
    
    // 恢复信号
    for (const auto& protoSig : kdb.signals()) {
        auto sig = std::make_unique<SignalInfo>();
        sig->id = protoSig.id();
        sig->name = protoSig.name();
        sig->fullName = protoSig.full_name();
        sig->type = fromProtoSignalType(protoSig.type());
        sig->msb = protoSig.msb();
        sig->lsb = protoSig.lsb();
        sig->isVector = protoSig.is_vector();
        sig->parentModuleId = protoSig.parent_module_id();
        sig->description = protoSig.description();
        
        // 源代码位置
        if (protoSig.has_declaration()) {
            sig->declaration.fileId = protoSig.declaration().file_id();
            sig->declaration.line = protoSig.declaration().line();
            sig->declaration.columnStart = protoSig.declaration().column_start();
            sig->declaration.columnEnd = protoSig.declaration().column_end();
        }
        
        // 驱动和负载
        for (uint64_t driverId : protoSig.driver_signal_ids()) {
            sig->driverSignalIds.push_back(driverId);
        }
        for (uint64_t loadId : protoSig.load_signal_ids()) {
            sig->loadSignalIds.push_back(loadId);
        }
        
        nextSignalId_ = std::max(nextSignalId_, sig->id + 1);
        signalFullNameToId_[sig->fullName] = sig->id;
        signalIdToIndex_[sig->id] = signals_.size();
        signals_.push_back(std::move(sig));
    }
    
    // 恢复设计层次
    topModuleId_ = kdb.hierarchy().top_module_id();
}

bool KdbBuilder::serializeToFile(const std::string& filepath) const {
#ifdef USE_PROTOBUF
    hwda::kdb::KnowledgeBase kdb;
    toProtobuf(&kdb);
    
    std::string serialized;
    if (!kdb.SerializeToString(&serialized)) {
        return false;
    }
    
#ifdef USE_ZSTD
    if (compressionEnabled_) {
        return serializeToFileCompressed(filepath, compressionLevel_);
    }
#endif
    
    std::ofstream output(filepath, std::ios::binary);
    if (!output) {
        return false;
    }
    
    output.write(serialized.data(), serialized.size());
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
    
    uint32_t magic = 0x4B445743;  // "KDBZ"
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
        return false;
    }
    
    input.seekg(0, std::ios::end);
    size_t fileSize = input.tellg();
    input.seekg(0, std::ios::beg);
    
    if (fileSize < sizeof(uint32_t)) {
        return false;
    }
    
    uint32_t magic;
    input.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    input.seekg(0, std::ios::beg);
    
    if (magic == 0x4B445743) {  // "KDBZ" - compressed
#ifdef USE_ZSTD
        return deserializeFromFileCompressed(filepath);
#else
        return false;
#endif
    }
    
    hwda::kdb::KnowledgeBase kdb;
    if (!kdb.ParseFromIstream(&input)) {
        return false;
    }
    
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

#else // !USE_PROTOBUF

bool KdbBuilder::serializeToFile(const std::string& filepath) const {
    // 未启用Protobuf时的占位实现
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

#endif // USE_PROTOBUF

}
}
