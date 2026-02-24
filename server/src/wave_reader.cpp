#include "wave_reader.h"
// #include "wave_fst.h"  // TODO: Enable when FST library is available
#include "wave_evcd.h"
#include <filesystem>
#include <algorithm>

namespace hwda {

std::unique_ptr<WaveReader> WaveReader::create(WaveFormat format) {
    switch (format) {
        case WaveFormat::FST:
            // TODO: Enable when FST library is available
            // return std::make_unique<WaveFst>();
            return nullptr;
        case WaveFormat::EVCD:
            return std::make_unique<WaveEvcd>();
        default:
            return nullptr;
    }
}

WaveFormat WaveReader::detectFormat(const std::string& path) {
    std::filesystem::path filePath(path);
    std::string ext = filePath.extension().string();
    
    std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
    
    if (ext == ".fst") {
        return WaveFormat::FST;
    } else if (ext == ".evcd" || ext == ".vcd") {
        return WaveFormat::EVCD;
    }
    
    std::ifstream file(path, std::ios::binary);
    if (file.is_open()) {
        char header[4];
        file.read(header, 4);
        file.close();
        
        if (header[0] == 'F' && header[1] == 'S' && header[2] == 'T') {
            return WaveFormat::FST;
        }
        if (header[0] == '$') {
            return WaveFormat::EVCD;
        }
    }
    
    return WaveFormat::Unknown;
}

}
