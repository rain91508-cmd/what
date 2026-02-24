#include "kdb_builder.h"
#include <iostream>
#include <fstream>
#include <functional>
#include <getopt.h>
#include <iomanip>

using namespace hwda::interpreter;

void printUsage(const char* progName) {
    std::cout << "Usage: " << progName << " [options] <kdb_file>\n"
              << "Options:\n"
              << "  -m, --modules         List all modules\n"
              << "  -s, --signals         List all signals\n"
              << "  -f, --files           List all source files\n"
              << "  -h, --hierarchy       Show design hierarchy\n"
              << "  -M, --module <name>   Show details of a specific module\n"
              << "  -S, --signal <name>   Search for signals by name pattern\n"
              << "  -c, --source          Show source code for module/signal\n"
              << "  -C, --content <file>  Show content of a source file\n"
              << "  -j, --json            Output in JSON format\n"
              << "  -v, --verbose         Verbose output\n"
              << "  --help                Show this help\n";
}

std::string signalTypeToString(SignalType type) {
    switch (type) {
        case SignalType::WIRE: return "wire";
        case SignalType::REG: return "reg";
        case SignalType::LOGIC: return "logic";
        case SignalType::BIT: return "bit";
        case SignalType::INTEGER: return "integer";
        case SignalType::REAL: return "real";
        case SignalType::PARAMETER: return "parameter";
        case SignalType::LOCALPARAM: return "localparam";
        case SignalType::INPUT: return "input";
        case SignalType::OUTPUT: return "output";
        case SignalType::INOUT: return "inout";
        default: return "unknown";
    }
}

std::string portDirectionToString(PortDirection dir) {
    switch (dir) {
        case PortDirection::INPUT: return "input";
        case PortDirection::OUTPUT: return "output";
        case PortDirection::INOUT: return "inout";
        default: return "unknown";
    }
}

void printModules(const KdbBuilder& builder, bool verbose) {
    auto modules = builder.getAllModules();
    std::cout << "\n=== Modules (" << modules.size() << ") ===\n";
    
    for (const auto* module : modules) {
        std::cout << "  [" << module->id << "] " << module->name;
        if (!module->fullName.empty() && module->fullName != module->name) {
            std::cout << " (" << module->fullName << ")";
        }
        std::cout << "\n";
        
        if (verbose) {
            std::cout << "      Ports: " << module->ports.size() << "\n";
            std::cout << "      File: " << module->fileId << ", Line: " << module->declaration.line << "\n";
        }
    }
}

void printSignals(const KdbBuilder& builder, bool verbose) {
    auto signals = builder.getAllSignals();
    std::cout << "\n=== Signals (" << signals.size() << ") ===\n";
    
    for (const auto* signal : signals) {
        std::cout << "  [" << signal->id << "] " << signal->name;
        if (!signal->fullName.empty() && signal->fullName != signal->name) {
            std::cout << " (" << signal->fullName << ")";
        }
        std::cout << " [" << signalTypeToString(signal->type) << "]\n";
        
        if (verbose) {
            std::cout << "      Module: " << signal->parentModuleId << "\n";
            std::cout << "      Location: Line " << signal->declaration.line << "\n";
        }
    }
}

void printFiles(const KdbBuilder& builder) {
    std::cout << "\n=== Source Files (" << builder.getFileCount() << ") ===\n";
    
    for (uint64_t id = 1; id <= builder.getFileCount(); ++id) {
        const auto* file = builder.findFileById(id);
        if (file) {
            std::cout << "  [" << id << "] " << file->path 
                      << " (" << file->lineCount << " lines)\n";
        }
    }
}

void printSourceFileContent(const KdbBuilder& builder, const std::string& filePath) {
    const auto* file = builder.findFileByPath(filePath);
    if (!file) {
        // Try to find by ID
        try {
            uint64_t id = std::stoull(filePath);
            file = builder.findFileById(id);
        } catch (...) {}
    }
    
    if (!file) {
        std::cout << "File not found: " << filePath << "\n";
        return;
    }
    
    std::cout << "\n=== Source File: " << file->path << " ===\n";
    std::cout << "Lines: " << file->lineCount << "\n\n";
    
    // Print with line numbers
    for (uint32_t line = 1; line <= file->lineCount; ++line) {
        std::cout << std::setw(5) << std::right << line << " | " 
                  << file->getLine(line) << "\n";
    }
}

