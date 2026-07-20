#include "driver_analyzer.h"
#include "types.h"

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
        if (!lhs) continue;
        
        // Driven signal: resolve via Actual_group() pointer (fast path) and
        // keep the full name as fallback.
        uintptr_t drivenObj = 0;
        std::string drivenName;
        if (auto* refObj = lhs->Cast<UHDM::ref_obj>()) {
            if (auto* actual = refObj->Actual_group()) {
                drivenObj = reinterpret_cast<uintptr_t>(actual);
            }
            drivenName = std::string(refObj->VpiFullName());
        }
        if (drivenObj == 0 && drivenName.empty()) continue;
        
        uint32_t line = contAssign->VpiLineNo();
        
        // Record the edge. If RHS exists, each referenced signal becomes a
        // driver; otherwise this is a constant driver (driverObj = 0).
        if (rhs) {
            extractRhsSignals(rhs, drivenObj, drivenName, line);
        } else {
            rawEdges_.push_back({drivenObj, 0, drivenName, std::string(), line});
        }
    }
}

void DriverAnalyzer::analyzeProceduralAssignments(const UHDM::module_inst* module) {
    if (!module) return;
    
    std::string moduleName(module->VpiFullName());
    VERBOSE_LOG("DEBUG: analyzeProceduralAssignments for module: " << moduleName << "\n");
    
    // Process all processes (always/initial blocks)
    // Note: UHDM uses Process() not Processes()
    auto* process = module->Process();
    if (process) {
        VERBOSE_LOG("DEBUG: Found " << process->size() << " processes\n");
        // Process is a VectorOfprocess_stmt
        for (auto* p : *process) {
            if (!p) continue;
            VERBOSE_LOG("DEBUG: Processing process, type=" << p->VpiType() << "\n");
            processProcessStmt(p);
        }
    } else {
        VERBOSE_LOG("DEBUG: No processes found\n");
    }
}

