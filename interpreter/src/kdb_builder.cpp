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

// Global KdbBuilder pointer for ModuleInfo::getSignalInst
static KdbBuilder* g_currentBuilder = nullptr;

KdbBuilder::KdbBuilder()
    : nextModuleId_(1)
    , nextInstanceId_(1) {
    g_currentBuilder = this;
}

KdbBuilder::~KdbBuilder() {
    if (g_currentBuilder == this) {
        g_currentBuilder = nullptr;
    }
}

void KdbBuilder::setProjectName(const std::string& name) {
    projectName_ = name;
}

uint32_t KdbBuilder::addSourceFile(const std::string& path, const std::string& content) {
    // Calculate ID from array index (ID = index + 1)
    uint32_t id = static_cast<uint32_t>(fileInfos_.size()) + 1;
    
    // Create file info
    auto fileInfo = std::make_unique<SourceFileInfo>();
    fileInfo->path = path;
    
    // Create file content
    auto fileContent = std::make_unique<SourceFileContent>();
    fileContent->data.assign(content.begin(), content.end());
    
    // Calculate total lines and line index offsets
    fileInfo->totalLines = 0;
    fileInfo->lineIndexOffset.push_back(0);  // Line 1 starts at offset 0
    
    for (size_t i = 0; i < content.size(); ++i) {
        if (content[i] == '\n') {
            fileInfo->totalLines++;
            // Every 256 lines, record the offset for the next line
            if ((fileInfo->totalLines % 256) == 0) {
                fileInfo->lineIndexOffset.push_back(static_cast<uint32_t>(i + 1));
            }
        }
    }
    // If file is not empty and doesn't end with newline, add 1
    if (!content.empty() && content.back() != '\n') {
        fileInfo->totalLines++;
    }
    
    filePathToId_[path] = id;
    fileIdToIndex_[id] = fileInfos_.size();
    fileInfos_.push_back(std::move(fileInfo));
    fileContents_.push_back(std::move(fileContent));
    
    return id;
}

bool KdbBuilder::setSourceFileContent(uint32_t fileId, const std::string& content) {
    if (fileId == 0 || fileId > fileContents_.size()) return false;
    
    auto* fileContent = fileContents_[fileId - 1].get();
    auto* fileInfo = fileInfos_[fileId - 1].get();
    
    fileContent->data.assign(content.begin(), content.end());
    
    // Recalculate line info
    fileInfo->totalLines = 0;
    fileInfo->lineIndexOffset.clear();
    fileInfo->lineIndexOffset.push_back(0);
    
    for (size_t i = 0; i < content.size(); ++i) {
        if (content[i] == '\n') {
            fileInfo->totalLines++;
            if ((fileInfo->totalLines % 256) == 0) {
                fileInfo->lineIndexOffset.push_back(static_cast<uint32_t>(i + 1));
            }
        }
    }
    if (!content.empty() && content.back() != '\n') {
        fileInfo->totalLines++;
    }
    
    return true;
}

std::string KdbBuilder::getSourceLine(uint32_t fileId, uint32_t line) const {
    if (fileId == 0 || fileId > fileInfos_.size()) return "";
    
    const auto* fileInfo = fileInfos_[fileId - 1].get();
    const auto* fileContent = fileContents_[fileId - 1].get();
    
    if (line == 0 || line > fileInfo->totalLines) return "";
    
    return fileInfo->getLine(*fileContent, line);
}

std::string KdbBuilder::getSourceRange(uint32_t fileId, uint32_t startLine, uint32_t startCol,
                                        uint32_t endLine, uint32_t endCol) const {
    if (fileId == 0 || fileId > fileInfos_.size()) return "";
    
    const auto* fileInfo = fileInfos_[fileId - 1].get();
    const auto* fileContent = fileContents_[fileId - 1].get();
    
    return fileInfo->getRange(*fileContent, startLine, startCol, endLine, endCol);
}

std::string KdbBuilder::getSourceFileContent(uint32_t fileId) const {
    if (fileId == 0 || fileId > fileContents_.size()) return "";
    
    const auto* fileContent = fileContents_[fileId - 1].get();
    return fileContent->toString();
}

std::vector<std::string> KdbBuilder::getSourceLineRange(uint32_t fileId, uint32_t startLine, uint32_t endLine) const {
    if (fileId == 0 || fileId > fileInfos_.size()) return {};
    
    const auto* fileInfo = fileInfos_[fileId - 1].get();
    const auto* fileContent = fileContents_[fileId - 1].get();
    
    return fileInfo->getLineRange(*fileContent, startLine, endLine);
}

// Get byte offset for a specific line (1-based) using line index
uint32_t SourceFileInfo::getLineOffset(uint32_t lineNum) const {
    if (lineNum == 0 || lineNum > totalLines) return 0;
    
    // Use line index for fast lookup (every 256 lines)
    uint32_t indexSlot = (lineNum - 1) / 256;
    uint32_t offset = 0;
    
    if (indexSlot < lineIndexOffset.size()) {
        offset = lineIndexOffset[indexSlot];
    }
    
    return offset;
}

std::string SourceFileInfo::getLine(const SourceFileContent& content, uint32_t lineNum) const {
    if (lineNum == 0 || lineNum > totalLines || content.data.empty()) return "";
    
    // Use line index for fast seeking
    uint32_t startOffset = getLineOffset(lineNum);
    
    // Find the exact line start
    uint32_t currentLine = ((lineNum - 1) / 256) * 256 + 1;
    size_t lineStart = startOffset;
    
    const auto& data = content.data;
    for (size_t i = startOffset; i < data.size() && currentLine < lineNum; ++i) {
        if (data[i] == '\n') {
            currentLine++;
            if (currentLine == lineNum) {
                lineStart = i + 1;
                break;
            }
        }
    }
    
    if (currentLine != lineNum) return "";
    
    // Find line end
    size_t lineEnd = lineStart;
    while (lineEnd < data.size() && data[lineEnd] != '\n' && data[lineEnd] != '\r') {
        lineEnd++;
    }
    
    return std::string(data.begin() + lineStart, data.begin() + lineEnd);
}

