#include "kdb_build_listener.h"
#include "bit_width_extractor.h"
#include "driver_analyzer.h"

#include <Surelog/API/Surelog.h>
#include <uhdm/VpiListener.h>
#include <uhdm/uhdm.h>
#include <uhdm/vpi_user.h>

#include <iostream>
#include <fstream>
#include <sstream>

namespace hwda {
namespace interpreter {

KdbBuildListener::KdbBuildListener(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId)
    : builder_(builder), filePathToId_(filePathToId), totalModules_(0), totalSignals_(0), nextPortId_(1), 
      driverAnalyzer_(new DriverAnalyzer(builder, filePathToId)) {}

KdbBuildListener::~KdbBuildListener() {
    delete driverAnalyzer_;
}

void KdbBuildListener::enterModule_inst(const UHDM::module_inst* object, vpiHandle handle) {
    if (!object) return;
    
    std::string instName(object->VpiName());
    std::string defName(object->VpiDefName());
    std::string fullName(object->VpiFullName());
    int32_t objType = object->VpiType();
    
    std::cerr << "DEBUG: enterModule_inst - instName='" << instName 
              << "', defName='" << defName 
              << "', fullName='" << fullName 
              << "', vpiType=" << objType << "\n";
    std::cerr << "DEBUG:   currentModuleStack_ size=" << currentModuleStack_.size() << "\n";
    
    driverAnalyzer_->clear();
    currentModuleSignalMap_.clear();
    currentModuleInstances_.clear();
    
    ModuleInfo moduleInfo;
    // Note: id removed, use array index + 1 as implicit ID
    moduleInfo.parentModuleId = 0;
    // Instance: name = VpiName() (e.g., "u_dut")
    // Definition: name = VpiDefName() (e.g., "work@dut")
    moduleInfo.name = instName.empty() ? defName : instName;
    // Determine if this is an instance: instance has non-empty VpiName()
    moduleInfo.isInstance = !instName.empty();
    moduleInfo.defModuleId = 0;  // Will be set in linkInstancesToDefinitions()

    // First, ensure the file is in the mapping before extracting location
    std::string filePath(object->VpiFile());
    uint32_t fileId = 0;
    if (!filePath.empty()) {
        auto it = filePathToId_.find(filePath);
        if (it == filePathToId_.end()) {
            std::ifstream fileStream(filePath);
            std::string content;
            if (fileStream) {
                std::stringstream buffer;
                buffer << fileStream.rdbuf();
                content = buffer.str();
            }
            fileId = builder_.addSourceFile(filePath, content);
            filePathToId_[filePath] = fileId;
        } else {
            fileId = it->second;
        }
    }

    // Now extract module location (fileId will be found in the mapping)
    moduleInfo.definition = extractModuleLocation(object, moduleInfo.isInstance);
    // Set definition fileId from the file mapping
    moduleInfo.definition.fileId = fileId;
    
    // Collect port signals first
    std::vector<SignalInfo> portSignals;
    auto ports = object->Ports();
    if (ports) {
        for (auto* port : *ports) {
            if (!port) continue;
            SignalInfo signalInfo;
            signalInfo.id = 0;  // Initialize id to 0 (will be assigned later)
            signalInfo.name = std::string(port->VpiName());
            signalInfo.fullName = fullName + "." + signalInfo.name;
            signalInfo.type = SignalType::WIRE;
            signalInfo.direction = convertPortDirection(port->VpiDirection());
            signalInfo.parentModuleId = 0;
            signalInfo.declaration = extractLocation(port);

            bool isVector = false;
            // Try to get bit width from the port's typespec with module context
            if (auto* portBase = port->Cast<UHDM::BaseClass>()) {
                // Cast module_inst to BaseClass for context
                UHDM::BaseClass* moduleContext = const_cast<UHDM::module_inst*>(object);
                extractBitWidthFromUhdmObject(portBase, signalInfo.msb, signalInfo.lsb, isVector, moduleContext, nullptr);
            }

            portSignals.push_back(signalInfo);
            moduleInfo.addSignal(signalInfo);
            currentModuleSignalMap_[signalInfo.fullName] = 0;
            driverAnalyzer_->getSignalMap()[signalInfo.fullName] = 0;
        }
    }

    std::string parentFullName;
    size_t lastDot = fullName.rfind('.');
    if (lastDot != std::string::npos) {
        parentFullName = fullName.substr(0, lastDot);
        const ModuleInfo* parentModule = builder_.findModuleByName(parentFullName);
        if (parentModule) {
            // Use getModuleId to get ID from pointer
            moduleInfo.parentModuleId = builder_.getModuleId(parentModule);
        }
    }

    std::cerr << "DEBUG:   parentModuleId=" << moduleInfo.parentModuleId << "\n";

    bool moduleExists = builder_.hasModule(fullName);
    std::cerr << "DEBUG:   moduleExists=" << (moduleExists ? "true" : "false") << "\n";

    if (moduleExists) {
        // Push false to indicate we didn't push to currentModuleStack_
        moduleStackMarkers_.push_back(false);
        return;
    }

    // Push true to indicate we will push to currentModuleStack_
    moduleStackMarkers_.push_back(true);

    uint32_t moduleId = builder_.addModule(moduleInfo, fullName);
    std::cerr << "DEBUG:   Added module with id=" << moduleId << ", isInstance=" << (moduleInfo.isInstance ? "true" : "false") << "\n";
    currentModuleStack_.push_back(moduleId);
    totalModules_++;
    std::cerr << "DEBUG:   After push, currentModuleStack_ size=" << currentModuleStack_.size() << "\n";
    
    // Store instance info for post-processing
    if (moduleInfo.isInstance && !defName.empty()) {
        instanceDefNames_.push_back({defName, moduleId});
    }
    
    // Register signals from moduleInfo to builder's signalFullNameToId_ map
    // This ensures findSignalByName can find ports when checking for duplicate nets
    uint32_t localIdx = 0;
    for (const auto& inst : moduleInfo.signalInsts) {
        uint64_t tempId = (static_cast<uint64_t>(moduleId) << 32) | localIdx;
        builder_.registerSignalFullName(inst.fullName, tempId);
        currentModuleSignalMap_[inst.fullName] = 0;  // Placeholder, not used
        driverAnalyzer_->getSignalMap()[inst.fullName] = 0;  // Placeholder, not used
        localIdx++;
    }

    auto nets = object->Nets();
    if (nets) {
        for (auto* net : *nets) {
            if (!net) continue;
            std::string netName = std::string(net->VpiName());
            std::string netFullName = fullName + "." + netName;

            // Check if signal already exists in builder (added via ports)
            if (builder_.findSignalByName(netFullName)) {
                continue;
            }
            
            SignalInfo signalInfo;
            signalInfo.name = netName;
            signalInfo.fullName = netFullName;
            signalInfo.type = convertSignalType(net->VpiNetType());
            signalInfo.direction = PortDirection::UNKNOWN;
            signalInfo.parentModuleId = moduleId;
            signalInfo.declaration = extractLocation(net);
            
            // Extract bit width from net
            bool isVector = false;
            extractBitWidthFromUhdmObject(net, signalInfo.msb, signalInfo.lsb, isVector);
            
            builder_.addSignal(moduleId, signalInfo);
            totalSignals_++;
            
            // Note: Signal IDs are no longer used, store placeholder for compatibility
            currentModuleSignalMap_[signalInfo.fullName] = 0;
            driverAnalyzer_->getSignalMap()[signalInfo.fullName] = 0;
        }
    }
    
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
            builder_.addSignal(moduleId, signalInfo);
            totalSignals_++;
            
            // Note: Signal IDs are no longer used, store placeholder for compatibility
            currentModuleSignalMap_[signalInfo.fullName] = 0;
            driverAnalyzer_->getSignalMap()[signalInfo.fullName] = 0;
        }
    }
    
