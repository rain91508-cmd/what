#include "wave_fst.h"
#include <iostream>

namespace hwda {

WaveFst::WaveFst() = default;
WaveFst::~WaveFst() {
    close();
}

bool WaveFst::open(const std::string& path) {
    fstCtx_ = fstReaderOpen(path.c_str());
    if (!fstCtx_) {
        std::cerr << "Failed to open FST file: " << path << "\n";
        return false;
    }
    
    info_.filePath = path;
    info_.format = WaveFormat::FST;
    
    auto startTime = fstReaderGetStartTime(fstCtx_);
    auto endTime = fstReaderGetEndTime(fstCtx_);
    info_.startTime = static_cast<TimeValue>(startTime);
    info_.endTime = static_cast<TimeValue>(endTime);
    
    loadSignalList();
    info_.signalCount = signals_.size();
    
    isOpen_ = true;
    return true;
}

void WaveFst::close() {
    if (fstCtx_) {
        fstReaderClose(fstCtx_);
        fstCtx_ = nullptr;
    }
    isOpen_ = false;
}

bool WaveFst::isOpen() const {
    return isOpen_;
}

WaveInfo WaveFst::getInfo() const {
    return info_;
}

std::vector<SignalInfo> WaveFst::getSignals() const {
    return signals_;
}

void WaveFst::loadSignalList() {
    if (!fstCtx_) return;
    
    struct fstHier* hier;
    fstReaderSetFacProcessMaskAll(fstCtx_);
    
    SignalId idCounter = 0;
    
    while ((hier = fstReaderIterateHier(fstCtx_)) != nullptr) {
        if (hier->htyp == FST_HT_SCOPE) {
            // Handle scope
        } else if (hier->htyp == FST_HT_VAR) {
            SignalInfo sig;
            sig.id = idCounter++;
            sig.name = hier->u.var.name;
            sig.fullPath = hier->u.var.name;
            sig.bitWidth = hier->u.var.length;
            sig.type = SignalType::Wire;
            sig.direction = SignalDirection::Internal;
            signals_.push_back(sig);
            
            handleMap_[sig.id] = hier->u.var.handle;
        }
    }
}

void WaveFst::buildSignalIndex() {
    for (size_t i = 0; i < signals_.size(); ++i) {
        signalIndex_[signals_[i].id] = i;
    }
}

WaveData WaveFst::getSignalData(SignalId signalId, TimeValue start, TimeValue end) const {
    WaveData data;
    data.signalId = signalId;
    
    auto it = handleMap_.find(signalId);
    if (it == handleMap_.end()) return data;
    
    fstHandle handle = it->second;
    
    fstReaderSetFacProcessMask(fstCtx_, handle);
    
    // Callback for value changes
    auto callback = [](void* userData, uint64_t time, fstHandle facHandle, const unsigned char* value, uint32_t len) {
        auto* waveData = static_cast<WaveData*>(userData);
        WaveDataPoint point;
        point.time = time;
        point.value.value = std::string(reinterpret_cast<const char*>(value), len);
        point.value.valid = true;
        point.value.state = (len == 1) ? value[0] : '0';
        waveData->points.push_back(point);
    };
    
    fstReaderIterBlocks2(fstCtx_, callback, nullptr, const_cast<WaveData*>(&data), start, end);
    
    return data;
}

SignalValue WaveFst::getSignalValue(SignalId signalId, TimeValue time) const {
    SignalValue value;
    value.valid = false;
    value.state = 'X';
    
    auto it = handleMap_.find(signalId);
    if (it == handleMap_.end()) return value;
    
    // Get value at specific time
    char* val = fstReaderGetValueFromHandleAtTime(fstCtx_, time, it->second, nullptr);
    if (val) {
        value.value = val;
        value.valid = true;
        value.state = (strlen(val) == 1) ? val[0] : '0';
        free(val);
    }
    
    return value;
}

}