void printModuleWithSource(const KdbBuilder& builder, const std::string& moduleName) {
    const auto* module = builder.findModuleByName(moduleName);
    if (!module) {
        std::cout << "Module not found: " << moduleName << "\n";
        return;
    }
    
    auto allSignals = builder.getAllSignals();
    
    std::cout << "\n=== Module: " << module->name << " ===\n";
    std::cout << "  ID: " << module->id << "\n";
    std::cout << "  Full Name: " << module->fullName << "\n";
    std::cout << "  File ID: " << module->fileId << "\n";
    std::cout << "  Location: Line " << module->declaration.line 
              << ", Col " << module->declaration.columnStart << "\n";
    
    // Show source code context
    if (module->declaration.fileId != 0) {
        const auto* file = builder.findFileById(module->declaration.fileId);
        if (file && !file->content.empty()) {
            std::cout << "\n  Source Code:\n";
            uint32_t startLine = (module->declaration.line > 3) ? module->declaration.line - 3 : 1;
            uint32_t endLine = std::min(startLine + 10, static_cast<uint32_t>(file->lineCount));
            
            for (uint32_t line = startLine; line <= endLine; ++line) {
                std::cout << "    ";
                if (line == module->declaration.line) {
                    std::cout << ">>> ";
                } else {
                    std::cout << "    ";
                }
                std::cout << std::setw(5) << std::right << line << " | " 
                          << file->getLine(line) << "\n";
            }
        }
    }
    
    std::cout << "\n  Ports (" << module->ports.size() << "):\n";
    for (const auto& port : module->ports) {
        std::cout << "    " << std::setw(8) << std::left 
                  << portDirectionToString(port.direction)
                  << " " << port.name;
        if (port.isVector) {
            std::cout << " [" << port.msb << ":" << port.lsb << "]";
        }
        std::cout << "\n";
    }
    
    std::cout << "\n  Signals:\n";
    for (const auto* signal : allSignals) {
        if (signal->parentModuleId == module->id) {
            std::cout << "    " << std::setw(10) << std::left 
                      << signalTypeToString(signal->type)
                      << " " << signal->name << "\n";
        }
    }
}

void printModuleDetails(const KdbBuilder& builder, const std::string& moduleName) {
    const auto* module = builder.findModuleByName(moduleName);
    if (!module) {
        std::cout << "Module not found: " << moduleName << "\n";
        return;
    }
    
    auto allSignals = builder.getAllSignals();
    
    std::cout << "\n=== Module: " << module->name << " ===\n";
    std::cout << "  ID: " << module->id << "\n";
    std::cout << "  Full Name: " << module->fullName << "\n";
    std::cout << "  File ID: " << module->fileId << "\n";
    std::cout << "  Location: Line " << module->declaration.line 
              << ", Col " << module->declaration.columnStart << "\n";
    
    std::cout << "\n  Ports (" << module->ports.size() << "):\n";
    for (const auto& port : module->ports) {
        std::cout << "    " << std::setw(8) << std::left 
                  << portDirectionToString(port.direction)
                  << " " << port.name;
        if (port.isVector) {
            std::cout << " [" << port.msb << ":" << port.lsb << "]";
        }
        std::cout << "\n";
    }
    
    std::cout << "\n  Signals:\n";
    for (const auto* signal : allSignals) {
        if (signal->parentModuleId == module->id) {
            std::cout << "    " << std::setw(10) << std::left 
                      << signalTypeToString(signal->type)
                      << " " << signal->name << "\n";
        }
    }
}

void searchSignals(const KdbBuilder& builder, const std::string& pattern) {
    auto signals = builder.getAllSignals();
    std::cout << "\n=== Signals matching '" << pattern << "' ===\n";
    
    int count = 0;
    for (const auto* signal : signals) {
        if (signal->name.find(pattern) != std::string::npos ||
            signal->fullName.find(pattern) != std::string::npos) {
            std::cout << "  [" << signal->id << "] " << signal->fullName 
                      << " [" << signalTypeToString(signal->type) << "]\n";
            count++;
        }
    }
    
    std::cout << "Found " << count << " matching signals.\n";
}

void printHierarchy(const KdbBuilder& builder) {
    std::cout << "\n=== Design Hierarchy ===\n";
    
    auto modules = builder.getAllModules();
    if (modules.empty()) {
        std::cout << "  (No modules found)\n";
        return;
    }
    
    for (const auto* module : modules) {
        std::cout << "  " << module->name << "\n";
        for (const auto& port : module->ports) {
            std::cout << "    " << portDirectionToString(port.direction) 
                      << " " << port.name << "\n";
        }
    }
}

