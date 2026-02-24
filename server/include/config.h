#ifndef HWDA_SERVER_CONFIG_H
#define HWDA_SERVER_CONFIG_H

#include <string>
#include <cstdint>

namespace hwda {

struct ServerConfig {
    std::string host = "0.0.0.0";
    uint16_t port = 8080;
    std::string kdbPath;
    std::string wavePath;
    int maxConnections = 10;
    int threadPoolSize = 4;
    bool verbose = false;
    
    static ServerConfig fromArgs(int argc, char* argv[]);
    void print() const;
};

struct KdbConfig {
    std::string version = "1.0";
    bool useCompression = true;
    int compressionLevel = 3;
};

struct WaveConfig {
    bool enableCache = true;
    size_t cacheSizeMB = 256;
    bool preloadSignalList = true;
};

}

#endif
