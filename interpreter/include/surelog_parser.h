#ifndef HWDA_INTERPRETER_SURELOG_PARSER_H
#define HWDA_INTERPRETER_SURELOG_PARSER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <memory>

// Surelog/UHDM forward declarations
namespace UHDM {
    class Serializer;
    class design;
    class module;
    class net;
    class ports;
    class any;
}

namespace SURELOG {
    class SymbolTable;
    class ErrorContainer;
    class CommandLineParser;
    class Compiler;
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
    SignalType convertSignalType(const std::string& uhdmType);
    PortDirection convertPortDirection(const std::string& uhdmDirection);
    
    // 源代码位置提取
    SourceLocation extractLocation(UHDM::any* uhdmObject);
    
    // 位宽解析
    void extractBitWidth(UHDM::any* uhdmObject, uint32_t& msb, uint32_t& lsb, bool& isVector);
    
    // 内部成员
    std::unique_ptr<SURELOG::SymbolTable> symbolTable_;
    std::unique_ptr<SURELOG::ErrorContainer> errorContainer_;
    std::unique_ptr<SURELOG::CommandLineParser> clp_;
    std::unique_ptr<SURELOG::Compiler> compiler_;
    
    std::string lastError_;
    std::string topModuleName_;
    
    bool verbose_;
    bool debug_;
    bool parseOnly_;
    
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
