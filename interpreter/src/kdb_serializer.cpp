#include "kdb_serializer.h"
#include <fstream>
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

void KdbSerializer::writeModules(std::vector<uint8_t>& buffer, const std::vector<ModuleInfo>& modules) {
    writeUint32(buffer, static_cast<uint32_t>(modules.size()));
    
    for (const auto& mod : modules) {
        writeString(buffer, mod.name);
        writeString(buffer, mod.fullName);
        writeUint64(buffer, mod.id);
        writeUint64(buffer, mod.fileId);
        
        // Write ports
        writeUint32(buffer, static_cast<uint32_t>(mod.ports.size()));
        for (const auto& port : mod.ports) {
            writeString(buffer, port.name);
            writeUint32(buffer, static_cast<uint32_t>(port.direction));
            writeUint32(buffer, static_cast<uint32_t>(port.type));
        }
    }
}

void KdbSerializer::writeSignals(std::vector<uint8_t>& buffer, const std::vector<SignalInfo>& signals) {
    writeUint32(buffer, static_cast<uint32_t>(signals.size()));
    
    for (const auto& sig : signals) {
        writeUint64(buffer, sig.id);
        writeString(buffer, sig.name);
        writeString(buffer, sig.fullName);
        writeUint32(buffer, static_cast<uint32_t>(sig.type));
        writeUint64(buffer, sig.parentModuleId);
    }
}

void KdbSerializer::writeConnections(std::vector<uint8_t>& buffer, const std::vector<ModuleInstanceInfo::PortConnection>& connections) {
    writeUint32(buffer, static_cast<uint32_t>(connections.size()));
    
    for (const auto& conn : connections) {
        writeUint64(buffer, conn.portId);
        writeString(buffer, conn.connectionExpr);
        writeUint64(buffer, conn.connectedSignalId);
    }
}

void KdbSerializer::writeSourceFiles(std::vector<uint8_t>& buffer, const std::vector<SourceFileInfo>& files) {
    writeUint32(buffer, static_cast<uint32_t>(files.size()));
    
    for (const auto& file : files) {
        writeUint64(buffer, file.id);
        writeString(buffer, file.path);
        writeString(buffer, file.hash);
        writeUint64(buffer, file.lineCount);
    }
}

std::vector<uint8_t> KdbSerializer::serializeToBuffer(const KdbBuilder& builder) {
    std::vector<uint8_t> buffer;
    
    writeHeader(buffer);
    
    // Get all modules and signals
    auto modules = builder.getAllModules();
    std::vector<ModuleInfo> moduleInfos;
    for (const auto* mod : modules) {
        if (mod) moduleInfos.push_back(*mod);
    }
    writeModules(buffer, moduleInfos);
    
    auto signals = builder.getAllSignals();
    std::vector<SignalInfo> signalInfos;
    for (const auto* sig : signals) {
        if (sig) signalInfos.push_back(*sig);
    }
    writeSignals(buffer, signalInfos);
    
    // TODO: Implement connection and source file writing
    std::vector<ModuleInstanceInfo::PortConnection> connections;
    writeConnections(buffer, connections);
    
    std::vector<SourceFileInfo> sourceFiles;
    writeSourceFiles(buffer, sourceFiles);
    
    // Return uncompressed buffer for now
    return buffer;
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
