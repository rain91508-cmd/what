#include "surelog_parser.h"
#include "kdb_build_listener.h"
#include "bit_width_extractor.h"

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
#include <unordered_set>
#include <unordered_map>

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
        
        // Find all modules and identify top modules
        auto modules = builder.getAllModules();
        
        // If user specified a top module, use it
        if (!topModuleName_.empty()) {
            const ModuleInfo* topModule = builder.findModuleByName(topModuleName_);
            if (topModule) {
                builder.addHierarchy(topModule->id);
            }
        } else {
            // Otherwise, find top modules: modules with no parent (parentModuleId == 0) that are definitions (not instances)
            // This follows the Surelog convention where top level modules are module definitions
            std::unordered_set<std::string> addedTopModules;
            for (const auto* mod : modules) {
                if (mod->parentModuleId == 0 && !mod->isInstance) {
                    if (addedTopModules.find(mod->fullName) == addedTopModules.end()) {
                        addedTopModules.insert(mod->fullName);
                        builder.addHierarchy(mod->id);
                    }
                }
            }
            
            // If no top modules found, fall back to all parentModuleId == 0 (definitions)
            if (builder.getTopModuleIds().empty()) {
                std::unordered_set<std::string> fallbackAddedTopModules;
                for (const auto* mod : modules) {
                    if (mod->parentModuleId == 0 && !mod->isInstance) {
                        if (fallbackAddedTopModules.find(mod->fullName) == fallbackAddedTopModules.end()) {
                            fallbackAddedTopModules.insert(mod->fullName);
                            builder.addHierarchy(mod->id);
                        }
                    }
                }
            }
        }
        
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
    // Note: columnStart and columnEnd removed from KdbSourceLocation
    return loc;
}

void SurelogParser::extractBitWidth(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                    uint32_t& lsb, bool& isVector) {
    extractBitWidthFromUhdmObject(uhdmObject, msb, lsb, isVector);
}

} // namespace interpreter
} // namespace hwda
