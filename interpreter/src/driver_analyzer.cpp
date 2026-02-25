#include "driver_analyzer.h"

#include <uhdm/uhdm.h>
#include <uhdm/vpi_user.h>

#include <iostream>

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
        
        // Always record driver line for continuous assignment
        signalDriverLines_[lhsName].push_back(extractLocation(contAssign));
        
        extractRhsSignals(rhs, lhsName, contAssign);
    }
}

void DriverAnalyzer::analyzeProceduralAssignments(const UHDM::module_inst* module) {
    if (!module) return;
    
    std::string moduleName(module->VpiFullName());
    std::cerr << "DEBUG: analyzeProceduralAssignments for module: " << moduleName << "\n";
    
    // Process all processes (always/initial blocks)
    // Note: UHDM uses Process() not Processes()
    auto* process = module->Process();
    if (process) {
        std::cerr << "DEBUG: Found " << process->size() << " processes\n";
        // Process is a VectorOfprocess_stmt
        for (auto* p : *process) {
            if (!p) continue;
            std::cerr << "DEBUG: Processing process, type=" << p->VpiType() << "\n";
            processProcessStmt(p);
        }
    } else {
        std::cerr << "DEBUG: No processes found\n";
    }
}

void DriverAnalyzer::processProcessStmt(const UHDM::process_stmt* process) {
    if (!process) return;
    
    // Get the statement body of the process
    auto* stmt = process->Stmt();
    if (!stmt) {
        std::cerr << "DEBUG: Process has no stmt\n";
        return;
    }
    
    std::cerr << "DEBUG: Process stmt type=" << stmt->VpiType() << "\n";
    
    // Recursively process any statement type
    processStmt(stmt);
}

void DriverAnalyzer::processStmt(const UHDM::BaseClass* stmt) {
    if (!stmt) return;
    
    std::cerr << "DEBUG: processStmt type=" << stmt->VpiType() << "\n";
    
    // Process begin block
    if (auto* beginBlock = stmt->Cast<UHDM::begin>()) {
        std::cerr << "DEBUG: Found begin block\n";
        auto stmts = beginBlock->Stmts();
        if (stmts) {
            std::cerr << "DEBUG: Begin block has " << stmts->size() << " statements\n";
            for (auto* s : *stmts) {
                processStmt(s);
            }
        }
    }
    // Process if statement
    else if (auto* ifStmt = stmt->Cast<UHDM::if_stmt>()) {
        std::cerr << "DEBUG: Found if statement\n";
        // Process then statement
        auto* thenStmt = ifStmt->VpiStmt();
        if (thenStmt) {
            std::cerr << "DEBUG: Processing then branch\n";
            processStmt(thenStmt);
        }
        
        // Note: UHDM if_stmt may not have VpiElseStmt, skip else processing for now
    }
    // Process if-else statement
    else if (auto* ifElseStmt = stmt->Cast<UHDM::if_else>()) {
        std::cerr << "DEBUG: Found if-else statement\n";
        // Process then statement
        auto* thenStmt = ifElseStmt->VpiStmt();
        if (thenStmt) {
            std::cerr << "DEBUG: Processing then branch\n";
            processStmt(thenStmt);
        }
        // Process else statement
        auto* elseStmt = ifElseStmt->VpiElseStmt();
        if (elseStmt) {
            std::cerr << "DEBUG: Processing else branch\n";
            processStmt(elseStmt);
        }
    }
    // Process assignment
    else if (auto* assign = stmt->Cast<UHDM::assignment>()) {
        std::cerr << "DEBUG: Found assignment\n";
        processAssignment(assign);
    }
    // Process event control (like @(posedge clk))
    else if (auto* eventCtrl = stmt->Cast<UHDM::event_control>()) {
        std::cerr << "DEBUG: Found event_control, processing stmt\n";
        auto* eventStmt = eventCtrl->Stmt();
        if (eventStmt) {
            processStmt(eventStmt);
        }
    }
}

