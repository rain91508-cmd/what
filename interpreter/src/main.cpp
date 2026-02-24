#include "parser.h"
#include "kdb_builder.h"
#include "kdb_serializer.h"
#include "surelog_parser.h"
#include <iostream>
#include <fstream>
#include <getopt.h>

using namespace hwda::interpreter;

void printUsage(const char* progName) {
    std::cout << "Usage: " << progName << " [options] <verilog_files...>\n"
              << "Options:\n"
              << "  -o, --output <path>   Output KDB file path (default: design.kdb)\n"
              << "  -I, --include <path>  Include directory\n"
              << "  -D, --define <macro>  Define macro\n"
              << "  -t, --top <module>    Top module name\n"
              << "  -z, --compress        Enable compression (default: enabled)\n"
              << "  -Z, --no-compress     Disable compression\n"
              << "  -l, --compress-level  Compression level 1-19 (default: 3)\n"
              << "  -v, --verbose         Verbose output\n"
              << "  -s, --surelog         Use Surelog parser (default)\n"
              << "  -b, --builtin         Use built-in parser\n"
              << "  -h, --help            Show this help\n";
}

int main(int argc, char* argv[]) {
    std::string outputPath = "design.kdb";
    std::vector<std::string> includeDirs;
    std::vector<std::string> defines;
    std::vector<std::string> inputFiles;
    std::string topModule;
    bool verbose = false;
    bool useSurelog = true;
    bool compressionEnabled = true;
    int compressionLevel = 3;
    
    static struct option longOptions[] = {
        {"output", required_argument, nullptr, 'o'},
        {"include", required_argument, nullptr, 'I'},
        {"define", required_argument, nullptr, 'D'},
        {"top", required_argument, nullptr, 't'},
        {"compress", no_argument, nullptr, 'z'},
        {"no-compress", no_argument, nullptr, 'Z'},
        {"compress-level", required_argument, nullptr, 'l'},
        {"verbose", no_argument, nullptr, 'v'},
        {"surelog", no_argument, nullptr, 's'},
        {"builtin", no_argument, nullptr, 'b'},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0}
    };
    
    int opt;
    while ((opt = getopt_long(argc, argv, "o:I:D:t:zZl:vsbh", longOptions, nullptr)) != -1) {
        switch (opt) {
            case 'o':
                outputPath = optarg;
                break;
            case 'I':
                includeDirs.push_back(optarg);
                break;
            case 'D':
                defines.push_back(optarg);
                break;
            case 't':
                topModule = optarg;
                break;
            case 'z':
                compressionEnabled = true;
                break;
            case 'Z':
                compressionEnabled = false;
                break;
            case 'l':
                compressionLevel = std::stoi(optarg);
                if (compressionLevel < 1) compressionLevel = 1;
                if (compressionLevel > 19) compressionLevel = 19;
                break;
            case 'v':
                verbose = true;
                break;
            case 's':
                useSurelog = true;
                break;
            case 'b':
                useSurelog = false;
                break;
            case 'h':
            default:
                printUsage(argv[0]);
                return (opt == 'h') ? 0 : 1;
        }
    }
    
    for (int i = optind; i < argc; ++i) {
        inputFiles.push_back(argv[i]);
    }
    
    if (inputFiles.empty()) {
        std::cerr << "Error: No input files specified\n";
        printUsage(argv[0]);
        return 1;
    }
    
    if (verbose) {
        std::cout << "Parsing " << inputFiles.size() << " file(s)...\n";
        for (const auto& file : inputFiles) {
            std::cout << "  " << file << "\n";
        }
    }
    
    KdbBuilder builder;
    builder.setProjectName("hwda_design");
    builder.setCompressionEnabled(compressionEnabled);
    builder.setCompressionLevel(compressionLevel);
    
    if (useSurelog) {
#ifdef USE_SURELOG
        SurelogParser surelogParser;
        surelogParser.setCompileOptions(verbose, false, false);
        if (!topModule.empty()) {
            surelogParser.setTopModule(topModule);
        }
        
        auto result = surelogParser.parseFiles(inputFiles, includeDirs, defines);
        if (!result.success) {
            std::cerr << "Surelog parse error: " << result.errorMessage << "\n";
            return 1;
        }
        
        if (verbose) {
            std::cout << "Surelog parsed successfully\n";
            std::cout << "  Modules: " << result.moduleCount << "\n";
        }
        
        if (!surelogParser.buildKnowledgeBase(builder)) {
            std::cerr << "Failed to build knowledge base: " << surelogParser.getLastError() << "\n";
            return 1;
        }
        
        if (verbose) {
            std::cout << "Knowledge base built successfully\n";
            std::cout << "  Total modules: " << builder.getModuleCount() << "\n";
            std::cout << "  Total signals: " << builder.getSignalCount() << "\n";
        }
#else
        std::cerr << "Error: Surelog support not compiled in\n";
        return 1;
#endif
    } else {
        // 使用内置解析器
        Parser parser;
        if (!parser.parseFiles(inputFiles)) {
            std::cerr << "Parse error: " << parser.getError() << "\n";
            return 1;
        }
        
        if (verbose) {
            std::cout << "Found " << parser.getModules().size() << " modules\n";
            std::cout << "Found " << parser.getSignals().size() << " signals\n";
            std::cout << "Found " << parser.getConnections().size() << " connections\n";
        }
    }
    
    // 序列化知识库
    if (!builder.serializeToFile(outputPath)) {
        std::cerr << "Failed to serialize KDB\n";
        return 1;
    }
    
    std::cout << "Generated KDB: " << outputPath << "\n";
    std::cout << "  Modules: " << builder.getModuleCount() << "\n";
    std::cout << "  Signals: " << builder.getSignalCount() << "\n";
    std::cout << "  Files: " << builder.getFileCount() << "\n";
#ifdef USE_ZSTD
    std::cout << "  Compression: " << (compressionEnabled ? "enabled" : "disabled") << "\n";
    if (compressionEnabled) {
        std::cout << "  Compression level: " << compressionLevel << "\n";
    }
#else
    std::cout << "  Compression: not available (zstd not compiled in)\n";
#endif
    
    return 0;
}