void printJson(const KdbBuilder& builder) {
    auto modules = builder.getAllModules();
    auto signals = builder.getAllSignals();
    
    std::cout << "{\n";
    
    std::cout << "  \"statistics\": {\n";
    std::cout << "    \"modules\": " << builder.getModuleCount() << ",\n";
    std::cout << "    \"signals\": " << builder.getSignalCount() << ",\n";
    std::cout << "    \"files\": " << builder.getFileCount() << "\n";
    std::cout << "  },\n";
    
    std::cout << "  \"modules\": [\n";
    bool first = true;
    for (const auto* module : modules) {
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "    {\"id\": " << module->id << ", \"name\": \"" << module->name 
                  << "\", \"ports\": " << module->ports.size() << "}";
    }
    std::cout << "\n  ],\n";
    
    std::cout << "  \"signals\": [\n";
    first = true;
    for (const auto* signal : signals) {
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "    {\"id\": " << signal->id << ", \"name\": \"" << signal->name 
                  << "\", \"type\": \"" << signalTypeToString(signal->type) << "\"}";
    }
    std::cout << "\n  ]\n";
    
    std::cout << "}\n";
}

int main(int argc, char* argv[]) {
    bool showModules = false;
    bool showSignals = false;
    bool showFiles = false;
    bool showHierarchy = false;
    bool showJson = false;
    bool verbose = false;
    bool showSource = false;
    std::string moduleName;
    std::string signalPattern;
    std::string contentFile;
    
    static struct option longOptions[] = {
        {"modules", no_argument, nullptr, 'm'},
        {"signals", no_argument, nullptr, 's'},
        {"files", no_argument, nullptr, 'f'},
        {"hierarchy", no_argument, nullptr, 'h'},
        {"module", required_argument, nullptr, 'M'},
        {"signal", required_argument, nullptr, 'S'},
        {"source", no_argument, nullptr, 'c'},
        {"content", required_argument, nullptr, 'C'},
        {"json", no_argument, nullptr, 'j'},
        {"verbose", no_argument, nullptr, 'v'},
        {"help", no_argument, nullptr, 'H'},
        {nullptr, 0, nullptr, 0}
    };
    
    int opt;
    while ((opt = getopt_long(argc, argv, "msfhM:S:cC:jv", longOptions, nullptr)) != -1) {
        switch (opt) {
            case 'm':
                showModules = true;
                break;
            case 's':
                showSignals = true;
                break;
            case 'f':
                showFiles = true;
                break;
            case 'h':
                showHierarchy = true;
                break;
            case 'M':
                moduleName = optarg;
                break;
            case 'S':
                signalPattern = optarg;
                break;
            case 'c':
                showSource = true;
                break;
            case 'C':
                contentFile = optarg;
                break;
            case 'j':
                showJson = true;
                break;
            case 'v':
                verbose = true;
                break;
            case 'H':
            default:
                printUsage(argv[0]);
                return (opt == 'H') ? 0 : 1;
        }
    }
    
    if (optind >= argc) {
        std::cerr << "Error: No KDB file specified\n";
        printUsage(argv[0]);
        return 1;
    }
    
    std::string kdbFile = argv[optind];
    
    KdbBuilder builder;
    if (!builder.deserializeFromFile(kdbFile)) {
        std::cerr << "Error: Failed to load KDB file: " << kdbFile << "\n";
        return 1;
    }
    
    std::cout << "Loaded KDB: " << kdbFile << "\n";
    std::cout << "Statistics:\n";
    std::cout << "  Modules: " << builder.getModuleCount() << "\n";
    std::cout << "  Signals: " << builder.getSignalCount() << "\n";
    std::cout << "  Files: " << builder.getFileCount() << "\n";
    
    bool anyOption = showModules || showSignals || showFiles || showHierarchy || 
                     showJson || !moduleName.empty() || !signalPattern.empty() || 
                     showSource || !contentFile.empty();
    
    if (!anyOption) {
        showModules = true;
        showFiles = true;
    }
    
    if (showJson) {
        printJson(builder);
        return 0;
    }
    
    if (!contentFile.empty()) {
        printSourceFileContent(builder, contentFile);
        return 0;
    }
    
    if (showModules) printModules(builder, verbose);
    if (showSignals) printSignals(builder, verbose);
    if (showFiles) printFiles(builder);
    if (showHierarchy) printHierarchy(builder);
    if (!moduleName.empty()) {
        if (showSource) {
            printModuleWithSource(builder, moduleName);
        } else {
            printModuleDetails(builder, moduleName);
        }
    }
    if (!signalPattern.empty()) searchSignals(builder, signalPattern);
    
    return 0;
}