void DriverAnalyzer::processAssignment(const UHDM::assignment* assign) {
    if (!assign) return;
    
    auto* lhs = assign->Lhs();
    auto* rhs = assign->Rhs();
    if (!lhs) return;
    
    std::string lhsName;
    if (auto* refObj = lhs->Cast<UHDM::ref_obj>()) {
        lhsName = std::string(refObj->VpiFullName());
    }
    
    if (lhsName.empty()) {
        std::cerr << "DEBUG: Assignment has empty LHS name\n";
        return;
    }
    
    std::cerr << "DEBUG: Processing assignment to " << lhsName << " at line " << assign->VpiLineNo() << "\n";
    
    // Always record driver line for this assignment
    signalDriverLines_[lhsName].push_back(extractLocation(assign));
    
    // If RHS exists, extract signals from it
    if (rhs) {
        // Cast rhs to expr for extractRhsSignals
        if (auto* rhsExpr = rhs->Cast<UHDM::expr>()) {
            extractRhsSignals(rhsExpr, lhsName, assign);
        }
    } else {
        std::cerr << "DEBUG: Assignment has no RHS (constant assignment)\n";
    }
}

void DriverAnalyzer::extractRhsSignals(const UHDM::expr* expr, const std::string& lhsSignalName, 
                                        const UHDM::BaseClass* assignObj) {
    if (!expr) return;
    
    if (auto* refObj = expr->Cast<UHDM::ref_obj>()) {
        std::string rhsName = std::string(refObj->VpiFullName());
        if (!rhsName.empty()) {
            std::cerr << "DEBUG: Found RHS signal: " << rhsName << " for LHS: " << lhsSignalName << "\n";
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
    // First apply driver signal relationships
    for (auto& [drivenSignalName, driverInfos] : signalToDriverNames_) {
        const SignalInfo* drivenSignal = builder_.findSignalByName(drivenSignalName);
        if (!drivenSignal) {
            std::cerr << "DEBUG: Could not find driven signal: " << drivenSignalName << "\n";
            continue;
        }
        
        for (auto& [driverSignalName, driverLocation] : driverInfos) {
            auto it = currentModuleSignalMap_.find(driverSignalName);
            if (it != currentModuleSignalMap_.end() && it->second != 0) {
                uint64_t driverSignalId = it->second;
                
                SignalInfo* signal = const_cast<SignalInfo*>(drivenSignal);
                
                // Check if this driver is already added (avoid duplicates)
                bool alreadyExists = false;
                for (auto id : signal->driverSignalIds) {
                    if (id == driverSignalId) {
                        alreadyExists = true;
                        break;
                    }
                }
                
                if (!alreadyExists) {
                    signal->driverSignalIds.push_back(driverSignalId);
                    std::cerr << "DEBUG: Added driver " << driverSignalName << " (id=" << driverSignalId 
                              << ") to " << drivenSignalName << "\n";
                }
            } else {
                std::cerr << "DEBUG: Driver signal not in map: " << driverSignalName << "\n";
            }
        }
    }
    
    // Then apply driver lines (including those without RHS signals)
    for (auto& [signalName, locations] : signalDriverLines_) {
        const SignalInfo* signal = builder_.findSignalByName(signalName);
        if (!signal) {
            std::cerr << "DEBUG: Could not find signal for driver lines: " << signalName << "\n";
            continue;
        }
        
        SignalInfo* mutableSignal = const_cast<SignalInfo*>(signal);
        for (const auto& loc : locations) {
            // Check if this line is already recorded
            bool alreadyExists = false;
            for (const auto& existingLoc : mutableSignal->driverLines) {
                if (existingLoc.fileId == loc.fileId && existingLoc.line == loc.line) {
                    alreadyExists = true;
                    break;
                }
            }
            
            if (!alreadyExists) {
                mutableSignal->driverLines.push_back(loc);
                std::cerr << "DEBUG: Added driver line " << loc.line << " to " << signalName << "\n";
            }
        }
    }
    
    signalToDriverNames_.clear();
    signalDriverLines_.clear();
}

void DriverAnalyzer::clear() {
    currentModuleSignalMap_.clear();
    signalToDriverNames_.clear();
    signalDriverLines_.clear();
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
