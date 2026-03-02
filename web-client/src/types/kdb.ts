// ============================================
// KDB Types - Matching New KDB Proto Structure
// ============================================
// These types match the protobuf definitions in interpreter/proto/kdb.proto
// Field names are converted to camelCase for JavaScript conventions
//
// Key changes:
// - Module.id removed (use array index + 1)
// - Module.fullName removed (calculate dynamically)
// - Signal split into SignalDef and SignalInst
// - SignalInst stored in global array allSignalInsts

/**
 * KDB Header
 */
export interface KDBHeader {
  version: string;
  projectName: string;  // proto: project_name
  createdAt: string;    // proto: created_at
}

/**
 * Source File
 */
export interface SourceFile {
  id: number;
  path: string;
  content: string;
  totalLines: number;  // proto: total_lines - Total number of lines in the source file
}

/**
 * Source Location
 */
export interface SourceLocation {
  fileId: number;  // proto: file_id
  line: number;
}

/**
 * Module Source Location (with start/end line)
 */
export interface ModuleSourceLocation {
  fileId: number;   // proto: file_id
  startLine: number; // proto: start_line
  endLine: number;   // proto: end_line
}

/**
 * Signal Type Enum
 */
export enum SignalType {
  UNKNOWN = 0,
  WIRE = 1,
  REG = 2,
  LOGIC = 3,
  BIT = 4,
  INTEGER = 5,
  REAL = 6,
  PARAMETER = 7,
  LOCALPARAM = 8,
}

/**
 * Port Direction Enum
 */
export enum PortDirection {
  UNKNOWN = 0,
  INPUT = 1,
  OUTPUT = 2,
  INOUT = 3,
}

/**
 * Signal Definition (stored in Definition modules)
 * Contains static information shared among all instances
 */
export interface SignalDef {
  name: string;
  type: SignalType;
  declaration?: SourceLocation;
  direction: PortDirection;
}

/**
 * Signal Instance (stored in global allSignalInsts array)
 * Contains instance-specific information
 */
export interface SignalInst {
  msb: number;
  lsb: number;
  parentModuleId: number;  // proto: parent_module_id
  driverSignalGlobalIds: number[];  // proto: driver_signal_global_ids
  driverLines: SourceLocation[];    // proto: driver_lines
}

/**
 * Module - can be a module definition or an instance
 * Note: id is implicit (array index + 1)
 * Note: fullName is calculated dynamically from parent chain
 */
export interface Module {
  // Note: id is implicit - use array index + 1
  name: string;
  // Note: fullName removed - calculate dynamically
  parentModuleId: number;     // proto: parent_module_id, 0 for top-level
  definition: ModuleSourceLocation;  // Replaces fileId + declaration
  signalDefs: SignalDef[];    // proto: signal_defs (only for definitions)
  isInstance: boolean;        // proto: is_instance
  childModuleIds: number[];   // proto: child_module_ids
  defModuleId: number;        // proto: def_module_id, 0 if this is a definition
  signalInstsStartId: number; // proto: signal_insts_start_id, index in allSignalInsts
  // Note: signal count = signalDefs.length (for def) or defModule's signalDefs.length (for instance)
}

/**
 * Design Hierarchy
 */
export interface DesignHierarchy {
  topModuleId: number;        // proto: top_module_id
  moduleIds: number[];        // proto: module_ids
}

/**
 * Knowledge Base - Complete design representation
 */
export interface KnowledgeBase {
  header: KDBHeader;
  files: SourceFile[];
  modules: Module[];          // All modules, index 0 = ID 1
  hierarchies: DesignHierarchy[];
  allSignalInsts: SignalInst[];  // proto: all_signal_insts, global signal instances
}

// ============================================
// Helper Types for UI (computed on demand)
// ============================================

/**
 * Signal with full information (computed from SignalDef + SignalInst)
 * This is what UI components work with
 */
export interface Signal {
  // Global ID in allSignalInsts array
  globalId: number;
  // Local index within module (0-based)
  localIndex: number;
  // Signal name (from SignalDef)
  name: string;
  // Full hierarchical name (computed on demand)
  fullName: string;
  // Signal type (from SignalDef)
  signalType: SignalType;
  // Port direction (from SignalDef)
  direction: PortDirection;
  // Bit width (from SignalInst)
  msb: number;
  lsb: number;
  // Declaration location (from SignalDef)
  declaration?: SourceLocation;
  // Driver signal global IDs (from SignalInst)
  driverSignalGlobalIds: number[];
  // Driver source locations (from SignalInst)
  driverLines: SourceLocation[];
  // Parent module ID (from SignalInst)
  parentModuleId: number;
}

/**
 * Module with computed full name
 * This is what UI components work with
 */
export interface ModuleWithFullName extends Module {
  // Module ID (1-based, computed from array index)
  id: number;
  // Full hierarchical name (computed on demand)
  fullName: string;
}
