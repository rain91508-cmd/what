#include "config.h"
#include <iostream>
#include <cstring>
#include <getopt.h>

namespace hwda {

ServerConfig ServerConfig::fromArgs(int argc, char* argv[]) {
    ServerConfig config;
    
    static struct option longOptions[] = {
        {"host", required_argument, nullptr, 'H'},
        {"port", required_argument, nullptr, 'p'},
        {"kdb", required_argument, nullptr, 'k'},
        {"wave", required_argument, nullptr, 'w'},
        {"connections", required_argument, nullptr, 'c'},
        {"threads", required_argument, nullptr, 't'},
        {"verbose", no_argument, nullptr, 'v'},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0}
    };
    
    int opt;
    while ((opt = getopt_long(argc, argv, "H:p:k:w:c:t:vh", longOptions, nullptr)) != -1) {
        switch (opt) {
            case 'H':
                config.host = optarg;
                break;
            case 'p':
                config.port = static_cast<uint16_t>(std::stoi(optarg));
                break;
            case 'k':
                config.kdbPath = optarg;
                break;
            case 'w':
                config.wavePath = optarg;
                break;
            case 'c':
                config.maxConnections = std::stoi(optarg);
                break;
            case 't':
                config.threadPoolSize = std::stoi(optarg);
                break;
            case 'v':
                config.verbose = true;
                break;
            case 'h':
            default:
                std::cout << "Usage: " << argv[0] << " [options]\n"
                          << "Options:\n"
                          << "  -H, --host <host>       Bind address (default: 0.0.0.0)\n"
                          << "  -p, --port <port>       Server port (default: 8080)\n"
                          << "  -k, --kdb <path>        Knowledge database file path\n"
                          << "  -w, --wave <path>       Waveform file path\n"
                          << "  -c, --connections <n>   Max connections (default: 10)\n"
                          << "  -t, --threads <n>       Thread pool size (default: 4)\n"
                          << "  -v, --verbose           Verbose output\n"
                          << "  -h, --help              Show this help\n";
                exit(opt == 'h' ? 0 : 1);
        }
    }
    
    return config;
}

void ServerConfig::print() const {
    std::cout << "Server Configuration:\n"
              << "  Host: " << host << "\n"
              << "  Port: " << port << "\n"
              << "  KDB Path: " << (kdbPath.empty() ? "(not specified)" : kdbPath) << "\n"
              << "  Wave Path: " << (wavePath.empty() ? "(not specified)" : wavePath) << "\n"
              << "  Max Connections: " << maxConnections << "\n"
              << "  Thread Pool Size: " << threadPoolSize << "\n"
              << "  Verbose: " << (verbose ? "yes" : "no") << "\n";
}

}
