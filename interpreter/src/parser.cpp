#include "parser.h"
#include <fstream>
#include <sstream>
#include <algorithm>

namespace hwda {
namespace interpreter {

Parser::Parser() = default;
Parser::~Parser() = default;

bool Parser::parseFile(const std::string& filePath) {
    std::ifstream file(filePath);
    if (!file.is_open()) {
        lastError_ = "Failed to open file: " + filePath;
        return false;
    }
    
    std::string content((std::istreambuf_iterator<char>(file)),
                        std::istreambuf_iterator<char>());
    file.close();
    
    size_t pos = 0;
    while (pos < content.size()) {
        skipWhitespace(content, pos);
        skipComment(content, pos);
        
        if (pos >= content.size()) break;
        
        std::string keyword = readIdentifier(content, pos);
        
        if (keyword == "module") {
            parseModule(content, pos, filePath);
        } else {
            while (pos < content.size() && content[pos] != ';' && content[pos] != '\n') {
                pos++;
            }
            if (pos < content.size()) pos++;
        }
    }
    
    return true;
}

bool Parser::parseFiles(const std::vector<std::string>& filePaths) {
    for (const auto& file : filePaths) {
        if (!parseFile(file)) {
            return false;
        }
    }
    return true;
}

bool Parser::parseModule(const std::string& content, size_t& pos, const std::string& filePath) {
    ParsedModule module;
    module.location.filePath = filePath;
    module.location.line = 1;
    
    for (size_t i = 0; i < pos; ++i) {
        if (content[i] == '\n') module.location.line++;
    }
    
    skipWhitespace(content, pos);
    module.name = readIdentifier(content, pos);
    currentModule_ = module.name;
    
    while (pos < content.size()) {
        skipWhitespace(content, pos);
        skipComment(content, pos);
        
        if (pos >= content.size()) break;
        
        std::string keyword = readIdentifier(content, pos);
        
        if (keyword == "endmodule") {
            module.endLine = 1;
            for (size_t i = 0; i < pos; ++i) {
                if (content[i] == '\n') module.endLine++;
            }
            modules_.push_back(module);
            currentModule_.clear();
            return true;
        }
        
        if (keyword == "input" || keyword == "output" || keyword == "inout") {
            parseSignal(content, pos, filePath, module.name);
        } else if (keyword == "wire" || keyword == "reg" || keyword == "logic") {
            parseSignal(content, pos, filePath, module.name);
        } else if (keyword == "assign") {
            parseAssignment(content, pos, filePath, module.name);
        } else if (!keyword.empty() && keyword[0] != ';') {
            // Could be an instance
            size_t savedPos = pos;
            std::string instanceName = readIdentifier(content, pos);
            if (!instanceName.empty() && instanceName != "(") {
                // This looks like an instance: ModuleType instanceName (
                module.instances.push_back(keyword);
            }
        }
    }
    
    lastError_ = "Unexpected end of file in module: " + module.name;
    return false;
}

bool Parser::parseSignal(const std::string& content, size_t& pos, const std::string& filePath, const std::string& moduleName) {
    ParsedSignal signal;
    signal.location.filePath = filePath;
    signal.location.line = 1;
    for (size_t i = 0; i < pos; ++i) {
        if (content[i] == '\n') signal.location.line++;
    }
    
    skipWhitespace(content, pos);
    
    // Check for bit width [MSB:LSB]
    if (pos < content.size() && content[pos] == '[') {
        pos++;
        std::string range = readUntil(content, pos, ']');
        if (!range.empty()) {
            size_t colonPos = range.find(':');
            if (colonPos != std::string::npos) {
                signal.msb = std::stoi(range.substr(0, colonPos));
                signal.lsb = std::stoi(range.substr(colonPos + 1));
                signal.bitWidth = signal.msb - signal.lsb + 1;
            }
        }
        if (pos < content.size() && content[pos] == ']') pos++;
    }
    
    skipWhitespace(content, pos);
    signal.name = readIdentifier(content, pos);
    
    if (!signal.name.empty()) {
        signal.bitWidth = std::max(1, signal.bitWidth);
        signals_.push_back(signal);
    }
    
    // Skip to semicolon
    while (pos < content.size() && content[pos] != ';') {
        pos++;
    }
    if (pos < content.size()) pos++;
    
    return true;
}

bool Parser::parseInstance(const std::string& content, size_t& pos, const std::string& filePath, const std::string& moduleName) {
    return true;
}

bool Parser::parseAssignment(const std::string& content, size_t& pos, const std::string& filePath, const std::string& moduleName) {
    skipWhitespace(content, pos);
    
    std::string lhs = readIdentifier(content, pos);
    skipWhitespace(content, pos);
    
    if (pos < content.size() && content[pos] == '=') {
        pos++;
        skipWhitespace(content, pos);
        
        std::string rhs;
        while (pos < content.size() && content[pos] != ';') {
            rhs += content[pos];
            pos++;
        }
        
        if (!lhs.empty() && !rhs.empty()) {
            ParsedConnection conn;
            conn.driver = rhs;
            conn.load = lhs;
            conn.driverInstance = moduleName;
            conn.loadInstance = moduleName;
            connections_.push_back(conn);
        }
    }
    
    if (pos < content.size() && content[pos] == ';') pos++;
    
    return true;
}

void Parser::skipWhitespace(const std::string& content, size_t& pos) {
    while (pos < content.size() && std::isspace(content[pos])) {
        pos++;
    }
}

void Parser::skipComment(const std::string& content, size_t& pos) {
    if (pos >= content.size()) return;
    
    if (pos + 1 < content.size() && content[pos] == '/' && content[pos + 1] == '/') {
        while (pos < content.size() && content[pos] != '\n') {
            pos++;
        }
        if (pos < content.size()) pos++;
        skipWhitespace(content, pos);
        skipComment(content, pos);
    } else if (pos + 1 < content.size() && content[pos] == '/' && content[pos + 1] == '*') {
        pos += 2;
        while (pos + 1 < content.size() && !(content[pos] == '*' && content[pos + 1] == '/')) {
            pos++;
        }
        if (pos + 1 < content.size()) pos += 2;
        skipWhitespace(content, pos);
        skipComment(content, pos);
    }
}

std::string Parser::readIdentifier(const std::string& content, size_t& pos) {
    std::string result;
    
    while (pos < content.size()) {
        char c = content[pos];
        if (std::isalnum(c) || c == '_' || c == '$' || c == '\\') {
            result += c;
            pos++;
        } else {
            break;
        }
    }
    
    return result;
}

std::string Parser::readUntil(const std::string& content, size_t& pos, char delim) {
    std::string result;
    while (pos < content.size() && content[pos] != delim) {
        result += content[pos];
        pos++;
    }
    return result;
}

}
}
