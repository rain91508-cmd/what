#ifndef HWDA_INTERPRETER_BIT_WIDTH_EXTRACTOR_H
#define HWDA_INTERPRETER_BIT_WIDTH_EXTRACTOR_H

#include <cstdint>

namespace UHDM {
    class BaseClass;
    class base;
}

namespace hwda {
namespace interpreter {

// Extract bit width (msb, lsb) from UHDM objects
// Currently a simplified implementation that returns default values
// Full implementation would require proper vpiHandle traversal
void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector);

// Overload for UHDM::base type (used in surelog_interpreter)
void extractBitWidthFromUhdmObject(UHDM::base* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector);

}
}

#endif
