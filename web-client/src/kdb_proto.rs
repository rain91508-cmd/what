// Manual protobuf message definitions for KDB
// Based on interpreter/proto/kdb.proto - Updated for new structure
// Changes:
// - Signal split into SignalDef and SignalInst
// - Module.id removed (use array index + 1)
// - Module.full_name removed (calculate dynamically)
// - Module.file_id removed (use definition.file_id)
// - Module.declaration replaced with definition (ModuleSourceLocation)

use prost::Message;

/// KDB Header
#[derive(Clone, PartialEq, Message)]
pub struct KDBHeader {
    #[prost(string, tag = "1")]
    pub version: String,
    #[prost(string, tag = "2")]
    pub project_name: String,
    #[prost(string, tag = "3")]
    pub created_at: String,
}

/// Source File
#[derive(Clone, PartialEq, Message)]
pub struct SourceFile {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(string, tag = "2")]
    pub path: String,
    #[prost(string, tag = "3")]
    pub content: String,
    #[prost(uint32, tag = "4")]
    pub total_lines: u32,
}

/// Source Location
#[derive(Clone, PartialEq, Message)]
pub struct SourceLocation {
    #[prost(uint32, tag = "1")]
    pub file_id: u32,
    #[prost(uint32, tag = "2")]
    pub line: u32,
}

/// Module Source Location (with start/end line)
#[derive(Clone, PartialEq, Message)]
pub struct ModuleSourceLocation {
    #[prost(uint32, tag = "1")]
    pub file_id: u32,
    #[prost(uint32, tag = "2")]
    pub start_line: u32,
    #[prost(uint32, tag = "3")]
    pub end_line: u32,
}

/// Signal Type Enum
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum SignalType {
    Unknown = 0,
    Wire = 1,
    Reg = 2,
    Logic = 3,
    Bit = 4,
    Integer = 5,
    Real = 6,
    Parameter = 7,
    Localparam = 8,
}

/// Port Direction Enum
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, prost::Enumeration)]
#[repr(i32)]
pub enum PortDirection {
    Unknown = 0,
    Input = 1,
    Output = 2,
    Inout = 3,
}

/// Signal Definition (stored in Definition modules)
/// Contains static information shared among all instances
/// Note: id removed, use array index as local index
#[derive(Clone, PartialEq, Message)]
pub struct SignalDef {
    // Note: id field removed - use array index as local index
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(enumeration = "SignalType", tag = "3")]
    pub r#type: i32,
    #[prost(message, optional, tag = "4")]
    pub declaration: Option<SourceLocation>,
    #[prost(enumeration = "PortDirection", tag = "5")]
    pub direction: i32,
}

/// Signal Instance (stored in global all_signal_insts array)
/// Contains instance-specific information
/// Note: id removed, use global array index
/// Note: full_name removed - dynamically reconstructed
#[derive(Clone, PartialEq, Message)]
pub struct SignalInst {
    // Note: id field removed - use global array index
    // Note: full_name removed - dynamically reconstructed from module hierarchy + signal name
    #[prost(uint32, tag = "3")]
    pub msb: u32,
    #[prost(uint32, tag = "4")]
    pub lsb: u32,
    #[prost(uint32, tag = "5")]
    pub parent_module_id: u32,
    #[prost(uint64, repeated, tag = "6")]
    pub driver_signal_global_ids: Vec<u64>,
    #[prost(message, repeated, tag = "7")]
    pub driver_lines: Vec<SourceLocation>,
}

/// Module - can be a module definition or an instance
/// Note: id is implicit (array index + 1)
/// Note: full_name is calculated dynamically from parent chain
#[derive(Clone, PartialEq, Message)]
pub struct Module {
    // Note: id removed - use array index + 1 as implicit ID
    #[prost(string, tag = "1")]
    pub name: String,
    // Note: full_name removed - calculate dynamically
    #[prost(uint32, tag = "2")]
    pub parent_module_id: u32,
    // Note: file_id removed - use definition.file_id instead
    #[prost(message, optional, tag = "3")]
    pub definition: Option<ModuleSourceLocation>,
    #[prost(message, repeated, tag = "4")]
    pub signal_defs: Vec<SignalDef>,
    #[prost(bool, tag = "6")]
    pub is_instance: bool,
    #[prost(uint32, repeated, tag = "7")]
    pub child_module_ids: Vec<u32>,
    #[prost(uint32, tag = "8")]
    pub def_module_id: u32,  // 0 if this is a definition
    #[prost(uint32, tag = "9")]
    pub signal_insts_start_id: u32,  // Start index in all_signal_insts
    // Note: signal_insts_count removed - derived from signal_defs.len() or def_module's signal_defs.len()
}

/// Design Hierarchy
#[derive(Clone, PartialEq, Message)]
pub struct DesignHierarchy {
    #[prost(uint32, tag = "1")]
    pub top_module_id: u32,
    #[prost(uint32, repeated, tag = "2")]
    pub module_ids: Vec<u32>,
}

/// Knowledge Base - Complete design representation
#[derive(Clone, PartialEq, Message)]
pub struct KnowledgeBase {
    #[prost(message, optional, tag = "1")]
    pub header: Option<KDBHeader>,
    #[prost(message, repeated, tag = "2")]
    pub files: Vec<SourceFile>,
    #[prost(message, repeated, tag = "3")]
    pub modules: Vec<Module>,
    #[prost(message, repeated, tag = "4")]
    pub hierarchies: Vec<DesignHierarchy>,
    // New: Global signal instances array for memory optimization
    #[prost(message, repeated, tag = "5")]
    pub all_signal_insts: Vec<SignalInst>,
}
