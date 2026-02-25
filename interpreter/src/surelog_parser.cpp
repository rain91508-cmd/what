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
#include <unordered_set>

namespace hwda {
namespace interpreter {

// Forward declaration of helper function for bit width extraction
static void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                          uint32_t& lsb, bool& isVector);

// VpiListener to build KDB
class KdbBuildListener : public UHDM::VpiListener {
public:
    KdbBuildListener(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId)
        : builder_(builder), filePathToId_(filePathToId), totalModules_(0), totalSignals_(0), nextPortId_(1) {}
    
    void enterModule_inst(const UHDM::module_inst* object, vpiHandle handle) override {
        if (!object) return;
        
        std::string instName(object->VpiName());
        std::string defName(object->VpiDefName());
        std::string fullName(object->VpiFullName());
        
        std::cerr << "DEBUG: enterModule_inst - instName='" << instName 
                  << "', defName='" << defName 
                  << "', fullName='" << fullName << "'\n";
        std::cerr << "DEBUG:   currentModuleStack_ size=" << currentModuleStack_.size() << "\n";
        
        ModuleInfo moduleInfo;
        moduleInfo.id = 0;
        moduleInfo.parentModuleId = 0;
        moduleInfo.fileId = 0;
        moduleInfo.name = defName.empty() ? instName : defName;
        moduleInfo.fullName = fullName.empty() ? moduleInfo.name : fullName;
        // Determine if this is a module instance or definition
        // If instName is empty, it's a module definition, otherwise it's an instance
        moduleInfo.isInstance = !instName.empty();
        
        // Extract location
        moduleInfo.declaration = extractLocation(object);
        
        // Get file info
        std::string filePath(object->VpiFile());
        if (!filePath.empty()) {
            auto it = filePathToId_.find(filePath);
            if (it == filePathToId_.end()) {
                // Read file content
                std::ifstream fileStream(filePath);
                std::string content;
                if (fileStream) {
                    std::stringstream buffer;
                    buffer << fileStream.rdbuf();
                    content = buffer.str();
                }
                moduleInfo.fileId = builder_.addSourceFile(filePath, content);
                filePathToId_[filePath] = moduleInfo.fileId;
            } else {
                moduleInfo.fileId = it->second;
            }
        }
        
        // Process ports - convert to signals with direction info
        auto ports = object->Ports();
        if (ports) {
            for (auto* port : *ports) {
                if (!port) continue;
                SignalInfo signalInfo;
                signalInfo.name = std::string(port->VpiName());
                signalInfo.fullName = fullName + "." + signalInfo.name;
                // Set appropriate type based on port direction
                switch (convertPortDirection(port->VpiDirection())) {
                    case PortDirection::INPUT:
                        signalInfo.type = SignalType::INPUT;
                        break;
                    case PortDirection::OUTPUT:
                        signalInfo.type = SignalType::OUTPUT;
                        break;
                    case PortDirection::INOUT:
                        signalInfo.type = SignalType::INOUT;
                        break;
                    default:
                        signalInfo.type = SignalType::WIRE;  // Default type for ports
                        break;
                }
                signalInfo.direction = convertPortDirection(port->VpiDirection());
                signalInfo.parentModuleId = 0;  // Will be set after module is added
                signalInfo.declaration = extractLocation(port);
                
                // Extract bit width from port
                bool isVector = false;
                extractBitWidthFromUhdmObject(port, signalInfo.msb, signalInfo.lsb, isVector);
                
                // Add signal to module
                moduleInfo.signals.push_back(signalInfo);
            }
        }
        
        // Determine parent module ID based on hierarchy in fullName
        // If fullName contains dots, extract parent module name
        std::string parentFullName;
        size_t lastDot = moduleInfo.fullName.rfind('.');
        if (lastDot != std::string::npos) {
            parentFullName = moduleInfo.fullName.substr(0, lastDot);
            // Look up parent module ID in builder
            const ModuleInfo* parentModule = builder_.findModuleByName(parentFullName);
            if (parentModule) {
                moduleInfo.parentModuleId = parentModule->id;
            }
        }
        
        std::cerr << "DEBUG:   parentModuleId=" << moduleInfo.parentModuleId << "\n";
        
        // Check if module already exists
        bool moduleExists = builder_.hasModule(moduleInfo.fullName);
        std::cerr << "DEBUG:   moduleExists=" << (moduleExists ? "true" : "false") << "\n";
        
        // Push a marker to the stack to indicate whether we should process this module
        moduleStackMarkers_.push_back(!moduleExists);
        
        // If module already exists, don't process further
        if (moduleExists) {
            return;
        }
        
        // Add module
        uint64_t moduleId = builder_.addModule(moduleInfo);
        std::cerr << "DEBUG:   Added module with id=" << moduleId << ", isInstance=" << (moduleInfo.isInstance ? "true" : "false") << "\n";
        currentModuleStack_.push_back(moduleId);
        totalModules_++;
        std::cerr << "DEBUG:   After push, currentModuleStack_ size=" << currentModuleStack_.size() << "\n";
        
        // Add module link
        if (moduleInfo.declaration.fileId != 0) {
            SourceLinkInfo link;
            link.line = moduleInfo.declaration.line;
            link.columnStart = moduleInfo.declaration.columnStart;
            link.columnEnd = moduleInfo.declaration.columnEnd;
            link.targetId = moduleId;
            builder_.addSubmodLink(moduleInfo.declaration.fileId, link);
        }
        
        // Add port links - now ports are stored in signals with direction != UNKNOWN
        for (const auto& sig : moduleInfo.signals) {
            if (sig.direction != PortDirection::UNKNOWN && sig.declaration.fileId != 0) {
                SourceLinkInfo link;
                link.line = sig.declaration.line;
                link.columnStart = sig.declaration.columnStart;
                link.columnEnd = sig.declaration.columnEnd;
                link.targetId = sig.id;
                builder_.addPortLink(sig.declaration.fileId, link);
            }
        }
        
        // Process nets/signals - skip if already added as port
        auto nets = object->Nets();
        if (nets) {
            for (auto* net : *nets) {
                if (!net) continue;
                std::string netName = std::string(net->VpiName());
                
                // Check if this signal already exists as a port
                bool alreadyExists = false;
                for (const auto& existingSig : moduleInfo.signals) {
                    if (existingSig.name == netName) {
                        alreadyExists = true;
                        break;
                    }
                }
                
                // Skip if already exists (port takes precedence)
                if (alreadyExists) {
                    continue;
                }
                
                SignalInfo signalInfo;
                signalInfo.name = netName;
                signalInfo.fullName = fullName + "." + signalInfo.name;
                signalInfo.type = convertSignalType(net->VpiNetType());
                signalInfo.direction = PortDirection::UNKNOWN;  // Internal signal has no direction
                signalInfo.parentModuleId = moduleId;
                signalInfo.declaration = extractLocation(net);
                uint64_t signalId = builder_.addSignal(moduleId, signalInfo);
                totalSignals_++;
                
                // Add signal link
                if (signalInfo.declaration.fileId != 0) {
                    SourceLinkInfo link;
                    link.line = signalInfo.declaration.line;
                    link.columnStart = signalInfo.declaration.columnStart;
                    link.columnEnd = signalInfo.declaration.columnEnd;
                    link.targetId = signalId;
                    builder_.addSignalLink(signalInfo.declaration.fileId, link);
                }
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
                uint64_t signalId = builder_.addSignal(moduleId, signalInfo);
                totalSignals_++;
                
                // Add signal link for parameter
                if (signalInfo.declaration.fileId != 0) {
                    SourceLinkInfo link;
                    link.line = signalInfo.declaration.line;
                    link.columnStart = signalInfo.declaration.columnStart;
                    link.columnEnd = signalInfo.declaration.columnEnd;
                    link.targetId = signalId;
                    builder_.addSignalLink(signalInfo.declaration.fileId, link);
                }
            }
        }
    }
    
