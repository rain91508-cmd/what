#include "parser.h"
#include "kdb_builder.h"
#include "kdb_serializer.h"
#include "surelog_parser.h"
#include <iostream>
#include <fstream>
#include <sstream>
#include <getopt.h>
#include <filesystem>

using namespace hwda::interpreter;

void printUsage(const char* progName) {
    std::cout << "Usage: " << progName << " [options] <verilog_files...>\n"
              << "\nStandard Verilog Options:\n"
              << "  -f <file>             Accepts a file containing command line arguments\n"
              << "  -v <file>             Library file\n"
              << "  -sv <file>            Forces this file to be parsed as a SystemVerilog file\n"
              << "  -sverilog             Forces all files to be parsed as SystemVerilog files\n"
              << "  -y <path>             Library directory\n"
              << "  +incdir+<dir>[+<dir>...]  Specifies include paths\n"
              << "  -I<dir>               Specifies include paths\n"
              << "  +libext+<ext>+...     Specifies the library extensions\n"
              << "  +define+<name>=<value>[+<name>=<value>...] Defines macros\n"
              << "  -D<name>=<value>      Defines a macro\n"
              << "  -P<parameter>=<value> Overrides a toplevel module parameter\n"
              << "  -top <module>         Top level module for elaboration\n"
              << "\nOutput Options:\n"
              << "  -o, --output <path>   Output KDB file path (default: design.kdb)\n"
              << "  -z, --compress        Enable compression (default: enabled)\n"
              << "  -Z, --no-compress     Disable compression\n"
              << "  -l, --compress-level  Compression level 1-19 (default: 9)\n"
              << "\nOther Options:\n"
              << "  -v, --verbose         Verbose output\n"
              << "  -s, --surelog         Use Surelog parser (default)\n"
              << "  -b, --builtin         Use built-in parser\n"
              << "  --help                Show this help\n";
}

std::vector<std::string> parsePlusArg(const std::string& arg, const std::string& prefix) {
    std::vector<std::string> result;
    if (arg.find(prefix) == 0) {
        std::string rest = arg.substr(prefix.length());
        std::stringstream ss(rest);
        std::string item;
        while (std::getline(ss, item, '+')) {
            if (!item.empty()) {
                result.push_back(item);
            }
        }
    }
    return result;
}

bool parseDefineValue(const std::string& def, std::string& name, std::string& value) {
    size_t pos = def.find('=');
    if (pos != std::string::npos) {
        name = def.substr(0, pos);
        value = def.substr(pos + 1);
    } else {
        name = def;
        value = "1";
    }
    return !name.empty();
}

std::vector<std::string> parseFileList(const std::string& filepath) {
    std::vector<std::string> args;
    std::ifstream file(filepath);
    if (!file) {
        std::cerr << "Error: Cannot open file list: " << filepath << "\n";
        return args;
    }
    
    std::string line;
    while (std::getline(file, line)) {
        // Remove comments
        size_t commentPos = line.find("//");
        if (commentPos != std::string::npos) {
            line = line.substr(0, commentPos);
        }
        commentPos = line.find("#");
        if (commentPos != std::string::npos) {
            line = line.substr(0, commentPos);
        }
        
        // Trim whitespace
        while (!line.empty() && (line.front() == ' ' || line.front() == '\t')) {
            line.erase(0, 1);
        }
        while (!line.empty() && (line.back() == ' ' || line.back() == '\t')) {
            line.pop_back();
        }
        
        if (line.empty()) continue;
        
        // Split into tokens
        std::stringstream ss(line);
        std::string token;
        while (ss >> token) {
            args.push_back(token);
        }
    }
    
    return args;
}

struct CommandLineOptions {
    std::string outputPath = "design.kdb";
    std::vector<std::string> includeDirs;
    std::vector<std::string> defines;
    std::vector<std::string> libraryDirs;
    std::vector<std::string> libraryFiles;
    std::vector<std::string> libraryExtensions;
    std::vector<std::string> inputFiles;
    std::vector<std::string> parameters;
    std::string topModule;
    bool verbose = false;
    bool useSurelog = true;
    bool compressionEnabled = true;
    int compressionLevel = 9;
    bool forceSystemVerilog = false;
};

