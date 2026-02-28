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
| `definition` | Definition's file range | Instance's location | Source code positioning |
| `full_name` | **Removed**, built dynamically from parent chain | **Removed**, built dynamically from parent chain | Reduce redundant storage |

### 3.2 SignalDef/SignalInst Split Architecture

To optimize memory usage, signals are split into two structures:

**SignalDef (Definition Module)**
- Stored in Definition modules
- Contains static information: name, type, direction, declaration location
- Shared among all instances of the same definition
- **Note: `id` field removed** - use array index as local index

**SignalInst (Instance Module)**
- Stored in global array `allSignalInsts` for memory efficiency
- Contains instance-specific information: driver relationships, driver line numbers, bit width
- **Note: `id` field removed** - use `signalInstsStartId + localIndex` as global ID
- **Note: `full_name` not serialized** - dynamically reconstructed from module hierarchy + signal name

```cpp
struct SignalDefInfo {
    // uint64_t id = 0;  // REMOVED: Use array index as local index
    std::string name;
    SignalType type = SignalType::UNKNOWN;
    PortDirection direction = PortDirection::UNKNOWN;
    KdbSourceLocation declaration;
};

struct SignalInstInfo {
    // uint64_t id = 0;  // REMOVED: Use global array index
    uint32_t localIndex;  // Index within module's signalInsts
    std::string fullName;  // Full hierarchical name
    uint32_t msb = 0;
    uint32_t lsb = 0;
    uint32_t parentModuleId;
    // Phase 1: Store driver full names (before global IDs are assigned)
    std::vector<std::string> driverSignalFullNames;
    // Phase 2: Converted to global IDs (after commit)
    std::vector<uint64_t> driverSignalGlobalIds;
    std::vector<KdbSourceLocation> driverLines;
};
```

### 3.3 Memory Optimization: Global SignalInst Array

All signal instances are stored in a single global array for better memory efficiency and cache performance:

```cpp
class KdbBuilder {
private:
    std::vector<SignalInstInfo> allSignalInsts_;  // Global unified storage
    
public:
    // Phase 2: Commit all signal instances to global array
    void commitSignalInsts();
    
    // Get global signal instance by global ID
    SignalInstInfo* getGlobalSignalInst(uint64_t globalId);
};
```

**ModuleInfo references global array:**

```cpp
struct ModuleInfo {
    std::vector<SignalDefInfo> signalDefs;  // Only for Definition modules
    // Note: signalInsts moved to global array after commit
    std::vector<SignalInstInfo> signalInsts;  // Temporary storage (cleared after commit)
    
    uint32_t signalInstsStartId = 0;  // Start index in global allSignalInsts
    bool signalInstsCommitted = false;
    
    // Get signal insts count - derived from signalDefs size
    uint32_t getSignalInstsCount() const {
        if (isInstance && externalSignalDefs) {
            return static_cast<uint32_t>(externalSignalDefs->size());
        }
        return static_cast<uint32_t>(signalDefs.size());
    }
    
    // Get signal instance by local index (auto-routes to global array after commit)
    SignalInstInfo* getSignalInst(uint32_t localIndex);
};
```

**Benefits:**
- All signal instances stored contiguously in memory
- Better cache locality when traversing signals
- Reduced memory overhead (no per-signal ID storage)
- Signal count reduced by eliminating duplicates

### 3.4 Memory Optimization: External SignalDefs

Instance modules don't store their own `signalDefs`. Instead, they reference the Definition's `signalDefs` via a pointer:

```cpp
struct ModuleInfo {
    std::vector<SignalDefInfo> signalDefs;  // Only for Definition modules
    
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
- Instance modules don't duplicate signal definition information
- Memory savings scale with number of instances
- Consistent signal definitions across all instances

### 3.5 Memory Optimization: Removed Fields

The following fields have been removed to reduce memory usage:

| Field | Location | Reason |
|-------|----------|--------|
| `id` | SignalDef, SignalInst | Use array index instead |
| `signal_insts_count` | Module | Derived from `signal_defs.size()` |
| `full_name` | Module | Built dynamically from parent chain |

**Memory Savings:**
- SignalDef: 8 bytes per signal (removed `id`)
- SignalInst: 4 bytes per signal (replaced `id` with `localIndex`)
- Module: 4 bytes per module (removed `signal_insts_count`)

## 4. Two-Phase Build Process

### 4.1 Phase 1: Signal Collection

During UHDM traversal:
1. Create ModuleInfo for each module
2. Add SignalDef to Definition modules
3. Add SignalInst to module's temporary storage
4. Store driver relationships by full name (not ID)

### 4.2 Phase 2: Signal Commit

After traversal completes:
1. Link Instance modules to their Definition modules
2. Calculate global array layout (`signalInstsStartId` for each module)
3. Copy all SignalInst to global array `allSignalInsts`
4. Resolve driver full names to global IDs
5. Clear temporary storage

```cpp
void KdbBuildListener::finishBuild() {
    // 1. Link instances to definitions
    linkInstancesToDefinitions();
    
    // 2. Commit all signal instances to global array
    builder_.commitSignalInsts();
}
```

## 5. Web Frontend API Guide

### 5.1 Getting Design Hierarchy

**Entry Point:** Start from `DesignHierarchy` or top-level modules.

```javascript
// Method 1: Get top module IDs from hierarchies, then index into allModules
const topModuleIds = kdb.hierarchies.map(h => h.top_module_id);
const topModules = topModuleIds.map(id => kdb.allModules[id - 1]);  // ID is 1-based

