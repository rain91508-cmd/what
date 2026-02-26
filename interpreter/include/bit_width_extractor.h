#ifndef HWDA_INTERPRETER_BIT_WIDTH_EXTRACTOR_H
#define HWDA_INTERPRETER_BIT_WIDTH_EXTRACTOR_H

#include <cstdint>

namespace UHDM {
    class BaseClass;
    class base;
    // Note: UHDM::any is typedef of BaseClass, not a separate class
}

namespace hwda {
namespace interpreter {

// Extract bit width (msb, lsb) from UHDM objects with context
// inst: instance context for parameter resolution (UHDM::any* which is actually BaseClass*)
// pexpr: parent expression context (UHDM::any* which is actually BaseClass*)
void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector,
                                   UHDM::BaseClass* inst, UHDM::BaseClass* pexpr);

// Backward-compatible version without context
void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector);

// Overload for UHDM::base type (used in surelog_interpreter)
void extractBitWidthFromUhdmObject(UHDM::base* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector);

}
}

#endif
