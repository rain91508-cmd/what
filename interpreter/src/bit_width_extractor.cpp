#include "bit_width_extractor.h"

#include <uhdm/uhdm.h>
#include <uhdm/ExprEval.h>

namespace hwda {
namespace interpreter {

void extractBitWidthFromUhdmObject(UHDM::BaseClass* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
    
    if (!uhdmObject) return;
    
    // Try to cast to net or logic_var types that have Ranges()
    UHDM::any* obj = uhdmObject;
    
    // Try logic_net which has Left_expr and Right_expr for bit width
    if (auto* logic_net = obj->Cast<UHDM::logic_net>()) {
        // First try to get from Ranges()
        auto ranges = logic_net->Ranges();
        if (ranges && !ranges->empty()) {
            auto* range = ranges->at(0);
            if (range) {
                UHDM::expr* leftExpr = range->Left_expr();
                UHDM::expr* rightExpr = range->Right_expr();
                if (leftExpr && rightExpr) {
                    UHDM::ExprEval eval;
                    uint64_t leftVal = eval.getValue(leftExpr);
                    uint64_t rightVal = eval.getValue(rightExpr);
                    msb = static_cast<uint32_t>(leftVal);
                    lsb = static_cast<uint32_t>(rightVal);
                    isVector = true;
                    return;
                }
            }
        }
        
        // Try Left_expr/Right_expr directly
        UHDM::expr* leftExpr = logic_net->Left_expr();
        UHDM::expr* rightExpr = logic_net->Right_expr();
        
        if (leftExpr && rightExpr) {
            UHDM::ExprEval eval;
            uint64_t leftVal = eval.getValue(leftExpr);
            uint64_t rightVal = eval.getValue(rightExpr);
            
            msb = static_cast<uint32_t>(leftVal);
            lsb = static_cast<uint32_t>(rightVal);
            isVector = true;
            return;
        }
        
        // Try to get from Typespec
        if (auto* typespec = logic_net->Typespec()) {
            if (auto* logic_typespec = typespec->Cast<UHDM::logic_typespec>()) {
                auto ranges = logic_typespec->Ranges();
                if (ranges && !ranges->empty()) {
                    auto* range = ranges->at(0);
                    if (range) {
                        UHDM::expr* leftExpr = range->Left_expr();
                        UHDM::expr* rightExpr = range->Right_expr();
                        if (leftExpr && rightExpr) {
                            UHDM::ExprEval eval;
                            uint64_t leftVal = eval.getValue(leftExpr);
                            uint64_t rightVal = eval.getValue(rightExpr);
                            msb = static_cast<uint32_t>(leftVal);
                            lsb = static_cast<uint32_t>(rightVal);
                            isVector = true;
                            return;
                        }
                    }
                }
            }
        }
        
        // Try VpiSize as fallback
        int32_t size = logic_net->VpiSize();
        if (size > 1) {
            msb = size - 1;
            lsb = 0;
            isVector = true;
            return;
        }
        
        return;
    } else if (auto* logic_var = obj->Cast<UHDM::logic_var>()) {
        // Try Ranges
        auto ranges = logic_var->Ranges();
        if (ranges && !ranges->empty()) {
            auto* range = ranges->at(0);
            if (range) {
                UHDM::expr* leftExpr = range->Left_expr();
                UHDM::expr* rightExpr = range->Right_expr();
                if (leftExpr && rightExpr) {
                    UHDM::ExprEval eval;
                    uint64_t leftVal = eval.getValue(leftExpr);
                    uint64_t rightVal = eval.getValue(rightExpr);
                    msb = static_cast<uint32_t>(leftVal);
                    lsb = static_cast<uint32_t>(rightVal);
                    isVector = true;
                    return;
                }
            }
        }
        
        // Try Typespec
        if (auto* typespec = logic_var->Typespec()) {
            if (auto* logic_typespec = typespec->Cast<UHDM::logic_typespec>()) {
                auto ranges = logic_typespec->Ranges();
                if (ranges && !ranges->empty()) {
                    auto* range = ranges->at(0);
                    if (range) {
                        UHDM::expr* leftExpr = range->Left_expr();
                        UHDM::expr* rightExpr = range->Right_expr();
                        if (leftExpr && rightExpr) {
                            UHDM::ExprEval eval;
                            uint64_t leftVal = eval.getValue(leftExpr);
                            uint64_t rightVal = eval.getValue(rightExpr);
                            msb = static_cast<uint32_t>(leftVal);
                            lsb = static_cast<uint32_t>(rightVal);
                            isVector = true;
                            return;
                        }
                    }
                }
            }
        }
        
        // Try VpiSize as fallback
        int32_t varSize = logic_var->VpiSize();
        if (varSize > 1) {
            msb = varSize - 1;
            lsb = 0;
            isVector = true;
            return;
        }
    } else if (auto* ref_obj = obj->Cast<UHDM::ref_obj>()) {
        // For ref_obj, try to get ranges from the actual object
        if (auto* actual = ref_obj->Actual_group()) {
            if (auto* actualBase = actual->Cast<UHDM::BaseClass>()) {
                extractBitWidthFromUhdmObject(actualBase, msb, lsb, isVector);
            }
            return;
        }
    }
}

void extractBitWidthFromUhdmObject(UHDM::base* uhdmObject, uint32_t& msb, 
                                   uint32_t& lsb, bool& isVector) {
    msb = 0;
    lsb = 0;
    isVector = false;
    
    if (!uhdmObject) return;
    
    // UHDM::base is just a forward declaration, we need to work with what we have
    // In practice, this function might not be used if the caller passes BaseClass*
    // For now, just return default values
}

}
}
