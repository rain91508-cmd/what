#ifndef HWDA_INTERPRETER_KDB_BUILDER_H
#define HWDA_INTERPRETER_KDB_BUILDER_H

#include "types.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <memory>
#include <iostream>

namespace hwda {
namespace kdb {
    class KnowledgeBase;
    class Module;
    class Signal;
    class SourceFile;
    class SourceLocation;
}
}

namespace hwda {
namespace interpreter {

enum class SignalType {
    UNKNOWN = 0,
    WIRE = 1,
    REG = 2,
    LOGIC = 3,
    BIT = 4,
    INTEGER = 5,
    REAL = 6,
    PARAMETER = 7,
    LOCALPARAM = 8
    // Note: INPUT, OUTPUT, INOUT removed - use PortDirection for direction
};

enum class PortDirection {
    UNKNOWN = 0,
    INPUT = 1,
    OUTPUT = 2,
    INOUT = 3
};

struct SourceFileInfo {
    uint32_t id;  // Changed from uint64_t to uint32_t
    std::string path;
    std::string content;
    
    std::string getLine(uint32_t lineNum) const;
    std::string getRange(uint32_t startLine, uint32_t startCol, 
                         uint32_t endLine, uint32_t endCol) const;
    uint64_t getLineCount() const;
};

struct KdbSourceLocation {
    uint32_t fileId;  // Changed from uint64_t to uint32_t
    uint32_t line;
    // Note: columnStart and columnEnd removed - not needed
};

struct KdbModuleSourceLocation {
    uint32_t fileId;
    uint32_t startLine;
    uint32_t endLine;
};

// Signal definition - shared between Definition and Instance
// Note: id removed, use array index as local index
struct SignalDefInfo {
    // uint64_t id;  // REMOVED: Use array index as local index
    std::string name;  // Signal name (e.g., "mem_arvalid")
    SignalType type;
    KdbSourceLocation declaration;
    PortDirection direction;  // INPUT, OUTPUT, INOUT, or UNKNOWN for internal signals
};

// Signal instance - specific to each module instance
// Note: id removed, use module's signalInstsStartId + localIndex as global id
struct SignalInstInfo {
    // uint64_t id;  // REMOVED: Use global signal insts array index
    uint32_t localIndex;  // Index within module's signalInsts (0, 1, 2, ...)
    std::string fullName;  // Full hierarchical name (e.g., "work@dut.mem_arvalid")
    uint32_t msb;
    uint32_t lsb;
    uint32_t parentModuleId;  // Module instance ID that owns this signal
    // Phase 1: Store driver full names (before global IDs are assigned)
    std::vector<std::string> driverSignalFullNames;  // Temporary storage for Phase 1
    // Phase 2: Converted to global IDs (after commit)
    std::vector<uint64_t> driverSignalGlobalIds;  // Global IDs in allSignalInsts array
    std::vector<KdbSourceLocation> driverLines;  // Source locations where drivers are discovered
};

// Deprecated: Keep for backward compatibility during transition
struct SignalInfo {
    uint64_t id;
    std::string name;
    std::string fullName;
    SignalType type;
    PortDirection direction;
    uint32_t msb;
    uint32_t lsb;
    KdbSourceLocation declaration;
    uint32_t parentModuleId;
    std::vector<uint64_t> driverSignalIds;
    std::vector<KdbSourceLocation> driverLines;
};

struct ModuleInstanceInfo {
    uint32_t id;  // Changed from uint64_t to uint32_t
    std::string name;
    uint32_t moduleDefId;  // Changed from uint64_t to uint32_t
    uint32_t parentModuleId;  // Changed from uint64_t to uint32_t
    KdbSourceLocation declaration;
    
    struct PortConnection {
        uint64_t portId;  // Keep uint64_t for signal IDs
        std::string connectionExpr;
        uint64_t connectedSignalId;  // Keep uint64_t for signal IDs
    };
    std::vector<PortConnection> connections;
};

struct ModuleInfo {
    // Note: id removed, use array index + 1 as implicit ID
    std::string name;  // Instance: VpiName(), Definition: VpiDefName()
    // Note: fullName removed, reconstruct from hierarchy if needed
    KdbModuleSourceLocation definition;
    // Phase 1: Temporary storage for signal instances (before commit)
    std::vector<SignalDefInfo> signalDefs;  // Signal definitions (shared) - only for Definition
    std::vector<SignalInstInfo> signalInsts;  // Temporary storage (cleared after commit)
    // Phase 2: Global array references (after commit)
    uint32_t signalInstsStartId = 0;  // Start index in global allSignalInsts array
    bool signalInstsCommitted = false;  // Whether signal insts have been committed to global array
    
