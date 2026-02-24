#include "kdb_builder.h"

namespace hwda {
namespace interpreter {

KdbBuilder::KdbBuilder() = default;
KdbBuilder::~KdbBuilder() = default;

void KdbBuilder::addModule(const ParsedModule& module) {
    KdbModule kdbModule;
    kdbModule.name = module.name;
    kdbModule.filePath = module.location.filePath;
    kdbModule.startLine = module.location.line;
    kdbModule.endLine = module.endLine;
    kdbModule.ports = module.ports;
    kdbModule.parameters = module.parameters;
    modules_.push_back(kdbModule);
}

void KdbBuilder::addSignal(const ParsedSignal& signal, const std::string& scope) {
    KdbSignal kdbSignal;
    kdbSignal.id = nextSignalId_++;
    kdbSignal.name = signal.name;
    kdbSignal.fullPath = scope.empty() ? signal.name : scope + "." + signal.name;
    kdbSignal.bitWidth = signal.bitWidth;
    kdbSignal.type = signal.type;
    kdbSignal.direction = signal.direction;
    kdbSignal.filePath = signal.location.filePath;
    kdbSignal.lineNumber = signal.location.line;
    signals_.push_back(kdbSignal);
}

void KdbBuilder::addConnection(const ParsedConnection& conn) {
    KdbConnection kdbConn;
    kdbConn.driverSignal = conn.driver;
    kdbConn.loadSignal = conn.load;
    kdbConn.driverInstance = conn.driverInstance;
    kdbConn.loadInstance = conn.loadInstance;
    kdbConn.driverLine = conn.driverLocation.line;
    kdbConn.loadLine = conn.loadLocation.line;
    connections_.push_back(kdbConn);
}

void KdbBuilder::addSourceFile(const std::string& path, const std::string& content) {
    KdbSourceFile file;
    file.path = path;
    file.content = content;
    sourceFiles_.push_back(file);
}

void KdbBuilder::buildIndices() {
    signalIndex_.clear();
    moduleIndex_.clear();
    
    for (const auto& sig : signals_) {
        signalIndex_[sig.fullPath] = sig.id;
    }
    
    for (size_t i = 0; i < modules_.size(); ++i) {
        moduleIndex_[modules_[i].name] = i;
    }
}

std::vector<uint64_t> KdbBuilder::findDrivers(const std::string& signalPath) const {
    std::vector<uint64_t> drivers;
    for (const auto& conn : connections_) {
        if (conn.loadSignal == signalPath) {
            auto it = signalIndex_.find(conn.driverSignal);
            if (it != signalIndex_.end()) {
                drivers.push_back(it->second);
            }
        }
    }
    return drivers;
}

std::vector<uint64_t> KdbBuilder::findLoads(const std::string& signalPath) const {
    std::vector<uint64_t> loads;
    for (const auto& conn : connections_) {
        if (conn.driverSignal == signalPath) {
            auto it = signalIndex_.find(conn.loadSignal);
            if (it != signalIndex_.end()) {
                loads.push_back(it->second);
            }
        }
    }
    return loads;
}

}
}
