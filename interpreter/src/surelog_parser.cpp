#include "surelog_parser.h"

#include <Surelog/API/Surelog.h>
#include <Surelog/CommandLine/CommandLineParser.h>
#include <Surelog/ErrorReporting/ErrorContainer.h>
#include <Surelog/SourceCompile/SymbolTable.h>

#include <uhdm/VpiListener.h>
#include <uhdm/uhdm.h>
#include <uhdm/vpi_user.h>

#include <iostream>
#include <fstream>
#include <sstream>

namespace hwda {
namespace interpreter {

// VpiListener to build KDB
class KdbBuildListener : public UHDM::VpiListener {
public:
    KdbBuildListener(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId)
        : builder_(builder), filePathToId_(filePathToId), totalModules_(0), totalSignals_(0) {}
    
    void enterModule_inst(const UHDM::module_inst* object, vpiHandle handle) override {
        if (!object) return;
        
        std::string instName(object->VpiName());
        std::string defName(object->VpiDefName());
        std::string fullName(object->VpiFullName());
        
        ModuleInfo moduleInfo;
        moduleInfo.name = defName.empty() ? instName : defName;
        moduleInfo.fullName = fullName.empty() ? moduleInfo.name : fullName;
        
        // Extract location
        moduleInfo.declaration = extractLocation(object);
        
        // Get file info
        std::string filePath(object->VpiFile());
        if (!filePath.empty()) {
            auto it = filePathToId_.find(filePath);
            if (it == filePathToId_.end()) {
                moduleInfo.fileId = builder_.addSourceFile(filePath, "", 0);
                filePathToId_[filePath] = moduleInfo.fileId;
            } else {
                moduleInfo.fileId = it->second;
            }
        }
        
        // Process ports
        auto ports = object->Ports();
        if (ports) {
            for (auto* port : *ports) {
                if (!port) continue;
                PortInfo portInfo;
                portInfo.name = std::string(port->VpiName());
                portInfo.direction = convertPortDirection(port->VpiDirection());
                portInfo.type = SignalType::WIRE;
                portInfo.declaration = extractLocation(port);
                moduleInfo.ports.push_back(portInfo);
            }
        }
        
        // Add module
        uint64_t moduleId = builder_.addModule(moduleInfo);
        currentModuleStack_.push_back(moduleId);
        totalModules_++;
        
        // Process nets/signals
        auto nets = object->Nets();
        if (nets) {
            for (auto* net : *nets) {
                if (!net) continue;
                SignalInfo signalInfo;
                signalInfo.name = std::string(net->VpiName());
                signalInfo.fullName = fullName + "." + signalInfo.name;
                signalInfo.type = convertSignalType(net->VpiNetType());
                signalInfo.parentModuleId = moduleId;
                signalInfo.declaration = extractLocation(net);
                builder_.addSignal(signalInfo);
                totalSignals_++;
            }
        }
        
        // Process parameters
        auto params = object->Parameters();
        if (params) {
            for (auto* param : *params) {
                if (!param) continue;
                SignalInfo signalInfo;
                signalInfo.name = std::string(param->VpiName());
                signalInfo.fullName = fullName + "." + signalInfo.name;
                signalInfo.type = SignalType::PARAMETER;
                signalInfo.parentModuleId = moduleId;
                signalInfo.declaration = extractLocation(param);
                builder_.addSignal(signalInfo);
                totalSignals_++;
            }
        }
    }
    
    void leaveModule_inst(const UHDM::module_inst* object, vpiHandle handle) override {
        if (!currentModuleStack_.empty()) {
            currentModuleStack_.pop_back();
        }
    }
    
    size_t getTotalModules() const { return totalModules_; }
    size_t getTotalSignals() const { return totalSignals_; }
    
private:
    KdbBuilder& builder_;
    std::unordered_map<std::string, uint64_t>& filePathToId_;
    std::vector<uint64_t> currentModuleStack_;
    size_t totalModules_;
    size_t totalSignals_;
    
    KdbSourceLocation extractLocation(const UHDM::BaseClass* obj) {
        KdbSourceLocation loc;
        loc.fileId = 0;
        loc.line = 0;
        loc.columnStart = 0;
        loc.columnEnd = 0;
        
        if (!obj) return loc;
        
        std::string filePath(obj->VpiFile());
        if (!filePath.empty()) {
            auto it = filePathToId_.find(filePath);
            if (it != filePathToId_.end()) {
                loc.fileId = it->second;
            }
        }
        
        loc.line = obj->VpiLineNo();
        loc.columnStart = obj->VpiColumnNo();
        loc.columnEnd = loc.columnStart;
        
        return loc;
    }
    
    SignalType convertSignalType(int32_t uhdmNetType) {
        // UHDM v1.86 uses vpiNetType enum values
        switch (uhdmNetType) {
            case vpiWire: return SignalType::WIRE;
            case vpiReg: return SignalType::REG;
            case vpiLogicVar: return SignalType::LOGIC;
            case vpiBitVar: return SignalType::BIT;
            case vpiIntVar: return SignalType::INTEGER;
            case vpiRealVar: return SignalType::REAL;
            default: return SignalType::UNKNOWN;
        }
    }
    