    // Get signal insts count - derived from signalDefs size
    uint32_t getSignalInstsCount() const {
        if (isInstance && externalSignalDefs) {
            // Instance: count equals Definition's signalDefs size
            return static_cast<uint32_t>(externalSignalDefs->size());
        }
        // Definition: count equals own signalDefs size
        return static_cast<uint32_t>(signalDefs.size());
    }
    // Deprecated: std::vector<SignalInfo> signals;
    std::vector<ModuleInstanceInfo> instances;
    uint32_t parentModuleId;  // 0 for top-level modules
    // Note: fileId removed, use definition.fileId instead
    bool isInstance;
    std::vector<uint32_t> childModuleIds;  // Direct child module IDs for hierarchy traversal
    uint32_t defModuleId;  // Definition module ID for instances (0 if this is a definition)
    // Note: defName removed - use getDefName() to get from defModuleId
    const std::vector<SignalDefInfo>* externalSignalDefs = nullptr;

    // Get signalDefs - for Definition use own, for Instance use external (from Definition)
    const std::vector<SignalDefInfo>& getSignalDefs() const {
        if (isInstance && externalSignalDefs) {
            return *externalSignalDefs;
        }
        return signalDefs;
    }

    // Check if signal insts have been committed to global array
    bool isSignalInstsCommitted() const {
        return signalInstsCommitted;
    }

    // Get signal instance by local index
    // Phase 1: from signalInsts vector
    // Phase 2: from global array (requires KdbBuilder pointer)
    SignalInstInfo* getSignalInst(uint32_t localIndex);
    const SignalInstInfo* getSignalInst(uint32_t localIndex) const;

    // Get global ID from local index
    uint64_t getSignalGlobalId(uint32_t localIndex) const {
        if (!signalInstsCommitted) {
            throw std::runtime_error("Cannot get global ID before commit phase");
        }
        return static_cast<uint64_t>(signalInstsStartId) + localIndex;
    }

    // Get local index from SignalInst pointer (for adding new signals)
    uint32_t getNextLocalIndex() const {
        return static_cast<uint32_t>(signalInsts.size());
    }

    // Add signal instance (Phase 1 only)
    void addSignalInst(SignalInstInfo&& inst) {
        if (signalInstsCommitted) {
            throw std::runtime_error("Cannot add signal after commit phase");
        }
        inst.localIndex = getNextLocalIndex();
        signalInsts.push_back(std::move(inst));
    }

    // Transition helper: Build SignalInfo vector from signalDefs and signalInsts
    // Automatically handles Definition vs Instance using getSignalDefs()
    std::vector<SignalInfo> getSignals() const;

    // Transition helper: Add signal by splitting into Def and Inst
    void addSignal(const SignalInfo& sig);
};

class KdbBuilder {
public:
    KdbBuilder();
    ~KdbBuilder();
    
    void setProjectName(const std::string& name);
    
    uint32_t addSourceFile(const std::string& path, const std::string& content);  // Changed return type
    
    bool setSourceFileContent(uint32_t fileId, const std::string& content);  // Changed parameter type
    
    std::string getSourceLine(uint32_t fileId, uint32_t line) const;  // Changed parameter type
    std::string getSourceRange(uint32_t fileId, uint32_t startLine, uint32_t startCol,
                               uint32_t endLine, uint32_t endCol) const;  // Changed parameter type
    std::string getSourceFileContent(uint32_t fileId) const;  // Changed parameter type
    
    uint32_t addModule(const ModuleInfo& module, const std::string& fullName);  // Changed return type, fullName for deduplication
    bool hasModule(const std::string& fullName) const;
    
    // Phase 1: Add signal (stores in module's temporary signalInsts)
    uint64_t addSignal(uint32_t moduleId, const SignalInfo& signal);  // Returns local index as temporary ID
    
    uint32_t addInstance(const ModuleInstanceInfo& instance);  // Changed return type
    
    void setTopModule(uint32_t moduleId);  // Changed parameter type
    void addHierarchy(uint32_t topModuleId);  // Changed parameter type
    
    void buildIndices();
    
    // Phase 2: Commit all signal instances to global array
    // This must be called after all modules are added and linked
    void commitSignalInsts();
    bool isSignalInstsCommitted() const { return signalInstsCommitted_; }
    
    // Get global signal instance by global ID
    SignalInstInfo* getGlobalSignalInst(uint64_t globalId);
    const SignalInstInfo* getGlobalSignalInst(uint64_t globalId) const;
    
    const ModuleInfo* findModuleByName(const std::string& name) const;
    const ModuleInfo* findModuleById(uint32_t id) const;  // Changed parameter type
    
    // Get definition name for an instance module
    std::string getDefName(const ModuleInfo* module) const {
        if (!module || !module->isInstance || module->defModuleId == 0) {
            return "";
        }
        const ModuleInfo* defModule = findModuleById(module->defModuleId);
        return defModule ? defModule->name : "";
    }
    
    // Calculate module's full hierarchical name (e.g., "work@top.u_adder")
    std::string calculateModuleFullName(const ModuleInfo* module) const;
    
    // Calculate signal's full hierarchical name (e.g., "work@top.u_adder.sum")
    std::string calculateSignalFullName(uint32_t moduleId, const std::string& signalName) const;
    std::string calculateSignalFullName(const ModuleInfo* module, const std::string& signalName) const;
    
