#ifndef HWDA_INTERPRETER_KDB_SERIALIZER_H
#define HWDA_INTERPRETER_KDB_SERIALIZER_H

#include "kdb_builder.h"
#include <string>
#include <vector>
#include <cstdint>

namespace hwda {
namespace interpreter {

class KdbSerializer {
public:
    KdbSerializer();
    ~KdbSerializer();
    
    bool serialize(const KdbBuilder& builder, const std::string& outputPath);
    std::vector<uint8_t> serializeToBuffer(const KdbBuilder& builder);
    
    void setCompressionLevel(int level) { compressionLevel_ = level; }
    int getCompressionLevel() const { return compressionLevel_; }
    
private:
    void writeHeader(std::vector<uint8_t>& buffer);
    void writeModules(std::vector<uint8_t>& buffer, const std::vector<KdbModule>& modules);
    void writeSignals(std::vector<uint8_t>& buffer, const std::vector<KdbSignal>& signals);
    void writeConnections(std::vector<uint8_t>& buffer, const std::vector<KdbConnection>& connections);
    void writeSourceFiles(std::vector<uint8_t>& buffer, const std::vector<KdbSourceFile>& files);
    
    void writeString(std::vector<uint8_t>& buffer, const std::string& str);
    void writeUint32(std::vector<uint8_t>& buffer, uint32_t value);
    void writeUint64(std::vector<uint8_t>& buffer, uint64_t value);
    void writeInt32(std::vector<uint8_t>& buffer, int32_t value);
    
    int compressionLevel_{3};
};

}

#endif
