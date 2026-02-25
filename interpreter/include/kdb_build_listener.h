#ifndef HWDA_INTERPRETER_KDB_BUILD_LISTENER_H
#define HWDA_INTERPRETER_KDB_BUILD_LISTENER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <unordered_set>

#include <uhdm/VpiListener.h>
#include <uhdm/vpi_user.h>

namespace UHDM {
    class module_inst;
    class expr;
    class BaseClass;
}

namespace hwda {
namespace interpreter {

struct DriverInfo {
    uint64_t driverSignalId;
    KdbSourceLocation location;
};

class KdbBuildListener : public UHDM::VpiListener {
public:
    KdbBuildListener(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId);
    
    void enterModule_inst(const UHDM::module_inst* object, vpiHandle handle) override;
    void leaveModule_inst(const UHDM::module_inst* object, vpiHandle handle) override;
    
    size_t getTotalModules() const { return totalModules_; }
    size_t getTotalSignals() const { return totalSignals_; }
    
private:
    void applyDriverRelationships();
    void processAssignStatements(const UHDM::module_inst* module);
    void extractRhsSignals(const UHDM::expr* expr, const std::string& lhsSignalName, 
                          const UHDM::BaseClass* assignObj);
    KdbSourceLocation extractLocation(const UHDM::BaseClass* obj);
    SignalType convertSignalType(int32_t uhdmNetType);
    PortDirection convertPortDirection(int direction);
    
    KdbBuilder& builder_;
    std::unordered_map<std::string, uint64_t>& filePathToId_;
    std::vector<uint64_t> currentModuleStack_;
    std::vector<bool> moduleStackMarkers_;
    size_t totalModules_;
    size_t totalSignals_;
    uint64_t nextPortId_;
    
    std::unordered_map<std::string, std::vector<DriverInfo>> currentModuleDrivers_;
    std::unordered_map<std::string, uint64_t> currentModuleSignalMap_;
    std::vector<std::pair<std::string, uint64_t>> currentModuleInstances_;
    std::unordered_map<std::string, std::vector<std::pair<std::string, KdbSourceLocation>>> signalToDriverNames_;
};

}
}

#endif
