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
    
    // Build the command line and let Surelog's CommandLineParser derive all
    // option state from the flags. Driving the individual setters *before*
    // parseCommandLine left the compile step without its library work files
    // (slpp_all/lib/work/...), so elaboration failed with
    // "Cannot open file .../lib/work/<file>.v". Passing the same flags a
    // working `surelog` CLI invocation uses avoids that.
    std::vector<std::string> argStrs;
    argStrs.push_back("what_interpreter");
    for (const auto& file : filePaths) {
        argStrs.push_back(file);
    }
    if (parseOnly_) {
        argStrs.push_back("-parse");
    } else {
        argStrs.push_back("-parse");
        argStrs.push_back("-elabuhdm");
    }
    // Never run Surelog's embedded Python listener.
    argStrs.push_back("-nopython");

    if (writeUhdmEnabled_) {
        // Keep the on-disk .uhdm DB for debugging (-uhdm / --keep-uhdm).
        // Surelog writes the .uhdm by default, so we must not disable it.
        // Strip debug / unnecessary elaboration overhead (equivalents of the
        // Surelog CLI flags the user requested):
        //   -nocache  : don't *read* the .sdb cache and triggers cleanCache()
        //               at shutdown, so no heavy compilation cache is left on
        //               disk. (Disabling the *write* with -nowritecache would
        //               also skip writing lib/work and break the design, so we
        //               deliberately keep the write on and just clean it up.)
        //   -nostdout : mute Surelog stdout (trims cached log structures)
        //   -nowarning: filter warning objects cached alongside the sources
        argStrs.push_back("-nocache");
        argStrs.push_back("-nostdout");
        argStrs.push_back("-nowarning");
    } else {
        // Default flow: we traverse the in-memory UHDM model directly and do
        // not need the on-disk .uhdm DB; we only walk the final in-memory UHDM.
        argStrs.push_back("-nouhdm");
    }

    // Multiprocessing is REQUIRED for BOTH flows on this Surelog build.
    // Single-process parsing crashes inside ParseCache::save -> cacheVObjects
    // (confirmed by segfaulting: the original setter-based code, a fresh
    // single-process run, and with/without TCMALLOC). The only safe path is to
    // let Surelog fork THIS binary with -batch to do preprocess/parse in a
    // child; what_interpreter handles -batch (see main.cpp) so the child runs
    // its phase and exits instead of forking recursively (no fork bomb).
    // -lowmem turns multiprocessing on (mp = 1); fall back to -mp 1 otherwise.
    // (We cannot honour the "single-process when UHDM is not needed" wish
    // because in-process parsing is broken on this build.)
    if (lowMemEnabled_) {
        argStrs.push_back("-lowmem");
    } else if (maxThreads_ > 0) {
        argStrs.push_back("-mt");
        argStrs.push_back(std::to_string(maxThreads_));
        argStrs.push_back("-mp");
        argStrs.push_back("1");
    } else {
        argStrs.push_back("-mp");
        argStrs.push_back("1");
    }

    if (verbose_) {
        argStrs.push_back("-verbose");
    }
    if (debug_) {
        argStrs.push_back("-debug");
    }

    std::vector<const char*> argv;
    for (const auto& a : argStrs) {
        argv.push_back(a.c_str());
    }

    // Create Surelog objects
    symbolTable_ = std::make_unique<SURELOG::SymbolTable>();
    errorContainer_ = std::make_unique<SURELOG::ErrorContainer>(symbolTable_.get());
    clp_ = std::make_unique<SURELOG::CommandLineParser>(
        errorContainer_.get(), symbolTable_.get(), false, false);

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
        listener.setDriverTracingEnabled(driverTracingEnabled_);
        listener.listenDesigns({static_cast<vpiHandle>(vpiDesign_)});
        
        // Post-processing: link instances and commit signal instances
        listener.finishBuild();
        
        totalModules_ = listener.getTotalModules();
        totalSignals_ = listener.getTotalSignals();
        
        // Find all modules and identify top modules
        auto modules = builder.getAllModules();
        
        // If user specified a top module, use it
        if (!topModuleName_.empty()) {
            const ModuleInfo* topModule = builder.findModuleByName(topModuleName_);
            if (topModule) {
                // Use getModuleId to get ID from pointer
                builder.addHierarchy(builder.getModuleId(topModule));
            }
        } else {
            // Otherwise, find top modules: modules with no parent (parentModuleId == 0) that are definitions (not instances)
            // This follows the Surelog convention where top level modules are module definitions
            std::unordered_set<std::string> addedTopModules;
            for (const auto* mod : modules) {
                if (mod->parentModuleId == 0 && !mod->isInstance) {
                    if (addedTopModules.find(mod->name) == addedTopModules.end()) {
                        addedTopModules.insert(mod->name);
                        // Use getModuleId to get ID from pointer
                        builder.addHierarchy(builder.getModuleId(mod));
                    }
                }
            }

            // If no top modules found, fall back to all parentModuleId == 0 (definitions)
            if (builder.getTopModuleIds().empty()) {
                std::unordered_set<std::string> fallbackAddedTopModules;
                for (const auto* mod : modules) {
                    if (mod->parentModuleId == 0 && !mod->isInstance) {
                        if (fallbackAddedTopModules.find(mod->name) == fallbackAddedTopModules.end()) {
                            fallbackAddedTopModules.insert(mod->name);
                            // Use getModuleId to get ID from pointer
                            builder.addHierarchy(builder.getModuleId(mod));
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
