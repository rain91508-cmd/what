#include "kdb_loader.h"
#include <fstream>
#include <iostream>
#include <algorithm>
#include <zstd.h>

namespace hwda {

KdbLoader::KdbLoader() = default;
KdbLoader::~KdbLoader() = default;

bool KdbLoader::load(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) {
        std::cerr << "Failed to open KDB file: " << path << "\n";
        return false;
    }
    
    fileSize_ = file.tellg();
    file.seekg(0);
    
    std::vector<uint8_t> compressedData(fileSize_);
    file.read(reinterpret_cast<char*>(compressedData.data()), fileSize_);
    file.close();
    
    unsigned long long const decompressedSize = ZSTD_getFrameContentSize(compressedData.data(), fileSize_);
    if (decompressedSize == ZSTD_CONTENTSIZE_ERROR) {
        std::cerr << "Invalid KDB file format\n";
        return false;
    }
    
    std::vector<uint8_t> decompressedData(decompressedSize);
    size_t const result = ZSTD_decompress(
        decompressedData.data(), decompressedSize,
        compressedData.data(), fileSize_
    );
    
    if (ZSTD_isError(result)) {
        std::cerr << "Failed to decompress KDB: " << ZSTD_getErrorName(result) << "\n";
        return false;
    }
    
    if (!deserialize(decompressedData)) {
        std::cerr << "Failed to deserialize KDB\n";
        return false;
    }
    
    buildIndices();
    loaded_ = true;
    return true;
}

bool KdbLoader::deserialize(const std::vector<uint8_t>& data) {
    size_t offset = 0;
    
    if (data.size() < 8) return false;
    
    uint32_t magic = *reinterpret_cast<const uint32_t*>(data.data() + offset);
    offset += 4;
    
    if (magic != 0x4B444257) { // "KDBW"
        std::cerr << "Invalid KDB magic number\n";
        return false;
    }
    
    uint32_t version = *reinterpret_cast<const uint32_t*>(data.data() + offset);
    offset += 4;
    version_ = std::to_string(version);
    
    return true;
}

void KdbLoader::buildIndices() {
    for (size_t i = 0; i < signals_.size(); ++i) {
        signalIndex_[signals_[i].fullPath] = i;
    }
    
    for (size_t i = 0; i < modules_.size(); ++i) {
        moduleIndex_[modules_[i].name] = i;
    }
    
    for (size_t i = 0; i < sourceFiles_.size(); ++i) {
        fileIndex_[sourceFiles_[i].path] = i;
    }
}

std::vector<SignalInfo> KdbLoader::getSignalsByScope(const std::string& scope) const {
    std::vector<SignalInfo> result;
    for (const auto& sig : signals_) {
        if (sig.fullPath.find(scope) == 0) {
            result.push_back(sig);
        }
    }
    return result;
}

std::vector<DriverInfo> KdbLoader::getDrivers(const std::string& signalPath) const {
    std::vector<DriverInfo> drivers;
    for (const auto& conn : connections_) {
        if (conn.loadSignal == signalPath) {
            DriverInfo info;
            info.driverPath = conn.driverSignal;
            info.filePath = conn.driverInstance;
            info.lineNumber = conn.driverLine;
            drivers.push_back(info);
        }
    }
    return drivers;
}

std::vector<LoadInfo> KdbLoader::getLoads(const std::string& signalPath) const {
    std::vector<LoadInfo> loads;
    for (const auto& conn : connections_) {
        if (conn.driverSignal == signalPath) {
            LoadInfo info;
            info.loadPath = conn.loadSignal;
            info.filePath = conn.loadInstance;
            info.lineNumber = conn.loadLine;
            loads.push_back(info);
        }
    }
    return loads;
}

std::string KdbLoader::getSourceCode(const std::string& filePath) const {
    auto it = fileIndex_.find(filePath);
    if (it != fileIndex_.end()) {
        return sourceFiles_[it->second].content;
    }
    return "";
}

std::vector<uint8_t> KdbLoader::serialize() const {
    std::vector<uint8_t> result;
    
    uint32_t magic = 0x4B444257; // "KDBW"
    result.insert(result.end(), reinterpret_cast<uint8_t*>(&magic), reinterpret_cast<uint8_t*>(&magic) + 4);
    
    uint32_t version = 1;
    result.insert(result.end(), reinterpret_cast<uint8_t*>(&version), reinterpret_cast<uint8_t*>(&version) + 4);
    
    return result;
}

}
