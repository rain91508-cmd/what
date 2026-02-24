#include "api_handler.h"
#include "kdb_loader.h"
#include "wave_reader.h"
#include <sstream>
#include <algorithm>

namespace hwda {

HttpResponse HttpResponse::ok(const std::string& body, const std::string& contentType) {
    HttpResponse resp;
    resp.statusCode = 200;
    resp.statusText = "OK";
    resp.headers["Content-Type"] = contentType;
    resp.headers["Access-Control-Allow-Origin"] = "*";
    resp.body = body;
    return resp;
}

HttpResponse HttpResponse::notFound() {
    HttpResponse resp;
    resp.statusCode = 404;
    resp.statusText = "Not Found";
    resp.headers["Content-Type"] = "application/json";
    resp.headers["Access-Control-Allow-Origin"] = "*";
    resp.body = R"({"status":"error","data":null,"error":{"code":"NOT_FOUND","message":"Resource not found"}})";
    return resp;
}

HttpResponse HttpResponse::error(int code, const std::string& message) {
    HttpResponse resp;
    resp.statusCode = code;
    resp.statusText = "Error";
    resp.headers["Content-Type"] = "application/json";
    resp.headers["Access-Control-Allow-Origin"] = "*";
    
    nlohmann::json j;
    j["status"] = "error";
    j["data"] = nullptr;
    j["error"]["code"] = code;
    j["error"]["message"] = message;
    resp.body = j.dump();
    return resp;
}

HttpResponse HttpResponse::binary(const std::vector<uint8_t>& data, const std::string& contentType) {
    HttpResponse resp;
    resp.statusCode = 200;
    resp.statusText = "OK";
    resp.headers["Content-Type"] = contentType;
    resp.headers["Access-Control-Allow-Origin"] = "*";
    resp.headers["Content-Length"] = std::to_string(data.size());
    resp.body.assign(data.begin(), data.end());
    return resp;
}

ApiHandler::ApiHandler(KdbLoader* kdbLoader, WaveReader* waveReader)
    : kdbLoader_(kdbLoader)
    , waveReader_(waveReader)
{
    registerRoutes();
}

void ApiHandler::registerRoutes() {
    routes_["/api/kdb"] = [this](const HttpRequest& req) {
        if (req.method == "GET") return handleKdbInfo(req);
        return HttpResponse::error(405, "Method not allowed");
    };
    
    routes_["/api/kdb/data"] = [this](const HttpRequest& req) {
        if (req.method == "GET") return handleKdbData(req);
        return HttpResponse::error(405, "Method not allowed");
    };
    
    routes_["/api/wave/info"] = [this](const HttpRequest& req) {
        if (req.method == "GET") return handleWaveInfo(req);
        return HttpResponse::error(405, "Method not allowed");
    };
    
    routes_["/api/wave/signals"] = [this](const HttpRequest& req) {
        if (req.method == "GET") return handleWaveSignals(req);
        return HttpResponse::error(405, "Method not allowed");
    };
    
    routes_["/api/wave/data"] = [this](const HttpRequest& req) {
        if (req.method == "GET") return handleWaveData(req);
        return HttpResponse::error(405, "Method not allowed");
    };
    
    routes_["/api/wave/value"] = [this](const HttpRequest& req) {
        if (req.method == "GET") return handleWaveValue(req);
        return HttpResponse::error(405, "Method not allowed");
    };
}

HttpResponse ApiHandler::handle(const HttpRequest& request) {
    auto it = routes_.find(request.path);
    if (it != routes_.end()) {
        return it->second(request);
    }
    return HttpResponse::notFound();
}

HttpResponse ApiHandler::handleKdbInfo(const HttpRequest& req) {
    if (!kdbLoader_ || !kdbLoader_->isLoaded()) {
        return HttpResponse::error(404, "Knowledge database not loaded");
    }
    
    nlohmann::json j;
    j["status"] = "success";
    j["data"]["size"] = kdbLoader_->getFileSize();
    j["data"]["version"] = kdbLoader_->getVersion();
    j["data"]["checksum"] = kdbLoader_->getChecksum();
    j["data"]["signal_count"] = kdbLoader_->getSignals().size();
    j["data"]["module_count"] = kdbLoader_->getModules().size();
    j["error"] = nullptr;
    
    return HttpResponse::ok(j.dump());
}

HttpResponse ApiHandler::handleKdbData(const HttpRequest& req) {
    if (!kdbLoader_ || !kdbLoader_->isLoaded()) {
        return HttpResponse::error(404, "Knowledge database not loaded");
    }
    
    auto data = kdbLoader_->serialize();
    return HttpResponse::binary(data, "application/octet-stream");
}

HttpResponse ApiHandler::handleWaveInfo(const HttpRequest& req) {
    if (!waveReader_ || !waveReader_->isOpen()) {
        return HttpResponse::error(404, "Waveform file not loaded");
    }
    
    auto info = waveReader_->getInfo();
    
    nlohmann::json j;
    j["status"] = "success";
    j["data"]["file_path"] = info.filePath;
    j["data"]["format"] = info.format == WaveFormat::FST ? "FST" : "EVCD";
    j["data"]["start_time"] = info.startTime;
    j["data"]["end_time"] = info.endTime;
    j["data"]["time_scale"] = info.timeScale;
    j["data"]["time_unit"] = info.timeUnit;
    j["data"]["signal_count"] = info.signalCount;
    j["error"] = nullptr;
    
    return HttpResponse::ok(j.dump());
}

HttpResponse ApiHandler::handleWaveSignals(const HttpRequest& req) {
    if (!waveReader_ || !waveReader_->isOpen()) {
        return HttpResponse::error(404, "Waveform file not loaded");
    }
    
    auto signals = waveReader_->getSignals();
    
    nlohmann::json j;
    j["status"] = "success";
    j["data"] = nlohmann::json::array();
    
    for (const auto& sig : signals) {
        nlohmann::json sigJson;
        sigJson["id"] = sig.id;
        sigJson["name"] = sig.name;
        sigJson["full_path"] = sig.fullPath;
        sigJson["bit_width"] = sig.bitWidth;
        j["data"].push_back(sigJson);
    }
    
    j["error"] = nullptr;
    return HttpResponse::ok(j.dump());
}

HttpResponse ApiHandler::handleWaveData(const HttpRequest& req) {
    if (!waveReader_ || !waveReader_->isOpen()) {
        return HttpResponse::error(404, "Waveform file not loaded");
    }
    
    auto signalsIt = req.params.find("signals");
    auto startIt = req.params.find("start");
    auto endIt = req.params.find("end");
    
    if (signalsIt == req.params.end()) {
        return HttpResponse::error(400, "Missing 'signals' parameter");
    }
    
    TimeValue start = startIt != req.params.end() ? std::stoull(startIt->second) : 0;
    TimeValue end = endIt != req.params.end() ? std::stoull(endIt->second) : UINT64_MAX;
    
    std::vector<SignalId> signalIds;
    std::istringstream ss(signalsIt->second);
    std::string token;
    while (std::getline(ss, token, ',')) {
        signalIds.push_back(std::stoull(token));
    }
    
    nlohmann::json j;
    j["status"] = "success";
    j["data"]["time_range"]["start"] = start;
    j["data"]["time_range"]["end"] = end;
    j["data"]["signals"] = nlohmann::json::array();
    
    for (SignalId id : signalIds) {
        auto waveData = waveReader_->getSignalData(id, start, end);
        
        nlohmann::json sigJson;
        sigJson["signal_id"] = id;
        sigJson["values"] = nlohmann::json::array();
        
        for (const auto& point : waveData.points) {
            nlohmann::json valJson;
            valJson["time"] = point.time;
            valJson["value"] = point.value.value;
            valJson["state"] = std::string(1, point.value.state);
            sigJson["values"].push_back(valJson);
        }
        
        j["data"]["signals"].push_back(sigJson);
    }
    
    j["error"] = nullptr;
    return HttpResponse::ok(j.dump());
}

HttpResponse ApiHandler::handleWaveValue(const HttpRequest& req) {
    if (!waveReader_ || !waveReader_->isOpen()) {
        return HttpResponse::error(404, "Waveform file not loaded");
    }
    
    auto signalIt = req.params.find("signal");
    auto timeIt = req.params.find("time");
    
    if (signalIt == req.params.end() || timeIt == req.params.end()) {
        return HttpResponse::error(400, "Missing 'signal' or 'time' parameter");
    }
    
    SignalId signalId = std::stoull(signalIt->second);
    TimeValue time = std::stoull(timeIt->second);
    
    auto value = waveReader_->getSignalValue(signalId, time);
    
    nlohmann::json j;
    j["status"] = "success";
    j["data"]["signal_id"] = signalId;
    j["data"]["time"] = time;
    j["data"]["value"] = value.value;
    j["data"]["state"] = std::string(1, value.state);
    j["data"]["valid"] = value.valid;
    j["error"] = nullptr;
    
    return HttpResponse::ok(j.dump());
}

}