std::string SourceFileInfo::getRange(const SourceFileContent& content, uint32_t startLine, uint32_t startCol,
                                      uint32_t endLine, uint32_t endCol) const {
    if (startLine == 0 || endLine == 0 || startLine > totalLines || endLine > totalLines) return "";
    if (startLine > endLine) return "";
    
    const auto& data = content.data;
    
    // Find start position
    uint32_t startOffset = getLineOffset(startLine);
    uint32_t currentLine = ((startLine - 1) / 256) * 256 + 1;
    size_t startPos = startOffset;
    
    for (size_t i = startOffset; i < data.size() && currentLine <= startLine; ++i) {
        if (currentLine == startLine) {
            startPos = i + (startCol > 0 ? startCol - 1 : 0);
            break;
        }
        if (data[i] == '\n') {
            currentLine++;
        }
    }
    
    // Find end position
    uint32_t endOffset = getLineOffset(endLine);
    currentLine = ((endLine - 1) / 256) * 256 + 1;
    size_t endPos = data.size();
    
    for (size_t i = endOffset; i < data.size() && currentLine <= endLine; ++i) {
        if (currentLine == endLine) {
            if (endCol > 0) {
                endPos = i + endCol;
            } else {
                while (i < data.size() && data[i] != '\n') i++;
                endPos = i;
            }
            break;
        }
        if (data[i] == '\n') {
            currentLine++;
        }
    }
    
    if (startPos >= endPos || startPos >= data.size()) return "";
    return std::string(data.begin() + startPos, data.begin() + endPos);
}

std::vector<std::string> SourceFileInfo::getLineRange(const SourceFileContent& content, 
                                                      uint32_t startLine, uint32_t endLine) const {
    std::vector<std::string> result;
    if (startLine == 0 || endLine == 0 || startLine > totalLines || endLine > totalLines) {
        return result;
    }
    if (startLine > endLine) {
        std::swap(startLine, endLine);
    }
    
    const auto& data = content.data;
    
    // Use index offset for fast seeking to start line
    uint32_t startOffset = getLineOffset(startLine);
    uint32_t currentLine = ((startLine - 1) / 256) * 256 + 1;
    size_t pos = startOffset;
    
    // Find exact start position
    while (pos < data.size() && currentLine < startLine) {
        if (data[pos] == '\n') {
            currentLine++;
        }
        pos++;
    }
    
    // Extract lines
    while (currentLine <= endLine && pos < data.size()) {
        size_t lineStart = pos;
        // Find end of current line
        while (pos < data.size() && data[pos] != '\n' && data[pos] != '\r') {
            pos++;
        }
        // Extract line content
        result.push_back(std::string(data.begin() + lineStart, data.begin() + pos));
        currentLine++;
        // Skip newline
        if (pos < data.size() && data[pos] == '\n') pos++;
        if (pos < data.size() && data[pos] == '\r') pos++;
    }
    
    return result;
}

bool KdbBuilder::hasModule(const std::string& fullName) const {
    return moduleNameToId_.find(fullName) != moduleNameToId_.end();
}

uint32_t KdbBuilder::addModule(const ModuleInfo& module, const std::string& fullName) {
    auto it = moduleNameToId_.find(fullName);
    if (it != moduleNameToId_.end()) {
        return it->second;
    }

    auto mod = std::make_unique<ModuleInfo>(module);
    
    // For Instance modules, find Definition
    const ModuleInfo* defModule = nullptr;
    if (mod->isInstance && mod->defModuleId != 0) {
        defModule = findModuleById(mod->defModuleId);
        if (defModule) {
            mod->externalSignalDefs = &defModule->signalDefs;
        }
    }

    // Calculate ID from array index (ID = index + 1)
    uint32_t id = static_cast<uint32_t>(modules_.size()) + 1;
    uint32_t parentModuleId = mod->parentModuleId;

    moduleNameToId_[fullName] = id;
    moduleIdToIndex_[id] = modules_.size();
    
    // Update all signalInsts parentModuleId (they were 0 when added to local moduleInfo)
    for (auto& inst : mod->signalInsts) {
        inst.parentModuleId = id;
    }
    
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

// Phase 1: Add signal (stores in module's temporary signalInsts)
// Returns local index, or existing index if signal already exists
uint64_t KdbBuilder::addSignal(uint32_t moduleId, const SignalInfo& signal) {
    if (signalInstsCommitted_) {
        throw std::runtime_error("Cannot add signal after commit phase");
    }
    
    auto* mod = const_cast<ModuleInfo*>(findModuleById(moduleId));
    if (!mod) return 0;

    // Check if signal already exists
    auto it = signalFullNameToId_.find(signal.fullName);
    if (it != signalFullNameToId_.end()) {
        // Signal already exists, return existing local index
        uint64_t tempId = it->second;
        uint32_t existingModuleId = static_cast<uint32_t>(tempId >> 32);
        if (existingModuleId == moduleId) {
            return static_cast<uint32_t>(tempId & 0xFFFFFFFF);
        }
    }

    // Build SignalDef (for Definition modules)
    if (!mod->isInstance) {
        SignalDefInfo def;
        def.name = signal.name;
        def.type = signal.type;
        def.declaration = signal.declaration;
        def.direction = signal.direction;
        mod->signalDefs.push_back(std::move(def));
    }

    // Build SignalInst
    SignalInstInfo inst;
    inst.localIndex = mod->getNextLocalIndex();
    inst.fullName = signal.fullName;
    inst.msb = signal.msb;
    inst.lsb = signal.lsb;
    inst.parentModuleId = moduleId;
    // Convert driverLines to driverLocations (without file_id)
    for (const auto& driverLine : signal.driverLines) {
        DriverLocation driverLoc;
        driverLoc.driverSignalGlobalId = 0;  // Will be filled later
        driverLoc.line = driverLine.line;
        inst.driverLocations.push_back(driverLoc);
    }
    // Note: driverSignalFullNames will be filled later by addDriverToSignal
    
    mod->addSignalInst(std::move(inst));
    
    // Store mapping from fullName to (moduleId, localIndex)
    uint64_t tempId = (static_cast<uint64_t>(moduleId) << 32) | inst.localIndex;
    signalFullNameToId_[signal.fullName] = tempId;
    
    return inst.localIndex;
}

uint32_t KdbBuilder::addInstance(const ModuleInstanceInfo& instance) {
    auto inst = std::make_unique<ModuleInstanceInfo>(instance);
    inst->id = nextInstanceId_++;
    
    uint32_t id = inst->id;
    instances_.push_back(std::move(inst));
    
    return id;
}

void KdbBuilder::setTopModule(uint32_t moduleId) {
    topModuleIds_.clear();
    topModuleIds_.push_back(moduleId);
}

void KdbBuilder::addHierarchy(uint32_t topModuleId) {
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
            collectModules(getModuleId(child));
        }
    };
    collectModules(topModuleId);
    
    hierarchies_.push_back(hierarchy);
}

