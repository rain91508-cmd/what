// ============================================
// KDB Types - Matching KDB Proto Structure
// ============================================
// These types match the protobuf definitions in interpreter/proto/kdb.proto
// Field names are converted to camelCase for JavaScript conventions

/**
 * KDB Header
 */
export interface KDBHeader {
  version: string;
  projectName: string;  // proto: project_name
  createdAt: string;    // proto: created_at
}

/**
 * Source Link - for source code navigation
 */
export interface SourceLink {
  line: number;
  columnStart: number;  // proto: column_start
  columnEnd: number;    // proto: column_end
  targetId: number;     // proto: target_id
}

/**
 * Source File
 */
export interface SourceFile {
  id: number;
  path: string;
  content: string;
  signalLinks: SourceLink[];  // proto: signal_links
  submodLinks: SourceLink[];  // proto: submod_links
}

/**
 * Source Location
 */
export interface SourceLocation {
  fileId: number;  // proto: file_id
  line: number;
}

/**
 * Signal Type Enum
 * Matches proto SignalType
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
 * Matches proto PortDirection
 */
export enum PortDirection {
  UNKNOWN = 0,
  INPUT = 1,
  OUTPUT = 2,
  INOUT = 3,
}

/**
 * Signal
 */
export interface Signal {
  id: number;
  name: string;
  fullName: string;           // proto: full_name
  signalType: SignalType;     // proto: type (renamed to avoid JS keyword)
  msb: number;
  lsb: number;
  parentModuleId: number;     // proto: parent_module_id
  declaration?: SourceLocation;
  driverSignalIds: number[];  // proto: driver_signal_ids
  direction: PortDirection;
  driverLines: SourceLocation[];  // proto: driver_lines
}

/**
 * Module - can be a module definition or an instance
 */
export interface Module {
  id: number;
  name: string;
  fullName: string;           // proto: full_name
  parentModuleId: number;     // proto: parent_module_id
  fileId: number;             // proto: file_id
  declaration?: SourceLocation;
  signals: Signal[];
  isInstance: boolean;        // proto: is_instance
  childModuleIds: number[];   // proto: child_module_ids
}

/**
 * Design Hierarchy
 */
export interface DesignHierarchy {
  topModuleId: number;        // proto: top_module_id
  moduleIds: number[];        // proto: module_ids
}

/**
 * Knowledge Base - minimal in-memory representation
 * For full storage, see IndexedDB schema
 */
export interface KnowledgeBase {
  id: string;
  header: KDBHeader;
  topModuleIds: number[];     // Extracted from hierarchies for quick access
  hierarchies: DesignHierarchy[];
}

// ============================================
// UI Types - for component props and state
// ============================================

/**
 * Tree Node for DesignBrowser
 */
export interface ModuleTreeNode {
  module: Module;
  children: ModuleTreeNode[];
  expanded: boolean;
}

/**
 * Selected module with its signals
 */
export interface SelectedModule {
  module: Module;
  signals: Signal[];
}
