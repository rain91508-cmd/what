#ifndef HWDA_INTERPRETER_SURELOG_INTERPRETER_H
#define HWDA_INTERPRETER_SURELOG_INTERPRETER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <memory>

// Surelog forward declarations
namespace SURELOG {
    class Compiler;
    class CommandLineParser;
    class ErrorContainer;
    class SymbolTable;
}

namespace UHDM {
    class Serializer;
    class design;
    class module;
    class net;
    class port;
    class any;
    class instance;
}

namespace hwda {
namespace interpreter {

// Surelog解析配置
struct SurelogConfig {
    // 基本选项
    bool verbose = false;
    bool debug = false;
    bool parseOnly = false;
    bool noElab = false;
    bool lowMem = false;
    
    // 多线程选项
    uint16_t nbMaxThreads = 0;  // 0 = single threaded
    uint16_t nbMaxProcesses = 0;
    
    // 输出选项
    bool writeUhdm = false;
    bool elabUhdm = true;
    std::string outputDir = ".";
    
    // 顶层模块
    std::vector<std::string> topModules;
    
    // 黑盒模块/实例
    std::vector<std::string> blackBoxModules;
    std::vector<std::string> blackBoxInstances;
    
    // 编译流程选项
    bool fileUnit = false;  // 每个文件作为独立编译单元
    bool sepComp = false;   // 分离编译模式
    bool link = false;      // 链接模式
    
    // 缓存选项
    bool cacheAllowed = true;
    bool writeCache = true;
    std::string cacheDir;
    
    // 调试选项
    int32_t debugLevel = 0;
    bool debugUhdm = false;
    bool debugAst = false;
    bool muteStdout = false;
};

// Surelog解释器 - 完全复用Surelog的命令行功能
class SurelogInterpreter {
public:
    SurelogInterpreter();
    ~SurelogInterpreter();
    
    // 初始化
    bool initialize();
    
    // 解析命令行参数 (复用Surelog的完整命令行解析)
    bool parseCommandLine(int argc, const char** argv);
    
    // 设置配置
    void setConfig(const SurelogConfig& config);
    
    // 添加文件/路径
    void addSourceFile(const std::string& file);
    void addLibraryPath(const std::string& path);
    void addLibraryFile(const std::string& file);
    void addIncludePath(const std::string& path);
    void addDefine(const std::string& name, const std::string& value = "");
    void addParameter(const std::string& name, const std::string& value);
    
    // 设置顶层模块
    void setTopModule(const std::string& moduleName);
    
    // 执行解析和编译
    bool compile();
    
    // 生成知识库
    bool buildKnowledgeBase(KdbBuilder& builder);
    
    // 获取错误信息
    std::string getErrors() const;
    bool hasErrors() const;
    
    // 获取统计信息
    size_t getModuleCount() const;
    size_t getSignalCount() const;
    
    // 高级API: 直接获取Surelog对象
    SURELOG::Compiler* getCompiler() const;
    UHDM::design* getUhdmDesign() const;
    
private:
    // UHDM遍历函数
    void processDesign(UHDM::design* design, KdbBuilder& builder);
    void processModule(UHDM::module* uhdmModule, KdbBuilder& builder,
                       uint64_t parentModuleId, const std::string& scope);
    void processPorts(UHDM::module* uhdmModule, ModuleInfo& moduleInfo, KdbBuilder& builder);
    void processSignals(UHDM::module* uhdmModule, uint64_t moduleId, 
                        KdbBuilder& builder, const std::string& scope);
    void processInstances(UHDM::module* uhdmModule, uint64_t parentModuleId,
                          KdbBuilder& builder, const std::string& scope);
    
    // 类型转换
    SignalType convertSignalType(const std::string& uhdmType);
    PortDirection convertPortDirection(const std::string& uhdmDirection);
    
    // 源代码位置提取
    SourceLocation extractLocation(UHDM::any* uhdmObject);
    
    // 位宽解析
    void extractBitWidth(UHDM::any* uhdmObject, uint32_t& msb, uint32_t& lsb, bool& isVector);
    
    // Surelog核心对象
    std::unique_ptr<SURELOG::SymbolTable> symbolTable_;
    std::unique_ptr<SURELOG::ErrorContainer> errorContainer_;
    std::unique_ptr<SURELOG::CommandLineParser> clp_;
    std::unique_ptr<SURELOG::Compiler> compiler_;
    
    // 配置
    SurelogConfig config_;
    
    // 文件ID映射
    std::unordered_map<std::string, uint64_t> filePathToId_;
    
    // 统计
    size_t totalModules_ = 0;
    size_t totalSignals_ = 0;
    size_t totalInstances_ = 0;
};

} // namespace interpreter
} // namespace hwda

#endif // HWDA_INTERPRETER_SURELOG_INTERPRETER_H
