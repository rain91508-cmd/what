#ifndef HWDA_INTERPRETER_DRIVER_ANALYZER_H
#define HWDA_INTERPRETER_DRIVER_ANALYZER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <cstdint>

namespace UHDM {
    class module_inst;
    class expr;
    class BaseClass;
    class process_stmt;
    class assignment;
    // NOTE: UHDM::any is a typedef for UHDM::BaseClass (see uhdm_types.h),
    // so it must NOT be forward-declared as a class here. Use UHDM::any /
    // UHDM::BaseClass directly; both are available via <uhdm/uhdm.h>.
}

namespace hwda {
namespace interpreter {

// Structure to track driver information before resolution
struct DriverInfo {
    uint64_t driverSignalId;
    KdbSourceLocation location;
};

// A raw driver edge collected during the UHDM walk.
// Driven/driver signals are identified by the UHDM object pointer
// (Actual_group()) of the referenced net/var/port, which we resolve to a
// KDB global signal ID after commit. The full names are kept only as a
// fallback in case a pointer cannot be resolved.
struct DriverEdge {
    uintptr_t drivenObj;   // Actual_group() of the driven signal (0 if unknown)
    uintptr_t driverObj;   // Actual_group() of the driving signal (0 if none)
    std::string drivenName; // Full name fallback for the driven signal
    std::string driverName; // Full name fallback for the driving signal
    uint32_t line;
    // Port-connection marker. Set for BOTH port-connection directions:
    //   Case A (output-port): driver is a sub-instance's own port, declared in
    //           a different file than the connection text.
    //   Case B (input-port):  driver is the parent-scope signal; the connection
    //           line is only the imprecise instance-header line.
    // For every port-connection edge `line` is rewritten in resolveEdges() to
    // the driver signal's declaration line, which is both precise and always
    // consistent with the driver's declaration file (drvFid). Non-connection
    // edges (continuous / procedural assignments) keep their assignment line,
    // which is already precise and lives in the driver's declaration file.
    bool useDriverDeclLine = false;
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
    
    // Resolve the collected edges to global signal IDs and attach them to the
    // KDB signals. Must be called ONCE after commitSignalInsts() so that
    // global IDs exist. This is O(E) with O(1) pointer lookups.
    void resolveEdges();
    
    // Clear all collected driver information
    void clear();
    
    // Register a UHDM signal object (net/var/port) -> its tempId
    // (moduleId<<32 | localIndex) so edges can be resolved to a global ID.
    // Uses UHDM::BaseClass* since UHDM::any is a typedef alias of BaseClass.
    void registerSignalObject(const UHDM::BaseClass* obj, uint64_t tempId);
    
    // Get the signal name to ID mapping for the current module
    std::unordered_map<std::string, uint64_t>& getSignalMap() { return currentModuleSignalMap_; }
    
private:
    // Extract driver signal references from an RHS expression and record edges
    // driving 'drivenObj' (with 'drivenName' as fallback).
    void extractRhsSignals(const UHDM::expr* expr, uintptr_t drivenObj,
                          const std::string& drivenName, uint32_t line);
    void processAssignment(const UHDM::assignment* assign);
    void processProcessStmt(const UHDM::process_stmt* process);
    void processStmt(const UHDM::BaseClass* stmt);
    KdbSourceLocation extractLocation(const UHDM::BaseClass* obj);
    
    // Resolve a UHDM object pointer (fast path) or full name (fallback) to a
    // global signal ID. Returns 0 if neither resolves.
    uint64_t resolveObj(uintptr_t objKey, const std::string& name);

    KdbBuilder& builder_;
    std::unordered_map<std::string, uint64_t>& filePathToId_;
    
    // Signal name to ID mapping for current module (kept for compatibility)
    std::unordered_map<std::string, uint64_t> currentModuleSignalMap_;
    
    // UHDM object pointer -> tempId (moduleId<<32 | localIndex), populated by
    // the structural listener as each signal is registered. Lets us map a
    // reference's Actual_group() to a KDB signal in O(1), avoiding any
    // per-signal name search.
    std::unordered_map<uintptr_t, uint64_t> uhdmToTempId_;
    
    // Raw driver edges collected during the walk, resolved in resolveEdges().
    std::vector<DriverEdge> rawEdges_;
};

}
}

#endif
