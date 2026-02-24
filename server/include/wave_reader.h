#ifndef HWDA_SERVER_WAVE_READER_H
#define HWDA_SERVER_WAVE_READER_H

#include "types.h"
#include <string>
#include <vector>
#include <memory>
#include <unordered_map>

namespace hwda {

enum class WaveFormat {
    Unknown,
    FST,
    EVCD
};

struct WaveInfo {
    std::string filePath;
    WaveFormat format;
    TimeValue startTime;
    TimeValue endTime;
    TimeValue timeScale;
    std::string timeUnit;
    size_t signalCount;
};

class WaveReader {
public:
    virtual ~WaveReader() = default;
    
    virtual bool open(const std::string& path) = 0;
    virtual void close() = 0;
    virtual bool isOpen() const = 0;
    
    virtual WaveInfo getInfo() const = 0;
    virtual std::vector<SignalInfo> getSignals() const = 0;
    
    virtual WaveData getSignalData(SignalId signalId, TimeValue start, TimeValue end) const = 0;
    virtual SignalValue getSignalValue(SignalId signalId, TimeValue time) const = 0;
    
    static std::unique_ptr<WaveReader> create(WaveFormat format);
    static WaveFormat detectFormat(const std::string& path);
};

}

#endif
