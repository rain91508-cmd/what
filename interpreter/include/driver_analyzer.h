#ifndef HWDA_INTERPRETER_DRIVER_ANALYZER_H
#define HWDA_INTERPRETER_DRIVER_ANALYZER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <unordered_map>

namespace UHDM {
    class module_inst;
    class expr;
    class BaseClass;
    class process_stmt;
    class assignment;
}

namespace hwda {
namespace interpreter {

// Structure to track driver information before resolution
struct DriverInfo {
    uint64_t driverSignalId;
    KdbSourceLocation location;
};

// DriverAnalyzer - analyzes signal driver relationships from UHDM
class DriverAnalyzer {
public:
    DriverAnalyzer(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId);
    
    // Analyze continuous assignments in a module to find driver relationships
    void analyzeContinuousAssignments(const UHDM::module_inst* module);
    
    // Analyze procedural assignments in always/initial blocks
    void analyzeProceduralAssignments(const UHDM::module_inst* module);
    
    // Analyze port connections from module instances
    void analyzePortConnections(const UHDM::module_inst* module);
    
    // Apply collected driver relationships to signals
    void applyDriverRelationships();
    
    // Clear all collected driver information
    void clear();
    
    // Get the signal name to ID mapping for the current module
    std::unordered_map<std::string, uint64_t>& getSignalMap() { return currentModuleSignalMap_; }
    
private:
    void extractRhsSignals(const UHDM::expr* expr, const std::string& lhsSignalName, 
                          const UHDM::BaseClass* assignObj, uint32_t line);
    void processAssignment(const UHDM::assignment* assign);
    void processProcessStmt(const UHDM::process_stmt* process);
    void processStmt(const UHDM::BaseClass* stmt);
    KdbSourceLocation extractLocation(const UHDM::BaseClass* obj);
    
    KdbBuilder& builder_;
    std::unordered_map<std::string, uint64_t>& filePathToId_;
    
    // Signal name to ID mapping for current module
    std::unordered_map<std::string, uint64_t> currentModuleSignalMap_;
    
    // Temporary storage: maps driven signal to driver signal names and locations
    std::unordered_map<std::string, std::vector<std::pair<std::string, KdbSourceLocation>>> signalToDriverNames_;
    
    // Track which signals have driver lines recorded (even without RHS signals)
    std::unordered_map<std::string, std::vector<KdbSourceLocation>> signalDriverLines_;
};

}
}

#endif
