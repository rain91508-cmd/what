#ifndef HWDA_SERVER_WAVE_FST_H
#define HWDA_SERVER_WAVE_FST_H

#include "wave_reader.h"
#include <fstapi.h>

namespace hwda {

class WaveFst : public WaveReader {
public:
    WaveFst();
    ~WaveFst() override;
    
    bool open(const std::string& path) override;
    void close() override;
    bool isOpen() const override;
    
    WaveInfo getInfo() const override;
    std::vector<SignalInfo> getSignals() const override;
    
    WaveData getSignalData(SignalId signalId, TimeValue start, TimeValue end) const override;
    SignalValue getSignalValue(SignalId signalId, TimeValue time) const override;
    
private:
    void loadSignalList();
    void buildSignalIndex();
    
    fstHandle fstCtx_{nullptr};
    bool isOpen_{false};
    WaveInfo info_;
    std::vector<SignalInfo> signals_;
    std::unordered_map<SignalId, fstHandle> handleMap_;
};

}

#endif
