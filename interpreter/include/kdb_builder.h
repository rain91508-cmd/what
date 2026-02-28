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
struct SignalDefInfo {
    uint64_t id;  // Unique signal ID
    std::string name;  // Signal name (e.g., "mem_arvalid")
    SignalType type;
    KdbSourceLocation declaration;
    PortDirection direction;  // INPUT, OUTPUT, INOUT, or UNKNOWN for internal signals
};

// Signal instance - specific to each module instance
struct SignalInstInfo {
    uint64_t id;  // References SignalDefInfo.id
    std::string fullName;  // Full hierarchical name (e.g., "work@dut.mem_arvalid")
    uint32_t msb;
    uint32_t lsb;
    uint32_t parentModuleId;  // Module instance ID that owns this signal
    std::vector<uint64_t> driverSignalIds;  // IDs of signals that drive this signal
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
	// New: Split signals into definition (shared) and instance (specific)
	std::vector<SignalDefInfo> signalDefs;  // Signal definitions (shared)
	std::vector<SignalInstInfo> signalInsts;  // Signal instances (specific to this module instance)
	// Deprecated: std::vector<SignalInfo> signals;
	std::vector<ModuleInstanceInfo> instances;
	uint32_t parentModuleId;  // 0 for top-level modules
	// Note: fileId removed, use definition.fileId instead
	bool isInstance;
	std::vector<uint32_t> childModuleIds;  // Direct child module IDs for hierarchy traversal
	uint32_t defModuleId;  // Definition module ID for instances (0 if this is a definition)

	// Transition helper: Build SignalInfo vector from signalDefs and signalInsts
	std::vector<SignalInfo> getSignals() const {
		std::vector<SignalInfo> result;
		result.reserve(signalInsts.size());
		for (const auto& inst : signalInsts) {
			// Find corresponding definition
			const SignalDefInfo* def = nullptr;
			for (const auto& d : signalDefs) {
				if (d.id == inst.id) {
					def = &d;
					break;
				}
			}
			if (def) {
				SignalInfo sig;
				sig.id = inst.id;
				sig.name = def->name;
				sig.fullName = inst.fullName;
				sig.type = def->type;
				sig.direction = def->direction;
				sig.msb = inst.msb;
				sig.lsb = inst.lsb;
				sig.declaration = def->declaration;
				sig.parentModuleId = inst.parentModuleId;
				sig.driverSignalIds = inst.driverSignalIds;
				sig.driverLines = inst.driverLines;
				result.push_back(std::move(sig));
			}
		}
		return result;
	}

	// Transition helper: Add signal by splitting into Def and Inst
	void addSignal(const SignalInfo& sig) {
		// Add to signalDefs if not exists (check by name for new signals with id=0)
		bool defExists = false;
		for (const auto& d : signalDefs) {
			if (d.name == sig.name) {
				defExists = true;
				break;
			}
		}
		if (!defExists) {
			SignalDefInfo def;
			def.id = sig.id;
			def.name = sig.name;
			def.type = sig.type;
			def.declaration = sig.declaration;
			def.direction = sig.direction;
			signalDefs.push_back(std::move(def));
		}

		// Add to signalInsts
		SignalInstInfo inst;
		inst.id = sig.id;
		inst.fullName = sig.fullName;
		inst.msb = sig.msb;
		inst.lsb = sig.lsb;
		inst.parentModuleId = sig.parentModuleId;
		inst.driverSignalIds = sig.driverSignalIds;
		inst.driverLines = sig.driverLines;
		signalInsts.push_back(std::move(inst));
	}
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
    
    uint64_t addSignal(uint32_t moduleId, const SignalInfo& signal);  // Changed parameter type
    
    uint32_t addInstance(const ModuleInstanceInfo& instance);  // Changed return type
    
    void setTopModule(uint32_t moduleId);  // Changed parameter type
    void addHierarchy(uint32_t topModuleId);  // Changed parameter type
    
    void buildIndices();
    
    const ModuleInfo* findModuleByName(const std::string& name) const;
    const ModuleInfo* findModuleById(uint32_t id) const;  // Changed parameter type
    const SignalInfo* findSignalByName(const std::string& fullName) const;
    const SignalInfo* findSignalById(uint64_t id) const;
    const SourceFileInfo* findFileByPath(const std::string& path) const;
    const SourceFileInfo* findFileById(uint32_t id) const;  // Changed parameter type
    
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
    
    std::unordered_map<std::string, uint32_t> filePathToId_;  // Changed value type
    std::unordered_map<std::string, uint32_t> moduleNameToId_;  // Changed value type
    std::unordered_map<std::string, uint64_t> signalFullNameToId_;  // Keep uint64_t for signal IDs
    std::unordered_map<uint32_t, size_t> moduleIdToIndex_;  // Changed key type
    std::unordered_map<uint64_t, size_t> signalIdToIndex_;  // Keep uint64_t for signal IDs
    std::unordered_map<uint32_t, size_t> fileIdToIndex_;  // Changed key type
    
    uint32_t nextFileId_;  // Changed from uint64_t to uint32_t
    uint32_t nextModuleId_;  // Changed from uint64_t to uint32_t
    uint64_t nextSignalId_;  // Keep uint64_t for signal IDs
    uint32_t nextInstanceId_;  // Changed from uint64_t to uint32_t
    
    bool compressionEnabled_ = true;
    int compressionLevel_ = 9;
    
    void toProtobuf(hwda::kdb::KnowledgeBase* kdb) const;
    void fromProtobuf(const hwda::kdb::KnowledgeBase& kdb);
};

}
}

#endif