void KdbBuilder::buildIndices() {
}

// Phase 2: Commit all signal instances to global array
void KdbBuilder::commitSignalInsts() {
    if (signalInstsCommitted_) return;
    
    // First pass: calculate total size and set start IDs
    // Use actual signalInsts.size() for each module to ensure we only allocate for existing signals
    uint32_t currentGlobalId = 0;
    for (uint32_t moduleId = 1; moduleId <= modules_.size(); ++moduleId) {
        ModuleInfo* mod = const_cast<ModuleInfo*>(findModuleById(moduleId));
        if (!mod) continue;
        
        mod->signalInstsStartId = currentGlobalId;
        // Use actual signalInsts size (not derived from signalDefs)
        // This ensures we only allocate space for signals that were actually added
        uint32_t count = static_cast<uint32_t>(mod->signalInsts.size());
        currentGlobalId += count;
    }
    
    // Allocate global array
    allSignalInsts_.resize(currentGlobalId);
    
    // Second pass: copy data to global array
    for (uint32_t moduleId = 1; moduleId <= modules_.size(); ++moduleId) {
        ModuleInfo* mod = const_cast<ModuleInfo*>(findModuleById(moduleId));
        if (!mod) continue;
        
        // Copy existing signal insts
        for (size_t i = 0; i < mod->signalInsts.size(); ++i) {
            uint32_t globalId = mod->signalInstsStartId + static_cast<uint32_t>(i);
            allSignalInsts_[globalId] = std::move(mod->signalInsts[i]);
        }
        
        // Clear temporary storage
        mod->signalInsts.clear();
        mod->signalInsts.shrink_to_fit();
        mod->signalInstsCommitted = true;
    }
    
    // Third pass: resolve driver references
    resolveDriverReferences();
    
    // Update signalFullNameToId_ to use global IDs
    // Use getSignalInstsCount() to iterate over all expected signals
    for (uint32_t moduleId = 1; moduleId <= modules_.size(); ++moduleId) {
        ModuleInfo* mod = const_cast<ModuleInfo*>(findModuleById(moduleId));
        if (!mod) continue;
        
        uint32_t count = mod->getSignalInstsCount();
        for (uint32_t localIdx = 0; localIdx < count; ++localIdx) {
            uint32_t globalId = mod->signalInstsStartId + localIdx;
            const SignalInstInfo* inst = getGlobalSignalInst(globalId);
            if (inst) {
                signalFullNameToId_[inst->fullName] = globalId;
            }
        }
    }
    
    signalInstsCommitted_ = true;
}

void KdbBuilder::resolveDriverReferences() {
    for (uint32_t globalId = 0; globalId < allSignalInsts_.size(); ++globalId) {
        SignalInstInfo& inst = allSignalInsts_[globalId];
        
        // Resolve driver full names to global IDs and update driverLocations
        // Find entries with driverSignalGlobalId=0 and update them
        auto locIt = inst.driverLocations.begin();
        for (const auto& driverName : inst.driverSignalFullNames) {
            auto it = signalFullNameToId_.find(driverName);
            if (it != signalFullNameToId_.end()) {
                // Before commit, the map contains temp IDs (moduleId << 32 | localIndex)
                // After we've updated the map in commitSignalInsts, it contains global IDs
                // But we're called before that update, so we need to handle temp IDs
                uint64_t tempId = it->second;
                uint32_t driverModuleId = static_cast<uint32_t>(tempId >> 32);
                uint32_t driverLocalIdx = static_cast<uint32_t>(tempId & 0xFFFFFFFF);
                
                const ModuleInfo* driverMod = findModuleById(driverModuleId);
                if (driverMod && driverMod->signalInstsCommitted) {
                    uint64_t driverGlobalId = driverMod->signalInstsStartId + driverLocalIdx;
                    
                    // Find the next entry with driverSignalGlobalId=0 and update it
                    while (locIt != inst.driverLocations.end() && locIt->driverSignalGlobalId != 0) {
                        ++locIt;
                    }
                    
                    if (locIt != inst.driverLocations.end()) {
                        locIt->driverSignalGlobalId = driverGlobalId;
                        ++locIt;
                    } else {
                        // No more entries with driverSignalGlobalId=0, create new one
                        DriverLocation driverLoc;
                        driverLoc.driverSignalGlobalId = driverGlobalId;
                        driverLoc.line = 0;  // Unknown line
                        inst.driverLocations.push_back(driverLoc);
                    }
                }
            }
        }
        
        // Clear temporary storage
        inst.driverSignalFullNames.clear();
        inst.driverSignalFullNames.shrink_to_fit();
    }
}

