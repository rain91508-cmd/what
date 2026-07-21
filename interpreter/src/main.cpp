#include "kdb_builder.h"
#include "surelog_parser.h"
#include <iostream>
#include <fstream>
#include <sstream>
#include <getopt.h>
#include <cctype>
#include <filesystem>

#include <Surelog/API/Surelog.h>
#include <Surelog/CommandLine/CommandLineParser.h>
#include <Surelog/ErrorReporting/ErrorContainer.h>
#include <Surelog/SourceCompile/SymbolTable.h>

using namespace hwda::interpreter;

// Define global verbose flag
namespace hwda {
namespace interpreter {
    bool g_verbose = false;
}
}

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
              << "  -dr, --drivers        Enable signal driver tracing (default: disabled)\n"
              << "  -uhdm, --keep-uhdm    Keep Surelog's intermediate .uhdm file for debugging (default: off)\n"
              << "\nMemory Options:\n"
              << "  --disable-low-mem     Disable Surelog low-memory optimization (default: ON).\n"
              << "                        When set, you may individually control the options below:\n"
              << "  -lowmem, --low-mem    Enable Surelog low-memory mode (only with --disable-low-mem)\n"
              << "  -mt, --max-threads <N> Max Surelog threads (only with --disable-low-mem; default: 0)\n"
              << "\nOther Options:\n"
              << "  -v, --verbose         Verbose output\n"
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

    // Read the whole file and strip comments (//, # line comments and
    // /* ... */ block comments that may span multiple lines) before tokenizing.
    std::stringstream whole;
    whole << file.rdbuf();
    std::string content = whole.str();

    bool inBlock = false;
    std::string cleaned;
    for (size_t i = 0; i < content.size(); ++i) {
        if (inBlock) {
            if (content[i] == '*' && i + 1 < content.size() && content[i + 1] == '/') {
                inBlock = false;
                ++i;  // consume the '/'
            }
            continue;
        }
        if (content[i] == '/' && i + 1 < content.size() && content[i + 1] == '*') {
            inBlock = true;
            ++i;  // consume the '*'
            continue;
        }
        if (content[i] == '/' && i + 1 < content.size() && content[i + 1] == '/') {
            while (i < content.size() && content[i] != '\n') ++i;
            continue;
        }
        if (content[i] == '#') {
            while (i < content.size() && content[i] != '\n') ++i;
            continue;
        }
        cleaned += content[i];
    }

    std::stringstream ss(cleaned);
    std::string token;
    while (ss >> token) {
        args.push_back(token);
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
    bool compressionEnabled = true;
    int compressionLevel = 9;
    bool forceSystemVerilog = false;
    bool driverTracingEnabled = true;  // Enabled by default: build driver/load graph
    bool keepUhdmFile = false;  // Default: do not write Surelog's .uhdm file
    bool disableLowMem = false; // Default: low-memory optimization is ON
    bool lowMem = false;        // Individual control, only with --disable-low-mem
    int maxThreads = 0;         // Individual control, only with --disable-low-mem
};

// Expand ${VAR}-style environment variables in a token.
static std::string expandEnvVars(const std::string& in) {
    std::string out;
    out.reserve(in.size());
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '$' && i + 1 < in.size() && in[i + 1] == '{') {
            size_t end = in.find('}', i + 2);
            if (end != std::string::npos) {
                std::string name = in.substr(i + 2, end - (i + 2));
                const char* v = std::getenv(name.c_str());
                if (v) out += v;
                i = end;
                continue;
            }
        }
        out += in[i];
    }
    return out;
}

static bool hasSourceExtension(const std::string& s) {
    std::string e = std::filesystem::path(s).extension().string();
    if (e.empty()) return false;
    for (auto& c : e) c = (char)std::tolower((unsigned char)c);
    static const char* exts[] = {".v", ".sv", ".vh", ".svh", ".vhd", ".svi", nullptr};
    for (int i = 0; exts[i]; ++i)
        if (e == exts[i]) return true;
    return false;
}