void DriverAnalyzer::analyzePortConnections(const UHDM::module_inst* module) {
    if (!module) return;
    
    std::string moduleName(module->VpiFullName());
    std::string instName(module->VpiName());
    std::string defName(module->VpiDefName());
    
    VERBOSE_LOG("DEBUG: analyzePortConnections for module: " << moduleName 
              << " (instName='" << instName << "', defName='" << defName << "')\n");
    
    // Process both module definitions and instances
    // For definitions (instName empty), we still want to analyze their port connections
    // when they are used as instances
    
    // Get ports for this module
    auto ports = module->Ports();
    if (!ports) {
        VERBOSE_LOG("DEBUG: No ports found for module\n");
        return;
    }
    
    VERBOSE_LOG("DEBUG: Found " << ports->size() << " ports\n");
    
    for (auto* port : *ports) {
        if (!port) continue;
        
        std::string portName(port->VpiName());
        int portDirection = port->VpiDirection();
        
        VERBOSE_LOG("DEBUG: Processing port: " << portName << " direction=" << portDirection << "\n");
        
        // Get the high_conn (parent module side connection) and low_conn (sub-module side)
        UHDM::any* highConn = port->High_conn();
        UHDM::any* lowConn = port->Low_conn();
        
        // Get the parent signal name from high_conn
        std::string parentSignalName;
        uintptr_t parentObj = 0;
        KdbSourceLocation parentSignalLoc;
        if (highConn) {
            if (auto* refObj = highConn->Cast<UHDM::ref_obj>()) {
                parentSignalName = std::string(refObj->VpiFullName());
                if (auto* actualSignal = refObj->Actual_group()) {
                    parentObj = reinterpret_cast<uintptr_t>(actualSignal);
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
        uintptr_t subModuleObj = 0;
        KdbSourceLocation subModuleSignalLoc;
        if (lowConn) {
            if (auto* refObj = lowConn->Cast<UHDM::ref_obj>()) {
                subModuleSignalName = std::string(refObj->VpiFullName());
                if (auto* actualSignal = refObj->Actual_group()) {
                    subModuleObj = reinterpret_cast<uintptr_t>(actualSignal);
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
                VERBOSE_LOG("DEBUG: Empty parent signal name for output port " << portName << "\n");
                continue;
            }
            
            VERBOSE_LOG("DEBUG: Output port connection: " << subModuleSignalName << " -> " << parentSignalName 
                      << " at module instance line " << portLoc.line << "\n");
            
            // Edge: sub-module output drives parent module signal.
            // Case A (output-port): driver is the sub-instance's own port ->
            // use the driver's declaration line in resolveEdges (flag = true).
            rawEdges_.push_back({parentObj, subModuleObj, parentSignalName, subModuleSignalName, portLoc.line, true});
        }
        
        // Process input ports: parent module signal drives sub-module input
        if (portDirection == vpiInput || portDirection == vpiInout) {
            if (parentSignalName.empty()) {
                VERBOSE_LOG("DEBUG: Empty parent signal name for input port " << portName << "\n");
                continue;
            }
            
            VERBOSE_LOG("DEBUG: Input port connection: " << parentSignalName << " -> " << subModuleSignalName 
                      << " at module instance line " << portLoc.line << "\n");
            
            // Edge: parent module signal drives sub-module input.
            // Case B (input-port): driver is the parent-scope signal. The
            // connection line (instance header) is imprecise, so use the
            // driver's declaration line in resolveEdges (flag = true).
            rawEdges_.push_back({subModuleObj, parentObj, subModuleSignalName, parentSignalName, portLoc.line, true});
        }
    }
}

void DriverAnalyzer::processProcessStmt(const UHDM::process_stmt* process) {
    if (!process) return;
    
    // Get the statement body of the process
    auto* stmt = process->Stmt();
    if (!stmt) {
        VERBOSE_LOG("DEBUG: Process has no stmt\n");
        return;
    }
    
    VERBOSE_LOG("DEBUG: Process stmt type=" << stmt->VpiType() << "\n");
    
    // Recursively process any statement type
    processStmt(stmt);
}

void DriverAnalyzer::processStmt(const UHDM::BaseClass* stmt) {
    if (!stmt) return;
    
    VERBOSE_LOG("DEBUG: processStmt type=" << stmt->VpiType() << "\n");
    
    // Process begin block
    if (auto* beginBlock = stmt->Cast<UHDM::begin>()) {
        VERBOSE_LOG("DEBUG: Found begin block\n");
        auto stmts = beginBlock->Stmts();
        if (stmts) {
            VERBOSE_LOG("DEBUG: Begin block has " << stmts->size() << " statements\n");
            for (auto* s : *stmts) {
                processStmt(s);
            }
        }
    }
    // Process if statement
    else if (auto* ifStmt = stmt->Cast<UHDM::if_stmt>()) {
        VERBOSE_LOG("DEBUG: Found if statement\n");
        // Process then statement
        auto* thenStmt = ifStmt->VpiStmt();
        if (thenStmt) {
            VERBOSE_LOG("DEBUG: Processing then branch\n");
            processStmt(thenStmt);
        }
        
        // Note: UHDM if_stmt may not have VpiElseStmt, skip else processing for now
    }
    // Process if-else statement
    else if (auto* ifElseStmt = stmt->Cast<UHDM::if_else>()) {
        VERBOSE_LOG("DEBUG: Found if-else statement\n");
        // Process then statement
        auto* thenStmt = ifElseStmt->VpiStmt();
        if (thenStmt) {
            VERBOSE_LOG("DEBUG: Processing then branch\n");
            processStmt(thenStmt);
        }
        // Process else statement
        auto* elseStmt = ifElseStmt->VpiElseStmt();
        if (elseStmt) {
            VERBOSE_LOG("DEBUG: Processing else branch\n");
            processStmt(elseStmt);
        }
    }
    // Process assignment
    else if (auto* assign = stmt->Cast<UHDM::assignment>()) {
        VERBOSE_LOG("DEBUG: Found assignment\n");
        processAssignment(assign);
    }
    // Process event control (like @(posedge clk))
    else if (auto* eventCtrl = stmt->Cast<UHDM::event_control>()) {
        VERBOSE_LOG("DEBUG: Found event_control, processing stmt\n");
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
    
    // Driven signal: resolve via Actual_group() pointer (fast path), keep name
    // as fallback.
    uintptr_t drivenObj = 0;
    std::string drivenName;
    if (auto* refObj = lhs->Cast<UHDM::ref_obj>()) {
        if (auto* actual = refObj->Actual_group()) {
            drivenObj = reinterpret_cast<uintptr_t>(actual);
        }
        drivenName = std::string(refObj->VpiFullName());
    }
    
    if (drivenObj == 0 && drivenName.empty()) {
        VERBOSE_LOG("DEBUG: Assignment has empty LHS name\n");
        return;
    }
    
    uint32_t line = assign->VpiLineNo();
    VERBOSE_LOG("DEBUG: Processing assignment to " << drivenName << " at line " << line << "\n");
    
    // If RHS exists, each referenced signal becomes a driver; otherwise this is
    // a constant driver (driverObj = 0).
    if (rhs) {
        if (auto* rhsExpr = rhs->Cast<UHDM::expr>()) {
            extractRhsSignals(rhsExpr, drivenObj, drivenName, line);
        }
    } else {
        VERBOSE_LOG("DEBUG: Assignment has no RHS (constant assignment)\n");
        rawEdges_.push_back({drivenObj, 0, drivenName, std::string(), line});
    }
}

void DriverAnalyzer::extractRhsSignals(const UHDM::expr* expr, uintptr_t drivenObj,
                                       const std::string& drivenName, uint32_t line) {
    if (!expr) return;
    
    if (auto* refObj = expr->Cast<UHDM::ref_obj>()) {
        uintptr_t driverObj = 0;
        std::string driverName;
        if (auto* actual = refObj->Actual_group()) {
            driverObj = reinterpret_cast<uintptr_t>(actual);
        }
        driverName = std::string(refObj->VpiFullName());
        if (driverObj != 0 || !driverName.empty()) {
            VERBOSE_LOG("DEBUG: Found RHS signal: " << driverName << " for LHS: " << drivenName 
                      << " at line " << line << "\n");
            rawEdges_.push_back({drivenObj, driverObj, drivenName, driverName, line});
        }
    }
    
    if (auto* op = expr->Cast<UHDM::operation>()) {
        auto* operands = op->Operands();
        if (operands) {
            for (auto* operand : *operands) {
                if (auto* operandExpr = operand->Cast<UHDM::expr>()) {
                    extractRhsSignals(operandExpr, drivenObj, drivenName, line);
                }
            }
        }
    }
}

void DriverAnalyzer::registerSignalObject(const UHDM::BaseClass* obj, uint64_t tempId) {
    if (!obj) return;
    uhdmToTempId_[reinterpret_cast<uintptr_t>(obj)] = tempId;
}

uint64_t DriverAnalyzer::resolveObj(uintptr_t objKey, const std::string& name) {
    // Fast path: UHDM object pointer -> tempId -> global ID.
    auto it = uhdmToTempId_.find(objKey);
    if (it != uhdmToTempId_.end()) {
        uint64_t tempId = it->second;
        uint32_t moduleId = static_cast<uint32_t>(tempId >> 32);
        uint32_t localIdx = static_cast<uint32_t>(tempId & 0xFFFFFFFF);
        const ModuleInfo* mod = builder_.findModuleById(moduleId);
        if (mod && mod->isSignalInstsCommitted()) {
            uint64_t globalId = static_cast<uint64_t>(mod->signalInstsStartId) + localIdx;
            if (globalId < builder_.getAllSignalInsts().size()) {
                return globalId;
            }
        }
    }
    // Fallback: resolve by full name (post-commit signalFullNameToId_ holds
    // global IDs, so this is an O(1) hash lookup, not a scan).
    if (!name.empty()) {
        return builder_.getSignalGlobalIdByName(name);
    }
    return 0;
}

void DriverAnalyzer::resolveEdges() {
    size_t total = 0, viaPointer = 0, viaName = 0, unresolved = 0;
    for (const auto& edge : rawEdges_) {
        total++;
        uint64_t drivenGlobal = resolveObj(edge.drivenObj, edge.drivenName);
        if (drivenGlobal == 0) { unresolved++; continue; }
        
        uint64_t driverGlobal = resolveObj(edge.driverObj, edge.driverName);
        if (driverGlobal != 0) {
            if (uhdmToTempId_.count(edge.driverObj)) viaPointer++;
            else viaName++;
        }
        
        SignalInstInfo* inst = builder_.getGlobalSignalInst(drivenGlobal);
        if (!inst) continue;
        
        DriverLocation loc;
        loc.driverSignalGlobalId = driverGlobal;  // 0 == constant/unknown driver
        loc.line = edge.line;
        // Port-connection edges (both output-port Case A and input-port Case B):
        // the connection line is either in the wrong file (Case A) or only the
        // imprecise instance-header line (Case B). Rewrite it to the driver
        // signal's own declaration line, which is precise and always lives in
        // the driver's defModule file -> the (drvFid, line) pair the viewer
        // derives from driverSignalGlobalId is then always self-consistent.
        if (edge.useDriverDeclLine && driverGlobal != 0) {
            const SignalInfo* drvSig = builder_.findSignalById(driverGlobal);
            if (drvSig && drvSig->declaration.line != 0) {
                loc.line = drvSig->declaration.line;
            }
        }
        inst->driverLocations.push_back(loc);
    }
    VERBOSE_LOG("[DriverAnalyzer] resolved " << total << " edges: viaPointer=" << viaPointer
              << " viaName=" << viaName << " unresolvedDriven=" << unresolved << "\n");
    rawEdges_.clear();
}

void DriverAnalyzer::clear() {
    currentModuleSignalMap_.clear();
    uhdmToTempId_.clear();
    rawEdges_.clear();
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
