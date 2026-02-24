#include "surelog_parser.h"

#include <surelog/API/Version.h>
#include <surelog/CommandLine/CommandLineParser.h>
#include <surelog/Design/Design.h>
#include <surelog/Design/ModuleDefinition.h>
#include <surelog/DesignCompile/SymbolTable.h>
#include <surelog/ErrorContainer.h>
#include <surelog/SourceManager/SourceManager.h>
#include <surelog/Parsing/ParserAPI.h>

#include <uhdm/uhdm.h>
#include <uhdm/serializer.h>

#include <iostream>
#include <fstream>
#include <sstream>

namespace hwda {
namespace interpreter {

SurelogParser::SurelogParser()
    : verbose_(false)
    , debug_(false)
    , parseOnly_(false)
    , totalModules_(0)
    , totalSignals_(0)
    , totalInstances_(0) {
}

SurelogParser::~SurelogParser() = default;

bool SurelogParser::initialize() {
    try {
        symbolTable_ = std::make_unique<SURELOG::SymbolTable>();
        errorContainer_ = std::make_unique<SURELOG::ErrorContainer>(nullptr);
        clp_ = std::make_unique<SURELOG::CommandLineParser>(
            symbolTable_.get(), errorContainer_.get(), false);
        return true;
    } catch (const std::exception& e) {
        lastError_ = std::string("Failed to initialize Surelog: ") + e.what();
        return false;
    }
}

ParseResult SurelogParser::parseFile(const std::string& filePath,
                                    const std::vector<std::string>& includePaths,
                                    const std::vector<std::string>& defines) {
    return parseFiles({filePath}, includePaths, defines);
}

ParseResult SurelogParser::parseFiles(const std::vector<std::string>& filePaths,
                                     const std::vector<std::string>& includePaths,
                                     const std::vector<std::string>& defines) {
    ParseResult result;
    result.success = false;
    result.moduleCount = 0;
    result.signalCount = 0;
    
    if (!initialize()) {
        result.errorMessage = lastError_;
        return result;
    }
    
    try {
        // 设置解析选项
        clp_->setFileList(filePaths);
        
        for (const auto& incPath : includePaths) {
            clp_->addIncludePath(incPath);
        }
        
        for (const auto& def : defines) {
            clp_->addDefine(def);
        }
        
        if (parseOnly_) {
            clp_->setParseOnly(true);
        }
        
        // 创建编译器
        compiler_ = std::make_unique<SURELOG::Compiler>(
            clp_.get(), symbolTable_.get(), errorContainer_.get());
        
        // 执行解析
        bool success = compiler_->compile();
        
        if (!success) {
            std::stringstream ss;
            errorContainer_->printToStream(ss);
            result.errorMessage = ss.str();
            return result;
        }
        
        // 获取设计对象
        SURELOG::Design* design = compiler_->getDesign();
        if (!design) {
            result.errorMessage = "Failed to get design object";
            return result;
        }
        
        // 统计模块数量
        const std::map<std::string, SURELOG::ModuleDefinition*>& modules = 
            design->getModuleDefinitions();
        result.moduleCount = modules.size();
        
        result.success = true;
        result.parsedFiles = filePaths;
        
    } catch (const std::exception& e) {
        result.errorMessage = std::string("Parse error: ") + e.what();
    }
    
    return result;
}

bool SurelogParser::buildKnowledgeBase(KdbBuilder& builder) {
    if (!compiler_) {
        lastError_ = "Parser not initialized";
        return false;
    }
    
    try {
        SURELOG::Design* design = compiler_->getDesign();
        if (!design) {
            lastError_ = "No design loaded";
            return false;
        }
        
        // 处理设计
        processDesign(design, builder);
        
        // 构建索引
        builder.buildIndices();
        
        return true;
        
    } catch (const std::exception& e) {
        lastError_ = std::string("Build KDB error: ") + e.what();
        return false;
    }
}

UHDM::design* SurelogParser::getDesign() const {
    if (!compiler_) {
        return nullptr;
    }
    
    SURELOG::Design* design = compiler_->getDesign();
    if (!design) {
        return nullptr;
    }
    
    // 这里可以扩展以返回UHDM对象
    return nullptr;
}

void SurelogParser::setTopModule(const std::string& moduleName) {
    topModuleName_ = moduleName;
}

void SurelogParser::setCompileOptions(bool verbose, bool debug, bool parseOnly) {
    verbose_ = verbose;
    debug_ = debug;
    parseOnly_ = parseOnly;
}

void SurelogParser::processDesign(UHDM::design* design, KdbBuilder& builder) {
    if (!design) return;
    
    const std::map<std::string, SURELOG::ModuleDefinition*>& modules = 
        design->getModuleDefinitions();
    
    // 处理所有模块
    for (const auto& pair : modules) {
        SURELOG::ModuleDefinition* modDef = pair.second;
        if (!modDef) continue;
        
        // 获取UHDM模块对象
        UHDM::module* uhdmModule = modDef->getUHDMModule(-1);
        if (uhdmModule) {
            processModule(uhdmModule, builder, 0, "");
        }
    }
}

void SurelogParser::processModule(UHDM::module* uhdmModule, KdbBuilder& builder,
                                 uint64_t parentModuleId, const std::string& scope) {
    if (!uhdmModule) return;
    
    ModuleInfo moduleInfo;
    moduleInfo.name = uhdmModule->VpiName();
    moduleInfo.fullName = scope.empty() ? moduleInfo.name : scope + "." + moduleInfo.name;
    moduleInfo.parentModuleId = parentModuleId;
    
    // 提取位置信息
    moduleInfo.declaration = extractLocation(uhdmModule);
    
    // 获取文件信息
    std::string filePath = uhdmModule->VpiFile();
    auto it = filePathToId_.find(filePath);
    if (it == filePathToId_.end()) {
        moduleInfo.fileId = builder.addSourceFile(filePath, "", 0);
        filePathToId_[filePath] = moduleInfo.fileId;
    } else {
        moduleInfo.fileId = it->second;
    }
    
    // 处理端口
    processPorts(uhdmModule, moduleInfo, builder);
    
    // 处理信号
    processSignals(uhdmModule, 0, builder, moduleInfo.fullName);
    
    // 处理实例
    processInstances(uhdmModule, 0, builder, moduleInfo.fullName);
    
    // 添加模块
    uint64_t moduleId = builder.addModule(moduleInfo);
    
    // 如果是顶层模块
    if (parentModuleId == 0 && totalModules_ == 0) {
        builder.setTopModule(moduleId);
    }
    
    totalModules_++;
}

void SurelogParser::processPorts(UHDM::module* uhdmModule, ModuleInfo& moduleInfo,
                                KdbBuilder& builder) {
    if (!uhdmModule) return;
    
    // 遍历端口
    for (const auto& port : uhdmModule->Ports()) {
        if (!port) continue;
        
        PortInfo portInfo;
        portInfo.name = port->VpiName();
        
        // 端口方向
        std::string dir = port->VpiDirection();
        portInfo.direction = convertPortDirection(dir);
        
        // 类型
        portInfo.type = SignalType::WIRE;
        
        // 位宽
        extractBitWidth(port.get(), portInfo.msb, portInfo.lsb, portInfo.isVector);
        
        // 位置
        portInfo.declaration = extractLocation(port.get());
        
        moduleInfo.ports.push_back(portInfo);
    }
}

void SurelogParser::processSignals(UHDM::module* uhdmModule, uint64_t moduleId,
                                   KdbBuilder& builder, const std::string& scope) {
    if (!uhdmModule) return;
    
    // 遍历信号
    for (const auto& net : uhdmModule->Nets()) {
        if (!net) continue;
        
        SignalInfo signalInfo;
        signalInfo.name = net->VpiName();
        signalInfo.fullName = scope + "." + signalInfo.name;
        signalInfo.parentModuleId = moduleId;
        
        // 类型
        std::string type = net->VpiNetType();
        signalInfo.type = convertSignalType(type);
        
        // 位宽
        extractBitWidth(net.get(), signalInfo.msb, signalInfo.lsb, signalInfo.isVector);
        
        // 位置
        signalInfo.declaration = extractLocation(net.get());
        
        // 添加信号
        uint64_t signalId = builder.addSignal(signalInfo);
        totalSignals_++;
    }
    
    // 处理参数
    for (const auto& param : uhdmModule->Parameters()) {
        if (!param) continue;
        
        SignalInfo signalInfo;
        signalInfo.name = param->VpiName();
        signalInfo.fullName = scope + "." + signalInfo.name;
        signalInfo.type = SignalType::PARAMETER;
        signalInfo.parentModuleId = moduleId;
        
        // 位置
        signalInfo.declaration = extractLocation(param.get());
        
        builder.addSignal(signalInfo);
        totalSignals_++;
    }
}

void SurelogParser::processInstances(UHDM::module* uhdmModule, uint64_t parentModuleId,
                                    KdbBuilder& builder, const std::string& scope) {
    if (!uhdmModule) return;
    
    // 遍历模块实例
    for (const auto& inst : uhdmModule->Instances()) {
        if (!inst) continue;
        
        ModuleInstanceInfo instanceInfo;
        instanceInfo.name = inst->VpiName();
        instanceInfo.parentModuleId = parentModuleId;
        
        // 位置
        instanceInfo.declaration = extractLocation(inst.get());
        
        // 获取实例化的模块定义
        UHDM::module* instModule = inst->Module();
        if (instModule) {
            std::string instScope = scope + "." + instanceInfo.name;
            
            // 递归处理子模块
            processModule(instModule, builder, parentModuleId, instScope);
            totalInstances_++;
        }
    }
}

SignalType SurelogParser::convertSignalType(const std::string& uhdmType) {
    if (uhdmType == "wire") return SignalType::WIRE;
    if (uhdmType == "reg") return SignalType::REG;
    if (uhdmType == "logic") return SignalType::LOGIC;
    if (uhdmType == "bit") return SignalType::BIT;
    if (uhdmType == "integer") return SignalType::INTEGER;
    if (uhdmType == "real") return SignalType::REAL;
    if (uhdmType == "time") return SignalType::INTEGER;
    return SignalType::UNKNOWN;
}

PortDirection SurelogParser::convertPortDirection(const std::string& uhdmDirection) {
    if (uhdmDirection == "input") return PortDirection::INPUT;
    if (uhdmDirection == "output") return PortDirection::OUTPUT;
    if (uhdmDirection == "inout") return PortDirection::INOUT;
    return PortDirection::UNKNOWN;
}

SourceLocation SurelogParser::extractLocation(UHDM::any* uhdmObject) {
    SourceLocation loc;
    loc.fileId = 0;
    loc.line = 0;
    loc.columnStart = 0;
    loc.columnEnd = 0;
    
    if (!uhdmObject) return loc;
    
    // 获取文件名和行号
    std::string filePath = uhdmObject->VpiFile();
    if (!filePath.empty()) {
        auto it = filePathToId_.find(filePath);
        if (it != filePathToId_.end()) {
            loc.fileId = it->second;
        }
    }
    
    loc.line = uhdmObject->VpiLineNo();
    loc.columnStart = uhdmObject->VpiColumnNo();
    loc.columnEnd = loc.columnStart + uhdmObject->VpiEndLineNo();
    
    return loc;
}

void SurelogParser::extractBitWidth(UHDM::any* uhdmObject, uint32_t& msb, 
                                    uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
    
    if (!uhdmObject) return;
    
    // 尝试获取向量信息
    UHDM::vector_* vec = uhdmObject->VpiVector();
    if (vec) {
        isVector = true;
        // UHDM中的位宽表示可能需要根据具体对象类型解析
    }
}

} // namespace interpreter
} // namespace hwda