const ModuleInfo* KdbBuilder::findModuleByName(const std::string& name) const {
    auto it = moduleNameToId_.find(name);
    if (it != moduleNameToId_.end()) {
        return findModuleById(it->second);
    }
    return nullptr;
}

const ModuleInfo* KdbBuilder::findModuleById(uint32_t id) const {
    if (id == 0 || id > modules_.size()) {
        return nullptr;
    }
    return modules_[id - 1].get();
}

std::string KdbBuilder::calculateModuleFullName(const ModuleInfo* module) const {
    if (!module) return "";
    
    // Build full name from parent chain
    std::vector<std::string> names;
    const ModuleInfo* current = module;
    while (current) {
        names.push_back(current->name);
        if (current->parentModuleId == 0) break;
        current = findModuleById(current->parentModuleId);
    }
    
    // Reverse to get root-to-leaf order
    std::reverse(names.begin(), names.end());
    
    // Join with "."
    std::string fullName;
    for (size_t i = 0; i < names.size(); ++i) {
        if (i > 0) fullName += ".";
        fullName += names[i];
    }
    return fullName;
}

std::string KdbBuilder::calculateSignalFullName(uint32_t moduleId, const std::string& signalName) const {
    const ModuleInfo* module = findModuleById(moduleId);
    return calculateSignalFullName(module, signalName);
}

std::string KdbBuilder::calculateSignalFullName(const ModuleInfo* module, const std::string& signalName) const {
    std::string moduleFullName = calculateModuleFullName(module);
    if (moduleFullName.empty()) return signalName;
    return moduleFullName + "." + signalName;
}

const SignalInfo* KdbBuilder::findSignalByName(const std::string& fullName) const {
    if (!signalInstsCommitted_) {
        // Phase 1: Use temp ID
        auto it = signalFullNameToId_.find(fullName);
        if (it != signalFullNameToId_.end()) {
            uint64_t tempId = it->second;
            uint32_t moduleId = static_cast<uint32_t>(tempId >> 32);
            uint32_t localIdx = static_cast<uint32_t>(tempId & 0xFFFFFFFF);
            
            const ModuleInfo* mod = findModuleById(moduleId);
            if (mod && !mod->signalInsts.empty() && localIdx < mod->signalInsts.size()) {
                const SignalInstInfo& inst = mod->signalInsts[localIdx];
                // For Phase 1, just return basic info from signalInst
                static thread_local SignalInfo result;
                result = SignalInfo();
                result.fullName = inst.fullName;
                result.msb = inst.msb;
                result.lsb = inst.lsb;
                result.parentModuleId = inst.parentModuleId;
                // Try to get def info if available
                const auto& defs = mod->getSignalDefs();
                if (localIdx < defs.size()) {
                    result.name = defs[localIdx].name;
                    result.type = defs[localIdx].type;
                    result.direction = defs[localIdx].direction;
                    result.declaration = defs[localIdx].declaration;
                }
                return &result;
            }
        }
    } else {
        // Phase 2: Use global ID
        auto it = signalFullNameToId_.find(fullName);
        if (it != signalFullNameToId_.end()) {
            return findSignalById(it->second);
        }
    }
    return nullptr;
}

const SignalInfo* KdbBuilder::findSignalById(uint64_t id) const {
    if (!signalInstsCommitted_) {
        throw std::runtime_error("Cannot find signal by global ID before commit phase");
    }
    
    if (id >= allSignalInsts_.size()) return nullptr;
    
    const SignalInstInfo& inst = allSignalInsts_[id];
    const ModuleInfo* mod = findModuleById(inst.parentModuleId);
    if (!mod) return nullptr;
    
    // Calculate local index
    uint32_t localIdx = static_cast<uint32_t>(id - mod->signalInstsStartId);
    const auto& defs = mod->getSignalDefs();
    if (localIdx >= defs.size()) return nullptr;
    
    static thread_local SignalInfo result;
    result = buildSignalInfo(inst, defs[localIdx]);
    return &result;
}

SignalInfo KdbBuilder::buildSignalInfo(const SignalInstInfo& inst, const SignalDefInfo& def) const {
    SignalInfo sig;
    // Note: id is now global ID (startId + localIndex)
    // We'll calculate it if needed, but for now leave as 0
    sig.id = 0;  // TODO: Calculate if needed
    sig.name = def.name;
    sig.fullName = inst.fullName;
    sig.type = def.type;
    sig.direction = def.direction;
    sig.msb = inst.msb;
    sig.lsb = inst.lsb;
    sig.declaration = def.declaration;
    sig.parentModuleId = inst.parentModuleId;
    // Convert driverLocations back to driverSignalIds and driverLines for backward compatibility
    for (const auto& driverLoc : inst.driverLocations) {
        sig.driverSignalIds.push_back(driverLoc.driverSignalGlobalId);
        KdbSourceLocation loc;
        loc.fileId = 0;  // Not stored in new format
        loc.line = driverLoc.line;
        sig.driverLines.push_back(loc);
    }
    return sig;
}

