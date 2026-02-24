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
    LOCALPARAM = 8,
    INPUT = 9,
    OUTPUT = 10,
    INOUT = 11
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
    uint64_t targetId;
};

struct SourceFileInfo {
    uint64_t id;
    std::string path;
    std::string content;
    std::vector<SourceLinkInfo> signalLinks;
    std::vector<SourceLinkInfo> submodLinks;
    std::vector<SourceLinkInfo> portLinks;
    
    std::string getLine(uint32_t lineNum) const;
    std::string getRange(uint32_t startLine, uint32_t startCol, 
                         uint32_t endLine, uint32_t endCol) const;
    uint64_t getSignalAtPosition(uint32_t line, uint32_t column) const;
    std::vector<const SourceLinkInfo*> getSignalLinksAtLine(uint32_t line) const;
    std::vector<const SourceLinkInfo*> getSubmodLinksAtLine(uint32_t line) const;
    std::vector<const SourceLinkInfo*> getPortLinksAtLine(uint32_t line) const;
    uint64_t getLineCount() const;
};

struct KdbSourceLocation {
    uint64_t fileId;
    uint32_t line;
    uint32_t columnStart;
    uint32_t columnEnd;
};

struct PortInfo {
    uint64_t id;
    std::string name;
    PortDirection direction;
    SignalType type;
    uint32_t msb;
    uint32_t lsb;
    uint64_t connectedSignalId;
    KdbSourceLocation declaration;
};

struct SignalInfo {
    uint64_t id;
    std::string name;
    std::string fullName;
    SignalType type;
    uint32_t msb;
    uint32_t lsb;
    KdbSourceLocation declaration;
    uint64_t parentModuleId;
    std::vector<uint64_t> driverSignalIds;
    std::vector<uint64_t> loadSignalIds;
};

struct ModuleInstanceInfo {
    uint64_t id;
    std::string name;
    uint64_t moduleDefId;
    uint64_t parentModuleId;
    KdbSourceLocation declaration;
    
    struct PortConnection {
        uint64_t portId;
        std::string connectionExpr;
        uint64_t connectedSignalId;
    };
    std::vector<PortConnection> connections;
};

struct ModuleInfo {
    uint64_t id;
    std::string name;
    std::string fullName;
    KdbSourceLocation declaration;
    KdbSourceLocation definitionStart;
    KdbSourceLocation definitionEnd;
    std::vector<PortInfo> ports;
    std::vector<SignalInfo> signals;
    std::vector<ModuleInstanceInfo> instances;
    uint64_t parentModuleId;
    uint64_t fileId;
};

class KdbBuilder {
public:
    KdbBuilder();
    ~KdbBuilder();
    
    void setProjectName(const std::string& name);
    
    uint64_t addSourceFile(const std::string& path, const std::string& content);
    
    bool setSourceFileContent(uint64_t fileId, const std::string& content);
    
    bool addSignalLink(uint64_t fileId, uint32_t line, uint32_t columnStart, 
                       uint32_t columnEnd, uint64_t signalId);
    bool addSignalLink(uint64_t fileId, const SourceLinkInfo& link);
    
    bool addSubmodLink(uint64_t fileId, uint32_t line, uint32_t columnStart,
                       uint32_t columnEnd, uint64_t moduleId);
    bool addSubmodLink(uint64_t fileId, const SourceLinkInfo& link);
    
    bool addPortLink(uint64_t fileId, uint32_t line, uint32_t columnStart,
                    uint32_t columnEnd, uint64_t portId);
    bool addPortLink(uint64_t fileId, const SourceLinkInfo& link);
    
    std::string getSourceLine(uint64_t fileId, uint32_t line) const;
    std::string getSourceRange(uint64_t fileId, uint32_t startLine, uint32_t startCol,
                               uint32_t endLine, uint32_t endCol) const;
    std::string getSourceFileContent(uint64_t fileId) const;
    
    uint64_t addModule(const ModuleInfo& module);
    
    uint64_t addSignal(uint64_t moduleId, const SignalInfo& signal);
    
    uint64_t addInstance(const ModuleInstanceInfo& instance);
    
    void setTopModule(uint64_t moduleId);
    
    void buildIndices();
    
    const ModuleInfo* findModuleByName(const std::string& name) const;
    const ModuleInfo* findModuleById(uint64_t id) const;
    const SignalInfo* findSignalByName(const std::string& fullName) const;
    const SignalInfo* findSignalById(uint64_t id) const;
    const SourceFileInfo* findFileByPath(const std::string& path) const;
    const SourceFileInfo* findFileById(uint64_t id) const;
    
    std::vector<const ModuleInfo*> getAllModules() const;
    std::vector<const SignalInfo*> getAllSignals() const;
    
    std::vector<const SignalInfo*> getDrivers(uint64_t signalId) const;
    std::vector<const SignalInfo*> getLoads(uint64_t signalId) const;
    
    uint64_t getTopModuleId() const { return topModuleId_; }
    std::vector<const ModuleInfo*> getChildModules(uint64_t parentModuleId) const;
    
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
    uint64_t topModuleId_;
    
    std::vector<std::unique_ptr<SourceFileInfo>> files_;
    std::vector<std::unique_ptr<ModuleInfo>> modules_;
    std::vector<std::unique_ptr<ModuleInstanceInfo>> instances_;
    
    std::unordered_map<std::string, uint64_t> filePathToId_;
    std::unordered_map<std::string, uint64_t> moduleNameToId_;
    std::unordered_map<std::string, uint64_t> signalFullNameToId_;
    std::unordered_map<uint64_t, size_t> moduleIdToIndex_;
    std::unordered_map<uint64_t, size_t> signalIdToIndex_;
    std::unordered_map<uint64_t, size_t> fileIdToIndex_;
    
    uint64_t nextFileId_;
    uint64_t nextModuleId_;
    uint64_t nextSignalId_;
    uint64_t nextInstanceId_;
    
    bool compressionEnabled_ = true;
    int compressionLevel_ = 9;
    
    void toProtobuf(hwda::kdb::KnowledgeBase* kdb) const;
    void fromProtobuf(const hwda::kdb::KnowledgeBase& kdb);
};

}
}

#endif