bool parseCommandLine(int argc, char* argv[], CommandLineOptions& opts) {
    // First pass: handle + arguments and collect all arguments
    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        
        // Handle +incdir+
        if (arg.find("+incdir+") == 0) {
            auto dirs = parsePlusArg(arg, "+incdir+");
            for (const auto& dir : dirs) {
                opts.includeDirs.push_back(dir);
            }
            continue;
        }
        
        // Handle +define+
        if (arg.find("+define+") == 0) {
            auto defs = parsePlusArg(arg, "+define+");
            for (const auto& def : defs) {
                opts.defines.push_back(def);
            }
            continue;
        }
        
        // Handle +libext+
        if (arg.find("+libext+") == 0) {
            auto exts = parsePlusArg(arg, "+libext+");
            for (const auto& ext : exts) {
                opts.libraryExtensions.push_back(ext);
            }
            continue;
        }
        
        args.push_back(arg);
    }
    
    // Second pass: process remaining arguments
    for (size_t i = 0; i < args.size(); ++i) {
        const std::string& arg = args[i];
        
        // Check for options with arguments
        if (arg == "-o" || arg == "--output") {
            if (i + 1 < args.size()) {
                opts.outputPath = args[++i];
            }
            continue;
        }
        if (arg == "-I") {
            if (i + 1 < args.size()) {
                opts.includeDirs.push_back(args[++i]);
            }
            continue;
        }
        if (arg == "-D") {
            if (i + 1 < args.size()) {
                opts.defines.push_back(args[++i]);
            }
            continue;
        }
        if (arg == "-f") {
            if (i + 1 < args.size()) {
                auto fileArgs = parseFileList(args[++i]);
                for (const auto& fa : fileArgs) {
                    // Process each argument from file
                    if (fa.find("+incdir+") == 0) {
                        auto dirs = parsePlusArg(fa, "+incdir+");
                        for (const auto& dir : dirs) {
                            opts.includeDirs.push_back(dir);
                        }
                    } else if (fa.find("+define+") == 0) {
                        auto defs = parsePlusArg(fa, "+define+");
                        for (const auto& def : defs) {
                            opts.defines.push_back(def);
                        }
                    } else if (fa[0] == '-') {
                        // Re-process as option
                        args.insert(args.begin() + i + 1, fa);
                    } else {
                        opts.inputFiles.push_back(fa);
                    }
                }
            }
            continue;
        }
        if (arg == "-v") {
            if (i + 1 < args.size() && args[i + 1][0] != '-') {
                opts.libraryFiles.push_back(args[++i]);
            } else {
                opts.verbose = true;
            }
            continue;
        }
        if (arg == "-y") {
            if (i + 1 < args.size()) {
                opts.libraryDirs.push_back(args[++i]);
            }
            continue;
        }
        if (arg == "-P") {
            if (i + 1 < args.size()) {
                opts.parameters.push_back(args[++i]);
            }
            continue;
        }
        if (arg == "-top" || arg == "-t" || arg == "--top-module") {
            if (i + 1 < args.size()) {
                opts.topModule = args[++i];
            }
            continue;
        }
        if (arg == "-l" || arg == "--compress-level") {
            if (i + 1 < args.size()) {
                opts.compressionLevel = std::stoi(args[++i]);
                if (opts.compressionLevel < 1) opts.compressionLevel = 1;
                if (opts.compressionLevel > 19) opts.compressionLevel = 19;
            }
            continue;
        }
        
        // Boolean options
        if (arg == "-z" || arg == "--compress") {
            opts.compressionEnabled = true;
            continue;
        }
        if (arg == "-Z" || arg == "--no-compress") {
            opts.compressionEnabled = false;
            continue;
        }
        if (arg == "-V" || arg == "--verbose") {
            opts.verbose = true;
            continue;
        }
        if (arg == "-s" || arg == "--surelog") {
            opts.useSurelog = true;
            continue;
        }
        if (arg == "-b" || arg == "--builtin") {
            opts.useSurelog = false;
            continue;
        }
        if (arg == "--help" || arg == "-h") {
            return false;
        }
        
        // Handle -D, -I, -P without space (e.g., -DWIDTH=8)
        if (arg.length() > 2 && arg[0] == '-') {
            char type = arg[1];
            std::string value = arg.substr(2);
            if (type == 'D') {
                opts.defines.push_back(value);
                continue;
            }
            if (type == 'I') {
                opts.includeDirs.push_back(value);
                continue;
            }
            if (type == 'P') {
                opts.parameters.push_back(value);
                continue;
            }
        }
        
        // Handle -sv option
        if (arg == "-sv") {
            opts.forceSystemVerilog = true;
            if (i + 1 < args.size() && args[i + 1][0] != '-') {
                opts.inputFiles.push_back(args[++i]);
            }
            continue;
        }
        
        // Handle -sverilog option
        if (arg == "-sverilog") {
            opts.forceSystemVerilog = true;
            continue;
        }
        
        // Unknown option starting with -
        if (arg[0] == '-') {
            std::cerr << "Warning: Unknown option: " << arg << "\n";
            continue;
        }
        
        // Otherwise it's an input file
        opts.inputFiles.push_back(arg);
    }
    
    return true;
}

