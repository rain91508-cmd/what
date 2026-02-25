#include "bit_width_extractor.h"

#include <uhdm/uhdm.h>

namespace hwda {
namespace interpreter {

void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
    
    // For now, we keep default values (0, 0, false)
    // Full bit width extraction requires more complex UHDM traversal
    // which would need access to the proper vpi context
}

void extractBitWidthFromUhdmObject(UHDM::base* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
    
    if (!uhdmObject) return;
    
    // Try to get vector information
    // UHDM bit width representation may need to be parsed based on specific object types
}

}
}