// Recursively expand `-f <file>` references. Path-bearing tokens (input
// files, -y, -v, -I, +incdir+) are resolved relative to the current working
// directory, matching Surelog's own `-f` semantics (cd starts at cwd).
// ${VAR} env vars are expanded. The result is a flat token list with no
// remaining -f entries.
static void expandArgsRecursive(const std::vector<std::string>& rawArgs,
                                std::vector<std::string>& out) {
    std::filesystem::path cwd = std::filesystem::current_path();
    for (size_t k = 0; k < rawArgs.size(); ++k) {
        std::string tok = expandEnvVars(rawArgs[k]);

        if (tok == "-f") {
            if (k + 1 < rawArgs.size()) {
                std::filesystem::path ref(expandEnvVars(rawArgs[++k]));
                if (ref.is_relative()) ref = cwd / ref;
                auto norm = ref.lexically_normal();
                auto nested = parseFileList(norm.string());
                expandArgsRecursive(nested, out);
            }
            continue;
        }

        if (tok.find("+incdir+") == 0) {
            auto dirs = parsePlusArg(tok, "+incdir+");
            std::string rebuilt = "+incdir+";
            for (auto& d : dirs) {
                std::filesystem::path p(expandEnvVars(d));
                if (p.is_relative()) p = cwd / p;
                rebuilt += p.lexically_normal().string() + "+";
            }
            out.push_back(rebuilt);
            continue;
        }

        if (tok.find("+libext+") == 0 || tok.find("+define+") == 0) {
            out.push_back(tok);
            continue;
        }

        if (tok == "-y" || tok == "-v" || tok == "-I") {
            if (k + 1 < rawArgs.size()) {
                std::string val = expandEnvVars(rawArgs[++k]);
                std::filesystem::path p(val);
                if (p.is_relative()) p = cwd / p;
                out.push_back(tok);
                out.push_back(p.lexically_normal().string());
            }
            continue;
        }

        if (tok.size() > 2 && tok[0] == '-' &&
            (tok[1] == 'I' || tok[1] == 'y' || tok[1] == 'v')) {
            char t = tok[1];
            std::string val = tok.substr(2);
            std::filesystem::path p(val);
            if (p.is_relative()) p = cwd / p;
            out.push_back("-" + std::string(1, t) + p.lexically_normal().string());
            continue;
        }

        if (!tok.empty() && tok[0] != '-') {
            bool pathLike = (tok.find('/') != std::string::npos) || hasSourceExtension(tok);
            if (pathLike) {
                std::filesystem::path p(tok);
                if (p.is_relative()) p = cwd / p;
                out.push_back(p.lexically_normal().string());
            } else {
                out.push_back(tok);
            }
            continue;
        }

        out.push_back(tok);
    }
}

bool parseCommandLine(int argc, char* argv[], CommandLineOptions& opts) {
    std::vector<std::string> rawArgs;
    for (int i = 1; i < argc; ++i) {
        rawArgs.push_back(argv[i]);
    }

    // Recursively expand -f file lists, resolving referenced paths relative
    // to the current working directory (matches Surelog's -f semantics).
    std::vector<std::string> args;
    expandArgsRecursive(rawArgs, args);

    for (size_t i = 0; i < args.size(); ++i) {
        const std::string& arg = args[i];
        
        if (arg.find("+incdir+") == 0) {
            auto dirs = parsePlusArg(arg, "+incdir+");
            for (const auto& dir : dirs) {
                opts.includeDirs.push_back(dir);
            }
            continue;
        }
        
        if (arg.find("+define+") == 0) {
            auto defs = parsePlusArg(arg, "+define+");
            for (const auto& def : defs) {
                opts.defines.push_back(def);
            }
            continue;
        }
        
        if (arg.find("+libext+") == 0) {
            auto exts = parsePlusArg(arg, "+libext+");
            for (const auto& ext : exts) {
                opts.libraryExtensions.push_back(ext);
            }
            continue;
        }
        
        if (arg == "-f") {
            // Already expanded by expandArgsRecursive; skip any leftover.
            if (i + 1 < args.size()) ++i;
            continue;
        }

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
        
        if (arg == "-z" || arg == "--compress") {
            opts.compressionEnabled = true;
            continue;
        }
        if (arg == "-dr" || arg == "--drivers") {
            opts.driverTracingEnabled = true;
            continue;
        }
        if (arg == "-uhdm" || arg == "--keep-uhdm") {
            opts.keepUhdmFile = true;
            continue;
        }
        if (arg == "--disable-low-mem") {
            opts.disableLowMem = true;
            continue;
        }
        if (arg == "-lowmem" || arg == "--low-mem") {
            if (!opts.disableLowMem) {
                std::cerr << "Error: -lowmem/--low-mem requires --disable-low-mem\n";
                return false;
            }
            opts.lowMem = true;
            continue;
        }
        if (arg == "-mt" || arg == "--max-threads") {
            if (!opts.disableLowMem) {
                std::cerr << "Error: -mt/--max-threads requires --disable-low-mem\n";
                return false;
            }
            if (i + 1 < args.size()) {
                opts.maxThreads = std::stoi(args[++i]);
            }
            continue;
        }
        if (arg == "-Z" || arg == "--no-compress") {
            opts.compressionEnabled = false;
            continue;
        }
        if (arg == "-V" || arg == "--verbose") {
            opts.verbose = true;
            g_verbose = true;
            continue;
        }
        if (arg == "--help" || arg == "-h") {
            return false;
        }
        
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
        
        if (arg == "-sv") {
            opts.forceSystemVerilog = true;
            if (i + 1 < args.size() && args[i + 1][0] != '-') {
                opts.inputFiles.push_back(args[++i]);
            }
            continue;
        }
        
        if (arg == "-sverilog") {
            opts.forceSystemVerilog = true;
            continue;
        }
        
        if (arg[0] == '-') {
            std::cerr << "Warning: Unknown option: " << arg << "\n";
            continue;
        }
        
        opts.inputFiles.push_back(arg);
    }
    
    return true;
}

