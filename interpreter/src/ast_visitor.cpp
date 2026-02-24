#include "ast_visitor.h"

namespace hwda {
namespace interpreter {

AstVisitor::AstVisitor() = default;
AstVisitor::~AstVisitor() = default;

void AstVisitor::visitModule(const ParsedModule& module) {
}

void AstVisitor::visitSignal(const ParsedSignal& signal) {
}

void AstVisitor::visitConnection(const ParsedConnection& connection) {
}

}
}
