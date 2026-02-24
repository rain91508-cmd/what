#ifndef HWDA_SERVER_WAVE_EVCD_H
#define HWDA_SERVER_WAVE_EVCD_H

#include "wave_reader.h"
#include <fstream>
#include <unordered_map>

namespace hwda {

class WaveEvcd : public WaveReader {
public:
    WaveEvcd();
    ~WaveEvcd() override;
    
    bool open(const std::string& path) override;
    void close() override;
    bool isOpen() const override;
    
    WaveInfo getInfo() const override;
    std::vector<SignalInfo> getSignals() const override;
    
    WaveData getSignalData(SignalId signalId, TimeValue start, TimeValue end) const override;
    SignalValue getSignalValue(SignalId signalId, TimeValue time) const override;
    
private:
    bool parseHeader();
    bool parseValueChanges();
    void buildSignalIndex();
    
    std::ifstream file_;
    bool isOpen_{false};
    WaveInfo info_;
    std::vector<SignalInfo> signals_;
    
    std::unordered_map<SignalId, size_t> signalIndex_;
    std::unordered_map<std::string, SignalId> codeToId_;
    
    struct ValueChange {
        TimeValue time;
        SignalId signalId;
        char value;
    };
    std::vector<ValueChange> valueChanges_;
};

}

#endif
