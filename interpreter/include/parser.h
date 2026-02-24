#ifndef HWDA_INTERPRETER_PARSER_H
#define HWDA_INTERPRETER_PARSER_H

#include "types.h"
#include <string>
#include <vector>
#include <memory>

namespace hwda {
namespace interpreter {

class Parser {
public:
    Parser();
    ~Parser();
    
    bool parseFile(const std::string& filePath);
    bool parseFiles(const std::vector<std::string>& filePaths);
    
    const std::vector<ParsedModule>& getModules() const { return modules_; }
    const std::vector<ParsedSignal>& getSignals() const { return signals_; }
    const std::vector<ParsedConnection>& getConnections() const { return connections_; }
    
    std::string getError() const { return lastError_; }
    bool hasError() const { return !lastError_.empty(); }
    
private:
    bool parseModule(const std::string& content, size_t& pos, const std::string& filePath);
    bool parseSignal(const std::string& content, size_t& pos, const std::string& filePath, const std::string& moduleName);
    bool parseInstance(const std::string& content, size_t& pos, const std::string& filePath, const std::string& moduleName);
    bool parseAssignment(const std::string& content, size_t& pos, const std::string& filePath, const std::string& moduleName);
    
    void skipWhitespace(const std::string& content, size_t& pos);
    void skipComment(const std::string& content, size_t& pos);
    std::string readIdentifier(const std::string& content, size_t& pos);
    std::string readUntil(const std::string& content, size_t& pos, char delim);
    
    std::vector<ParsedModule> modules_;
    std::vector<ParsedSignal> signals_;
    std::vector<ParsedConnection> connections_;
    
    std::string lastError_;
    std::string currentModule_;
};

}
}

#endif
