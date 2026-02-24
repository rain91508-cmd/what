#include "kdb_serializer.h"
#include <fstream>
#include <zstd.h>
#include <iostream>

namespace hwda {
namespace interpreter {

KdbSerializer::KdbSerializer() = default;
KdbSerializer::~KdbSerializer() = default;

void KdbSerializer::writeString(std::vector<uint8_t>& buffer, const std::string& str) {
    writeUint32(buffer, static_cast<uint32_t>(str.size()));
    buffer.insert(buffer.end(), str.begin(), str.end());
}

void KdbSerializer::writeUint32(std::vector<uint8_t>& buffer, uint32_t value) {
    buffer.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
}

void KdbSerializer::writeUint64(std::vector<uint8_t>& buffer, uint64_t value) {
    buffer.push_back(static_cast<uint8_t>(value & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 8) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 16) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 24) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 32) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 40) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 48) & 0xFF));
    buffer.push_back(static_cast<uint8_t>((value >> 56) & 0xFF));
}

void KdbSerializer::writeInt32(std::vector<uint8_t>& buffer, int32_t value) {
    writeUint32(buffer, static_cast<uint32_t>(value));
}

void KdbSerializer::writeHeader(std::vector<uint8_t>& buffer) {
    // Magic number: "KDBW" (Knowledge DataBase for Web)
    buffer.push_back('K');
    buffer.push_back('D');
    buffer.push_back('B');
    buffer.push_back('W');
    
    // Version
    writeUint32(buffer, 1);
}

void KdbSerializer::writeModules(std::vector<uint8_t>& buffer, const std::vector<KdbModule>& modules) {
    writeUint32(buffer, static_cast<uint32_t>(modules.size()));
    
    for (const auto& mod : modules) {
        writeString(buffer, mod.name);
        writeString(buffer, mod.filePath);
        writeInt32(buffer, mod.startLine);
        writeInt32(buffer, mod.endLine);
        
        writeUint32(buffer, static_cast<uint32_t>(mod.ports.size()));
        for (const auto& port : mod.ports) {
            writeString(buffer, port);
        }
        
        writeUint32(buffer, static_cast<uint32_t>(mod.parameters.size()));
        for (const auto& param : mod.parameters) {
            writeString(buffer, param);
        }
    }
}

void KdbSerializer::writeSignals(std::vector<uint8_t>& buffer, const std::vector<KdbSignal>& signals) {
    writeUint32(buffer, static_cast<uint32_t>(signals.size()));
    
    for (const auto& sig : signals) {
        writeUint64(buffer, sig.id);
        writeString(buffer, sig.name);
        writeString(buffer, sig.fullPath);
        writeInt32(buffer, sig.bitWidth);
        writeString(buffer, sig.type);
        writeString(buffer, sig.direction);
        writeString(buffer, sig.filePath);
        writeInt32(buffer, sig.lineNumber);
    }
}

void KdbSerializer::writeConnections(std::vector<uint8_t>& buffer, const std::vector<KdbConnection>& connections) {
    writeUint32(buffer, static_cast<uint32_t>(connections.size()));
    
    for (const auto& conn : connections) {
        writeString(buffer, conn.driverSignal);
        writeString(buffer, conn.loadSignal);
        writeString(buffer, conn.driverInstance);
        writeString(buffer, conn.loadInstance);
        writeInt32(buffer, conn.driverLine);
        writeInt32(buffer, conn.loadLine);
    }
}

void KdbSerializer::writeSourceFiles(std::vector<uint8_t>& buffer, const std::vector<KdbSourceFile>& files) {
    writeUint32(buffer, static_cast<uint32_t>(files.size()));
    
    for (const auto& file : files) {
        writeString(buffer, file.path);
        writeString(buffer, file.content);
    }
}

std::vector<uint8_t> KdbSerializer::serializeToBuffer(const KdbBuilder& builder) {
    std::vector<uint8_t> buffer;
    
    writeHeader(buffer);
    writeModules(buffer, builder.getModules());
    writeSignals(buffer, builder.getSignals());
    writeConnections(buffer, builder.getConnections());
    writeSourceFiles(buffer, builder.getSourceFiles());
    
    size_t const compressedSize = ZSTD_compressBound(buffer.size());
    std::vector<uint8_t> compressed(compressedSize);
    
    size_t const result = ZSTD_compress(
        compressed.data(), compressedSize,
        buffer.data(), buffer.size(),
        compressionLevel_
    );
    
    if (ZSTD_isError(result)) {
        std::cerr << "ZSTD compression error: " << ZSTD_getErrorName(result) << "\n";
        return {};
    }
    
    compressed.resize(result);
    return compressed;
}

bool KdbSerializer::serialize(const KdbBuilder& builder, const std::string& outputPath) {
    auto compressed = serializeToBuffer(builder);
    if (compressed.empty()) {
        return false;
    }
    
    std::ofstream file(outputPath, std::ios::binary);
    if (!file.is_open()) {
        std::cerr << "Failed to create output file: " << outputPath << "\n";
        return false;
    }
    
    file.write(reinterpret_cast<const char*>(compressed.data()), compressed.size());
    file.close();
    
    return true;
}

}
}
