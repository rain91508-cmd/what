#ifndef HWDA_SERVER_SERVER_H
#define HWDA_SERVER_SERVER_H

#include "config.h"
#include "types.h"
#include <memory>
#include <functional>
#include <thread>
#include <atomic>

namespace hwda {

class ApiHandler;
class KdbLoader;
class WaveReader;

class Server {
public:
    Server(const ServerConfig& config);
    ~Server();
    
    bool start();
    void stop();
    void run();
    
    bool isRunning() const { return running_; }
    uint16_t getPort() const { return config_.port; }
    
private:
    void acceptConnections();
    void handleClient(int clientFd);
    
    ServerConfig config_;
    std::atomic<bool> running_{false};
    int serverFd_{-1};
    
    std::unique_ptr<ApiHandler> apiHandler_;
    std::unique_ptr<KdbLoader> kdbLoader_;
    std::unique_ptr<WaveReader> waveReader_;
    
    std::vector<std::thread> workerThreads_;
};

}

#endif