const SourceFileInfo* KdbBuilder::findFileByPath(const std::string& path) const {
    auto it = filePathToId_.find(path);
    if (it != filePathToId_.end()) {
        return findFileById(it->second);
    }
    return nullptr;
}

const SourceFileInfo* KdbBuilder::findFileById(uint32_t id) const {
    if (id == 0 || id > fileInfos_.size()) {
        return nullptr;
    }
    return fileInfos_[id - 1].get();
}

const SourceFileContent* KdbBuilder::findFileContentById(uint32_t id) const {
    if (id == 0 || id > fileContents_.size()) {
        return nullptr;
    }
    return fileContents_[id - 1].get();
}

uint32_t KdbBuilder::getModuleId(const ModuleInfo* module) const {
    if (!module || modules_.empty()) return 0;
    for (size_t i = 0; i < modules_.size(); ++i) {
        if (modules_[i].get() == module) {
            return static_cast<uint32_t>(i) + 1;
        }
    }
    return 0;
}

uint32_t KdbBuilder::getSignalId(const ModuleInfo* module, const SignalInfo* signal) const {
    // TODO: Implement for new structure
    (void)module;
    (void)signal;
    return 0;
}

SignalInstInfo* KdbBuilder::getGlobalSignalInst(uint64_t globalId) {
    if (globalId >= allSignalInsts_.size()) return nullptr;
    return &allSignalInsts_[globalId];
}

const SignalInstInfo* KdbBuilder::getGlobalSignalInst(uint64_t globalId) const {
    if (globalId >= allSignalInsts_.size()) return nullptr;
    return &allSignalInsts_[globalId];
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
    // TODO: Implement for new structure
    return result;
}

