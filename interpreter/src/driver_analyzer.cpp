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

void DriverAnalyzer::analyzePortConnections(const UHDM::module_inst* module) {
    if (!module) return;
    
    std::string moduleName(module->VpiFullName());
    std::string instName(module->VpiName());
    std::string defName(module->VpiDefName());
    
    std::cerr << "DEBUG: analyzePortConnections for module: " << moduleName 
              << " (instName='" << instName << "', defName='" << defName << "')\n";
    
    // Process both module definitions and instances
    // For definitions (instName empty), we still want to analyze their port connections
    // when they are used as instances
    
    // Get ports for this module
    auto ports = module->Ports();
    if (!ports) {
        std::cerr << "DEBUG: No ports found for module\n";
        return;
    }
    
    std::cerr << "DEBUG: Found " << ports->size() << " ports\n";
    
    for (auto* port : *ports) {
        if (!port) continue;
        
        std::string portName(port->VpiName());
        int portDirection = port->VpiDirection();
        
        std::cerr << "DEBUG: Processing port: " << portName << " direction=" << portDirection << "\n";
        
        // Get the high_conn (parent module side connection) and low_conn (sub-module side)
        UHDM::any* highConn = port->High_conn();
        UHDM::any* lowConn = port->Low_conn();
        
        // Get the parent signal name from high_conn
        std::string parentSignalName;
        KdbSourceLocation parentSignalLoc;
        if (highConn) {
            if (auto* refObj = highConn->Cast<UHDM::ref_obj>()) {
                parentSignalName = std::string(refObj->VpiFullName());
                if (auto* actualSignal = refObj->Actual_group()) {
                    parentSignalLoc = extractLocation(actualSignal);
                } else {
                    parentSignalLoc = extractLocation(refObj);
                }
            } else {
                parentSignalName = std::string(highConn->VpiName());
                parentSignalLoc = extractLocation(highConn);
            }
        }
        
        // Get the sub-module signal name from low_conn
        std::string subModuleSignalName;
        KdbSourceLocation subModuleSignalLoc;
        if (lowConn) {
            if (auto* refObj = lowConn->Cast<UHDM::ref_obj>()) {
                subModuleSignalName = std::string(refObj->VpiFullName());
                if (auto* actualSignal = refObj->Actual_group()) {
                    subModuleSignalLoc = extractLocation(actualSignal);
                } else {
                    subModuleSignalLoc = extractLocation(refObj);
                }
            } else {
                subModuleSignalName = std::string(lowConn->VpiName());
                subModuleSignalLoc = extractLocation(lowConn);
            }
        }
        
        if (subModuleSignalName.empty()) {
            subModuleSignalName = moduleName + "." + portName;
        }
        
        // Use module instance's line number for port connection location
        KdbSourceLocation portLoc = extractLocation(module);
        
        // Process output/inout ports: sub-module output drives parent module signal
        if (portDirection == vpiOutput || portDirection == vpiInout) {
            if (parentSignalName.empty()) {
                std::cerr << "DEBUG: Empty parent signal name for output port " << portName << "\n";
                continue;
            }
            
            std::cerr << "DEBUG: Output port connection: " << subModuleSignalName << " -> " << parentSignalName 
                      << " at module instance line " << portLoc.line << "\n";
            
            // Record the driver relationship: sub-module output drives parent module signal
            signalToDriverNames_[parentSignalName].push_back({subModuleSignalName, portLoc});
            
            // Record the driver signal definition location
            if (subModuleSignalLoc.line > 0) {
                signalDriverLines_[parentSignalName].push_back(subModuleSignalLoc);
            }
        }
        
        // Process input ports: parent module signal drives sub-module input
        if (portDirection == vpiInput || portDirection == vpiInout) {
            if (parentSignalName.empty()) {
                std::cerr << "DEBUG: Empty parent signal name for input port " << portName << "\n";
                continue;
            }
            
            std::cerr << "DEBUG: Input port connection: " << parentSignalName << " -> " << subModuleSignalName 
                      << " at module instance line " << portLoc.line << "\n";
            
            // Record the driver relationship: parent module signal drives sub-module input
            signalToDriverNames_[subModuleSignalName].push_back({parentSignalName, portLoc});
            
            // Record the driver signal definition location (parent signal location)
            if (parentSignalLoc.line > 0) {
                signalDriverLines_[subModuleSignalName].push_back(parentSignalLoc);
            }
        }
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
        for (auto& [driverSignalName, driverLocation] : driverInfos) {
            // Use the new method to add driver by full name (will be resolved to global ID in Phase 2)
            if (builder_.addDriverToSignal(drivenSignalName, driverSignalName)) {
                std::cerr << "DEBUG: Added driver " << driverSignalName 
                          << " to " << drivenSignalName << "\n";
            } else {
                std::cerr << "DEBUG: Could not add driver " << driverSignalName 
                          << " to " << drivenSignalName << "\n";
            }
        }
    }
    
    // Then apply driver lines (including those without RHS signals)
    for (auto& [signalName, locations] : signalDriverLines_) {
        for (const auto& loc : locations) {
            // Use the new method to directly add driver line to signalInsts
            if (builder_.addDriverLineToSignal(signalName, loc)) {
                std::cerr << "DEBUG: Added driver line " << loc.line << " to " << signalName << "\n";
            } else {
                std::cerr << "DEBUG: Could not find signal for driver lines: " << signalName << "\n";
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