int main(int argc, char* argv[]) {
    CommandLineOptions opts;
    
    if (argc < 2) {
        printUsage(argv[0]);
        return 1;
    }
    
    // Check for --help
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--help" || arg == "-h") {
            printUsage(argv[0]);
            return 0;
        }
    }
    
    if (!parseCommandLine(argc, argv, opts)) {
        printUsage(argv[0]);
        return 1;
    }
    
    if (opts.inputFiles.empty()) {
        std::cerr << "Error: No input files specified\n";
        printUsage(argv[0]);
        return 1;
    }
    
    if (opts.verbose) {
        std::cout << "Parsing " << opts.inputFiles.size() << " file(s)...\n";
        for (const auto& file : opts.inputFiles) {
            std::cout << "  " << file << "\n";
        }
        if (!opts.includeDirs.empty()) {
            std::cout << "Include directories:\n";
            for (const auto& dir : opts.includeDirs) {
                std::cout << "  " << dir << "\n";
            }
        }
        if (!opts.defines.empty()) {
            std::cout << "Defines:\n";
            for (const auto& def : opts.defines) {
                std::cout << "  " << def << "\n";
            }
        }
        if (!opts.topModule.empty()) {
            std::cout << "Top module: " << opts.topModule << "\n";
        }
    }
    
    KdbBuilder builder;
    builder.setProjectName("hwda_design");
    builder.setCompressionEnabled(opts.compressionEnabled);
    builder.setCompressionLevel(opts.compressionLevel);
    
    if (opts.useSurelog) {
#ifdef USE_SURELOG
        SurelogParser surelogParser;
        surelogParser.setCompileOptions(opts.verbose, false, false);
        if (!opts.topModule.empty()) {
            surelogParser.setTopModule(opts.topModule);
        }
        
        auto result = surelogParser.parseFiles(opts.inputFiles, opts.includeDirs, opts.defines);
        if (!result.success) {
            std::cerr << "Surelog parse error: " << result.errorMessage << "\n";
            return 1;
        }
        
        if (opts.verbose) {
            std::cout << "Surelog parsed successfully\n";
            std::cout << "  Modules: " << result.moduleCount << "\n";
        }
        
        if (!surelogParser.buildKnowledgeBase(builder)) {
            std::cerr << "Failed to build knowledge base: " << surelogParser.getLastError() << "\n";
            return 1;
        }
        
        if (opts.verbose) {
            std::cout << "Knowledge base built successfully\n";
            std::cout << "  Total modules: " << builder.getModuleCount() << "\n";
            std::cout << "  Total signals: " << builder.getSignalCount() << "\n";
        }
#else
        std::cerr << "Error: Surelog support not compiled in\n";
        return 1;
#endif
    } else {
        Parser parser;
        if (!parser.parseFiles(opts.inputFiles)) {
            std::cerr << "Parse error: " << parser.getError() << "\n";
            return 1;
        }
        
        if (opts.verbose) {
            std::cout << "Found " << parser.getModules().size() << " modules\n";
            std::cout << "Found " << parser.getSignals().size() << " signals\n";
            std::cout << "Found " << parser.getConnections().size() << " connections\n";
        }
    }
    
    if (!builder.serializeToFile(opts.outputPath)) {
        std::cerr << "Failed to serialize KDB\n";
        return 1;
    }
    
    std::cout << "Generated KDB: " << opts.outputPath << "\n";
    std::cout << "  Modules: " << builder.getModuleCount() << "\n";
    std::cout << "  Signals: " << builder.getTotalSignalCount() << "\n";
    std::cout << "  Files: " << builder.getFileCount() << "\n";
#ifdef USE_ZSTD
    std::cout << "  Compression: " << (opts.compressionEnabled ? "enabled" : "disabled") << "\n";
    if (opts.compressionEnabled) {
        std::cout << "  Compression level: " << opts.compressionLevel << "\n";
    }
#else
    std::cout << "  Compression: not available (zstd not compiled in)\n";
#endif
    
    return 0;
}
