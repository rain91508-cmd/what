#include "parser.h"
#include "kdb_builder.h"
#include "kdb_serializer.h"
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
              << "  -v, --verbose         Verbose output\n"
              << "  -h, --help            Show this help\n";
}

int main(int argc, char* argv[]) {
    std::string outputPath = "design.kdb";
    std::vector<std::string> includeDirs;
    std::vector<std::string> defines;
    std::vector<std::string> inputFiles;
    bool verbose = false;
    
    static struct option longOptions[] = {
        {"output", required_argument, nullptr, 'o'},
        {"include", required_argument, nullptr, 'I'},
        {"define", required_argument, nullptr, 'D'},
        {"verbose", no_argument, nullptr, 'v'},
        {"help", no_argument, nullptr, 'h'},
        {nullptr, 0, nullptr, 0}
    };
    
    int opt;
    while ((opt = getopt_long(argc, argv, "o:I:D:vh", longOptions, nullptr)) != -1) {
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
            case 'v':
                verbose = true;
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
    
    KdbBuilder builder;
    
    for (const auto& module : parser.getModules()) {
        builder.addModule(module);
    }
    
    for (const auto& signal : parser.getSignals()) {
        builder.addSignal(signal, "");
    }
    
    for (const auto& conn : parser.getConnections()) {
        builder.addConnection(conn);
    }
    
    for (const auto& file : inputFiles) {
        std::ifstream ifs(file);
        if (ifs.is_open()) {
            std::string content((std::istreambuf_iterator<char>(ifs)),
                               std::istreambuf_iterator<char>());
            builder.addSourceFile(file, content);
        }
    }
    
    builder.buildIndices();
    
    KdbSerializer serializer;
    if (!serializer.serialize(builder, outputPath)) {
        std::cerr << "Failed to serialize KDB\n";
        return 1;
    }
    
    std::cout << "Generated KDB: " << outputPath << "\n";
    
    return 0;
}
