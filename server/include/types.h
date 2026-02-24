#ifndef HWDA_SERVER_TYPES_H
#define HWDA_SERVER_TYPES_H

#include <string>
#include <vector>
#include <cstdint>
#include <optional>

namespace hwda {

using SignalId = uint64_t;
using TimeValue = uint64_t;

enum class SignalType {
    Wire,
    Reg,
    Logic,
    Bit,
    Integer,
    Real,
    Enum,
    Struct,
    Unknown
};

enum class SignalDirection {
    Input,
    Output,
    Inout,
    Internal
};

struct SignalValue {
    std::string value;
    bool valid;
    char state; // '0', '1', 'X', 'Z'
};

struct SignalInfo {
    SignalId id;
    std::string name;
    std::string fullPath;
    int bitWidth;
    SignalType type;
    SignalDirection direction;
    std::string filePath;
    int lineNumber;
};

struct TimeRange {
    TimeValue start;
    TimeValue end;
};

struct WaveDataPoint {
    TimeValue time;
    SignalValue value;
};

struct WaveData {
    SignalId signalId;
    std::vector<WaveDataPoint> points;
};

struct DriverInfo {
    SignalId driverId;
    std::string driverPath;
    std::string filePath;
    int lineNumber;
};

struct LoadInfo {
    SignalId loadId;
    std::string loadPath;
    std::string filePath;
    int lineNumber;
};

}

#endif
