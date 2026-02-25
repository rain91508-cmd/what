#include "kdb_builder.h"
#include <iostream>
#include <fstream>
#include <functional>
#include <getopt.h>
#include <iomanip>
#include <map>

using namespace hwda::interpreter;

void printUsage(const char* progName) {
    std::cout << "Usage: " << progName << " [options] <kdb_file>\n"
              << "Options:\n"
              << "  -m, --modules         List all modules\n"
              << "  -s, --signals         List all signals\n"
              << "  -f, --files           List all source files\n"
              << "  -h, --hierarchy       Show design hierarchy tree\n"
              << "  -M, --module <name>   Show details of a specific module\n"
              << "  -S, --signal <name>   Search for signals by name pattern\n"
              << "  -D, --driver <name>   Show signal driver trace\n"
              << "  -L, --load <name>     Show signal load trace\n"
              << "  -l, --links <file>    Show signal links in source file\n"
              << "  -S, --submods <file>  Show submodule links in source file\n"
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
        std::cout << ", Parent: " << module->parentModuleId;
        std::cout << ", IsInstance: " << (module->isInstance ? "true" : "false") << "\n";
        
        if (verbose) {
            // Count port signals (those with direction != UNKNOWN)
        int portCount = 0;
        for (const auto& sig : module->signals) {
            if (sig.direction != PortDirection::UNKNOWN) {
                portCount++;
            }
        }
        std::cout << "      Ports: " << portCount << "\n";
            std::cout << "      Signals: " << module->signals.size() << "\n";
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
            if (!signal->driverSignalIds.empty()) {
                std::cout << "      Drivers: ";
                for (size_t i = 0; i < signal->driverSignalIds.size(); ++i) {
                    if (i > 0) std::cout << ", ";
                    std::cout << signal->driverSignalIds[i];
                }
                std::cout << "\n";
            }
            // Note: loadSignalIds removed - not needed
        }
    }
}

void printFiles(const KdbBuilder& builder) {
    std::cout << "\n=== Source Files (" << builder.getFileCount() << ") ===\n";
    
    for (uint64_t id = 1; id <= builder.getFileCount(); ++id) {
        const auto* file = builder.findFileById(id);
        if (file) {
            std::cout << "  [" << id << "] " << file->path 
                      << " (" << file->getLineCount() << " lines, " 
                      << file->signalLinks.size() << " signal links, "
                      << file->submodLinks.size() << " submodule links)\n";
        }
    }
}

