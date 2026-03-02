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
        // Note: fullName removed, reconstruct from hierarchy if needed
        // Note: id removed, use array index + 1 as implicit ID
        // Note: fileId removed, use definition.fileId instead
        writeUint64(buffer, mod.definition.fileId);

        // Count and write port signals (those with direction != UNKNOWN)
        // Use signalDefs for port information
        uint32_t portCount = 0;
        for (const auto& def : mod.signalDefs) {
            if (def.direction != PortDirection::UNKNOWN) {
                portCount++;
            }
        }
        writeUint32(buffer, portCount);
        for (const auto& def : mod.signalDefs) {
            if (def.direction != PortDirection::UNKNOWN) {
                writeString(buffer, def.name);
                writeUint32(buffer, static_cast<uint32_t>(def.direction));
                writeUint32(buffer, static_cast<uint32_t>(def.type));
            }
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

void KdbSerializer::writeSourceFiles(std::vector<uint8_t>& buffer, const std::vector<SourceFileInfo>& files,
                                     const std::vector<SourceFileContent>& contents) {
    writeUint32(buffer, static_cast<uint32_t>(files.size()));
    
    for (size_t i = 0; i < files.size(); ++i) {
        const auto& file = files[i];
        const auto& content = contents[i];
        // Note: id removed - use array index + 1 as implicit ID
        writeString(buffer, file.path);
        writeUint32(buffer, file.totalLines);
        // Write line index offsets
        writeUint32(buffer, static_cast<uint32_t>(file.lineIndexOffset.size()));
        for (uint32_t offset : file.lineIndexOffset) {
            writeUint32(buffer, offset);
        }
        // Write content as byte array
        writeUint32(buffer, static_cast<uint32_t>(content.data.size()));
        buffer.insert(buffer.end(), content.data.begin(), content.data.end());
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
    
    // Get all source files
    auto files = builder.getAllFiles();
    std::vector<SourceFileInfo> sourceFileInfos;
    std::vector<SourceFileContent> sourceFileContents;
    for (size_t i = 0; i < files.size(); ++i) {
        if (files[i]) {
            sourceFileInfos.push_back(*files[i]);
            // Get content by ID (array index + 1)
            const auto* content = builder.findFileContentById(static_cast<uint32_t>(i + 1));
            if (content) {
                sourceFileContents.push_back(*content);
            } else {
                sourceFileContents.push_back(SourceFileContent());
            }
        }
    }
    writeSourceFiles(buffer, sourceFileInfos, sourceFileContents);
    
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
