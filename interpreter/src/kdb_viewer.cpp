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
              << "  -c, --source          Show source code for module/signal\n"
              << "  -C, --content <file>  Show content of a source file\n"
              << "  -R, --range <spec>    Show line range using index offset (format: fileId:startLine:endLine)\n"
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

// Build full name from parent chain
std::string buildFullName(const ModuleInfo* module, const KdbBuilder& builder) {
    if (!module) return "";
    
    std::vector<std::string> names;
    const ModuleInfo* current = module;
    
    while (current != nullptr) {
        names.push_back(current->name);
        if (current->parentModuleId == 0) break;
        current = builder.findModuleById(current->parentModuleId);
    }
    
    // Reverse to get root-to-leaf order
    std::reverse(names.begin(), names.end());
    
    // Join with "."
    std::string fullName;
    for (size_t i = 0; i < names.size(); ++i) {
        if (i > 0) fullName += ".";
        fullName += names[i];
    }
    
    return fullName;
}

void printModules(const KdbBuilder& builder, bool verbose) {
    auto modules = builder.getAllModules();
    std::cout << "\n=== Modules (" << modules.size() << ") ===\n";
    
    for (const auto* module : modules) {
        std::string fullName = buildFullName(module, builder);
        // Use getModuleId to get ID from pointer
        std::cout << "  [" << builder.getModuleId(module) << "] " << module->name;
        if (!fullName.empty() && fullName != module->name) {
            std::cout << " (" << fullName << ")";
        }
        std::cout << ", Parent: " << module->parentModuleId;
        std::cout << ", IsInstance: " << (module->isInstance ? "true" : "false") << "\n";
        
        if (verbose) {
            // Count port signals (those with direction != UNKNOWN)
            // Use signalDefs for port count
            int portCount = 0;
            for (const auto& def : module->signalDefs) {
                if (def.direction != PortDirection::UNKNOWN) {
                    portCount++;
                }
            }
            std::cout << "      Ports: " << portCount << "\n";
            std::cout << "      Signals: " << module->signalInsts.size() << "\n";
            std::cout << "      File: " << module->definition.fileId << ", Start Line: " << module->definition.startLine << ", End Line: " << module->definition.endLine << "\n";
            if (module->isInstance && module->defModuleId != 0) {
                std::cout << "      Definition Module ID: " << module->defModuleId << "\n";
            }
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
        const auto* fileInfo = builder.findFileById(id);
        if (fileInfo) {
            std::cout << "  [" << id << "] " << fileInfo->path 
                      << " (" << fileInfo->totalLines << " lines)\n";
            // Show line index offset info
            if (!fileInfo->lineIndexOffset.empty()) {
                std::cout << "      Line index offsets (every 256 lines):\n";
                for (size_t i = 0; i < fileInfo->lineIndexOffset.size() && i < 5; ++i) {
                    std::cout << "        Line " << (i * 256 + 1) 
                              << " -> byte offset " << fileInfo->lineIndexOffset[i] << "\n";
                }
                if (fileInfo->lineIndexOffset.size() > 5) {
                    std::cout << "        ... (" << fileInfo->lineIndexOffset.size() 
                              << " total index points)\n";
                }
            }
        }
    }
}

void printSourceFileContent(const KdbBuilder& builder, const std::string& filePath) {
    const SourceFileInfo* fileInfo = builder.findFileByPath(filePath);
    const SourceFileContent* fileContent = nullptr;
    uint32_t fileId = 0;
    
    if (!fileInfo) {
        try {
            uint64_t id = std::stoull(filePath);
            fileInfo = builder.findFileById(id);
            if (fileInfo) fileId = static_cast<uint32_t>(id);
        } catch (...) {}
    } else {
        // Find ID by path
        for (uint32_t id = 1; id <= builder.getFileCount(); ++id) {
            const auto* info = builder.findFileById(id);
            if (info && info->path == filePath) {
                fileId = id;
                break;
            }
        }
    }
    
    if (fileId != 0) {
        fileContent = builder.findFileContentById(fileId);
    }
    
    if (!fileInfo || !fileContent) {
        std::cout << "File not found: " << filePath << "\n";
        return;
    }
    
    std::cout << "\n=== Source File: " << fileInfo->path << " ===\n";
    std::cout << "Lines: " << fileInfo->totalLines << "\n\n";
    
    for (uint32_t line = 1; line <= fileInfo->totalLines; ++line) {
        std::cout << std::setw(5) << std::right << line << " | " 
                  << fileInfo->getLine(*fileContent, line) << "\n";
    }
}

void printSourceLineRange(const KdbBuilder& builder, const std::string& filePath, 
                          uint32_t startLine, uint32_t endLine) {
    const SourceFileInfo* fileInfo = builder.findFileByPath(filePath);
    uint32_t fileId = 0;
    
    if (!fileInfo) {
        try {
            uint64_t id = std::stoull(filePath);
            fileInfo = builder.findFileById(id);
            if (fileInfo) fileId = static_cast<uint32_t>(id);
        } catch (...) {}
    } else {
        for (uint32_t id = 1; id <= builder.getFileCount(); ++id) {
            const auto* info = builder.findFileById(id);
            if (info && info->path == filePath) {
                fileId = id;
                break;
            }
        }
    }
    
    if (fileId == 0 || !fileInfo) {
        std::cout << "File not found: " << filePath << "\n";
        return;
    }
    
    std::cout << "\n=== Source File: " << fileInfo->path << " (lines " << startLine << "-" << endLine << ") ===\n";
    std::cout << "Using index offset for fast seeking...\n\n";
    
    // Show which index offset is being used
    uint32_t indexSlot = (startLine - 1) / 256;
    if (indexSlot < fileInfo->lineIndexOffset.size()) {
        std::cout << "Debug: Using index offset[" << indexSlot << "] = " 
                  << fileInfo->lineIndexOffset[indexSlot] 
                  << " (line " << (indexSlot * 256 + 1) << ")\n\n";
    }
    
    auto lines = builder.getSourceLineRange(fileId, startLine, endLine);
    
    uint32_t lineNum = startLine;
    for (const auto& line : lines) {
        std::cout << std::setw(5) << std::right << lineNum << " | " << line << "\n";
        lineNum++;
    }
}

void printModuleWithSource(const KdbBuilder& builder, const std::string& moduleName) {
    const auto* module = builder.findModuleByName(moduleName);
    if (!module) {
        std::cout << "Module not found: " << moduleName << "\n";
        return;
    }
    
    std::string fullName = buildFullName(module, builder);
    std::cout << "\n=== Module: " << module->name << " ===\n";
    // Use getModuleId to get ID from pointer
    std::cout << "  ID: " << builder.getModuleId(module) << "\n";
    std::cout << "  Full Name: " << fullName << "\n";
    std::cout << "  Definition: File " << module->definition.fileId << ", Start Line " << module->definition.startLine;
    std::cout << ", End Line " << module->definition.endLine << "\n";
    
    if (module->definition.fileId != 0) {
        const auto* fileInfo = builder.findFileById(module->definition.fileId);
        const auto* fileContent = builder.findFileContentById(module->definition.fileId);
        if (fileInfo && fileContent && !fileContent->data.empty()) {
            std::cout << "\n  Source Code:\n";
            uint32_t startLine = (module->definition.startLine > 3) ? module->definition.startLine - 3 : 1;
            uint32_t endLine = std::min(startLine + 10, fileInfo->totalLines);
            
            for (uint32_t line = startLine; line <= endLine; ++line) {
                std::cout << "    ";
                if (line >= module->definition.startLine && line <= module->definition.endLine) {
                    std::cout << ">>> ";
                } else {
                    std::cout << "    ";
                }
                std::cout << std::setw(5) << std::right << line << " | " 
                          << fileInfo->getLine(*fileContent, line) << "\n";
            }
        }
    }
    
    // Print port signals (those with direction != UNKNOWN)
    // Use signalDefs for port information
    int portCount = 0;
    for (const auto& def : module->signalDefs) {
        if (def.direction != PortDirection::UNKNOWN) {
            portCount++;
        }
    }
    std::cout << "\n  Ports (" << portCount << "):\n";
    uint32_t localIdx = 0;
    for (const auto& def : module->signalDefs) {
        if (def.direction != PortDirection::UNKNOWN) {
            std::cout << "    " << std::setw(8) << std::left
                      << portDirectionToString(def.direction)
                      << " " << def.name;
            // Find corresponding instance for bit width using localIndex
            const SignalInstInfo* inst = module->getSignalInst(localIdx);
            if (inst && inst->msb != inst->lsb) {
                std::cout << " [" << inst->msb << ":" << inst->lsb << "]";
            }
            std::cout << "\n";
        }
        localIdx++;
    }

    // Print all signals using getSignals()
    auto signals = module->getSignals();
    std::cout << "\n  Signals (" << signals.size() << "):\n";
    for (const auto& signal : signals) {
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
    
    std::string fullName = buildFullName(module, builder);
    std::cout << "\n=== Module: " << module->name << " ===\n";
    // Use getModuleId to get ID from pointer
    std::cout << "  ID: " << builder.getModuleId(module) << "\n";
    std::cout << "  Full Name: " << fullName << "\n";
    std::cout << "  Definition: File " << module->definition.fileId << ", Start Line " << module->definition.startLine;
    std::cout << ", End Line " << module->definition.endLine << "\n";

    // Print port signals (those with direction != UNKNOWN)
    // Use signalDefs for port information
    int portCount = 0;
    for (const auto& def : module->signalDefs) {
        if (def.direction != PortDirection::UNKNOWN) {
            portCount++;
        }
    }
    std::cout << "\n  Ports (" << portCount << "):\n";
    uint32_t localIdx2 = 0;
    for (const auto& def : module->signalDefs) {
        if (def.direction != PortDirection::UNKNOWN) {
            std::cout << "    " << std::setw(8) << std::left
                      << portDirectionToString(def.direction)
                      << " " << def.name;
            // Find corresponding instance for bit width using localIndex
            const SignalInstInfo* inst = module->getSignalInst(localIdx2);
            if (inst && inst->msb != inst->lsb) {
                std::cout << " [" << inst->msb << ":" << inst->lsb << "]";
            }
            std::cout << "\n";
        }
        localIdx2++;
    }

    // Print all signals using getSignals()
    auto signals = module->getSignals();
    std::cout << "\n  Signals (" << signals.size() << "):\n";
    for (const auto& signal : signals) {
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
    
    // Copy driver data to local variables to avoid modification
    std::vector<uint64_t> driverIds = signal->driverSignalIds;
    std::vector<KdbSourceLocation> driverLines = signal->driverLines;
    
    std::cout << "  Drivers (" << driverIds.size() << "):\n";
    for (size_t i = 0; i < driverIds.size(); ++i) {
        uint64_t driverId = driverIds[i];
        const auto* driver = builder.findSignalById(driverId);
        if (driver) {
            std::cout << "    [" << i + 1 << "] ID=" << driverId 
                      << " Name=" << driver->fullName 
                      << " [" << signalTypeToString(driver->type) << "]";
            // Show driver line if available
            if (i < driverLines.size()) {
                std::cout << " at line " << driverLines[i].line;
            }
            std::cout << "\n";
        } else {
            std::cout << "    [" << i + 1 << "] ID=" << driverId << " <unknown>";
            if (i < driverLines.size()) {
                std::cout << " at line " << driverLines[i].line;
            }
            std::cout << "\n";
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
    std::string fullName = buildFullName(module, builder);
    std::cout << indent << module->name;
    if (!fullName.empty()) {
        std::cout << " (" << fullName << ")";
    }
    std::cout << "\n";

    auto children = builder.getChildModules(moduleId);
    for (const auto* child : children) {
        // Use getModuleId to get ID from pointer
        printHierarchyTree(builder, builder.getModuleId(child), depth + 1);
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
    
    // Output files array
    std::cout << "  \"files\": [\n";
    bool firstFile = true;
    uint32_t fileId = 1;
    for (const auto* file : builder.getAllFiles()) {
        if (!firstFile) std::cout << ",\n";
        firstFile = false;
        std::cout << "    {\n";
        std::cout << "      \"id\": " << fileId++ << ",\n";
        std::cout << "      \"path\": \"" << file->path << "\",\n";
        std::cout << "      \"total_lines\": " << file->totalLines << ",\n";
        // Output line_index_offset
        std::cout << "      \"line_index_offset\": [";
        for (size_t i = 0; i < file->lineIndexOffset.size(); ++i) {
            if (i > 0) std::cout << ", ";
            std::cout << file->lineIndexOffset[i];
        }
        std::cout << "]\n";
        std::cout << "    }";
    }
    std::cout << "\n  ],\n";
    
    std::cout << "  \"modules\": [\n";
    bool first = true;
    for (const auto* module : modules) {
        if (!first) std::cout << ",\n";
        first = false;
        std::cout << "    {\n";
        std::string fullName = buildFullName(module, builder);
        // Use getModuleId to get ID from pointer
        std::cout << "      \"id\": " << builder.getModuleId(module) << ",\n";
        std::cout << "      \"name\": \"" << module->name << "\",\n";
        // Note: full_name removed, reconstruct from hierarchy if needed
        std::cout << "      \"parent_module_id\": " << module->parentModuleId << ",\n";
        if (module->parentModuleId != 0) {
            const auto* parentModule = builder.findModuleById(module->parentModuleId);
            if (parentModule) {
                std::string parentFullName = buildFullName(parentModule, builder);
                std::cout << "      \"parent_module_full_name\": \"" << parentFullName << "\",\n";
            }
        }
        // Note: file_id removed, use definition.file_id instead
        std::cout << "      \"is_instance\": " << (module->isInstance ? "true" : "false") << ",\n";
        if (module->isInstance) {
            std::cout << "      \"def_module_id\": " << module->defModuleId << ",\n";
        }
        std::cout << "      \"definition\": {\n";
        std::cout << "        \"file_id\": " << module->definition.fileId << ",\n";
        std::cout << "        \"start_line\": " << module->definition.startLine << ",\n";
        std::cout << "        \"end_line\": " << module->definition.endLine << "\n";
        std::cout << "      },\n";
        
        std::cout << "      \"child_module_ids\": [";
        for (size_t i = 0; i < module->childModuleIds.size(); ++i) {
            if (i > 0) std::cout << ", ";
            std::cout << module->childModuleIds[i];
        }
        std::cout << "],\n";
        
        // Use getSignals() to get combined signal information
        auto signals = module->getSignals();
        std::cout << "      \"signals\": [\n";
        bool firstModuleSignal = true;
        for (const auto& signal : signals) {
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
            std::cout << "        }";
        }
        std::cout << "\n      ],\n";
        
        std::cout << "      \"instances\": [\n";
        bool firstInstance = true;
        for (uint32_t childId : module->childModuleIds) {
            const auto* childModule = builder.findModuleById(childId);
            if (!childModule) continue;
            if (!firstInstance) std::cout << ",\n";
            firstInstance = false;
            std::string childFullName = buildFullName(childModule, builder);
            std::cout << "        {\n";
            std::cout << "          \"full_name\": \"" << childFullName << "\"\n";
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
    
    static struct option longOptions[] = {
        {"modules", no_argument, nullptr, 'm'},
        {"signals", no_argument, nullptr, 's'},
        {"files", no_argument, nullptr, 'f'},
        {"hierarchy", no_argument, nullptr, 'h'},
        {"module", required_argument, nullptr, 'M'},
        {"signal", required_argument, nullptr, 'S'},
        {"driver", required_argument, nullptr, 'D'},
        {"load", required_argument, nullptr, 'L'},
        {"source", no_argument, nullptr, 'c'},
        {"content", required_argument, nullptr, 'C'},
        {"range", required_argument, nullptr, 'R'},
        {"json", no_argument, nullptr, 'j'},
        {"verbose", no_argument, nullptr, 'v'},
        {"help", no_argument, nullptr, 'H'},
        {nullptr, 0, nullptr, 0}
    };
    
    int opt;
    std::string rangeSpec;
    while ((opt = getopt_long(argc, argv, "msfhM:S:D:L:cC:R:jv", longOptions, nullptr)) != -1) {
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
            case 'c':
                showSource = true;
                break;
            case 'C':
                contentFile = optarg;
                break;
            case 'R':
                rangeSpec = optarg;
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
                     showSource || !contentFile.empty();
    
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
    
    // Handle range option: format "fileId:startLine:endLine" or "fileId:startLine"
    if (!rangeSpec.empty()) {
        // Parse range spec: fileId:startLine:endLine or fileId:startLine
        size_t firstColon = rangeSpec.find(':');
        if (firstColon != std::string::npos) {
            std::string fileIdStr = rangeSpec.substr(0, firstColon);
            size_t secondColon = rangeSpec.find(':', firstColon + 1);
            
            try {
                uint32_t fileId = std::stoul(fileIdStr);
                uint32_t startLine = std::stoul(rangeSpec.substr(firstColon + 1, 
                    secondColon != std::string::npos ? secondColon - firstColon - 1 : std::string::npos));
                uint32_t endLine = (secondColon != std::string::npos) ? 
                    std::stoul(rangeSpec.substr(secondColon + 1)) : startLine;
                
                printSourceLineRange(builder, std::to_string(fileId), startLine, endLine);
            } catch (...) {
                std::cout << "Invalid range format. Use: fileId:startLine:endLine or fileId:startLine\n";
            }
        } else {
            std::cout << "Invalid range format. Use: fileId:startLine:endLine or fileId:startLine\n";
        }
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