// Surelog parallelizes preprocessing/parsing by re-spawning this very binary
// with "-batch <file>". Each line of that batch file is a standalone Surelog
// command (preprocess or parse) that we run through the public API. Without
// handling -batch, the spawned child re-enters the full KDB build and forks
// itself recursively (a fork bomb that exhausts memory). The batch lines
// already carry "-mp 0", so no further forking happens inside a child.
static int runBatchMode(int argc, char* argv[]) {
    std::filesystem::path batchFile;
    std::filesystem::path outputDir;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "-batch" && i + 1 < argc) {
            batchFile = argv[++i];
        } else if (a == "-o" && i + 1 < argc) {
            outputDir = argv[++i];
        }
    }
    if (batchFile.empty()) {
        std::cerr << "Error: -batch requires a file argument\n";
        return 1;
    }

    std::ifstream stream(batchFile);
    if (!stream.good()) {
        std::cerr << "Error: cannot open batch file: " << batchFile << "\n";
        return 1;
    }

    int returnCode = 0;
    std::string line;
    while (std::getline(stream, line)) {
        if (line.empty()) continue;
        std::vector<std::string> args;
        {
            std::stringstream ss(line);
            std::string tok;
            while (ss >> tok) args.push_back(tok);
        }
        // Inject the output directory if the line does not already set one.
        bool hasOutput = false;
        for (const auto& t : args) {
            if (t == "-o") {
                hasOutput = true;
                break;
            }
        }
        if (!hasOutput && !outputDir.empty()) {
            args.push_back("-o");
            args.push_back(outputDir.string());
        }

        std::vector<const char*> cargv;
        cargv.push_back(argv[0]);
        for (const auto& t : args) cargv.push_back(t.c_str());
        if (cargv.size() < 2) continue;

        SURELOG::SymbolTable* st = new SURELOG::SymbolTable();
        SURELOG::ErrorContainer* ec = new SURELOG::ErrorContainer(st);
        SURELOG::CommandLineParser* clp =
            new SURELOG::CommandLineParser(ec, st, false, false);
        bool ok = clp->parseCommandLine((int)cargv.size(), cargv.data());
        if (ok && !clp->help()) {
            SURELOG::scompiler* compiler = SURELOG::start_compiler(clp);
            if (!compiler) returnCode |= 1;
            SURELOG::shutdown_compiler(compiler);
        }
        clp->cleanCache();
        delete clp;
        delete ec;
        delete st;
    }
    return returnCode;
}

int main(int argc, char* argv[]) {
    CommandLineOptions opts;
    
    if (argc < 2) {
        printUsage(argv[0]);
        return 1;
    }

    // If Surelog spawned us as a multiprocess child, handle -batch and exit.
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "-batch") {
            return runBatchMode(argc, argv);
        }
    }
    
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
        std::cout << "Driver tracing: " << (opts.driverTracingEnabled ? "enabled" : "disabled") << "\n";
        std::cout << "Keep .uhdm file: " << (opts.keepUhdmFile ? "enabled" : "disabled") << "\n";
        std::cout << "Low-memory optimization: " << ((opts.disableLowMem ? opts.lowMem : true) ? "enabled" : "disabled") << "\n";
    }
    
    KdbBuilder builder;
    builder.setProjectName("what_design");
    builder.setCompressionEnabled(opts.compressionEnabled);
    builder.setCompressionLevel(opts.compressionLevel);
    
    SurelogParser surelogParser;
    surelogParser.setCompileOptions(opts.verbose, false, false);
    surelogParser.setDriverTracingEnabled(opts.driverTracingEnabled);
    surelogParser.setWriteUhdmEnabled(opts.keepUhdmFile);
    // Low-memory optimization is ON by default. With --disable-low-mem the
    // user takes manual control of -lowmem / -mt (both default off there).
    surelogParser.setLowMemEnabled(opts.disableLowMem ? opts.lowMem : true);
    surelogParser.setMaxThreads(opts.disableLowMem ? opts.maxThreads : 0);
    // Forward library options (-y / -v / +libext+) that the CLI collected but
    // that parseFiles() cannot take as parameters. +incdir+ / +define+ are
    // forwarded via parseFiles()'s includePaths/defines arguments.
    surelogParser.setLibraryDirs(opts.libraryDirs);
    surelogParser.setLibraryFiles(opts.libraryFiles);
    surelogParser.setLibraryExtensions(opts.libraryExtensions);
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
        std::cout << "  Total signals: " << builder.getTotalSignalCount() << "\n";
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
    std::cout << "  Driver tracing: " << (opts.driverTracingEnabled ? "enabled" : "disabled") << "\n";
    std::cout << "  Keep .uhdm file: " << (opts.keepUhdmFile ? "enabled" : "disabled") << "\n";
    std::cout << "  Low-memory optimization: " << ((opts.disableLowMem ? opts.lowMem : true) ? "enabled" : "disabled") << "\n";
    
    return 0;
}
