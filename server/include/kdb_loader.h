#ifndef HWDA_SERVER_KDB_LOADER_H
#define HWDA_SERVER_KDB_LOADER_H

#include "types.h"
#include <string>
#include <vector>
#include <unordered_map>
#include <memory>

namespace hwda {

struct Module {
    std::string name;
    std::string filePath;
    int startLine;
    int endLine;
    std::vector<std::string> ports;
    std::vector<std::string> parameters;
};

struct Connection {
    std::string driverSignal;
    std::string loadSignal;
    std::string driverInstance;
    std::string loadInstance;
    int driverLine;
    int loadLine;
};

struct SourceFile {
    std::string path;
    std::string content;
};

class KdbLoader {
public:
    KdbLoader();
    ~KdbLoader();
    
    bool load(const std::string& path);
    bool isLoaded() const { return loaded_; }
    
    const std::vector<Module>& getModules() const { return modules_; }
    const std::vector<SignalInfo>& getSignals() const { return signals_; }
    const std::vector<Connection>& getConnections() const { return connections_; }
    const std::vector<SourceFile>& getSourceFiles() const { return sourceFiles_; }
    
    std::vector<SignalInfo> getSignalsByScope(const std::string& scope) const;
    std::vector<DriverInfo> getDrivers(const std::string& signalPath) const;
    std::vector<LoadInfo> getLoads(const std::string& signalPath) const;
    
    std::string getSourceCode(const std::string& filePath) const;
    
    size_t getFileSize() const { return fileSize_; }
    std::string getVersion() const { return version_; }
    std::string getChecksum() const { return checksum_; }
    
    std::vector<uint8_t> serialize() const;
    
private:
    bool deserialize(const std::vector<uint8_t>& data);
    void buildIndices();
    
    bool loaded_{false};
    std::string version_;
    std::string checksum_;
    size_t fileSize_{0};
    
    std::vector<Module> modules_;
    std::vector<SignalInfo> signals_;
    std::vector<Connection> connections_;
    std::vector<SourceFile> sourceFiles_;
    
    std::unordered_map<std::string, size_t> signalIndex_;
    std::unordered_map<std::string, size_t> moduleIndex_;
    std::unordered_map<std::string, size_t> fileIndex_;
};

}

#endif