    void leaveModule_inst(const UHDM::module_inst* object, vpiHandle handle) override {
        if (!moduleStackMarkers_.empty()) {
            bool shouldPop = moduleStackMarkers_.back();
            moduleStackMarkers_.pop_back();
            if (shouldPop && !currentModuleStack_.empty()) {
                currentModuleStack_.pop_back();
            }
        }
    }
    
    size_t getTotalModules() const { return totalModules_; }
    size_t getTotalSignals() const { return totalSignals_; }
    
private:
    KdbBuilder& builder_;
    std::unordered_map<std::string, uint64_t>& filePathToId_;
    std::vector<uint64_t> currentModuleStack_;
    std::vector<bool> moduleStackMarkers_;
    size_t totalModules_;
    size_t totalSignals_;
    uint64_t nextPortId_;
    
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
    loc.columnStart = 0;
    loc.columnEnd = 0;
    return loc;
}

// Helper function to extract bit width from UHDM objects
static void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                          uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
    
    if (!uhdmObject) return;
    
    // For now, we don't extract bit width from UHDM objects
    // as it requires proper vpiHandle which is not directly available
    // from BaseClass pointer. The bit width extraction would need
    // to be done at a different level where vpiHandle is available.
    // Default to scalar (msb=0, lsb=0, isVector=false)
}

void SurelogParser::extractBitWidth(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                    uint32_t& lsb, bool& isVector) {
    extractBitWidthFromUhdmObject(uhdmObject, msb, lsb, isVector);
}

} // namespace interpreter
} // namespace hwda