    auto modules = object->Modules();
    if (modules) {
        for (auto* mod : *modules) {
            if (!mod) continue;
            std::string instName = std::string(mod->VpiName());
            std::string instFullName = std::string(mod->VpiFullName());
            if (!instName.empty()) {
                currentModuleInstances_.push_back({instFullName, 0});
            }
        }
    }
    
    driverAnalyzer_->analyzeContinuousAssignments(object);
    driverAnalyzer_->analyzeProceduralAssignments(object);
    driverAnalyzer_->analyzePortConnections(object);
}

void KdbBuildListener::leaveModule_inst(const UHDM::module_inst* object, vpiHandle handle) {
    if (!moduleStackMarkers_.empty()) {
        bool shouldPop = moduleStackMarkers_.back();
        moduleStackMarkers_.pop_back();
        if (shouldPop && !currentModuleStack_.empty()) {
            driverAnalyzer_->applyDriverRelationships();
            currentModuleStack_.pop_back();
        }
    }
}

KdbSourceLocation KdbBuildListener::extractLocation(const UHDM::BaseClass* obj) {
    KdbSourceLocation loc;
    loc.fileId = 0;
    loc.line = 0;
    
    if (!obj) return loc;
    
    std::string filePath(obj->VpiFile());
    if (!filePath.empty()) {
        auto it = filePathToId_.find(filePath);
        if (it != filePathToId_.end()) {
            loc.fileId = it->second;
        }
    }
    
    loc.line = obj->VpiLineNo();
    
    return loc;
}