// Method 2: Directly index allModules array
const allModules = kdb.allModules;  // Array index 0 = module ID 1

// Method 3: Find top modules by checking parent_module_id
const topModules = kdb.allModules.filter(m => m.parent_module_id === 0);
```

### 5.2 Traversing Module Hierarchy

**Get child modules using child_module_ids:**
```javascript
function getChildModules(module, kdb) {
    // Use child_module_ids to directly index into allModules
    return module.child_module_ids.map(childId => kdb.allModules[childId - 1]);
}

// Recursive traversal using array index
function traverseHierarchy(moduleId, kdb, depth = 0) {
    const module = kdb.allModules[moduleId - 1];  // ID is 1-based
    console.log('  '.repeat(depth) + module.name);
    
    // Use child_module_ids for O(1) access to children
    module.child_module_ids.forEach(childId => {
        traverseHierarchy(childId, kdb, depth + 1);
    });
}
```

### 5.3 Getting Module Information

**Module basic info using array index:**
```javascript
// Direct array index access (ID is 1-based)
const module = kdb.allModules[moduleId - 1];

// Check if it's an instance or definition
const isInstance = module.is_instance;

// For instances, get the definition using array index
if (isInstance) {
    const definition = kdb.allModules[module.def_module_id - 1];
}

// Get source location
const { file_id, start_line, end_line } = module.definition;
const sourceFile = kdb.files[file_id - 1];  // File ID is also 1-based
```

### 5.4 Getting Module Signals

**Get all signals in a module using array index:**
```javascript
function getModuleSignals(moduleId, kdb) {
    // Direct array index access (ID is 1-based)
    const module = kdb.allModules[moduleId - 1];
    
    // Get signal definitions
    const signalDefs = module.signal_defs;
    
    // Get signal instances from global array using start_id
    const startId = module.signal_insts_start_id;
    const count = signalDefs.length;  // Instance count equals def count
    
    const signals = [];
    for (let i = 0; i < count; i++) {
        const def = signalDefs[i];
        const inst = kdb.all_signal_insts[startId + i];
        
        signals.push({
            name: def.name,
            fullName: calculateSignalFullName(module, def.name),  // Dynamic calculation
            type: def.type,
            direction: def.direction,
            bitWidth: {
                msb: inst.msb,
                lsb: inst.lsb
            },
            declaration: def.declaration,
            driverSignalIds: inst.driver_signal_global_ids,
            driverLines: inst.driver_lines
        });
    }
    
    return signals;
}

// Helper: Calculate signal's full hierarchical name
function calculateSignalFullName(module, signalName) {
    const moduleFullName = calculateModuleFullName(module);
    return moduleFullName ? `${moduleFullName}.${signalName}` : signalName;
}

// Helper: Calculate module's full hierarchical name
function calculateModuleFullName(module) {
    const names = [];
    let current = module;
    while (current) {
        names.push(current.name);
        if (current.parent_module_id === 0) break;
        current = kdb.allModules[current.parent_module_id - 1];
    }
    return names.reverse().join('.');
}
```

### 5.5 Finding Signal by Full Name

```javascript
function findSignalByFullName(fullName, kdb) {
    // Search in all_signal_insts and reconstruct fullName for comparison
    for (let globalId = 0; globalId < kdb.all_signal_insts.length; globalId++) {
        const inst = kdb.all_signal_insts[globalId];
        const module = kdb.allModules[inst.parent_module_id - 1];
        
        // Find signal definition to get name
        const count = module.signal_defs.length;
        const localIdx = globalId - module.signal_insts_start_id;
        if (localIdx < 0 || localIdx >= count) continue;
        
        const def = module.signal_defs[localIdx];
        const reconstructedFullName = calculateSignalFullName(module, def.name);
        
        if (reconstructedFullName === fullName) {
            return {
                instance: inst,
                definition: def,
                module: module
            };
        }
    }
    return null;
}
```

### 5.6 Getting Signal Drivers

**Get driver signals for a given signal using array index:**
```javascript
function getSignalDrivers(signalInst, kdb) {
    const drivers = [];
    
    for (const driverGlobalId of signalInst.driver_signal_global_ids) {
        const driverInst = kdb.all_signal_insts[driverGlobalId];
        const driverModule = kdb.allModules[driverInst.parent_module_id - 1];
        
        // Calculate local index within the module
        const localIdx = driverGlobalId - driverModule.signal_insts_start_id;
        const driverDef = driverModule.signal_defs[localIdx];
        
        drivers.push({
            fullName: calculateSignalFullName(driverModule, driverDef.name),
            name: driverDef.name,
            module: driverModule.name
        });
    }
    
    return drivers;
}
```

### 5.7 Getting Source Code

**Get source line or range using array index:**
```javascript
function getSourceLine(fileId, lineNum, kdb) {
    // Direct array index access (file ID is 1-based)
    const file = kdb.files[fileId - 1];
    if (!file) return null;
    
    const lines = file.content.split('\n');
    return lines[lineNum - 1];  // Line numbers are 1-based
}

