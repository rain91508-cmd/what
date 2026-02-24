#ifndef HWDA_INTERPRETER_AST_VISITOR_H
#define HWDA_INTERPRETER_AST_VISITOR_H

#include "types.h"

namespace hwda {
namespace interpreter {

class AstVisitor {
public:
    AstVisitor();
    virtual ~AstVisitor();
    
    virtual void visitModule(const ParsedModule& module);
    virtual void visitSignal(const ParsedSignal& signal);
    virtual void visitConnection(const ParsedConnection& connection);
};

}
}

#endif
