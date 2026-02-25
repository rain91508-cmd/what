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
    
    std::cerr << "DEBUG: enterModule_inst - instName='" << instName 
              << "', defName='" << defName 
              << "', fullName='" << fullName << "'\n";
    std::cerr << "DEBUG:   currentModuleStack_ size=" << currentModuleStack_.size() << "\n";
    
    driverAnalyzer_->clear();
    currentModuleSignalMap_.clear();
    currentModuleInstances_.clear();
    
    ModuleInfo moduleInfo;
    moduleInfo.id = 0;
    moduleInfo.parentModuleId = 0;
    moduleInfo.fileId = 0;
    moduleInfo.name = defName.empty() ? instName : defName;
    moduleInfo.fullName = fullName.empty() ? moduleInfo.name : fullName;
    moduleInfo.isInstance = !instName.empty();
    
    moduleInfo.declaration = extractLocation(object);
    
    std::string filePath(object->VpiFile());
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
            moduleInfo.fileId = builder_.addSourceFile(filePath, content);
            filePathToId_[filePath] = moduleInfo.fileId;
        } else {
            moduleInfo.fileId = it->second;
        }
    }
    
    auto ports = object->Ports();
    if (ports) {
        for (auto* port : *ports) {
            if (!port) continue;
            SignalInfo signalInfo;
            signalInfo.name = std::string(port->VpiName());
            signalInfo.fullName = fullName + "." + signalInfo.name;
            signalInfo.type = SignalType::WIRE;
            signalInfo.direction = convertPortDirection(port->VpiDirection());
            signalInfo.parentModuleId = 0;
            signalInfo.declaration = extractLocation(port);
            
            bool isVector = false;
            extractBitWidthFromUhdmObject(port, signalInfo.msb, signalInfo.lsb, isVector);
            
            moduleInfo.signals.push_back(signalInfo);
            currentModuleSignalMap_[signalInfo.fullName] = 0;
            driverAnalyzer_->getSignalMap()[signalInfo.fullName] = 0;
        }
    }
    
    std::string parentFullName;
    size_t lastDot = moduleInfo.fullName.rfind('.');
    if (lastDot != std::string::npos) {
        parentFullName = moduleInfo.fullName.substr(0, lastDot);
        const ModuleInfo* parentModule = builder_.findModuleByName(parentFullName);
        if (parentModule) {
            moduleInfo.parentModuleId = parentModule->id;
        }
    }
    
    std::cerr << "DEBUG:   parentModuleId=" << moduleInfo.parentModuleId << "\n";
    
    bool moduleExists = builder_.hasModule(moduleInfo.fullName);
    std::cerr << "DEBUG:   moduleExists=" << (moduleExists ? "true" : "false") << "\n";
    
    moduleStackMarkers_.push_back(!moduleExists);
    
    if (moduleExists) {
        return;
    }
    
    uint64_t moduleId = builder_.addModule(moduleInfo);
    std::cerr << "DEBUG:   Added module with id=" << moduleId << ", isInstance=" << (moduleInfo.isInstance ? "true" : "false") << "\n";
    currentModuleStack_.push_back(moduleId);
    totalModules_++;
    std::cerr << "DEBUG:   After push, currentModuleStack_ size=" << currentModuleStack_.size() << "\n";
    
    if (moduleInfo.declaration.fileId != 0) {
        SourceLinkInfo link;
        link.line = moduleInfo.declaration.line;
        link.columnStart = 0;
        link.columnEnd = 0;
        link.targetId = moduleId;
        builder_.addSubmodLink(moduleInfo.declaration.fileId, link);
    }
    
    for (const auto& sig : moduleInfo.signals) {
        const SignalInfo* addedSignal = builder_.findSignalByName(sig.fullName);
        if (addedSignal) {
            currentModuleSignalMap_[sig.fullName] = addedSignal->id;
            driverAnalyzer_->getSignalMap()[sig.fullName] = addedSignal->id;
            
            if (sig.direction != PortDirection::UNKNOWN && sig.declaration.fileId != 0) {
                SourceLinkInfo link;
                link.line = sig.declaration.line;
                link.columnStart = 0;
                link.columnEnd = 0;
                link.targetId = addedSignal->id;
                builder_.addSignalLink(sig.declaration.fileId, link);
            }
        }
    }
    
    auto nets = object->Nets();
    if (nets) {
        for (auto* net : *nets) {
            if (!net) continue;
            std::string netName = std::string(net->VpiName());
            
            bool alreadyExists = false;
            for (const auto& existingSig : moduleInfo.signals) {
                if (existingSig.name == netName) {
                    alreadyExists = true;
                    break;
                }
            }
            
            if (alreadyExists) {
                continue;
            }
            
            SignalInfo signalInfo;
            signalInfo.name = netName;
            signalInfo.fullName = fullName + "." + signalInfo.name;
            signalInfo.type = convertSignalType(net->VpiNetType());
            signalInfo.direction = PortDirection::UNKNOWN;
            signalInfo.parentModuleId = moduleId;
            signalInfo.declaration = extractLocation(net);
            uint64_t signalId = builder_.addSignal(moduleId, signalInfo);
            totalSignals_++;
            
            currentModuleSignalMap_[signalInfo.fullName] = signalId;
            driverAnalyzer_->getSignalMap()[signalInfo.fullName] = signalId;
            
            if (signalInfo.declaration.fileId != 0) {
                SourceLinkInfo link;
                link.line = signalInfo.declaration.line;
                link.columnStart = 0;
                link.columnEnd = 0;
                link.targetId = signalId;
                builder_.addSignalLink(signalInfo.declaration.fileId, link);
            }
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
            uint64_t signalId = builder_.addSignal(moduleId, signalInfo);
            totalSignals_++;
            
            currentModuleSignalMap_[signalInfo.fullName] = signalId;
            driverAnalyzer_->getSignalMap()[signalInfo.fullName] = signalId;
            
            if (signalInfo.declaration.fileId != 0) {
                SourceLinkInfo link;
                link.line = signalInfo.declaration.line;
                link.columnStart = 0;
                link.columnEnd = 0;
                link.targetId = signalId;
                builder_.addSignalLink(signalInfo.declaration.fileId, link);
            }
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

}
}