    PortDirection convertPortDirection(int direction) {
        switch (direction) {
            case vpiInput: return PortDirection::INPUT;
            case vpiOutput: return PortDirection::OUTPUT;
            case vpiInout: return PortDirection::INOUT;
            default: return PortDirection::UNKNOWN;
        }
    }
};

SurelogParser::SurelogParser()
    : verbose_(false)
    , debug_(false)
    , parseOnly_(false)
    , totalModules_(0)
    , totalSignals_(0)
    , totalInstances_(0) {
}

SurelogParser::~SurelogParser() {
    if (compilerHandle_) {
        SURELOG::shutdown_compiler(static_cast<SURELOG::scompiler*>(compilerHandle_));
    }
}

bool SurelogParser::initialize() {
    return true;
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
    
    // Build command line arguments
    std::vector<const char*> argv;
    argv.push_back("hwda_interpreter");
    
    for (const auto& file : filePaths) {
        argv.push_back(file.c_str());
    }
    
    if (parseOnly_) {
        argv.push_back("-parse");
    } else {
        argv.push_back("-parse");
        argv.push_back("-elabuhdm");
    }
    
    if (verbose_) {
        argv.push_back("-verbose");
    }
    
    if (debug_) {
        argv.push_back("-debug");
    }
    
    // Create Surelog objects
    symbolTable_ = std::make_unique<SURELOG::SymbolTable>();
    errorContainer_ = std::make_unique<SURELOG::ErrorContainer>(symbolTable_.get());
    clp_ = std::make_unique<SURELOG::CommandLineParser>(
        errorContainer_.get(), symbolTable_.get(), false, false);
    
    clp_->noPython();
    clp_->setParse(true);
    clp_->setCompile(true);
    clp_->setElaborate(true);
    clp_->setElabUhdm(true);
    
    bool success = clp_->parseCommandLine(argv.size(), argv.data());
    errorContainer_->printMessages(clp_->muteStdout());
    
    if (!success || clp_->help()) {
        result.errorMessage = "Failed to parse command line";
        return result;
    }
    
    // Start compiler
    compilerHandle_ = SURELOG::start_compiler(clp_.get());
    vpiDesign_ = SURELOG::get_uhdm_design(static_cast<SURELOG::scompiler*>(compilerHandle_));
    
    if (!vpiDesign_) {
        result.errorMessage = "Failed to get UHDM design";
        return result;
    }
    
    result.success = true;
    result.parsedFiles = filePaths;
    
    return result;
}

bool SurelogParser::buildKnowledgeBase(KdbBuilder& builder) {
    if (!vpiDesign_) {
        lastError_ = "No design loaded";
        return false;
    }
    
    try {
        // Create listener to traverse design
        KdbBuildListener listener(builder, filePathToId_);
        listener.listenDesigns({static_cast<vpiHandle>(vpiDesign_)});
        
        totalModules_ = listener.getTotalModules();
        totalSignals_ = listener.getTotalSignals();
        
        // Build indices
        builder.buildIndices();
        
        return true;
        
    } catch (const std::exception& e) {
        lastError_ = std::string("Build KDB error: ") + e.what();
        return false;
    }
}

UHDM::design* SurelogParser::getDesign() const {
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
}

void SurelogParser::processModule(UHDM::module* uhdmModule, KdbBuilder& builder,
                                 uint64_t parentModuleId, const std::string& scope) {
}

void SurelogParser::processPorts(UHDM::module* uhdmModule, ModuleInfo& moduleInfo,
                                KdbBuilder& builder) {
}

void SurelogParser::processSignals(UHDM::module* uhdmModule, uint64_t moduleId,
                                   KdbBuilder& builder, const std::string& scope) {
}

void SurelogParser::processInstances(UHDM::module* uhdmModule, uint64_t parentModuleId,
                                    KdbBuilder& builder, const std::string& scope) {
}

SignalType SurelogParser::convertSignalType(int32_t uhdmNetType) {
    switch (uhdmNetType) {
        case vpiWire: return SignalType::WIRE;
        case vpiReg: return SignalType::REG;
        case vpiLogicVar: return SignalType::LOGIC;
        case vpiBitVar: return SignalType::BIT;
        case vpiIntVar: return SignalType::INTEGER;
        case vpiRealVar: return SignalType::REAL;
        default: return SignalType::UNKNOWN;
    }
}

PortDirection SurelogParser::convertPortDirection(int direction) {
    switch (direction) {
        case vpiInput: return PortDirection::INPUT;
        case vpiOutput: return PortDirection::OUTPUT;
        case vpiInout: return PortDirection::INOUT;
        default: return PortDirection::UNKNOWN;
    }
}

KdbSourceLocation SurelogParser::extractLocation(UHDM::BaseClass* uhdmObject) {
    KdbSourceLocation loc;
    loc.fileId = 0;
    loc.line = 0;
    loc.columnStart = 0;
    loc.columnEnd = 0;
    return loc;
}

void SurelogParser::extractBitWidth(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                    uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
}

} // namespace interpreter
} // namespace hwda