std::vector<const SourceFileInfo*> KdbBuilder::getAllFiles() const {
    std::vector<const SourceFileInfo*> result;
    result.reserve(fileInfos_.size());
    for (const auto& file : fileInfos_) {
        result.push_back(file.get());
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
    // TODO: Implement load calculation
    (void)signalId;
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

size_t KdbBuilder::getTotalSignalCount() const {
    if (signalInstsCommitted_) {
        return allSignalInsts_.size();
    }
    size_t count = 0;
    for (const auto& mod : modules_) {
        count += mod->signalInsts.size();
    }
    return count;
}

// Phase 1: Store driver full name
// Phase 2: Resolved to global ID during commit
bool KdbBuilder::addDriverToSignal(const std::string& signalFullName, const std::string& driverSignalFullName) {
    if (signalInstsCommitted_) {
        // Phase 2: Directly add global ID
        auto it = signalFullNameToId_.find(driverSignalFullName);
        if (it == signalFullNameToId_.end()) return false;
        
        uint64_t driverGlobalId = it->second;
        
        // Find signal and add driver
        auto sigIt = signalFullNameToId_.find(signalFullName);
        if (sigIt == signalFullNameToId_.end()) return false;
        
        uint64_t signalGlobalId = sigIt->second;
        SignalInstInfo* inst = getGlobalSignalInst(signalGlobalId);
        if (!inst) return false;
        
        // Add driver location
        DriverLocation driverLoc;
        driverLoc.driverSignalGlobalId = driverGlobalId;
        driverLoc.line = 0;  // Line will be added by addDriverLineToSignal
        inst->driverLocations.push_back(driverLoc);
        return true;
    } else {
        // Phase 1: Store full name for later resolution
        for (auto& mod : modules_) {
            for (auto& inst : mod->signalInsts) {
                if (inst.fullName == signalFullName) {
                    inst.driverSignalFullNames.push_back(driverSignalFullName);
                    return true;
                }
            }
        }
    }
    return false;
}

bool KdbBuilder::addDriverLineToSignal(const std::string& signalFullName, const KdbSourceLocation& location) {
    if (signalInstsCommitted_) {
        // Phase 2: Use global array
        auto it = signalFullNameToId_.find(signalFullName);
        if (it == signalFullNameToId_.end()) return false;
        
        uint64_t signalGlobalId = it->second;
        SignalInstInfo* inst = getGlobalSignalInst(signalGlobalId);
        if (!inst) return false;
        
        // Update ALL driver locations with line=0 (added by addDriverToSignal for this assignment)
        // A single assignment can have multiple RHS signals, so multiple driverLocations with line=0
        bool updated = false;
        for (auto& driverLoc : inst->driverLocations) {
            if (driverLoc.line == 0) {
                driverLoc.line = location.line;
                updated = true;
            }
        }
        
        // If no entry with line=0 found, create a new one (orphan line without driver)
        if (!updated) {
            DriverLocation driverLoc;
            driverLoc.driverSignalGlobalId = 0;  // Unknown driver
            driverLoc.line = location.line;
            inst->driverLocations.push_back(driverLoc);
        }
        return true;
    } else {
        // Phase 1: Store in module's signalInsts
        for (auto& mod : modules_) {
            for (auto& inst : mod->signalInsts) {
                if (inst.fullName == signalFullName) {
                    // Update ALL driver locations with line=0
                    bool updated = false;
                    for (auto& driverLoc : inst.driverLocations) {
                        if (driverLoc.line == 0) {
                            driverLoc.line = location.line;
                            updated = true;
                        }
                    }
                    
                    // If no entry with line=0 found, create a new one
                    if (!updated) {
                        DriverLocation driverLoc;
                        driverLoc.driverSignalGlobalId = 0;  // Will be resolved later
                        driverLoc.line = location.line;
                        inst.driverLocations.push_back(driverLoc);
                    }
                    return true;
                }
            }
        }
    }
    return false;
}

bool KdbBuilder::addDriverLocation(const std::string& signalFullName, const std::string& driverSignalFullName, uint32_t line) {
    // This function adds both driver ID and line number at once, ensuring they are paired correctly
    if (signalInstsCommitted_) {
        // Phase 2: Directly add global ID with line
        auto it = signalFullNameToId_.find(driverSignalFullName);
        if (it == signalFullNameToId_.end()) return false;
        
        uint64_t driverGlobalId = it->second;
        
        // Find signal and add driver location
        auto sigIt = signalFullNameToId_.find(signalFullName);
        if (sigIt == signalFullNameToId_.end()) return false;
        
        uint64_t signalGlobalId = sigIt->second;
        SignalInstInfo* inst = getGlobalSignalInst(signalGlobalId);
        if (!inst) return false;
        
        // Add complete driver location with both ID and line
        DriverLocation driverLoc;
        driverLoc.driverSignalGlobalId = driverGlobalId;
        driverLoc.line = line;
        inst->driverLocations.push_back(driverLoc);
        return true;
    } else {
        // Phase 1: Store full name and line for later resolution
        for (auto& mod : modules_) {
            for (auto& inst : mod->signalInsts) {
                if (inst.fullName == signalFullName) {
                    // Store driver full name for later resolution
                    inst.driverSignalFullNames.push_back(driverSignalFullName);
                    // Add driver location with line (driver ID will be resolved later)
                    DriverLocation driverLoc;
                    driverLoc.driverSignalGlobalId = 0;  // Will be resolved later
                    driverLoc.line = line;
                    inst.driverLocations.push_back(driverLoc);
                    return true;
                }
            }
        }
    }
    return false;
}

// ModuleInfo implementation
SignalInstInfo* ModuleInfo::getSignalInst(uint32_t localIndex) {
    if (!signalInstsCommitted) {
        if (localIndex < signalInsts.size()) {
            return &signalInsts[localIndex];
        }
    } else if (g_currentBuilder) {
        uint32_t globalId = signalInstsStartId + localIndex;
        return g_currentBuilder->getGlobalSignalInst(globalId);
    }
    return nullptr;
}

const SignalInstInfo* ModuleInfo::getSignalInst(uint32_t localIndex) const {
    if (!signalInstsCommitted) {
        if (localIndex < signalInsts.size()) {
            return &signalInsts[localIndex];
        }
    } else if (g_currentBuilder) {
        uint32_t globalId = signalInstsStartId + localIndex;
        return g_currentBuilder->getGlobalSignalInst(globalId);
    }
    return nullptr;
}

std::vector<SignalInfo> ModuleInfo::getSignals() const {
    std::vector<SignalInfo> result;
    
    const auto& defsToUse = getSignalDefs();
    
    // Use getSignalInstsCount() to get expected count
    // But also check actual available signal instances
    uint32_t expectedCount = getSignalInstsCount();
    uint32_t availableCount = signalInstsCommitted ? expectedCount : static_cast<uint32_t>(signalInsts.size());
    uint32_t count = std::min(expectedCount, availableCount);
    count = std::min(count, static_cast<uint32_t>(defsToUse.size()));
    result.reserve(count);
    
    for (uint32_t localIdx = 0; localIdx < count; ++localIdx) {
        const SignalInstInfo* inst = getSignalInst(localIdx);
        if (!inst) continue;
        
        const SignalDefInfo& def = defsToUse[localIdx];
        SignalInfo sig;
        sig.name = def.name;
        sig.fullName = inst->fullName;
        sig.type = def.type;
        sig.direction = def.direction;
        sig.msb = inst->msb;
        sig.lsb = inst->lsb;
        sig.declaration = def.declaration;
        sig.parentModuleId = inst->parentModuleId;
        // Convert driverLocations to driverSignalIds and driverLines
        for (const auto& driverLoc : inst->driverLocations) {
            sig.driverSignalIds.push_back(driverLoc.driverSignalGlobalId);
            KdbSourceLocation loc;
            loc.fileId = 0;  // Not stored in new format
            loc.line = driverLoc.line;
            sig.driverLines.push_back(loc);
        }
        result.push_back(std::move(sig));
    }
    return result;
}

void ModuleInfo::addSignal(const SignalInfo& sig) {
    // Add to signalDefs if not exists (for Definition modules)
    if (!isInstance) {
        bool defExists = false;
        for (const auto& d : signalDefs) {
            if (d.name == sig.name) {
                defExists = true;
                break;
            }
        }
        if (!defExists) {
            SignalDefInfo def;
            def.name = sig.name;
            def.type = sig.type;
            def.declaration = sig.declaration;
            def.direction = sig.direction;
            signalDefs.push_back(std::move(def));
        }
    }

    // Add to signalInsts
    SignalInstInfo inst;
    inst.localIndex = getNextLocalIndex();
    inst.fullName = sig.fullName;
    inst.msb = sig.msb;
    inst.lsb = sig.lsb;
    inst.parentModuleId = sig.parentModuleId;
    // Convert driverSignalIds and driverLines to driverLocations
    size_t driverCount = std::max(sig.driverSignalIds.size(), sig.driverLines.size());
    for (size_t i = 0; i < driverCount; ++i) {
        DriverLocation driverLoc;
        driverLoc.driverSignalGlobalId = (i < sig.driverSignalIds.size()) ? sig.driverSignalIds[i] : 0;
        driverLoc.line = (i < sig.driverLines.size()) ? sig.driverLines[i].line : 0;
        inst.driverLocations.push_back(driverLoc);
    }
    addSignalInst(std::move(inst));
}

// Serialization (simplified - needs full implementation)
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
    
    // Serialize file infos and contents separately
    for (size_t i = 0; i < fileInfos_.size(); ++i) {
        const auto& info = fileInfos_[i];
        const auto& content = fileContents_[i];
        
        // Serialize file info
        auto* protoInfo = kdb->add_file_infos();
        protoInfo->set_path(info->path);
        protoInfo->set_total_lines(info->totalLines);
        for (uint32_t offset : info->lineIndexOffset) {
            protoInfo->add_line_index_offset(offset);
        }
        
        // Serialize file content
        auto* protoContent = kdb->add_file_contents();
        protoContent->set_content(content->data.data(), content->data.size());
    }
    
    for (const auto& mod : modules_) {
        auto* protoMod = kdb->add_modules();
        // Note: id removed - use array index + 1 as implicit ID
        protoMod->set_name(mod->name);  // field 1
        protoMod->set_parent_module_id(mod->parentModuleId);  // field 2
        
        // definition (field 3)
        if (mod->definition.fileId != 0) {
            auto* decl = protoMod->mutable_definition();
            decl->set_file_id(mod->definition.fileId);
            decl->set_start_line(mod->definition.startLine);
            decl->set_end_line(mod->definition.endLine);
        }
        
        // signal_defs (field 4)
        for (const auto& def : mod->signalDefs) {
            auto* protoDef = protoMod->add_signal_defs();
            protoDef->set_name(def.name);
            protoDef->set_type(toProtoSignalType(def.type));
            protoDef->set_direction(toProtoPortDirection(def.direction));

            if (def.declaration.fileId != 0) {
                auto* decl = protoDef->mutable_declaration();
                decl->set_file_id(def.declaration.fileId);
                decl->set_line(def.declaration.line);
            }
        }
        
        // Note: signal_insts moved to KnowledgeBase level (field 5 in old format, now removed)
        
        protoMod->set_is_instance(mod->isInstance);  // field 6
        
        // child_module_ids (field 7)
        for (uint32_t childId : mod->childModuleIds) {
            protoMod->add_child_module_ids(childId);
        }
        
        protoMod->set_def_module_id(mod->defModuleId);  // field 8
        // Note: def_name removed - can be obtained from def_module_id's module name
        protoMod->set_signal_insts_start_id(mod->signalInstsStartId);  // field 9
        // Note: signal_insts_count removed - derived from signal_defs.size()
    }
    
    // Serialize global signal instances
    // Note: fullName is not serialized - will be reconstructed during deserialization
    for (const auto& inst : allSignalInsts_) {
        auto* protoInst = kdb->add_all_signal_insts();
        // protoInst->set_full_name(inst.fullName);  // REMOVED: fullName reconstructed dynamically
        protoInst->set_msb(inst.msb);
        protoInst->set_lsb(inst.lsb);
        protoInst->set_parent_module_id(inst.parentModuleId);

        // Serialize driver locations (combined driver_signal_global_ids and driver_lines)
        for (const auto& driverLoc : inst.driverLocations) {
            auto* protoDriverLoc = protoInst->add_driver_locations();
            protoDriverLoc->set_driver_signal_global_id(driverLoc.driverSignalGlobalId);
            protoDriverLoc->set_line(driverLoc.line);
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
    fileInfos_.clear();
    fileContents_.clear();
    modules_.clear();
    instances_.clear();
    allSignalInsts_.clear();
    filePathToId_.clear();
    moduleNameToId_.clear();
    signalFullNameToId_.clear();
    fileIdToIndex_.clear();
    moduleIdToIndex_.clear();
    signalIdToIndex_.clear();
    
    projectName_ = kdb.header().project_name();
    
    // Deserialize file infos and contents separately
    // Note: file_infos and file_contents should have the same size and order
    size_t fileCount = std::min(kdb.file_infos_size(), kdb.file_contents_size());
    for (size_t i = 0; i < fileCount; ++i) {
        const auto& protoInfo = kdb.file_infos(i);
        const auto& protoContent = kdb.file_contents(i);
        
        // Deserialize file info
        auto info = std::make_unique<SourceFileInfo>();
        info->path = protoInfo.path();
        info->totalLines = protoInfo.total_lines();
        for (uint32_t offset : protoInfo.line_index_offset()) {
            info->lineIndexOffset.push_back(offset);
        }
        
        // Deserialize file content
        auto content = std::make_unique<SourceFileContent>();
        const std::string& contentStr = protoContent.content();
        content->data.assign(contentStr.begin(), contentStr.end());
        
        // Calculate ID from array index (ID = index + 1)
        uint32_t id = static_cast<uint32_t>(fileInfos_.size()) + 1;
        filePathToId_[info->path] = id;
        fileIdToIndex_[id] = fileInfos_.size();
        fileInfos_.push_back(std::move(info));
        fileContents_.push_back(std::move(content));
    }
    
    // First pass: load modules
    for (const auto& protoMod : kdb.modules()) {
        auto mod = std::make_unique<ModuleInfo>();
        mod->name = protoMod.name();
        mod->parentModuleId = protoMod.parent_module_id();
        mod->isInstance = protoMod.is_instance();
        mod->defModuleId = protoMod.def_module_id();
        // Note: def_name removed from proto - will be obtained from def_module_id's module name after linking
        mod->signalInstsStartId = protoMod.signal_insts_start_id();
        // Note: signal_insts_count removed from proto - will be derived from signal_defs.size() after linking
        mod->signalInstsCommitted = true;  // Loaded from protobuf = already committed

        if (protoMod.has_definition()) {
            mod->definition.fileId = protoMod.definition().file_id();
            mod->definition.startLine = protoMod.definition().start_line();
            mod->definition.endLine = protoMod.definition().end_line();
        }

        // Load SignalDefs
        for (const auto& protoDef : protoMod.signal_defs()) {
            SignalDefInfo def;
            def.name = protoDef.name();
            def.type = fromProtoSignalType(protoDef.type());
            def.direction = fromProtoPortDirection(protoDef.direction());
            if (protoDef.has_declaration()) {
                def.declaration.fileId = protoDef.declaration().file_id();
                def.declaration.line = protoDef.declaration().line();
            }
            mod->signalDefs.push_back(std::move(def));
        }

        // Load child module IDs
        for (uint32_t childId : protoMod.child_module_ids()) {
            mod->childModuleIds.push_back(childId);
        }

        uint32_t id = static_cast<uint32_t>(modules_.size()) + 1;
        moduleIdToIndex_[id] = modules_.size();
        moduleNameToId_[mod->name] = id;  // Build moduleNameToId_ mapping
        modules_.push_back(std::move(mod));
    }
    
    // Load global signal instances
    // Note: fullName is not loaded from proto - will be reconstructed after all modules are loaded
    for (const auto& protoInst : kdb.all_signal_insts()) {
        SignalInstInfo inst;
        // inst.fullName = protoInst.full_name();  // REMOVED: fullName reconstructed dynamically
        inst.msb = protoInst.msb();
        inst.lsb = protoInst.lsb();
        inst.parentModuleId = protoInst.parent_module_id();
        // Load driver locations (combined driver_signal_global_ids and driver_lines)
        for (const auto& protoDriverLoc : protoInst.driver_locations()) {
            DriverLocation driverLoc;
            driverLoc.driverSignalGlobalId = protoDriverLoc.driver_signal_global_id();
            driverLoc.line = protoDriverLoc.line();
            inst.driverLocations.push_back(driverLoc);
        }
        allSignalInsts_.push_back(std::move(inst));
    }
    
    // Second pass: link Instance modules to Definition modules' signalDefs
    for (auto& mod : modules_) {
        if (mod->isInstance && mod->defModuleId != 0) {
            const ModuleInfo* defModule = findModuleById(mod->defModuleId);
            if (defModule) {
                mod->externalSignalDefs = &defModule->signalDefs;
                mod->signalDefs.clear();
            }
        }
    }
    
    // Third pass: reconstruct fullName for all signal instances
    for (uint32_t moduleId = 1; moduleId <= modules_.size(); ++moduleId) {
        const ModuleInfo* mod = findModuleById(moduleId);
        if (!mod) continue;
        
        uint32_t count = mod->getSignalInstsCount();
        const auto& defs = mod->getSignalDefs();
        for (uint32_t localIdx = 0; localIdx < count && localIdx < defs.size(); ++localIdx) {
            uint32_t globalId = mod->signalInstsStartId + localIdx;
            if (globalId < allSignalInsts_.size()) {
                allSignalInsts_[globalId].fullName = calculateSignalFullName(mod, defs[localIdx].name);
            }
        }
    }
    
    // Build signalFullNameToId_ map
    for (uint32_t moduleId = 1; moduleId <= modules_.size(); ++moduleId) {
        const ModuleInfo* mod = findModuleById(moduleId);
        if (!mod) continue;
        
        // Use getSignalInstsCount() which derives count from signal_defs.size()
        uint32_t count = mod->getSignalInstsCount();
        for (uint32_t localIdx = 0; localIdx < count; ++localIdx) {
            uint32_t globalId = mod->signalInstsStartId + localIdx;
            if (globalId < allSignalInsts_.size()) {
                signalFullNameToId_[allSignalInsts_[globalId].fullName] = globalId;
            }
        }
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
    
    signalInstsCommitted_ = true;
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
    if (!output) return false;
    
    output.write(serialized.data(), serialized.size());
    return output.good();
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
    if (!output) return false;
    
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
    if (!input) return false;
    
    // Check if file is compressed (check magic number)
    uint32_t magic = 0;
    input.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    input.seekg(0, std::ios::beg);
    
    if (magic == 0x4B445743) {
        // Compressed format
        return deserializeFromFileCompressed(filepath);
    }
    
    // Uncompressed format
    std::string serialized((std::istreambuf_iterator<char>(input)),
                           std::istreambuf_iterator<char>());
    
    return deserializeFromString(serialized);
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

bool KdbBuilder::deserializeFromFileCompressed(const std::string& filepath) {
#ifdef USE_PROTOBUF
#ifdef USE_ZSTD
    std::ifstream input(filepath, std::ios::binary);
    if (!input) return false;
    
    uint32_t magic;
    uint32_t origSize;
    input.read(reinterpret_cast<char*>(&magic), sizeof(magic));
    input.read(reinterpret_cast<char*>(&origSize), sizeof(origSize));
    
    if (magic != 0x4B445743) return false;
    
    std::vector<char> compressed((std::istreambuf_iterator<char>(input)),
                                  std::istreambuf_iterator<char>());
    
    std::string serialized;
    serialized.resize(origSize);
    
    size_t result = ZSTD_decompress(&serialized[0], origSize,
                                    compressed.data(), compressed.size());
    
    if (ZSTD_isError(result)) {
        return false;
    }
    
    return deserializeFromString(serialized);
#else
    (void)filepath;
    return false;
#endif
#else
    (void)filepath;
    return false;
#endif
}

#endif // USE_PROTOBUF

}
}
