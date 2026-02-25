#ifndef HWDA_INTERPRETER_KDB_BUILDER_H
#define HWDA_INTERPRETER_KDB_BUILDER_H

#include "types.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <memory>

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

struct SourceLinkInfo {
    uint32_t line;
    uint32_t columnStart;
    uint32_t columnEnd;
    uint32_t targetId;  // Changed from uint64_t to uint32_t for non-signal IDs
};

struct SourceFileInfo {
    uint32_t id;  // Changed from uint64_t to uint32_t
    std::string path;
    std::string content;
    std::vector<SourceLinkInfo> signalLinks;  // Contains both port and internal signal links
    std::vector<SourceLinkInfo> submodLinks;
    // Note: portLinks removed - ports are now stored in signals with direction != UNKNOWN
    
    std::string getLine(uint32_t lineNum) const;
    std::string getRange(uint32_t startLine, uint32_t startCol, 
                         uint32_t endLine, uint32_t endCol) const;
    uint64_t getSignalAtPosition(uint32_t line, uint32_t column) const;
    std::vector<const SourceLinkInfo*> getSignalLinksAtLine(uint32_t line) const;
    std::vector<const SourceLinkInfo*> getSubmodLinksAtLine(uint32_t line) const;
    // Note: getPortLinksAtLine removed - port links are now in signalLinks
    uint64_t getLineCount() const;
};

struct KdbSourceLocation {
    uint32_t fileId;  // Changed from uint64_t to uint32_t
    uint32_t line;
    uint32_t columnStart;
    uint32_t columnEnd;
};

// Source location for driver discovery
struct DriverLocation {
    uint32_t fileId;
    uint32_t line;
    // Note: columnStart and columnEnd removed - not needed for driver location
};



struct SignalInfo {
    uint64_t id;  // Keep uint64_t for signal IDs (can be many signals)
    std::string name;
    std::string fullName;
    SignalType type;
    PortDirection direction;  // Direction of the signal: INPUT, OUTPUT, INOUT, or UNKNOWN for internal signals
    uint32_t msb;
    uint32_t lsb;
    KdbSourceLocation declaration;
    uint32_t parentModuleId;  // Changed from uint64_t to uint32_t
    std::vector<uint64_t> driverSignalIds;
    std::vector<uint64_t> loadSignalIds;
    std::vector<DriverLocation> driverLines;  // Source locations where drivers are discovered
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
    uint32_t id;  // Changed from uint64_t to uint32_t
    std::string name;
    std::string fullName;
    KdbSourceLocation declaration;
    std::vector<SignalInfo> signals;  // Contains both ports and internal signals
    std::vector<ModuleInstanceInfo> instances;
    uint32_t parentModuleId;  // Changed from uint64_t to uint32_t
    uint32_t fileId;  // Changed from uint64_t to uint32_t
    bool isInstance;
};

class KdbBuilder {
public:
    KdbBuilder();
    ~KdbBuilder();
    
    void setProjectName(const std::string& name);
    
    uint32_t addSourceFile(const std::string& path, const std::string& content);  // Changed return type
    
    bool setSourceFileContent(uint32_t fileId, const std::string& content);  // Changed parameter type
    
    bool addSignalLink(uint32_t fileId, uint32_t line, uint32_t columnStart, 
                       uint32_t columnEnd, uint64_t signalId);
    bool addSignalLink(uint32_t fileId, const SourceLinkInfo& link);  // Changed parameter type
    
    bool addSubmodLink(uint32_t fileId, uint32_t line, uint32_t columnStart,
                       uint32_t columnEnd, uint32_t moduleId);  // Changed parameter types
    bool addSubmodLink(uint32_t fileId, const SourceLinkInfo& link);  // Changed parameter type
    // Note: addPortLink removed - use addSignalLink for both ports and internal signals
    
    std::string getSourceLine(uint32_t fileId, uint32_t line) const;  // Changed parameter type
    std::string getSourceRange(uint32_t fileId, uint32_t startLine, uint32_t startCol,
                               uint32_t endLine, uint32_t endCol) const;  // Changed parameter type
    std::string getSourceFileContent(uint32_t fileId) const;  // Changed parameter type
    
    uint32_t addModule(const ModuleInfo& module);  // Changed return type
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
