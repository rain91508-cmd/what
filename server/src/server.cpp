#include "server.h"
#include "api_handler.h"
#include "kdb_loader.h"
#include "wave_reader.h"
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <iostream>
#include <cstring>

namespace hwda {

Server::Server(const ServerConfig& config)
    : config_(config)
    , kdbLoader_(std::make_unique<KdbLoader>())
{
}

Server::~Server() {
    stop();
}

bool Server::start() {
    if (!config_.kdbPath.empty()) {
        if (!kdbLoader_->load(config_.kdbPath)) {
            std::cerr << "Failed to load knowledge database: " << config_.kdbPath << "\n";
            return false;
        }
        std::cout << "Loaded knowledge database: " << config_.kdbPath 
                  << " (" << kdbLoader_->getFileSize() << " bytes)\n";
    }
    
    if (!config_.wavePath.empty()) {
        auto format = WaveReader::detectFormat(config_.wavePath);
        if (format == WaveFormat::Unknown) {
            std::cerr << "Unknown waveform format: " << config_.wavePath << "\n";
            return false;
        }
        waveReader_ = WaveReader::create(format);
        if (!waveReader_->open(config_.wavePath)) {
            std::cerr << "Failed to open waveform file: " << config_.wavePath << "\n";
            return false;
        }
        auto info = waveReader_->getInfo();
        std::cout << "Loaded waveform file: " << config_.wavePath 
                  << " (format: " << (format == WaveFormat::FST ? "FST" : "EVCD")
                  << ", signals: " << info.signalCount << ")\n";
    }
    
    apiHandler_ = std::make_unique<ApiHandler>(kdbLoader_.get(), waveReader_.get());
    
    serverFd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (serverFd_ < 0) {
        std::cerr << "Failed to create socket: " << strerror(errno) << "\n";
        return false;
    }
    
    int opt = 1;
    setsockopt(serverFd_, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    
    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(config_.port);
    inet_pton(AF_INET, config_.host.c_str(), &addr.sin_addr);
    
    if (bind(serverFd_, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        std::cerr << "Failed to bind: " << strerror(errno) << "\n";
        close(serverFd_);
        return false;
    }
    
    if (listen(serverFd_, config_.maxConnections) < 0) {
        std::cerr << "Failed to listen: " << strerror(errno) << "\n";
        close(serverFd_);
        return false;
    }
    
    running_ = true;
    return true;
}

void Server::stop() {
    if (!running_) return;
    
    running_ = false;
    
    if (serverFd_ >= 0) {
        close(serverFd_);
        serverFd_ = -1;
    }
    
    for (auto& thread : workerThreads_) {
        if (thread.joinable()) {
            thread.join();
        }
    }
    workerThreads_.clear();
    
    if (waveReader_) {
        waveReader_->close();
    }
}

void Server::run() {
    while (running_) {
        acceptConnections();
    }
}

void Server::acceptConnections() {
    struct sockaddr_in clientAddr;
    socklen_t clientLen = sizeof(clientAddr);
    
    int clientFd = accept(serverFd_, (struct sockaddr*)&clientAddr, &clientLen);
    if (clientFd < 0) {
        if (running_) {
            std::cerr << "Accept failed: " << strerror(errno) << "\n";
        }
        return;
    }
    
    if (config_.verbose) {
        char clientIp[INET_ADDRSTRLEN];
        inet_ntop(AF_INET, &clientAddr.sin_addr, clientIp, sizeof(clientIp));
        std::cout << "Client connected: " << clientIp << ":" << ntohs(clientAddr.sin_port) << "\n";
    }
    
    handleClient(clientFd);
    close(clientFd);
}

void Server::handleClient(int clientFd) {
    char buffer[4096];
    std::string request;
    
    while (running_) {
        ssize_t bytesRead = recv(clientFd, buffer, sizeof(buffer) - 1, 0);
        if (bytesRead <= 0) break;
        
        buffer[bytesRead] = '\0';
        request += buffer;
        
        if (request.find("\r\n\r\n") != std::string::npos) {
            break;
        }
    }
    
    if (request.empty()) return;
    
    HttpRequest req;
    size_t pos = request.find(' ');
    if (pos != std::string::npos) {
        req.method = request.substr(0, pos);
        size_t pathStart = pos + 1;
        size_t pathEnd = request.find(' ', pathStart);
        if (pathEnd != std::string::npos) {
            req.path = request.substr(pathStart, pathEnd - pathStart);
        }
    }
    
    size_t paramPos = req.path.find('?');
    if (paramPos != std::string::npos) {
        std::string params = req.path.substr(paramPos + 1);
        req.path = req.path.substr(0, paramPos);
        
        size_t start = 0;
        while (start < params.size()) {
            size_t eqPos = params.find('=', start);
            size_t ampPos = params.find('&', start);
            
            if (eqPos != std::string::npos) {
                std::string key = params.substr(start, eqPos - start);
                size_t valueEnd = (ampPos != std::string::npos) ? ampPos : params.size();
                std::string value = params.substr(eqPos + 1, valueEnd - eqPos - 1);
                req.params[key] = value;
            }
            
            start = (ampPos != std::string::npos) ? ampPos + 1 : params.size();
        }
    }
    
    HttpResponse resp = apiHandler_->handle(req);
    
    std::string response = "HTTP/1.1 " + std::to_string(resp.statusCode) + " " + resp.statusText + "\r\n";
    for (const auto& [key, value] : resp.headers) {
        response += key + ": " + value + "\r\n";
    }
    response += "Connection: close\r\n";
    response += "\r\n";
    response += resp.body;
    
    send(clientFd, response.c_str(), response.size(), 0);
}

}
