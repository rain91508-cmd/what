#include "server.h"
#include "config.h"
#include <iostream>
#include <csignal>
#include <memory>

using namespace hwda;

std::unique_ptr<Server> g_server;

void signalHandler(int signal) {
    std::cout << "\nReceived signal " << signal << ", shutting down...\n";
    if (g_server) {
        g_server->stop();
    }
}

int main(int argc, char* argv[]) {
    auto config = ServerConfig::fromArgs(argc, argv);
    
    if (config.kdbPath.empty()) {
        std::cerr << "Error: Knowledge database path is required (--kdb)\n";
        return 1;
    }
    
    if (config.verbose) {
        config.print();
    }
    
    std::signal(SIGINT, signalHandler);
    std::signal(SIGTERM, signalHandler);
    
    try {
        g_server = std::make_unique<Server>(config);
        
        if (!g_server->start()) {
            std::cerr << "Failed to start server\n";
            return 1;
        }
        
        std::cout << "Server started on " << config.host << ":" << config.port << "\n";
        std::cout << "Press Ctrl+C to stop\n";
        
        g_server->run();
        
    } catch (const std::exception& e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
    
    std::cout << "Server stopped\n";
    return 0;
}
