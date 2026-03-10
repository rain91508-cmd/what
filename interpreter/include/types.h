#ifndef HWDA_INTERPRETER_TYPES_H
#define HWDA_INTERPRETER_TYPES_H

#include <string>
#include <vector>
#include <cstdint>
#include <iostream>

namespace hwda {
namespace interpreter {

// Global verbose flag for debug output
extern bool g_verbose;

// Helper macro for verbose output
#define VERBOSE_LOG(msg) do { if (hwda::interpreter::g_verbose) { std::cerr << msg; } } while(0)

enum class AstNodeType {
    Module,
    Port,
    Signal,
    Instance,
    Assignment,
    AlwaysBlock,
    InitialBlock,
    Parameter,
    Unknown
};

struct SourceLocation {
    std::string filePath;
    int line;
    int column;
};

struct AstNode {
    AstNodeType type;
    std::string name;
    SourceLocation location;
    std::vector<AstNode*> children;
    AstNode* parent = nullptr;
};

struct ParsedModule {
    std::string name;
    SourceLocation location;
    std::vector<std::string> ports;
    std::vector<std::string> parameters;
    std::vector<std::string> signals;
    std::vector<std::string> instances;
    int endLine;
};

struct ParsedSignal {
    std::string name;
    std::string type;
    int bitWidth;
    int msb;
    int lsb;
    std::string direction;
    SourceLocation location;
};

struct ParsedConnection {
    std::string driver;
    std::string load;
    std::string driverInstance;
    std::string loadInstance;
    SourceLocation driverLocation;
    SourceLocation loadLocation;
};

}
}

#endif
