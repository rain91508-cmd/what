#ifndef HWDA_INTERPRETER_KDB_BUILDER_H
#define HWDA_INTERPRETER_KDB_BUILDER_H

#include "types.h"
#include <string>
#include <vector>
#include <unordered_map>

namespace hwda {
namespace interpreter {

struct KdbModule {
    std::string name;
    std::string filePath;
    int startLine;
    int endLine;
    std::vector<std::string> ports;
    std::vector<std::string> parameters;
};

struct KdbSignal {
    uint64_t id;
    std::string name;
    std::string fullPath;
    int bitWidth;
    std::string type;
    std::string direction;
    std::string filePath;
    int lineNumber;
};

struct KdbConnection {
    std::string driverSignal;
    std::string loadSignal;
    std::string driverInstance;
    std::string loadInstance;
    int driverLine;
    int loadLine;
};

struct KdbSourceFile {
    std::string path;
    std::string content;
};

class KdbBuilder {
public:
    KdbBuilder();
    ~KdbBuilder();
    
    void addModule(const ParsedModule& module);
    void addSignal(const ParsedSignal& signal, const std::string& scope);
    void addConnection(const ParsedConnection& conn);
    void addSourceFile(const std::string& path, const std::string& content);
    
    const std::vector<KdbModule>& getModules() const { return modules_; }
    const std::vector<KdbSignal>& getSignals() const { return signals_; }
    const std::vector<KdbConnection>& getConnections() const { return connections_; }
    const std::vector<KdbSourceFile>& getSourceFiles() const { return sourceFiles_; }
    
    void buildIndices();
    
    std::vector<uint64_t> findDrivers(const std::string& signalPath) const;
    std::vector<uint64_t> findLoads(const std::string& signalPath) const;
    
private:
    std::vector<KdbModule> modules_;
    std::vector<KdbSignal> signals_;
    std::vector<KdbConnection> connections_;
    std::vector<KdbSourceFile> sourceFiles_;
    
    std::unordered_map<std::string, uint64_t> signalIndex_;
    std::unordered_map<std::string, size_t> moduleIndex_;
    uint64_t nextSignalId_{1};
};

}
}

#endif
