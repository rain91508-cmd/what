// Manual protobuf message definitions for KDB
// Based on interpreter/proto/kdb.proto

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

/// Source Link
#[derive(Clone, PartialEq, Message)]
pub struct SourceLink {
    #[prost(uint32, tag = "1")]
    pub line: u32,
    #[prost(uint32, tag = "2")]
    pub column_start: u32,
    #[prost(uint32, tag = "3")]
    pub column_end: u32,
    #[prost(uint32, tag = "4")]
    pub target_id: u32,
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
    #[prost(message, repeated, tag = "4")]
    pub signal_links: Vec<SourceLink>,
    #[prost(message, repeated, tag = "5")]
    pub submod_links: Vec<SourceLink>,
}

/// Source Location
#[derive(Clone, PartialEq, Message)]
pub struct SourceLocation {
    #[prost(uint32, tag = "1")]
    pub file_id: u32,
    #[prost(uint32, tag = "2")]
    pub line: u32,
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

/// Signal
#[derive(Clone, PartialEq, Message)]
pub struct Signal {
    #[prost(uint64, tag = "1")]
    pub id: u64,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(string, tag = "3")]
    pub full_name: String,
    #[prost(enumeration = "SignalType", tag = "4")]
    pub r#type: i32,
    #[prost(uint32, tag = "5")]
    pub msb: u32,
    #[prost(uint32, tag = "6")]
    pub lsb: u32,
    #[prost(uint32, tag = "7")]
    pub parent_module_id: u32,
    #[prost(message, optional, tag = "8")]
    pub declaration: Option<SourceLocation>,
    #[prost(uint64, repeated, tag = "9")]
    pub driver_signal_ids: Vec<u64>,
    #[prost(enumeration = "PortDirection", tag = "10")]
    pub direction: i32,
    #[prost(message, repeated, tag = "11")]
    pub driver_lines: Vec<SourceLocation>,
}

/// Module
#[derive(Clone, PartialEq, Message)]
pub struct Module {
    #[prost(uint32, tag = "1")]
    pub id: u32,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(string, tag = "3")]
    pub full_name: String,
    #[prost(uint32, tag = "4")]
    pub parent_module_id: u32,
    #[prost(uint32, tag = "5")]
    pub file_id: u32,
    #[prost(message, optional, tag = "6")]
    pub declaration: Option<SourceLocation>,
    #[prost(message, repeated, tag = "7")]
    pub signals: Vec<Signal>,
    #[prost(bool, tag = "8")]
    pub is_instance: bool,
    #[prost(uint32, repeated, tag = "9")]
    pub child_module_ids: Vec<u32>,
}

/// Design Hierarchy
#[derive(Clone, PartialEq, Message)]
pub struct DesignHierarchy {
    #[prost(uint32, tag = "1")]
    pub top_module_id: u32,
    #[prost(uint32, repeated, tag = "2")]
    pub module_ids: Vec<u32>,
}

/// Knowledge Base
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
}