void printSourceFileContent(const KdbBuilder& builder, const std::string& filePath) {
    const auto* file = builder.findFileByPath(filePath);
    if (!file) {
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
    std::cout << "Lines: " << file->getLineCount() << "\n\n";
    
    for (uint32_t line = 1; line <= file->getLineCount(); ++line) {
        std::cout << std::setw(5) << std::right << line << " | " 
                  << file->getLine(line) << "\n";
    }
}

void printSignalLinks(const KdbBuilder& builder, const std::string& filePath) {
    const auto* file = builder.findFileByPath(filePath);
    if (!file) {
        try {
            uint64_t id = std::stoull(filePath);
            file = builder.findFileById(id);
        } catch (...) {}
    }
    
    if (!file) {
        std::cout << "File not found: " << filePath << "\n";
        return;
    }
    
    std::cout << "\n=== Signal Links in: " << file->path << " ===\n";
    std::cout << "Total signal links: " << file->signalLinks.size() << "\n\n";
    
    if (file->signalLinks.empty()) {
        std::cout << "  (No signal links recorded)\n";
        return;
    }
    
    std::map<uint32_t, std::vector<const SourceLinkInfo*>> linksByLine;
    for (const auto& link : file->signalLinks) {
        linksByLine[link.line].push_back(&link);
    }
    
    for (const auto& [line, links] : linksByLine) {
        std::cout << "Line " << std::setw(4) << line << ":\n";
        std::string sourceLine = file->getLine(line);
        
        for (const auto* link : links) {
            const auto* signal = builder.findSignalById(link->targetId);
            std::string signalName = signal ? signal->fullName : "(unknown)";
            std::string signalType = signal ? signalTypeToString(signal->type) : "unknown";
            
            std::cout << "  Col " << std::setw(3) << link->columnStart 
                      << "-" << std::setw(3) << link->columnEnd << ": ";
            
            if (link->columnStart > 0 && link->columnEnd <= sourceLine.length()) {
                std::string text = sourceLine.substr(link->columnStart - 1, link->columnEnd - link->columnStart + 1);
                std::cout << "\"" << text << "\" -> ";
            }
            
            std::cout << "[" << link->targetId << "] " << signalName 
                      << " (" << signalType << ")\n";
        }
    }
}

void printSubmodLinks(const KdbBuilder& builder, const std::string& filePath) {
    const auto* file = builder.findFileByPath(filePath);
    if (!file) {
        try {
            uint64_t id = std::stoull(filePath);
            file = builder.findFileById(id);
        } catch (...) {}
    }
    
    if (!file) {
        std::cout << "File not found: " << filePath << "\n";
        return;
    }
    
    std::cout << "\n=== Submodule Links in: " << file->path << " ===\n";
    std::cout << "Total submodule links: " << file->submodLinks.size() << "\n\n";
    
    if (file->submodLinks.empty()) {
        std::cout << "  (No submodule links recorded)\n";
        return;
    }
    
    std::map<uint32_t, std::vector<const SourceLinkInfo*>> linksByLine;
    for (const auto& link : file->submodLinks) {
        linksByLine[link.line].push_back(&link);
    }
    
    for (const auto& [line, links] : linksByLine) {
        std::cout << "Line " << std::setw(4) << line << ":\n";
        std::string sourceLine = file->getLine(line);
        
        for (const auto* link : links) {
            const auto* module = builder.findModuleById(link->targetId);
            std::string moduleName = module ? module->name : "(unknown)";
            
            std::cout << "  Col " << std::setw(3) << link->columnStart 
                      << "-" << std::setw(3) << link->columnEnd << ": ";
            
            if (link->columnStart > 0 && link->columnEnd <= sourceLine.length()) {
                std::string text = sourceLine.substr(link->columnStart - 1, link->columnEnd - link->columnStart + 1);
                std::cout << "\"" << text << "\" -> ";
            }
            
            std::cout << "[" << link->targetId << "] " << moduleName << "\n";
        }
    }
}

void printSourceWithLinks(const KdbBuilder& builder, const std::string& filePath) {
    const auto* file = builder.findFileByPath(filePath);
    if (!file) {
        try {
            uint64_t id = std::stoull(filePath);
            file = builder.findFileById(id);
        } catch (...) {}
    }
    
    if (!file) {
        std::cout << "File not found: " << filePath << "\n";
        return;
    }
    
    std::cout << "\n=== Source File with Links: " << file->path << " ===\n\n";
    
    std::map<uint32_t, std::vector<const SourceLinkInfo*>> signalLinksByLine;
    for (const auto& link : file->signalLinks) {
        signalLinksByLine[link.line].push_back(&link);
    }
    
    std::map<uint32_t, std::vector<const SourceLinkInfo*>> submodLinksByLine;
    for (const auto& link : file->submodLinks) {
        submodLinksByLine[link.line].push_back(&link);
    }
    
    for (uint32_t line = 1; line <= file->getLineCount(); ++line) {
        std::string sourceLine = file->getLine(line);
        std::cout << std::setw(5) << std::right << line << " | " << sourceLine << "\n";
        
        auto sigIt = signalLinksByLine.find(line);
        if (sigIt != signalLinksByLine.end()) {
            for (const auto* link : sigIt->second) {
                const auto* signal = builder.findSignalById(link->targetId);
                std::string signalName = signal ? signal->fullName : "(unknown)";
                
                std::string indent(link->columnStart + 8, ' ');
                std::string marker(link->columnEnd - link->columnStart + 1, '^');
                std::cout << "       " << indent << marker << " [S:" << link->targetId << "] " << signalName << "\n";
            }
        }
        
        auto subIt = submodLinksByLine.find(line);
        if (subIt != submodLinksByLine.end()) {
            for (const auto* link : subIt->second) {
                const auto* module = builder.findModuleById(link->targetId);
                std::string moduleName = module ? module->name : "(unknown)";
                
                std::string indent(link->columnStart + 8, ' ');
                std::string marker(link->columnEnd - link->columnStart + 1, '~');
                std::cout << "       " << indent << marker << " [M:" << link->targetId << "] " << moduleName << "\n";
            }
        }
    }
}

void printModuleWithSource(const KdbBuilder& builder, const std::string& moduleName) {
    const auto* module = builder.findModuleByName(moduleName);
    if (!module) {
        std::cout << "Module not found: " << moduleName << "\n";
        return;
    }
    
    std::cout << "\n=== Module: " << module->name << " ===\n";
    std::cout << "  ID: " << module->id << "\n";
    std::cout << "  Full Name: " << module->fullName << "\n";
    std::cout << "  File ID: " << module->fileId << "\n";
    std::cout << "  Location: Line " << module->declaration.line << "\n";
    // Note: column info removed from KdbSourceLocation
    
    if (module->declaration.fileId != 0) {
        const auto* file = builder.findFileById(module->declaration.fileId);
        if (file && !file->content.empty()) {
            std::cout << "\n  Source Code:\n";
            uint32_t startLine = (module->declaration.line > 3) ? module->declaration.line - 3 : 1;
            uint32_t endLine = std::min(startLine + 10, static_cast<uint32_t>(file->getLineCount()));
            
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
    
    // Print port signals (those with direction != UNKNOWN)
    int portCount = 0;
    for (const auto& sig : module->signals) {
        if (sig.direction != PortDirection::UNKNOWN) {
            portCount++;
        }
    }
    std::cout << "\n  Ports (" << portCount << "):\n";
    for (const auto& sig : module->signals) {
        if (sig.direction != PortDirection::UNKNOWN) {
            std::cout << "    " << std::setw(8) << std::left 
                      << portDirectionToString(sig.direction)
                      << " " << sig.name;
            if (sig.msb != sig.lsb) {
                std::cout << " [" << sig.msb << ":" << sig.lsb << "]";
            }
            std::cout << "\n";
        }
    }
    
    std::cout << "\n  Signals (" << module->signals.size() << "):\n";
    for (const auto& signal : module->signals) {
        std::cout << "    " << std::setw(10) << std::left 
                  << signalTypeToString(signal.type)
                  << " " << std::setw(8) << std::left
                  << portDirectionToString(signal.direction)
                  << " " << signal.name;
        if (signal.msb != 0 || signal.lsb != 0) {
            std::cout << " [" << signal.msb << ":" << signal.lsb << "]";
        }
        std::cout << "\n";
    }
}

void printModuleDetails(const KdbBuilder& builder, const std::string& moduleName) {
    const auto* module = builder.findModuleByName(moduleName);
    if (!module) {
        std::cout << "Module not found: " << moduleName << "\n";
        return;
    }
    
    std::cout << "\n=== Module: " << module->name << " ===\n";
    std::cout << "  ID: " << module->id << "\n";
    std::cout << "  Full Name: " << module->fullName << "\n";
    std::cout << "  File ID: " << module->fileId << "\n";
    std::cout << "  Location: Line " << module->declaration.line << "\n";
    // Note: column info removed from KdbSourceLocation
    
    // Print port signals (those with direction != UNKNOWN)
    int portCount = 0;
    for (const auto& sig : module->signals) {
        if (sig.direction != PortDirection::UNKNOWN) {
            portCount++;
        }
    }
    std::cout << "\n  Ports (" << portCount << "):\n";
    for (const auto& sig : module->signals) {
        if (sig.direction != PortDirection::UNKNOWN) {
            std::cout << "    " << std::setw(8) << std::left 
                      << portDirectionToString(sig.direction)
                      << " " << sig.name;
            if (sig.msb != sig.lsb) {
                std::cout << " [" << sig.msb << ":" << sig.lsb << "]";
            }
            std::cout << "\n";
        }
    }
    
    std::cout << "\n  Signals (" << module->signals.size() << "):\n";
    for (const auto& signal : module->signals) {
        std::cout << "    " << std::setw(10) << std::left 
                  << signalTypeToString(signal.type)
                  << " " << std::setw(8) << std::left
                  << portDirectionToString(signal.direction)
                  << " " << signal.name;
        if (signal.msb != 0 || signal.lsb != 0) {
            std::cout << " [" << signal.msb << ":" << signal.lsb << "]";
        }
        std::cout << "\n";
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

void printSignalDriverTrace(const KdbBuilder& builder, const std::string& signalName) {
    const auto* signal = builder.findSignalByName(signalName);
    if (!signal) {
        std::cout << "Signal not found: " << signalName << "\n";
        return;
    }
    
    std::cout << "\n=== Driver Trace for: " << signal->fullName << " ===\n";
    std::cout << "  Type: " << signalTypeToString(signal->type) << "\n";
    
    if (signal->driverSignalIds.empty()) {
        std::cout << "  (No drivers found - this is likely a primary input or constant)\n";
        return;
    }
    
    std::cout << "  Drivers:\n";
    for (uint64_t driverId : signal->driverSignalIds) {
        const auto* driver = builder.findSignalById(driverId);
        if (driver) {
            std::cout << "    [" << driver->id << "] " << driver->fullName 
                      << " [" << signalTypeToString(driver->type) << "]\n";
        }
    }
}

void printSignalLoadTrace(const KdbBuilder& builder, const std::string& signalName) {
    const auto* signal = builder.findSignalByName(signalName);
    if (!signal) {
        std::cout << "Signal not found: " << signalName << "\n";
        return;
    }
    
    std::cout << "\n=== Load Trace for: " << signal->fullName << " ===\n";
    std::cout << "  Type: " << signalTypeToString(signal->type) << "\n";
    
    // Note: loadSignalIds removed - not needed
    std::cout << "  (Load tracing not implemented - loadSignalIds removed)\n";
}

void printHierarchyTree(const KdbBuilder& builder, uint64_t moduleId, int depth) {
    const auto* module = builder.findModuleById(moduleId);
    if (!module) return;
    
    std::string indent(depth * 2, ' ');
    std::cout << indent << module->name;
    if (!module->fullName.empty()) {
        std::cout << " (" << module->fullName << ")";
    }
    std::cout << "\n";
    
    auto children = builder.getChildModules(moduleId);
    for (const auto* child : children) {
        printHierarchyTree(builder, child->id, depth + 1);
    }
}

void printHierarchy(const KdbBuilder& builder) {
    std::cout << "\n=== Design Hierarchy ===\n";
    
    const auto& topModuleIds = builder.getTopModuleIds();
    
    if (topModuleIds.empty()) {
        std::cout << "  (No top module found)\n";
        return;
    }
    
    for (uint64_t moduleId : topModuleIds) {
        printHierarchyTree(builder, moduleId, 0);
    }
}

void printJson(const KdbBuilder& builder) {
    auto modules = builder.getAllModules();
    
    std::cout << "{\n";
    
    std::cout << "  \"statistics\": {\n";
    std::cout << "    \"modules\": " << builder.getModuleCount() << ",\n";
    std::cout << "    \"signals\": " << builder.getTotalSignalCount() << ",\n";
    std::cout << "    \"files\": " << builder.getFileCount() << "\n";
    std::cout << "  },\n";
    
    std::cout << "  \"modules\": [\n";
    bool first = true;
    for (const auto* module : modules) {
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "    {\n";
        std::cout << "      \"id\": " << module->id << ",\n";
        std::cout << "      \"name\": \"" << module->name << "\",\n";
        std::cout << "      \"full_name\": \"" << module->fullName << "\",\n";
        std::cout << "      \"parent_module_id\": " << module->parentModuleId << ",\n";
        std::cout << "      \"file_id\": " << module->fileId << ",\n";
        std::cout << "      \"is_instance\": " << (module->isInstance ? "true" : "false") << ",\n";
        std::cout << "      \"declaration\": {\n";
        std::cout << "        \"file_id\": " << module->declaration.fileId << ",\n";
        std::cout << "        \"line\": " << module->declaration.line << "\n";
        // Note: column_start and column_end removed - not needed
        std::cout << "      },\n";
        
        std::cout << "      \"signals\": [\n";
        bool firstModuleSignal = true;
        for (const auto& signal : module->signals) {
            if (!firstModuleSignal) std::cout << ",\n";
            firstModuleSignal = false;
            std::cout << "        {\n";
            std::cout << "          \"id\": " << signal.id << ",\n";
            std::cout << "          \"name\": \"" << signal.name << "\",\n";
            std::cout << "          \"full_name\": \"" << signal.fullName << "\",\n";
            std::cout << "          \"type\": \"" << signalTypeToString(signal.type) << "\",\n";
            std::cout << "          \"direction\": \"" << portDirectionToString(signal.direction) << "\",\n";
            std::cout << "          \"msb\": " << signal.msb << ",\n";
            std::cout << "          \"lsb\": " << signal.lsb << ",\n";
            std::cout << "          \"parent_module_id\": " << signal.parentModuleId << ",\n";
            std::cout << "          \"declaration\": {\n";
            std::cout << "            \"file_id\": " << signal.declaration.fileId << ",\n";
            std::cout << "            \"line\": " << signal.declaration.line << "\n";
            // Note: column_start and column_end removed - not needed
            std::cout << "          },\n";
            std::cout << "          \"driver_signal_ids\": [";
            for (size_t i = 0; i < signal.driverSignalIds.size(); ++i) {
                if (i > 0) std::cout << ", ";
                std::cout << signal.driverSignalIds[i];
            }
            std::cout << "],\n";
            std::cout << "          \"driver_lines\": [\n";
            for (size_t i = 0; i < signal.driverLines.size(); ++i) {
                if (i > 0) std::cout << ",\n";
                std::cout << "            {\n";
                std::cout << "              \"file_id\": " << signal.driverLines[i].fileId << ",\n";
                std::cout << "              \"line\": " << signal.driverLines[i].line << "\n";
                std::cout << "            }";
            }
            std::cout << "\n          ]\n";
            // Note: load_signal_ids removed - not needed
            std::cout << "        }";
        }
        std::cout << "\n      ],\n";
        
        std::cout << "      \"instances\": [\n";
        bool firstInstance = true;
        for (const auto& instance : module->instances) {
            if (!firstInstance) std::cout << ",\n";
            firstInstance = false;
            std::cout << "        {\n";
            std::cout << "          \"id\": " << instance.id << ",\n";
            std::cout << "          \"name\": \"" << instance.name << "\",\n";
            std::cout << "          \"module_def_id\": " << instance.moduleDefId << ",\n";
            std::cout << "          \"parent_module_id\": " << instance.parentModuleId << ",\n";
            std::cout << "          \"declaration\": {\n";
            std::cout << "            \"file_id\": " << instance.declaration.fileId << ",\n";
            std::cout << "            \"line\": " << instance.declaration.line << "\n";
            // Note: column_start and column_end removed - not needed
            std::cout << "          },\n";
            std::cout << "          \"connections\": [\n";
            bool firstConnection = true;
            for (const auto& conn : instance.connections) {
                if (!firstConnection) std::cout << ",\n";
                firstConnection = false;
                std::cout << "            {\n";
                std::cout << "              \"port_id\": " << conn.portId << ",\n";
                std::cout << "              \"connection_expr\": \"" << conn.connectionExpr << "\",\n";
                std::cout << "              \"connected_signal_id\": " << conn.connectedSignalId << "\n";
                std::cout << "            }";
            }
            std::cout << "\n          ]\n";
            std::cout << "        }";
        }
        std::cout << "\n      ]\n";
        
        std::cout << "    }";
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
    std::string driverSignal;
    std::string loadSignal;
    std::string contentFile;
    std::string linksFile;
    std::string submodsFile;
    
    static struct option longOptions[] = {
        {"modules", no_argument, nullptr, 'm'},
        {"signals", no_argument, nullptr, 's'},
        {"files", no_argument, nullptr, 'f'},
        {"hierarchy", no_argument, nullptr, 'h'},
        {"module", required_argument, nullptr, 'M'},
        {"signal", required_argument, nullptr, 'S'},
        {"driver", required_argument, nullptr, 'D'},
        {"load", required_argument, nullptr, 'L'},
        {"links", required_argument, nullptr, 'l'},
        {"submods", required_argument, nullptr, 'b'},
        {"source", no_argument, nullptr, 'c'},
        {"content", required_argument, nullptr, 'C'},
        {"json", no_argument, nullptr, 'j'},
        {"verbose", no_argument, nullptr, 'v'},
        {"help", no_argument, nullptr, 'H'},
        {nullptr, 0, nullptr, 0}
    };
    
    int opt;
    while ((opt = getopt_long(argc, argv, "msfhM:S:D:L:l:b:cC:jv", longOptions, nullptr)) != -1) {
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
            case 'D':
                driverSignal = optarg;
                break;
            case 'L':
                loadSignal = optarg;
                break;
            case 'l':
                linksFile = optarg;
                break;
            case 'b':
                submodsFile = optarg;
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
    
    std::ifstream input(kdbFile, std::ios::binary);
    if (!input) {
        std::cerr << "Error: Cannot open KDB file: " << kdbFile << "\n";
        return 1;
    }
    
    input.seekg(0, std::ios::end);
    size_t fileSize = input.tellg();
    input.seekg(0, std::ios::beg);
    
    std::cout << "Debug: File size = " << fileSize << " bytes\n";
    
    uint32_t magic = 0;
    if (fileSize >= 4) {
        input.read(reinterpret_cast<char*>(&magic), sizeof(magic));
        input.seekg(0, std::ios::beg);
        std::cout << "Debug: Magic number = 0x" << std::hex << magic << std::dec << "\n";
    }
    
    KdbBuilder builder;
    if (!builder.deserializeFromFile(kdbFile)) {
        std::cerr << "Error: Failed to load KDB file: " << kdbFile << "\n";
        return 1;
    }
    
    std::cout << "Loaded KDB: " << kdbFile << "\n";
    std::cout << "Statistics:\n";
    std::cout << "  Modules: " << builder.getModuleCount() << "\n";
    std::cout << "  Signals: " << builder.getTotalSignalCount() << "\n";
    std::cout << "  Files: " << builder.getFileCount() << "\n";
    
    bool anyOption = showModules || showSignals || showFiles || showHierarchy || 
                     showJson || !moduleName.empty() || !signalPattern.empty() || 
                     !driverSignal.empty() || !loadSignal.empty() ||
                     showSource || !contentFile.empty() || !linksFile.empty() || !submodsFile.empty();
    
    if (!anyOption) {
        showModules = true;
        showHierarchy = true;
    }
    
    if (showJson) {
        printJson(builder);
        return 0;
    }
    
    if (!contentFile.empty()) {
        printSourceFileContent(builder, contentFile);
        return 0;
    }
    
    if (!linksFile.empty()) {
        if (showSource) {
            printSourceWithLinks(builder, linksFile);
        } else {
            printSignalLinks(builder, linksFile);
        }
        return 0;
    }
    
    if (!submodsFile.empty()) {
        printSubmodLinks(builder, submodsFile);
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
    if (!driverSignal.empty()) printSignalDriverTrace(builder, driverSignal);
    if (!loadSignal.empty()) printSignalLoadTrace(builder, loadSignal);
    
    return 0;
}
