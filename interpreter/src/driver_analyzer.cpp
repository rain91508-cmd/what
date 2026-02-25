#include "driver_analyzer.h"

#include <uhdm/uhdm.h>
#include <uhdm/vpi_user.h>

namespace hwda {
namespace interpreter {

DriverAnalyzer::DriverAnalyzer(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId)
    : builder_(builder), filePathToId_(filePathToId) {}

void DriverAnalyzer::analyzeContinuousAssignments(const UHDM::module_inst* module) {
    if (!module) return;
    
    auto contAssigns = module->Cont_assigns();
    if (!contAssigns) return;
    
    for (auto* contAssign : *contAssigns) {
        if (!contAssign) continue;
        
        auto* lhs = contAssign->Lhs();
        auto* rhs = contAssign->Rhs();
        if (!lhs || !rhs) continue;
        
        std::string lhsName;
        if (auto* refObj = lhs->Cast<UHDM::ref_obj>()) {
            lhsName = std::string(refObj->VpiFullName());
        }
        
        if (lhsName.empty()) continue;
        
        extractRhsSignals(rhs, lhsName, contAssign);
    }
}

void DriverAnalyzer::extractRhsSignals(const UHDM::expr* expr, const std::string& lhsSignalName, 
                                        const UHDM::BaseClass* assignObj) {
    if (!expr) return;
    
    if (auto* refObj = expr->Cast<UHDM::ref_obj>()) {
        std::string rhsName = std::string(refObj->VpiFullName());
        if (!rhsName.empty()) {
            signalToDriverNames_[lhsSignalName].push_back({rhsName, extractLocation(assignObj)});
        }
    }
    
    if (auto* op = expr->Cast<UHDM::operation>()) {
        auto* operands = op->Operands();
        if (operands) {
            for (auto* operand : *operands) {
                if (auto* operandExpr = operand->Cast<UHDM::expr>()) {
                    extractRhsSignals(operandExpr, lhsSignalName, assignObj);
                }
            }
        }
    }
}

void DriverAnalyzer::applyDriverRelationships() {
    for (auto& [drivenSignalName, driverInfos] : signalToDriverNames_) {
        const SignalInfo* drivenSignal = builder_.findSignalByName(drivenSignalName);
        if (!drivenSignal) continue;
        
        for (auto& [driverSignalName, driverLocation] : driverInfos) {
            auto it = currentModuleSignalMap_.find(driverSignalName);
            if (it != currentModuleSignalMap_.end() && it->second != 0) {
                uint64_t driverSignalId = it->second;
                
                SignalInfo* signal = const_cast<SignalInfo*>(drivenSignal);
                signal->driverSignalIds.push_back(driverSignalId);
                signal->driverLines.push_back(driverLocation);
            }
        }
    }
    
    signalToDriverNames_.clear();
}

void DriverAnalyzer::clear() {
    currentModuleSignalMap_.clear();
    signalToDriverNames_.clear();
}

KdbSourceLocation DriverAnalyzer::extractLocation(const UHDM::BaseClass* obj) {
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

}
}