function getSourceRange(fileId, startLine, endLine, kdb) {
    // Direct array index access (file ID is 1-based)
    const file = kdb.files[fileId - 1];
    if (!file) return null;
    
    const lines = file.content.split('\n');
    return lines.slice(startLine - 1, endLine).join('\n');
}
```

### 5.8 Complete Example: Module Tree with Signals

```javascript
function buildModuleTree(kdb) {
    const tree = [];
    
    function buildNode(moduleId, depth = 0) {
        // Direct array index access (ID is 1-based)
        const module = kdb.allModules[moduleId - 1];
        const signals = getModuleSignals(moduleId, kdb);
        
        const node = {
            id: moduleId,
            name: module.name,
            isInstance: module.is_instance,
            signals: signals.map(s => ({
                name: s.name,
                direction: s.direction,
                bitWidth: s.bitWidth.msb > 0 ? `[${s.bitWidth.msb}:${s.bitWidth.lsb}]` : ''
            })),
            children: []
        };
        
        // Recursively add children using child_module_ids
        module.child_module_ids.forEach(childId => {
            node.children.push(buildNode(childId, depth + 1));
        });
        
        return node;
    }
    
    // Start from top-level modules
    const topModules = kdb.allModules.filter(m => m.parent_module_id === 0);
    topModules.forEach(m => tree.push(buildNode(m.id)));
    
    return tree;
}
```

## 6. KDB File Format

### 6.1 Serialization

KDB files are serialized using Protocol Buffers with optional ZSTD compression:

```cpp
// Uncompressed format
KnowledgeBase kdb;
kdb.SerializeToFile("design.kdb");

// Compressed format (default)
builder.serializeToFileCompressed("design.kdb", compressionLevel);
```

### 6.2 File Structure

```protobuf
message KnowledgeBase {
  KDBHeader header = 1;
  repeated SourceFile files = 2;
  repeated Module modules = 3;
  repeated DesignHierarchy hierarchies = 4;
  repeated SignalInst all_signal_insts = 5;  // Global signal instances
}
```

### 6.3 Compression Format

Compressed files start with a magic number:
- Magic: `0x4B445743` ("KDWC" in ASCII)
- Original size: 4 bytes (uint32)
- Compressed data: ZSTD compressed protobuf

## 7. Build Instructions

### 7.1 Dependencies

- CMake 3.14+
- C++17 compiler (GCC 9+, Clang 10+, MSVC 2019+)
- Surelog (included as submodule)
- Protocol Buffers
- ZSTD (optional, for compression)

### 7.2 Build Commands

```bash
# Clone with submodules
git clone --recursive <repo-url>

# Build
cd webhwd
./build.sh

# Output binaries
./build_new/interpreter/hwda_interpreter
./build_new/interpreter/kdb_viewer
```

### 7.3 Usage

```bash
# Parse Verilog and generate KDB
./hwda_interpreter design.v --output design.kdb

# View KDB contents
./kdb_viewer design.kdb --modules
./kdb_viewer design.kdb --module work@top
./kdb_viewer design.kdb --json
```

## 8. Performance Considerations

### 8.1 Memory Usage

- SignalDef: ~40 bytes per signal (without ID)
- SignalInst: ~80 bytes per signal (with drivers)
- Typical design: 1M signals ≈ 120MB memory

### 8.2 Build Time

- Parsing: O(n) where n = source code size
- Signal linking: O(s) where s = number of signals
- Driver resolution: O(d) where d = number of driver relationships

### 8.3 Query Performance

- Find module by ID: O(1) (array index)
- Find signal by full name: O(1) (hash map)
- Get module signals: O(k) where k = signals in module
- Traverse hierarchy: O(m) where m = modules

## 9. Future Optimizations

Potential future improvements:

1. **Lazy Loading**: Load signal details on demand for large designs
2. **Incremental Updates**: Only re-parse changed modules
3. **Signal Indexing**: Build spatial index for faster range queries
4. **Memory Mapping**: Use mmap for large KDB files
5. **Parallel Processing**: Multi-threaded parsing for large designs