    const SignalInfo* findSignalByName(const std::string& fullName) const;
    const SignalInfo* findSignalById(uint64_t id) const;  // Now requires commit phase
    const SourceFileInfo* findFileByPath(const std::string& path) const;
    const SourceFileInfo* findFileById(uint32_t id) const;  // Changed parameter type
    
    // Add driver to a signal by name (Phase 1: stores fullName, Phase 2: resolved to global ID)
    bool addDriverToSignal(const std::string& signalFullName, const std::string& driverSignalFullName);
    bool addDriverLineToSignal(const std::string& signalFullName, const KdbSourceLocation& location);
    
    // Helper methods to get ID from pointer (for future optimization)
    uint32_t getModuleId(const ModuleInfo* module) const;
    uint32_t getSignalId(const ModuleInfo* module, const SignalInfo* signal) const;
    
    std::vector<const ModuleInfo*> getAllModules() const;
    std::vector<const SignalInfo*> getAllSignals() const;
    
    std::vector<const SignalInfo*> getDrivers(uint64_t signalId) const;
    std::vector<const SignalInfo*> getLoads(uint64_t signalId) const;
    
    const std::vector<uint32_t>& getTopModuleIds() const { return topModuleIds_; }  // Changed return type
    std::vector<const ModuleInfo*> getChildModules(uint32_t parentModuleId) const;  // Changed parameter type
    
    bool serializeToFile(const std::string& filepath) const;
    bool serializeToString(std::string* output) const;
    bool serializeToFileCompressed(const std::string& filepath, int compressionLevel = 3) const;
    
    bool deserializeFromFile(const std::string& filepath);
    bool deserializeFromString(const std::string& data);
    bool deserializeFromFileCompressed(const std::string& filepath);
    
    void setCompressionEnabled(bool enabled) { compressionEnabled_ = enabled; }
    bool isCompressionEnabled() const { return compressionEnabled_; }
    void setCompressionLevel(int level) { compressionLevel_ = level; }
    int getCompressionLevel() const { return compressionLevel_; }
    
    size_t getModuleCount() const { return modules_.size(); }
    size_t getFileCount() const { return files_.size(); }
    size_t getTotalSignalCount() const;
    
    // Get global signal insts array (for ModuleInfo::getSignalInst)
    std::vector<SignalInstInfo>& getAllSignalInsts() { return allSignalInsts_; }
    const std::vector<SignalInstInfo>& getAllSignalInsts() const { return allSignalInsts_; }
    
    // Build SignalInfo from SignalInstInfo and SignalDefInfo
    SignalInfo buildSignalInfo(const SignalInstInfo& inst, const SignalDefInfo& def) const;
    
    // Register signal fullName to tempId mapping (used by kdb_build_listener)
    void registerSignalFullName(const std::string& fullName, uint64_t tempId) {
        signalFullNameToId_[fullName] = tempId;
    }
    
private:
    std::string projectName_;
    std::vector<uint32_t> topModuleIds_;  // Changed from uint64_t to uint32_t
    
    struct HierarchyInfo {
        uint32_t topModuleId;  // Changed from uint64_t to uint32_t
        std::vector<uint32_t> moduleIds;  // Changed from uint64_t to uint32_t
    };
    std::vector<HierarchyInfo> hierarchies_;
    
    std::vector<std::unique_ptr<SourceFileInfo>> files_;
    std::vector<std::unique_ptr<ModuleInfo>> modules_;
    std::vector<std::unique_ptr<ModuleInstanceInfo>> instances_;
    
    // Phase 2: Global signal instances array
    std::vector<SignalInstInfo> allSignalInsts_;
    bool signalInstsCommitted_ = false;
    
    std::unordered_map<std::string, uint32_t> filePathToId_;  // Changed value type
    std::unordered_map<std::string, uint32_t> moduleNameToId_;  // Changed value type
    std::unordered_map<std::string, uint64_t> signalFullNameToId_;  // Now stores global ID after commit
    std::unordered_map<uint32_t, size_t> moduleIdToIndex_;  // Changed key type
    std::unordered_map<uint64_t, size_t> signalIdToIndex_;  // Maps global ID to index in allSignalInsts
    std::unordered_map<uint32_t, size_t> fileIdToIndex_;  // Changed key type
    
    uint32_t nextFileId_;  // Changed from uint64_t to uint32_t
    uint32_t nextModuleId_;  // Changed from uint64_t to uint32_t
    uint32_t nextInstanceId_;  // Changed from uint64_t to uint32_t
    
    bool compressionEnabled_ = true;
    int compressionLevel_ = 9;
    
    void toProtobuf(hwda::kdb::KnowledgeBase* kdb) const;
    void fromProtobuf(const hwda::kdb::KnowledgeBase& kdb);
    
    // Resolve driver references after commit
    void resolveDriverReferences();
};

}
}

#endif
