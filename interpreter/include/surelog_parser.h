#ifndef HWDA_INTERPRETER_SURELOG_PARSER_H
#define HWDA_INTERPRETER_SURELOG_PARSER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <memory>
#include <unordered_map>

// Surelog/UHDM forward declarations
namespace UHDM {
    class Serializer;
    class design;
    class module;
    class net;
    class ports;
    class BaseClass;  // UHDM v1.86: any is typedef of BaseClass
}

namespace SURELOG {
    class SymbolTable;
    class ErrorContainer;
    class CommandLineParser;
}

namespace hwda {
namespace interpreter {

// Surelog解析结果
struct ParseResult {
    bool success;
    std::string errorMessage;
    std::vector<std::string> parsedFiles;
    size_t moduleCount;
    size_t signalCount;
};

// Surelog解析器封装类
class SurelogParser {
public:
    SurelogParser();
    ~SurelogParser();
    
    // 初始化解析器
    bool initialize();
    
    // 解析文件列表
    ParseResult parseFiles(const std::vector<std::string>& filePaths, 
                           const std::vector<std::string>& includePaths = {},
                           const std::vector<std::string>& defines = {});
    
    // 解析单个文件
    ParseResult parseFile(const std::string& filePath,
                          const std::vector<std::string>& includePaths = {},
                          const std::vector<std::string>& defines = {});
    
    // 转换为知识库
    bool buildKnowledgeBase(KdbBuilder& builder);
    
    // 获取UHDM设计对象（高级用法）
    UHDM::design* getDesign() const;
    
    // 获取错误信息
    std::string getLastError() const { return lastError_; }
    
    // 设置顶层模块名称
    void setTopModule(const std::string& moduleName);
    
    // 设置编译选项
    void setCompileOptions(bool verbose = false, 
                          bool debug = false,
                          bool parseOnly = false);
    
    // 启用/禁用信号驱动追踪（默认禁用，因为大型设计中耗时较长）
    void setDriverTracingEnabled(bool enabled) { driverTracingEnabled_ = enabled; }
    bool isDriverTracingEnabled() const { return driverTracingEnabled_; }
    
    // 控制是否保留 Surelog 生成的中间 .uhdm 文件（默认不保留，仅用于调试）
    void setWriteUhdmEnabled(bool enabled) { writeUhdmEnabled_ = enabled; }
    bool isWriteUhdmEnabled() const { return writeUhdmEnabled_; }

    // 控制 Surelog 低内存优化（默认开启）
    void setLowMemEnabled(bool enabled) { lowMemEnabled_ = enabled; }
    bool isLowMemEnabled() const { return lowMemEnabled_; }

    // 控制 Surelog 最大线程数（0 = 单线程）
    void setMaxThreads(int n) { maxThreads_ = n; }
    int getMaxThreads() const { return maxThreads_; }

    // 标准 Verilog 库选项（-y / -v / +libext+），会原样转发给 Surelog。
    // 注意：必须在 parseFiles() 之前设置，否则会被静默丢弃。
    // （+incdir+ / +define+ 通过 parseFiles() 的参数传入。）
    void setLibraryDirs(const std::vector<std::string>& dirs) { libraryDirs_ = dirs; }
    void setLibraryFiles(const std::vector<std::string>& files) { libraryFiles_ = files; }
    void setLibraryExtensions(const std::vector<std::string>& exts) { libraryExtensions_ = exts; }
    
private:
    // UHDM遍历函数
    void processDesign(UHDM::design* design, KdbBuilder& builder);
    void processModule(UHDM::module* uhdmModule, KdbBuilder& builder, 
                       uint64_t parentModuleId, const std::string& scope);
    void processPorts(UHDM::module* uhdmModule, ModuleInfo& moduleInfo, 
                      KdbBuilder& builder);
    void processSignals(UHDM::module* uhdmModule, uint64_t moduleId, 
                        KdbBuilder& builder, const std::string& scope);
    void processInstances(UHDM::module* uhdmModule, uint64_t parentModuleId,
                          KdbBuilder& builder, const std::string& scope);
    
    // 类型转换辅助函数
    SignalType convertSignalType(int32_t uhdmNetType);
    PortDirection convertPortDirection(int vpiDirection);
    
    // 源代码位置提取
    KdbSourceLocation extractLocation(UHDM::BaseClass* uhdmObject);
    
    // 位宽解析
    void extractBitWidth(UHDM::BaseClass* uhdmObject, uint32_t& msb, uint32_t& lsb, bool& isVector);
    
    // 内部成员
    std::unique_ptr<SURELOG::SymbolTable> symbolTable_;
    std::unique_ptr<SURELOG::ErrorContainer> errorContainer_;
    std::unique_ptr<SURELOG::CommandLineParser> clp_;
    
    // Surelog compiler handle (opaque pointer)
    void* compilerHandle_ = nullptr;
    void* vpiDesign_ = nullptr;
    
    std::string lastError_;
    std::string topModuleName_;
    
    bool verbose_;
    bool debug_;
    bool parseOnly_;
    bool driverTracingEnabled_ = true;  // Driver/load tracing on by default
    bool writeUhdmEnabled_ = false;      // 默认不保留 .uhdm 文件
    bool lowMemEnabled_ = true;          // 默认开启低内存优化
    int maxThreads_ = 0;                 // 默认单线程

    // 转发给 Surelog 的库选项（-y / -v / +libext+）
    std::vector<std::string> libraryDirs_;
    std::vector<std::string> libraryFiles_;
    std::vector<std::string> libraryExtensions_;
    
    // 文件ID映射
    std::unordered_map<std::string, uint64_t> filePathToId_;
    
    // 统计信息
    size_t totalModules_;
    size_t totalSignals_;
    size_t totalInstances_;
};

} // namespace interpreter
} // namespace hwda

#endif // HWDA_INTERPRETER_SURELOG_PARSER_H
