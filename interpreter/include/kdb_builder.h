#ifndef HWDA_INTERPRETER_KDB_BUILDER_H
#define HWDA_INTERPRETER_KDB_BUILDER_H

#include "types.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <memory>

// Forward declarations for protobuf generated classes
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

// 信号类型枚举
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

// 端口方向枚举
enum class PortDirection {
    UNKNOWN = 0,
    INPUT = 1,
    OUTPUT = 2,
    INOUT = 3
};

// 源文件信息
struct SourceFileInfo {
    uint64_t id;
    std::string path;
    std::string hash;
    uint64_t lineCount;
    std::string content;           // 源代码内容
    std::vector<uint64_t> lineOffsets; // 每行起始偏移量
    
    // 获取指定行的源代码
    std::string getLine(uint32_t lineNum) const;
    // 获取指定范围的源代码
    std::string getRange(uint32_t startLine, uint32_t startCol, 
                         uint32_t endLine, uint32_t endCol) const;
};

// 源代码位置 (KDB专用)
struct KdbSourceLocation {
    uint64_t fileId;
    uint32_t line;
    uint32_t columnStart;
    uint32_t columnEnd;
};

// 端口信息
struct PortInfo {
    uint64_t id;
    std::string name;
    PortDirection direction;
    SignalType type;
    uint32_t msb;
    uint32_t lsb;
    bool isVector;
    uint64_t connectedSignalId;
    KdbSourceLocation declaration;
};

// 模块实例信息
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

// 模块信息
struct ModuleInfo {
    uint64_t id;
    std::string name;
    std::string fullName;
    KdbSourceLocation declaration;
    KdbSourceLocation definitionStart;
    KdbSourceLocation definitionEnd;
    std::vector<PortInfo> ports;
    std::vector<uint64_t> signalIds;
    std::vector<ModuleInstanceInfo> instances;
    uint64_t parentModuleId;
    uint64_t fileId;
    std::string description;
};

// 信号信息
struct SignalInfo {
    uint64_t id;
    std::string name;
    std::string fullName;
    SignalType type;
    uint32_t msb;
    uint32_t lsb;
    bool isVector;
    KdbSourceLocation declaration;
    uint64_t parentModuleId;
    std::vector<uint64_t> driverSignalIds;
    std::vector<uint64_t> loadSignalIds;
    std::string description;
};

// 知识库构建器
class KdbBuilder {
public:
    KdbBuilder();
    ~KdbBuilder();
    
    // 设置项目信息
    void setProjectName(const std::string& name);
    void setSourcePath(const std::string& path);
    
    // 添加源文件
    uint64_t addSourceFile(const std::string& path, const std::string& hash, uint64_t lineCount);
    uint64_t addSourceFile(const std::string& path, const std::string& content);
    
    // 设置源文件内容
    bool setSourceFileContent(uint64_t fileId, const std::string& content);
    
    // 获取源代码
    std::string getSourceLine(uint64_t fileId, uint32_t line) const;
    std::string getSourceRange(uint64_t fileId, uint32_t startLine, uint32_t startCol,
                               uint32_t endLine, uint32_t endCol) const;
    std::string getSourceFileContent(uint64_t fileId) const;
    
    // 添加模块
    uint64_t addModule(const ModuleInfo& module);
    
    // 添加信号
    uint64_t addSignal(const SignalInfo& signal);
    
    // 添加模块实例
    uint64_t addInstance(const ModuleInstanceInfo& instance);
    
    // 设置设计层次
    void setTopModule(uint64_t moduleId);
    
    // 构建索引
    void buildIndices();
    
    // 查询接口
    const ModuleInfo* findModuleByName(const std::string& name) const;
    const ModuleInfo* findModuleById(uint64_t id) const;
    const SignalInfo* findSignalByName(const std::string& fullName) const;
    const SignalInfo* findSignalById(uint64_t id) const;
    const SourceFileInfo* findFileByPath(const std::string& path) const;
    const SourceFileInfo* findFileById(uint64_t id) const;
    
    // 获取所有模块/信号
    std::vector<const ModuleInfo*> getAllModules() const;
    std::vector<const SignalInfo*> getAllSignals() const;
    
    // 获取驱动/负载
    std::vector<const SignalInfo*> getDrivers(uint64_t signalId) const;
    std::vector<const SignalInfo*> getLoads(uint64_t signalId) const;
    
    // 序列化
    bool serializeToFile(const std::string& filepath) const;
    bool serializeToString(std::string* output) const;
    bool serializeToFileCompressed(const std::string& filepath, int compressionLevel = 3) const;
    
    // 反序列化
    bool deserializeFromFile(const std::string& filepath);
    bool deserializeFromString(const std::string& data);
    bool deserializeFromFileCompressed(const std::string& filepath);
    
    // 压缩设置
    void setCompressionEnabled(bool enabled) { compressionEnabled_ = enabled; }
    bool isCompressionEnabled() const { return compressionEnabled_; }
    void setCompressionLevel(int level) { compressionLevel_ = level; }
    int getCompressionLevel() const { return compressionLevel_; }
    
    // 获取统计信息
    size_t getModuleCount() const { return modules_.size(); }
    size_t getSignalCount() const { return signals_.size(); }
    size_t getFileCount() const { return files_.size(); }
    
private:
    std::string projectName_;
    std::string sourcePath_;
    uint64_t topModuleId_;
    
    std::vector<std::unique_ptr<SourceFileInfo>> files_;
    std::vector<std::unique_ptr<ModuleInfo>> modules_;
    std::vector<std::unique_ptr<SignalInfo>> signals_;
    std::vector<std::unique_ptr<ModuleInstanceInfo>> instances_;
    
    // 索引
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
    
    // 压缩设置
    bool compressionEnabled_ = true;
    int compressionLevel_ = 3;
    
    // Protobuf序列化辅助函数
    void toProtobuf(hwda::kdb::KnowledgeBase* kdb) const;
    void fromProtobuf(const hwda::kdb::KnowledgeBase& kdb);
};

}
}

#endif