KdbModuleSourceLocation KdbBuildListener::extractModuleLocation(const UHDM::module_inst* obj, bool isInstance) {
    KdbModuleSourceLocation loc;
    loc.fileId = 0;
    loc.startLine = 0;
    loc.endLine = 0;
    
    if (!obj) return loc;
    
    // Get file location using VpiFile
    std::string filePath(obj->VpiFile());
    if (!filePath.empty()) {
        auto it = filePathToId_.find(filePath);
        if (it != filePathToId_.end()) {
            loc.fileId = it->second;
        }
    }
    loc.startLine = obj->VpiLineNo();
    
    // Scan for endmodule
    if (loc.fileId != 0 && loc.startLine > 0) {
        const auto* fileInfo = builder_.findFileById(loc.fileId);
        const auto* fileContent = builder_.findFileContentById(loc.fileId);
        if (fileInfo && fileContent && !fileContent->data.empty()) {
            std::string contentStr(fileContent->data.begin(), fileContent->data.end());
            loc.endLine = findEndmoduleLine(contentStr, loc.startLine);
        } else {
            loc.endLine = loc.startLine;
        }
    } else {
        loc.endLine = loc.startLine;
    }
    
    return loc;
}

uint32_t KdbBuildListener::findEndmoduleLine(const std::string& content, uint32_t startLine) {
    std::istringstream stream(content);
    std::string line;
    uint32_t currentLine = 0;
    uint32_t lastNonEmptyLine = startLine;
    int braceDepth = 0;
    bool foundModule = false;
    
    while (std::getline(stream, line)) {
        currentLine++;
        
        // Skip lines before start line
        if (currentLine < startLine) continue;
        
        // Mark that we've reached the module line
        if (currentLine == startLine) {
            foundModule = true;
        }
        
        // Only process after finding the module keyword line
        if (!foundModule) continue;
        
        // Track brace depth to handle nested structures
        for (char c : line) {
            if (c == '(' || c == '[' || c == '{') braceDepth++;
            else if (c == ')' || c == ']' || c == '}') braceDepth--;
        }
        
        // Check for endmodule keyword (only at brace depth 0 to avoid matching in strings/comments)
        if (braceDepth == 0) {
            // Remove comments for checking
            std::string checkLine = line;
            size_t commentPos = checkLine.find("//");
            if (commentPos != std::string::npos) {
                checkLine = checkLine.substr(0, commentPos);
            }
            
            // Check for endmodule - must be at the start of line (after whitespace)
            size_t pos = checkLine.find("endmodule");
            if (pos != std::string::npos) {
                // Verify it's not part of another word by checking preceding character
                if (pos == 0 || std::isspace(checkLine[pos - 1])) {
                    return currentLine;
                }
            }
        }
        
        // Track last non-empty line as fallback
        if (!line.empty() && line.find_first_not_of(" \t\r\n") != std::string::npos) {
            lastNonEmptyLine = currentLine;
        }
    }
    
    // If endmodule not found, return the last non-empty line of the file
    return lastNonEmptyLine;
}

SignalType KdbBuildListener::convertSignalType(int32_t uhdmNetType) {
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

PortDirection KdbBuildListener::convertPortDirection(int direction) {
    switch (direction) {
        case vpiInput: return PortDirection::INPUT;
        case vpiOutput: return PortDirection::OUTPUT;
        case vpiInout: return PortDirection::INOUT;
        default: return PortDirection::UNKNOWN;
    }
}

void KdbBuildListener::linkInstancesToDefinitions() {
    std::cerr << "DEBUG: Linking instances to definitions, count=" << instanceDefNames_.size() << "\n";
    
    for (const auto& [defName, instanceId] : instanceDefNames_) {
        // defName may or may not have "work@" prefix, handle both cases
        std::string defFullName;
        if (defName.find("work@") == 0) {
            // defName already has work@ prefix
            defFullName = defName;
        } else {
            // Add work@ prefix
            defFullName = "work@" + defName;
        }
        
        // Find definition module
        const ModuleInfo* defModule = builder_.findModuleByName(defFullName);
        if (defModule) {
            // Update instance's defModuleId
            ModuleInfo* instanceModule = const_cast<ModuleInfo*>(builder_.findModuleById(instanceId));
            if (instanceModule) {
                // Use getModuleId to get ID from pointer
                instanceModule->defModuleId = builder_.getModuleId(defModule);
                std::cerr << "DEBUG: Linked instance id=" << instanceId
                          << " -> definition id=" << builder_.getModuleId(defModule)
                          << " (" << defFullName << ")\n";
                // Note: Signal ID sync is now done in addModule
            }
        } else {
            std::cerr << "DEBUG: Definition module not found: " << defFullName
                      << " for instance id=" << instanceId << "\n";
        }
    }
}

void KdbBuildListener::finishBuild() {
    std::cerr << "DEBUG: Finishing build, committing signal instances...\n";
    
    // 1. Apply any remaining driver relationships
    driverAnalyzer_->applyDriverRelationships();
    
    // 2. Link instances to definitions (if not already done)
    linkInstancesToDefinitions();
    
    // 3. Commit all signal instances to global array
    builder_.commitSignalInsts();
    
    std::cerr << "DEBUG: Build finished, signal instances committed.\n";
}

}
}
