#ifndef HWDA_SERVER_API_HANDLER_H
#define HWDA_SERVER_API_HANDLER_H

#include "types.h"
#include <string>
#include <map>
#include <functional>
#include <nlohmann/json.hpp>

namespace hwda {

class KdbLoader;
class WaveReader;

struct HttpRequest {
    std::string method;
    std::string path;
    std::map<std::string, std::string> headers;
    std::map<std::string, std::string> params;
    std::string body;
};

struct HttpResponse {
    int statusCode;
    std::string statusText;
    std::map<std::string, std::string> headers;
    std::string body;
    
    static HttpResponse ok(const std::string& body, const std::string& contentType = "application/json");
    static HttpResponse notFound();
    static HttpResponse error(int code, const std::string& message);
    static HttpResponse binary(const std::vector<uint8_t>& data, const std::string& contentType);
};

class ApiHandler {
public:
    using HandlerFunc = std::function<HttpResponse(const HttpRequest&)>;
    
    ApiHandler(KdbLoader* kdbLoader, WaveReader* waveReader);
    
    HttpResponse handle(const HttpRequest& request);
    
private:
    void registerRoutes();
    
    HttpResponse handleKdbInfo(const HttpRequest& req);
    HttpResponse handleKdbData(const HttpRequest& req);
    HttpResponse handleWaveInfo(const HttpRequest& req);
    HttpResponse handleWaveSignals(const HttpRequest& req);
    HttpResponse handleWaveData(const HttpRequest& req);
    HttpResponse handleWaveValue(const HttpRequest& req);
    
    KdbLoader* kdbLoader_;
    WaveReader* waveReader_;
    std::map<std::string, HandlerFunc> routes_;
};

}

#endif
