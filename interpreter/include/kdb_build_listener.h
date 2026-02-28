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

class DriverAnalyzer;

class KdbBuildListener : public UHDM::VpiListener {
public:
    KdbBuildListener(KdbBuilder& builder, std::unordered_map<std::string, uint64_t>& filePathToId);
    ~KdbBuildListener();
    
    void enterModule_inst(const UHDM::module_inst* object, vpiHandle handle) override;
    void leaveModule_inst(const UHDM::module_inst* object, vpiHandle handle) override;
    
    // Post-processing: link instances to their definition modules
    void linkInstancesToDefinitions();
    
    size_t getTotalModules() const { return totalModules_; }
    size_t getTotalSignals() const { return totalSignals_; }
    
private:
    KdbSourceLocation extractLocation(const UHDM::BaseClass* obj);
    KdbModuleSourceLocation extractModuleLocation(const UHDM::module_inst* obj, bool isInstance);
    uint32_t findEndmoduleLine(const std::string& content, uint32_t startLine);
    SignalType convertSignalType(int32_t uhdmNetType);
    PortDirection convertPortDirection(int direction);
    
    KdbBuilder& builder_;
    std::unordered_map<std::string, uint64_t>& filePathToId_;
    std::vector<uint64_t> currentModuleStack_;
    std::vector<bool> moduleStackMarkers_;
    size_t totalModules_;
    size_t totalSignals_;
    uint64_t nextPortId_;
    
    std::unordered_map<std::string, uint64_t> currentModuleSignalMap_;
    std::vector<std::pair<std::string, uint64_t>> currentModuleInstances_;
    
    // Store instance info for post-processing (defName -> instance module ID)
    std::vector<std::pair<std::string, uint32_t>> instanceDefNames_;
    
    DriverAnalyzer* driverAnalyzer_;
};

}
}

#endif
