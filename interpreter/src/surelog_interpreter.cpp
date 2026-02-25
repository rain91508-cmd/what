#include "surelog_interpreter.h"
#include "bit_width_extractor.h"

#include <Surelog/API/Surelog.h>
#include <Surelog/CommandLine/CommandLineParser.h>
#include <Surelog/ErrorReporting/ErrorContainer.h>
#include <Surelog/SourceCompile/SymbolTable.h>

#include <uhdm/uhdm.h>
#include <uhdm/VpiListener.h>
#include <uhdm/vpi_user.h>

#include <iostream>
#include <sstream>

namespace hwda {
namespace interpreter {

SurelogInterpreter::SurelogInterpreter() = default;
SurelogInterpreter::~SurelogInterpreter() = default;

bool SurelogInterpreter::initialize() {
    try {
        symbolTable_ = std::make_unique<SURELOG::SymbolTable>();
        errorContainer_ = std::make_unique<SURELOG::ErrorContainer>(symbolTable_.get());
        clp_ = std::make_unique<SURELOG::CommandLineParser>(
            errorContainer_.get(), symbolTable_.get(), false, config_.fileUnit);
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Failed to initialize Surelog: " << e.what() << std::endl;
        return false;
    }
}

bool SurelogInterpreter::parseCommandLine(int argc, const char** argv) {
    if (!clp_ && !initialize()) {
        return false;
    }
    
    // 使用Surelog的完整命令行解析
    bool success = clp_->parseCommandLine(argc, argv);
    
    // 应用配置
    if (config_.verbose) {
        // Surelog内部处理verbose
    }
    
    if (config_.lowMem) {
        clp_->setLowMem(true);
    }
    
    if (config_.parseOnly) {
        clp_->setParseOnly(true);
    }
    
    if (config_.noElab) {
        clp_->setElaborate(false);
    }
    
    if (config_.nbMaxThreads > 0) {
        clp_->setNbMaxTreads(config_.nbMaxThreads);
    }
    
    if (config_.nbMaxProcesses > 0) {
        clp_->setNbMaxProcesses(config_.nbMaxProcesses);
    }
    
    // 设置顶层模块
    for (const auto& top : config_.topModules) {
        clp_->setTopLevelModule(top);
    }
    
    // 设置黑盒
    for (const auto& bb : config_.blackBoxModules) {
        clp_->setBlackBoxModule(bb);
    }
    
    for (const auto& bb : config_.blackBoxInstances) {
        clp_->setBlackBoxInstance(bb);
    }
    
    // 设置调试选项
    if (config_.debugLevel > 0) {
        // Surelog内部处理debug level
    }
    
    if (config_.debugUhdm) {
        clp_->setDebugUhdm(true);
    }
    
    if (config_.muteStdout) {
        clp_->setMuteStdout();
    }
    
    return success;
}

void SurelogInterpreter::setConfig(const SurelogConfig& config) {
    config_ = config;
}

void SurelogInterpreter::addSourceFile(const std::string& file) {
    if (!clp_ && !initialize()) return;
    // 通过CommandLineParser添加源文件
    // 注意: Surelog的API可能需要使用PathId
}

void SurelogInterpreter::addLibraryPath(const std::string& path) {
    if (!clp_ && !initialize()) return;
}

void SurelogInterpreter::addLibraryFile(const std::string& file) {
    if (!clp_ && !initialize()) return;
}

void SurelogInterpreter::addIncludePath(const std::string& path) {
    if (!clp_ && !initialize()) return;
}

void SurelogInterpreter::addDefine(const std::string& name, const std::string& value) {
    if (!clp_ && !initialize()) return;
}

void SurelogInterpreter::addParameter(const std::string& name, const std::string& value) {
    if (!clp_ && !initialize()) return;
}

void SurelogInterpreter::setTopModule(const std::string& moduleName) {
    if (!clp_ && !initialize()) return;
    clp_->setTopLevelModule(moduleName);
}

bool SurelogInterpreter::compile() {
    if (!clp_ && !initialize()) {
        return false;
    }
    
    try {
        // 创建编译器
        compiler_ = std::make_unique<SURELOG::Compiler>(
            clp_.get(), symbolTable_.get(), errorContainer_.get());
        
        // 执行编译
        bool success = compiler_->compile();
        
        if (!success) {
            std::cerr << "Compilation failed" << std::endl;
            return false;
        }
        
        return true;
        
    } catch (const std::exception& e) {
        std::cerr << "Compile error: " << e.what() << std::endl;
        return false;
    }
}

bool SurelogInterpreter::buildKnowledgeBase(KdbBuilder& builder) {
    if (!compiler_) {
        std::cerr << "Compiler not initialized" << std::endl;
        return false;
    }
    
    try {
        // 获取设计对象
        SURELOG::Design* design = compiler_->getDesign();
        if (!design) {
            std::cerr << "No design loaded" << std::endl;
            return false;
        }
        
        // 获取UHDM设计
        UHDM::Serializer& serializer = compiler_->getSerializer();
        UHDM::design* uhdmDesign = nullptr;
        
        // 遍历所有顶层模块
        for (auto& [modName, modDef] : design->getModuleDefinitions()) {
            if (!modDef) continue;
            
            // 获取UHDM模块
            UHDM::module* uhdmModule = modDef->getUHDMModule(-1);
            if (uhdmModule) {
                processModule(uhdmModule, builder, 0, "");
            }
        }
        
        // 构建索引
        builder.buildIndices();
        
        return true;
        
    } catch (const std::exception& e) {
        std::cerr << "Build KDB error: " << e.what() << std::endl;
        return false;
    }
}

std::string SurelogInterpreter::getErrors() const {
    if (!errorContainer_) return "";
    
    std::stringstream ss;
    errorContainer_->printToStream(ss);
    return ss.str();
}

bool SurelogInterpreter::hasErrors() const {
    if (!errorContainer_) return false;
    return errorContainer_->hasErrors();
}

size_t SurelogInterpreter::getModuleCount() const {
    return totalModules_;
}

size_t SurelogInterpreter::getSignalCount() const {
    return totalSignals_;
}

SURELOG::Compiler* SurelogInterpreter::getCompiler() const {
    return compiler_.get();
}

UHDM::design* SurelogInterpreter::getUhdmDesign() const {
    if (!compiler_) return nullptr;
    
    SURELOG::Design* design = compiler_->getDesign();
    if (!design) return nullptr;
    
    // 返回第一个顶层模块的UHDM设计
    for (auto& [modName, modDef] : design->getModuleDefinitions()) {
        if (modDef) {
            return modDef->getUHDMModule(-1)->GetDesign();
        }
    }
    return nullptr;
}

void SurelogInterpreter::processDesign(UHDM::design* design, KdbBuilder& builder) {
    if (!design) return;
    
    // 处理设计中的所有模块
    auto topModules = design->TopModules();
    if (topModules) {
        for (auto* module : *topModules) {
            if (module) {
                processModule(module, builder, 0, "");
            }
        }
    }
}

void SurelogInterpreter::processModule(UHDM::module* uhdmModule, KdbBuilder& builder,
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
    if (!filePath.empty()) {
        auto it = filePathToId_.find(filePath);
        if (it == filePathToId_.end()) {
            moduleInfo.fileId = builder.addSourceFile(filePath, "", 0);
            filePathToId_[filePath] = moduleInfo.fileId;
        } else {
            moduleInfo.fileId = it->second;
        }
    }
    
    // 处理端口
    processPorts(uhdmModule, moduleInfo, builder);
    
    // 添加模块并获取ID
    uint64_t moduleId = builder.addModule(moduleInfo);
    totalModules_++;
    
    // 处理信号
    processSignals(uhdmModule, moduleId, builder, moduleInfo.fullName);
    
    // 处理实例
    processInstances(uhdmModule, moduleId, builder, moduleInfo.fullName);
}

void SurelogInterpreter::processPorts(UHDM::module* uhdmModule, ModuleInfo& moduleInfo,
                                      KdbBuilder& builder) {
    if (!uhdmModule) return;
    
    // 遍历端口
    for (auto* port : uhdmModule->Ports()) {
        if (!port) continue;
        
        PortInfo portInfo;
        portInfo.name = port->VpiName();
        
        // 端口方向
        std::string dir = port->VpiDirection();
        portInfo.direction = convertPortDirection(dir);
        
        // 类型
        portInfo.type = SignalType::WIRE;
        
        // 位宽
        extractBitWidth(port, portInfo.msb, portInfo.lsb, portInfo.isVector);
        
        // 位置
        portInfo.declaration = extractLocation(port);
        
        moduleInfo.ports.push_back(portInfo);
    }
}

void SurelogInterpreter::processSignals(UHDM::module* uhdmModule, uint64_t moduleId,
                                        KdbBuilder& builder, const std::string& scope) {
    if (!uhdmModule) return;
    
    // 遍历信号
    for (auto* net : uhdmModule->Nets()) {
        if (!net) continue;
        
        SignalInfo signalInfo;
        signalInfo.name = net->VpiName();
        signalInfo.fullName = scope + "." + signalInfo.name;
        signalInfo.parentModuleId = moduleId;
        
        // 类型
        std::string type = net->VpiNetType();
        signalInfo.type = convertSignalType(type);
        
        // 位宽
        extractBitWidth(net, signalInfo.msb, signalInfo.lsb, signalInfo.isVector);
        
        // 位置
        signalInfo.declaration = extractLocation(net);
        
        // 添加信号
        uint64_t signalId = builder.addSignal(signalInfo);
        totalSignals_++;
    }
    
    // 处理参数
    for (auto* param : uhdmModule->Parameters()) {
        if (!param) continue;
        
        SignalInfo signalInfo;
        signalInfo.name = param->VpiName();
        signalInfo.fullName = scope + "." + signalInfo.name;
        signalInfo.type = SignalType::PARAMETER;
        signalInfo.parentModuleId = moduleId;
        
        // 位置
        signalInfo.declaration = extractLocation(param);
        
        builder.addSignal(signalInfo);
        totalSignals_++;
    }
}

void SurelogInterpreter::processInstances(UHDM::module* uhdmModule, uint64_t parentModuleId,
                                          KdbBuilder& builder, const std::string& scope) {
    if (!uhdmModule) return;
    
    // 遍历模块实例
    for (auto* inst : uhdmModule->Instances()) {
        if (!inst) continue;
        
        // 获取实例化的模块
        UHDM::module* instModule = inst->Module();
        if (instModule) {
            std::string instScope = scope + "." + inst->VpiName();
            
            // 递归处理子模块
            processModule(instModule, builder, parentModuleId, instScope);
            totalInstances_++;
        }
    }
}

SignalType SurelogInterpreter::convertSignalType(const std::string& uhdmType) {
    if (uhdmType == "wire") return SignalType::WIRE;
    if (uhdmType == "reg") return SignalType::REG;
    if (uhdmType == "logic") return SignalType::LOGIC;
    if (uhdmType == "bit") return SignalType::BIT;
    if (uhdmType == "integer") return SignalType::INTEGER;
    if (uhdmType == "real") return SignalType::REAL;
    if (uhdmType == "time") return SignalType::INTEGER;
    return SignalType::UNKNOWN;
}

PortDirection SurelogInterpreter::convertPortDirection(const std::string& uhdmDirection) {
    if (uhdmDirection == "input") return PortDirection::INPUT;
    if (uhdmDirection == "output") return PortDirection::OUTPUT;
    if (uhdmDirection == "inout") return PortDirection::INOUT;
    return PortDirection::UNKNOWN;
}

KdbSourceLocation SurelogInterpreter::extractLocation(UHDM::base* uhdmObject) {
    KdbSourceLocation loc;
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

void SurelogInterpreter::extractBitWidth(UHDM::base* uhdmObject, uint32_t& msb, 
                                         uint32_t& lsb, bool& isVector) {
    extractBitWidthFromUhdmObject(uhdmObject, msb, lsb, isVector);
}

} // namespace interpreter
} // namespace hwda
