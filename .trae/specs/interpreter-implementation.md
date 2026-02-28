# Design Interpreter Implementation Details

## 1. Overview

The Design Interpreter is responsible for converting Verilog/SystemVerilog source code into an internal Knowledge Base (KDB) for use by the wHDL and wSignal modules.

## 2. Technical Architecture

### 2.1 Parser Selection

**Surelog** (<https://github.com/chipsalliance/Surelog>) is used as the SystemVerilog parser.

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| Parser | Surelog | Parse Verilog/SystemVerilog with elaboration |
| Data Model | UHDM | Unified Hardware Data Model |
| Language | C++17 | Implementation language |

### 2.2 Knowledge Base Contents

| Information Type | Content Description |
|-----------------|---------------------|
| Signal Info | Name, full path, bit width, type, direction, driver relationships, declaration location |
| Module Info | Module definition/instance, parent module, child modules, definition location, source file ID |
| Hierarchy | Module parent-child relationships, instance-to-definition associations |
| Source Code | Source text, file path, line numbers |

## 3. Module Structure Design

### 3.1 Definition vs Instance

| Field | Definition | Instance | Description |
|-------|------------|----------|-------------|
| `name` | `VpiDefName()` (e.g., "work@dut") | `VpiName()` (e.g., "u_dut") | Distinguish definition and instance |
| `is_instance` | `false` | `true` | Identify module type |
| `def_module_id` | `0` | Points to Definition's ID | Instance links to its definition |
| `def_name` | Empty | Definition name (e.g., "work@dut") | For Definition lookup |
| `definition` | Definition's file range | Instance's location | Source code positioning |
| `full_name` | **Removed**, built dynamically from parent chain | **Removed**, built dynamically from parent chain | Reduce redundant storage |

### 3.2 SignalDef/SignalInst Split Architecture

To optimize memory usage, signals are split into two structures:

**SignalDef (Definition Module)**
- Stored in Definition modules
- Contains static information: name, type, bit width, direction, declaration location
- Shared among all instances of the same definition

**SignalInst (Instance Module)**
- Stored in Instance modules
- Contains instance-specific information: driver relationships, driver line numbers
- References SignalDef via signal ID

```cpp
struct SignalDefInfo {
    uint64_t id = 0;
    std::string name;
    SignalType type = SignalType::UNKNOWN;
    uint32_t msb = 0;
    uint32_t lsb = 0;
    PortDirection direction = PortDirection::UNKNOWN;
    SourceLocation declaration;
};

struct SignalInstInfo {
    uint64_t id = 0;
    std::vector<uint64_t> driver_signal_ids;
    std::vector<SourceLocation> driver_lines;
};
```

### 3.3 Memory Optimization: External SignalDefs

Instance modules don't store their own `signalDefs`. Instead, they reference the Definition's `signalDefs` via a pointer:

```cpp
struct ModuleInfo {
    std::vector<SignalDefInfo> signalDefs;  // Only for Definition modules
    std::vector<SignalInstInfo> signalInsts;  // For both Definition and Instance
    
    // For Instance modules, points to Definition's signalDefs
    const std::vector<SignalDefInfo>* externalSignalDefs = nullptr;
    
    // Get signalDefs - automatically route to Definition for Instances
    const std::vector<SignalDefInfo>& getSignalDefs() const {
        if (isInstance && externalSignalDefs) {
            return *externalSignalDefs;
        }
        return signalDefs;
    }
};
```

**Benefits:**
- Instance modules save memory by not duplicating signal definitions
- Signal IDs remain consistent between Definition and Instance
- `getSignals()` automatically handles the routing transparently

## 4. Knowledge Base Data Structure

### 4.1 Protocol Buffers Definition

```protobuf
syntax = "proto3";
package hwda.kdb;

// Knowledge Base Header
message KDBHeader {
  string version = 1;
  string project_name = 2;
  string created_at = 3;
}

// Source File
message SourceFile {
  uint32 id = 1;
  string path = 2;
  string content = 3;
}

// Source Location
message SourceLocation {
  uint32 file_id = 1;
  uint32 line = 2;
}

// Module Definition Location
message ModuleSourceLocation {
  uint32 file_id = 1;
  uint32 start_line = 2;
  uint32 end_line = 3;
}

// Signal Type
enum SignalType {
  SIGNAL_TYPE_UNKNOWN = 0;
  SIGNAL_TYPE_WIRE = 1;
  SIGNAL_TYPE_REG = 2;
  SIGNAL_TYPE_LOGIC = 3;
  SIGNAL_TYPE_BIT = 4;
  SIGNAL_TYPE_INTEGER = 5;
  SIGNAL_TYPE_REAL = 6;
  SIGNAL_TYPE_PARAMETER = 7;
  SIGNAL_TYPE_LOCALPARAM = 8;
}

// Port Direction
enum PortDirection {
  PORT_DIR_UNKNOWN = 0;
  PORT_DIR_INPUT = 1;
  PORT_DIR_OUTPUT = 2;
  PORT_DIR_INOUT = 3;
}

// Signal Definition
message Signal {
  uint64 id = 1;
  string name = 2;
  string full_name = 3;
  SignalType type = 4;
  uint32 msb = 5;
  uint32 lsb = 6;
  uint32 parent_module_id = 7;
  SourceLocation declaration = 8;
  repeated uint64 driver_signal_ids = 9;
  PortDirection direction = 10;
  repeated SourceLocation driver_lines = 11;
}

// Module
message Module {
  uint32 id = 1;
  string name = 2;
  uint32 parent_module_id = 3;
  ModuleSourceLocation definition = 4;
  repeated Signal signals = 5;
  bool is_instance = 6;
  repeated uint32 child_module_ids = 7;
  uint32 def_module_id = 8;
  string def_name = 9;  // Definition name for instances
}

// Design Hierarchy
message DesignHierarchy {
  uint32 top_module_id = 1;
  repeated uint32 module_ids = 2;
}

// Knowledge Base
message KnowledgeBase {
  KDBHeader header = 1;
  repeated SourceFile files = 2;
  repeated Module modules = 3;
  repeated DesignHierarchy hierarchies = 4;
}
```

### 4.2 Storage Format

| Attribute | Specification |
|-----------|--------------|
| File Extension | .kdb |
| Serialization | Protocol Buffers |
| Compression | zstd |
| Version ID | Version number in file header |

## 5. Bit Width Extraction

### 5.1 Extraction Scenarios

| Scenario | Implementation | Description |
|----------|---------------|-------------|
| Direct width | `logic [7:0] a` | Get range from port's Typespec |
| Parameterized | `logic [WIDTH-1:0] a` | Use ExprEval in module context |
| Scalar | `logic a` | MSB=LSB=0 |
| Array | `logic [7:0] a [3:0]` | Support packed/unpacked ranges |

### 5.2 Implementation Details

**UHDM Data Path:** `port -> Typespec() -> Actual_typespec() -> logic_typespec -> Ranges()`

**Expression Evaluation:** Use `UHDM::ExprEval::reduceExpr()` to evaluate parameter expressions in module instance context.

**Example Code:**

```cpp
if (auto* port = obj->Cast<UHDM::port>()) {
    if (auto* ref_typespec = port->Typespec()) {
        if (auto* actual_typespec = ref_typespec->Actual_typespec()) {
            if (auto* logic_typespec = actual_typespec->Cast<UHDM::logic_typespec>()) {
                auto ranges = logic_typespec->Ranges();
                if (ranges && !ranges->empty()) {
                    auto* range = ranges->at(0);
                    UHDM::ExprEval eval;
                    bool invalidValue = false;
                    UHDM::expr* reducedLeft = eval.reduceExpr(
                        range->Left_expr(), invalidValue, module_inst, nullptr);
                    uint64_t msb = eval.getValue(reducedLeft);
                }
            }
        }
    }
}
```

## 6. Knowledge Base Build Flow

```
Verilog Source Files
        │
        ▼
┌───────────────────┐
│   Surelog Parser  │  ← Parse Verilog/SystemVerilog
│  (with elaboration)│  ← Parameter expansion, hierarchy expansion
└───────────────────┘
        │
        ▼
┌───────────────────┐
│   UHDM Database   │  ← Unified Hardware Data Model
│  (uhdmTopModules) │  ← Expanded module instances
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  VpiListener Traversal │  ← Traverse UHDM object tree
│  (KdbBuildListener)    │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│  KnowledgeBase    │  ← Extract modules, signals, connections
│   Builder         │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│ Protocol Buffers  │  ← Serialization
│   Serialization   │
└───────────────────┘
        │
        ▼
┌───────────────────┐
│    zstd Compress  │  ← Compression
└───────────────────┘
        │
        ▼
    .kdb File
```

## 7. Core Components

| Component | File | Responsibility |
|-----------|------|----------------|
| SurelogParser | `surelog_parser.cpp` | Surelog parser wrapper, configure parsing options |
| KdbBuildListener | `kdb_build_listener.cpp` | UHDM traversal listener, extract design information |
| BitWidthExtractor | `bit_width_extractor.cpp` | Signal bit width extraction, support parameterized widths |
| KnowledgeBaseBuilder | `kdb_builder.cpp` | Knowledge base builder, manage KDB data structures |
| KdbSerializer | `kdb_serializer.cpp` | Knowledge base serialization/deserialization |
| KdbViewer | `kdb_viewer.cpp` | Knowledge base viewer tool (CLI) |
| DriverAnalyzer | `driver_analyzer.cpp` | Analyze driver/load relationships between signals |

## 8. Surelog Configuration

| Configuration | Value | Description |
|--------------|-------|-------------|
| setParse(true) | Enable | Enable syntax parsing |
| setElaborate(true) | Enable | Enable design elaboration |
| setElabUhdm(true) | Enable | Generate elaborated UHDM |
| setDebugUhdm(false) | Disable | Disable UHDM debug output |
| setCacheAllowed(true) | Enable | Enable parsing cache |

## 9. Key API Reference

### 9.1 ModuleInfo Methods

```cpp
// Add signal to module
// For Definition: adds to both signalDefs and signalInsts
// For Instance: only adds to signalInsts, references Definition's signalDefs
void addSignal(const SignalDefInfo& signalDef, const SignalInstInfo& signalInst);

// Get all signals (combines signalDefs and signalInsts)
// Automatically routes to externalSignalDefs for Instance modules
std::vector<SignalInfo> getSignals() const;

// Get signalDefs (for Definition use own, for Instance use external)
const std::vector<SignalDefInfo>& getSignalDefs() const;

// Directly add driver to a signal (modifies signalInsts)
bool addDriverToSignal(const std::string& signalName, uint64_t driverSignalId);

// Directly add driver line to a signal (modifies signalInsts)
bool addDriverLineToSignal(const std::string& signalName, const SourceLocation& location);
```

### 9.2 KnowledgeBaseBuilder Methods

```cpp
// Add module and link Instance to Definition
ModuleInfo* addModule(ModuleInfo&& module);

// Find module by name
const ModuleInfo* findModuleByName(const std::string& name) const;

// Find module by ID
const ModuleInfo* findModuleById(uint32_t id) const;

// Serialize to file
bool saveToFile(const std::string& filepath) const;

// Deserialize from file
bool loadFromFile(const std::string& filepath);
```

## 10. Command Line Interface

```bash
# Basic usage
hwda_interpreter <verilog_files...> --output <output.kdb>

# Example
hwda_interpreter tests/simple.v --output design.kdb

# View knowledge base
kdb_viewer design.kdb --json
```

## 11. Recent Architecture Updates

### 11.1 SignalDef/SignalInst Split (Completed)

**Problem:** Original design stored all signal information in a single structure, causing memory duplication for Instance modules.

**Solution:** Split into SignalDef (static info) and SignalInst (dynamic info), with Instance modules referencing Definition's SignalDefs.

**Files Modified:**
- `kdb_builder.h`: Added `externalSignalDefs` pointer, `getSignalDefs()` method
- `kdb_builder.cpp`: Modified `addModule()` to link Instances to Definitions
- `kdb_build_listener.cpp`: Store `defName` for Instance modules

### 11.2 Driver Information Fix (Completed)

**Problem:** Driver information wasn't being saved because `findSignalByName` returned a copy.

**Solution:** Added `addDriverToSignal()` and `addDriverLineToSignal()` methods to directly modify `signalInsts`.

**Files Modified:**
- `kdb_builder.h`: Added new methods
- `kdb_builder.cpp`: Implemented new methods
- `driver_analyzer.cpp`: Updated to use new methods

### 11.3 Signal ID Consistency (Completed)

**Problem:** Instance and Definition signals had different IDs, causing lookup issues.

**Solution:** Instance modules now share Definition's signalDefs via `externalSignalDefs` pointer, ensuring consistent IDs.

**Implementation:**
1. During `addModule()`: If module is Instance, find its Definition and store `defModuleId`
2. During serialization: Save `defModuleId` for Instance modules
3. During deserialization: Second pass to link Instance modules to Definition's signalDefs
4. `getSignalDefs()` automatically routes to externalSignalDefs for Instances

## 12. Build Instructions

```bash
# Build interpreter (in WSL)
cd interpreter
./build.sh

# Run tests
./build/test/kdb_test

# Parse a design
./build/hwda_interpreter tests/simple.v --output design.kdb

# View the knowledge base
./build/kdb_viewer design.kdb --json
```

## 13. Testing

### 13.1 Unit Tests

Located in `interpreter/tests/`:
- `test_kdb_builder.cpp`: Test KDB builder functionality
- `test_bit_width.cpp`: Test bit width extraction
- `test_serialization.cpp`: Test serialization/deserialization

### 13.2 Integration Tests

Test designs located in `interpreter/tests/designs/`:
- `simple.v`: Basic module with ports and signals
- `hierarchy.v`: Module hierarchy with instances
- `parameters.v`: Parameterized bit widths

### 13.3 Verification Checklist

- [ ] Instance signal directions match Definition
- [ ] Instance signal widths match Definition
- [ ] Instance signal IDs match Definition
- [ ] Driver relationships correctly tracked
- [ ] Load relationships correctly tracked
- [ ] Serialization preserves all data
- [ ] Deserialization restores externalSignalDefs links
