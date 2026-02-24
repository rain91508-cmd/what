#include "wave_evcd.h"
#include <iostream>
#include <sstream>
#include <algorithm>

namespace hwda {

WaveEvcd::WaveEvcd() = default;
WaveEvcd::~WaveEvcd() {
    close();
}

bool WaveEvcd::open(const std::string& path) {
    file_.open(path);
    if (!file_.is_open()) {
        std::cerr << "Failed to open EVCD file: " << path << "\n";
        return false;
    }
    
    info_.filePath = path;
    info_.format = WaveFormat::EVCD;
    
    if (!parseHeader()) {
        std::cerr << "Failed to parse EVCD header\n";
        close();
        return false;
    }
    
    isOpen_ = true;
    return true;
}

void WaveEvcd::close() {
    if (file_.is_open()) {
        file_.close();
    }
    isOpen_ = false;
}

bool WaveEvcd::isOpen() const {
    return isOpen_;
}

WaveInfo WaveEvcd::getInfo() const {
    return info_;
}

std::vector<SignalInfo> WaveEvcd::getSignals() const {
    return signals_;
}

bool WaveEvcd::parseHeader() {
    std::string line;
    SignalId idCounter = 0;
    
    while (std::getline(file_, line)) {
        if (line.empty() || line[0] == '$') {
            if (line.find("$timescale") == 0) {
                // Parse timescale
            } else if (line.find("$scope") == 0) {
                // Parse scope
            } else if (line.find("$var") == 0) {
                std::istringstream iss(line);
                std::string var, type, code, name;
                int width;
                
                iss >> var >> type >> width >> code >> name;
                
                SignalInfo sig;
                sig.id = idCounter++;
                sig.name = name;
                sig.fullPath = name;
                sig.bitWidth = width;
                sig.type = SignalType::Wire;
                sig.direction = SignalDirection::Internal;
                signals_.push_back(sig);
                
                codeToId_[code] = sig.id;
            } else if (line.find("$enddefinitions") == 0) {
                break;
            }
        }
    }
    
    info_.signalCount = signals_.size();
    info_.startTime = 0;
    info_.endTime = 0;
    
    buildSignalIndex();
    return true;
}

bool WaveEvcd::parseValueChanges() {
    std::string line;
    TimeValue currentTime = 0;
    
    while (std::getline(file_, line)) {
        if (line.empty()) continue;
        
        if (line[0] == '#') {
            currentTime = std::stoull(line.substr(1));
            if (currentTime > info_.endTime) {
                info_.endTime = currentTime;
            }
        } else {
            char value = line[0];
            std::string code = line.substr(1);
            
            auto it = codeToId_.find(code);
            if (it != codeToId_.end()) {
                ValueChange vc;
                vc.time = currentTime;
                vc.signalId = it->second;
                vc.value = value;
                valueChanges_.push_back(vc);
            }
        }
    }
    
    return true;
}

void WaveEvcd::buildSignalIndex() {
    for (size_t i = 0; i < signals_.size(); ++i) {
        signalIndex_[signals_[i].id] = i;
    }
}

WaveData WaveEvcd::getSignalData(SignalId signalId, TimeValue start, TimeValue end) const {
    WaveData data;
    data.signalId = signalId;
    
    for (const auto& vc : valueChanges_) {
        if (vc.signalId == signalId && vc.time >= start && vc.time <= end) {
            WaveDataPoint point;
            point.time = vc.time;
            point.value.value = std::string(1, vc.value);
            point.value.valid = true;
            point.value.state = vc.value;
            data.points.push_back(point);
        }
    }
    
    return data;
}

SignalValue WaveEvcd::getSignalValue(SignalId signalId, TimeValue time) const {
    SignalValue value;
    value.valid = false;
    value.state = 'X';
    
    for (auto it = valueChanges_.rbegin(); it != valueChanges_.rend(); ++it) {
        if (it->signalId == signalId && it->time <= time) {
            value.value = std::string(1, it->value);
            value.valid = true;
            value.state = it->value;
            break;
        }
    }
    
    return value;
}

}
