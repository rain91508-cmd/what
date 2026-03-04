//! 工具模块
//!
//! 提供各种实用工具和辅助函数

pub mod trie;

pub use trie::{TrieNode, encode_signals_with_trie, decode_signals};
