//! OPFS Cache Implementation
//!
//! This module provides local caching for waveform data using OPFS (Origin Private File System).
//! Features:
//! - Three-level cache: Memory LRU -> OPFS LRU -> Server
//! - Group-based signal partitioning (256 signals per group)
//! - Tile-based time partitioning with LOD levels
//! - Immutable data: existing tiles never modified, only new groups appended

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// Console logging
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

// =============================================================================
// Global Constants
// =============================================================================

/// LOD multiplier: each level has 16x time span
pub const LOD_MULTIPLIER: u64 = 16;

/// LOD 0 base resolution: 1 time_unit
pub const LOD0_RESOLUTION: u64 = 1;

/// Tile span multiplier for LOD 0: 1M time_units
pub const TILE_SPAN_MULTIPLIER: u64 = 1_000_000;

/// Group size: 256 signals per group
pub const GROUP_SIZE: u32 = 256;

/// Memory cache max size: 50MB
pub const MEMORY_CACHE_MAX: usize = 50 * 1024 * 1024;

/// OPFS cache max size: 1GB
pub const OPFS_CACHE_MAX: u64 = 1 * 1024 * 1024 * 1024;

/// GC trigger threshold: 900MB
pub const OPFS_GC_TRIGGER: u64 = 900 * 1024 * 1024;

/// GC target size: 700MB
pub const OPFS_GC_TARGET: u64 = 700 * 1024 * 1024;

// =============================================================================
// Data Structures
// =============================================================================

/// Signal information with draw_sig_id
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalWithId {
    pub global_id: u64,      // KDB global_id
    pub name: String,        // Signal name for display
    pub row: usize,          // Display row
    pub width: u32,          // Bit width
    pub draw_sig_id: u32,    // JS-allocated monotonic ID
}

/// Data block identifier (LOD + Tile + Group)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DataBlock {
    pub lod: u32,
    pub tile: u64,
    pub group: u32,
}

impl DataBlock {
    /// Convert to file path: "lod{l}/tile_{nnnn}/group_{n}.bin"
    pub fn to_path(&self) -> String {
        format!("lod{}/tile_{:04}/group_{}.bin", self.lod, self.tile, self.group)
    }

    /// Parse from file path
    pub fn from_path(path: &str) -> Option<Self> {
        // Expected format: "lod{l}/tile_{nnnn}/group_{n}.bin"
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() != 3 {
            return None;
        }

        let lod_str = parts[0].strip_prefix("lod")?;
        let lod = lod_str.parse().ok()?;

        let tile_str = parts[1].strip_prefix("tile_")?;
        let tile = tile_str.parse().ok()?;

        let group_str = parts[2].strip_prefix("group_")?.strip_suffix(".bin")?;
        let group = group_str.parse().ok()?;

        Some(DataBlock { lod, tile, group })
    }
}

/// Transition data point
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub time: u64,
    pub value: Vec<u8>,  // Binary value (variable length)
}

/// Signal data within a group
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalData {
    pub draw_sig_id: u32,
    pub transitions: Vec<Transition>,
}

/// Group data containing multiple signals
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupData {
    pub signals: Vec<SignalData>,
}

/// Cache statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheStats {
    pub memory_hits: u32,
    pub opfs_hits: u32,
    pub misses: u32,
}

/// Missing block info for server request
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingBlock {
    pub lod: u32,
    pub tile: u64,
    pub group: u32,
    pub draw_sig_ids: Vec<u32>,
}

/// Prepare data result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrepareDataResult {
    pub missing_blocks: Vec<MissingBlock>,
    pub cache_stats: CacheStats,
}

// =============================================================================
// Group Bin File Format
// =============================================================================

/// Group bin file header (4 bytes)
#[derive(Debug, Clone)]
pub struct GroupBinHeader {
    pub signal_count: u16,
    pub reserved: u16,
}

impl GroupBinHeader {
    pub const SIZE: usize = 4;

    pub fn new(signal_count: u16) -> Self {
        Self {
            signal_count,
            reserved: 0,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::SIZE);
        bytes.extend_from_slice(&self.signal_count.to_le_bytes());
        bytes.extend_from_slice(&self.reserved.to_le_bytes());
        bytes
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Group bin header too small".to_string());
        }

        Ok(Self {
            signal_count: u16::from_le_bytes([data[0], data[1]]),
            reserved: u16::from_le_bytes([data[2], data[3]]),
        })
    }
}

/// Signal offset table entry (8 bytes)
#[derive(Debug, Clone)]
pub struct SignalOffsetEntry {
    pub draw_sig_id: u32,
    pub offset: u32,
}

impl SignalOffsetEntry {
    pub const SIZE: usize = 8;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::SIZE);
        bytes.extend_from_slice(&self.draw_sig_id.to_le_bytes());
        bytes.extend_from_slice(&self.offset.to_le_bytes());
        bytes
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Signal offset entry too small".to_string());
        }

        Ok(Self {
            draw_sig_id: u32::from_le_bytes([data[0], data[1], data[2], data[3]]),
            offset: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
        })
    }
}

/// Serialize group data to bin format
pub fn serialize_group_data(group_data: &GroupData) -> Vec<u8> {
    let signal_count = group_data.signals.len() as u16;
    let header = GroupBinHeader::new(signal_count);

    // Calculate offsets
    let header_size = GroupBinHeader::SIZE;
    let offset_table_size = signal_count as usize * SignalOffsetEntry::SIZE;
    let data_start = header_size + offset_table_size;

    // Build offset table and data
    let mut offset_table: Vec<SignalOffsetEntry> = Vec::new();
    let mut signal_data_bytes: Vec<u8> = Vec::new();

    for signal in &group_data.signals {
        let offset = data_start + signal_data_bytes.len();
        offset_table.push(SignalOffsetEntry {
            draw_sig_id: signal.draw_sig_id,
            offset: offset as u32,
        });

        // Serialize signal data: [transition_count: u32] + [time: u64, value_len: u8, value: bytes] × count
        signal_data_bytes.extend_from_slice(&(signal.transitions.len() as u32).to_le_bytes());
        for transition in &signal.transitions {
            signal_data_bytes.extend_from_slice(&transition.time.to_le_bytes());
            signal_data_bytes.push(transition.value.len() as u8);
            signal_data_bytes.extend_from_slice(&transition.value);
        }
    }

    // Combine all parts
    let mut result = Vec::new();
    result.extend_from_slice(&header.to_bytes());
    for entry in offset_table {
        result.extend_from_slice(&entry.to_bytes());
    }
    result.extend_from_slice(&signal_data_bytes);

    result
}

/// Deserialize group data from bin format
pub fn deserialize_group_data(data: &[u8]) -> Result<GroupData, String> {
    if data.len() < GroupBinHeader::SIZE {
        return Err("Data too small for header".to_string());
    }

    let header = GroupBinHeader::from_bytes(data)?;
    let signal_count = header.signal_count as usize;

    // Parse offset table
    let offset_table_start = GroupBinHeader::SIZE;
    let data_area_start = offset_table_start + signal_count * SignalOffsetEntry::SIZE;

    if data.len() < data_area_start {
        return Err("Data too small for offset table".to_string());
    }

    let mut signals = Vec::new();

    for i in 0..signal_count {
        let entry_start = offset_table_start + i * SignalOffsetEntry::SIZE;
        let entry = SignalOffsetEntry::from_bytes(&data[entry_start..])?;

        // Parse signal data at offset
        let offset = entry.offset as usize;
        if offset + 4 > data.len() {
            return Err(format!("Signal {} data offset out of bounds", i));
        }

        let transition_count = u32::from_le_bytes([
            data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
        ]) as usize;

        let mut transitions = Vec::new();
        let mut pos = offset + 4;

        for _ in 0..transition_count {
            if pos + 9 > data.len() {
                break;
            }

            let time = u64::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
            ]);
            pos += 8;

            let value_len = data[pos] as usize;
            pos += 1;

            if pos + value_len > data.len() {
                break;
            }

            let value = data[pos..pos + value_len].to_vec();
            pos += value_len;

            transitions.push(Transition { time, value });
        }

        signals.push(SignalData {
            draw_sig_id: entry.draw_sig_id,
            transitions,
        });
    }

    Ok(GroupData { signals })
}

// =============================================================================
// Memory LRU Cache
// =============================================================================

/// LRU cache entry
struct LruEntry {
    data: Vec<u8>,
    size: usize,
    last_access: u64,  // Timestamp
}

/// Simple LRU cache for memory
pub struct MemoryLruCache {
    cache: HashMap<String, LruEntry>,
    max_size: usize,
    current_size: usize,
    access_counter: u64,
}

impl MemoryLruCache {
    pub fn new(max_size: usize) -> Self {
        Self {
            cache: HashMap::new(),
            max_size,
            current_size: 0,
            access_counter: 0,
        }
    }

    /// Get data from cache
    pub fn get(&mut self, key: &str) -> Option<&Vec<u8>> {
        self.access_counter += 1;

        if let Some(entry) = self.cache.get_mut(key) {
            entry.last_access = self.access_counter;
            Some(&entry.data)
        } else {
            None
        }
    }

    /// Set data in cache
    pub fn set(&mut self, key: String, data: Vec<u8>) {
        self.access_counter += 1;
        let size = data.len();

        // Remove old entry if exists
        if let Some(old_entry) = self.cache.remove(&key) {
            self.current_size -= old_entry.size;
        }

        // Evict if necessary
        while self.current_size + size > self.max_size && !self.cache.is_empty() {
            self.evict_lru();
        }

        // Insert new entry
        self.cache.insert(key, LruEntry {
            data,
            size,
            last_access: self.access_counter,
        });
        self.current_size += size;
    }

    /// Evict least recently used entry
    fn evict_lru(&mut self) {
        let lru_key = self.cache
            .iter()
            .min_by_key(|(_, entry)| entry.last_access)
            .map(|(k, _)| k.clone());

        if let Some(key) = lru_key {
            if let Some(entry) = self.cache.remove(&key) {
                self.current_size -= entry.size;
                console_log!("[MemoryCache] Evicted: {}, size: {}", key, entry.size);
            }
        }
    }

    /// Clear all cache
    pub fn clear(&mut self) {
        self.cache.clear();
        self.current_size = 0;
        self.access_counter = 0;
    }

    /// Get cache stats
    pub fn stats(&self) -> (usize, usize) {
        (self.cache.len(), self.current_size)
    }
}

// =============================================================================
// OPFS Cache Manager
// =============================================================================

/// OPFS cache manager (WASM side)
pub struct OpfsCacheManager {
    /// Whether OPFS cache is enabled
    pub enabled: bool,
    /// Memory LRU cache
    memory_cache: MemoryLruCache,
    /// Current waveform name
    waveform_name: String,
    /// JS callbacks for OPFS access
    opfs_read: Option<js_sys::Function>,
    opfs_write: Option<js_sys::Function>,
    opfs_exists: Option<js_sys::Function>,
}

impl OpfsCacheManager {
    pub fn new() -> Self {
        Self {
            enabled: false,
            memory_cache: MemoryLruCache::new(MEMORY_CACHE_MAX),
            waveform_name: String::new(),
            opfs_read: None,
            opfs_write: None,
            opfs_exists: None,
        }
    }

    /// Initialize with OPFS callbacks
    pub fn init(
        &mut self,
        opfs_read: js_sys::Function,
        opfs_write: js_sys::Function,
        opfs_exists: js_sys::Function,
        enabled: bool,
    ) {
        self.opfs_read = Some(opfs_read);
        self.opfs_write = Some(opfs_write);
        self.opfs_exists = Some(opfs_exists);
        self.enabled = enabled;

        console_log!("[OpfsCache] Initialized, enabled: {}", enabled);
    }

    /// Set waveform name
    pub fn set_waveform(&mut self, name: String) {
        console_log!("[OpfsCache] Waveform: {}", name);
        self.waveform_name = name;
    }

    /// Calculate tile span for given LOD
    /// Tile span equals the LoD resolution (16^lod)
    /// This ensures each tile covers a time range that matches the LoD's granularity
    pub fn get_tile_span(lod: u32) -> u64 {
        // Tile span = 16^lod (same as LoD resolution)
        LOD_MULTIPLIER.pow(lod)
    }

    /// Calculate tile ID for given time and LOD
    pub fn get_tile_id(time: u64, lod: u32) -> u64 {
        let span = Self::get_tile_span(lod);
        time / span
    }

    /// Calculate group ID for given draw_sig_id
    pub fn get_group_id(draw_sig_id: u32) -> u32 {
        draw_sig_id / GROUP_SIZE
    }

    /// Read data from cache (Memory -> OPFS)
    pub async fn read(&mut self, block: &DataBlock) -> Result<Option<Vec<u8>>, JsValue> {
        let path = format!("{}/{}", self.waveform_name, block.to_path());

        // 1. Check memory cache
        if let Some(data) = self.memory_cache.get(&path) {
            console_log!("[OpfsCache] Memory hit: {}", path);
            return Ok(Some(data.clone()));
        }

        // 2. Check OPFS (if enabled)
        if self.enabled {
            if let Some(ref opfs_read) = self.opfs_read {
                console_log!("[OpfsCache] OPFS read: {}", path);

                // Call JS callback: (path: string) -> Promise<Uint8Array | null>
                let this = JsValue::NULL;
                let path_js = JsValue::from_str(&path);
                let result = opfs_read.call1(&this, &path_js)?;

                // Await the promise
                let promise: js_sys::Promise = result.dyn_into()?;
                let data_js = wasm_bindgen_futures::JsFuture::from(promise).await?;

                // Check if null
                if data_js.is_null() || data_js.is_undefined() {
                    console_log!("[OpfsCache] OPFS miss: {}", path);
                    return Ok(None);
                }

                // Convert Uint8Array to Vec<u8>
                let uint8_array: js_sys::Uint8Array = data_js.dyn_into()?;
                let mut data = vec![0u8; uint8_array.length() as usize];
                uint8_array.copy_to(&mut data);

                // Store in memory cache
                self.memory_cache.set(path, data.clone());

                console_log!("[OpfsCache] OPFS hit: {}, size: {}", block.to_path(), data.len());
                return Ok(Some(data));
            }
        }

        Ok(None)
    }

    /// Write data to cache (OPFS + Memory)
    pub async fn write(&mut self, block: &DataBlock, data: Vec<u8>) -> Result<(), JsValue> {
        let path = format!("{}/{}", self.waveform_name, block.to_path());

        // Store in memory cache
        self.memory_cache.set(path.clone(), data.clone());

        // Write to OPFS (if enabled)
        if self.enabled {
            if let Some(ref opfs_write) = self.opfs_write {
                console_log!("[OpfsCache] OPFS write: {}, size: {}", path, data.len());

                // Call JS callback: (path: string, data: Uint8Array) -> Promise<()>
                let this = JsValue::NULL;
                let path_js = JsValue::from_str(&path);
                let data_js = js_sys::Uint8Array::from(&data[..]);
                let result = opfs_write.call2(&this, &path_js, &data_js)?;

                // Await the promise
                let promise: js_sys::Promise = result.dyn_into()?;
                wasm_bindgen_futures::JsFuture::from(promise).await?;
            }
        }

        Ok(())
    }

    /// Check if data exists in OPFS
    pub async fn exists(&self, block: &DataBlock) -> Result<bool, JsValue> {
        if !self.enabled {
            return Ok(false);
        }

        let path = format!("{}/{}", self.waveform_name, block.to_path());

        if let Some(ref opfs_exists) = self.opfs_exists {
            let this = JsValue::NULL;
            let path_js = JsValue::from_str(&path);
            let result = opfs_exists.call1(&this, &path_js)?;

            let promise: js_sys::Promise = result.dyn_into()?;
            let exists_js = wasm_bindgen_futures::JsFuture::from(promise).await?;

            return Ok(exists_js.as_bool().unwrap_or(false));
        }

        Ok(false)
    }

    /// Clear memory cache
    pub fn clear_memory(&mut self) {
        self.memory_cache.clear();
        console_log!("[OpfsCache] Memory cache cleared");
    }

    /// Get memory cache stats
    pub fn get_memory_stats(&self) -> (usize, usize) {
        self.memory_cache.stats()
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

/// Calculate required data blocks for given signals and viewport
pub fn compute_required_blocks(
    signals: &[SignalWithId],
    time_start: u64,
    time_end: u64,
    lod: u32,
) -> Vec<DataBlock> {
    let tile_span = OpfsCacheManager::get_tile_span(lod);
    
    // Calculate tile range
    let start_tile = time_start / tile_span;
    let end_tile = time_end / tile_span;
    
    web_sys::console::log_1(&format!(
        "[OPFS] compute_required_blocks: signals={}, time={}-{}, lod={}, tile_span={}",
        signals.len(), time_start, time_end, lod, tile_span
    ).into());
    web_sys::console::log_1(&format!(
        "[OPFS]   Tile range: {} to {} (tiles: {})",
        start_tile, end_tile, end_tile - start_tile + 1
    ).into());

    // Collect unique groups
    let mut groups: Vec<u32> = signals
        .iter()
        .map(|s| {
            let group_id = OpfsCacheManager::get_group_id(s.draw_sig_id);
            web_sys::console::log_1(&format!(
                "[OPFS]   Signal '{}': draw_sig_id={} -> group_id={}",
                s.name, s.draw_sig_id, group_id
            ).into());
            group_id
        })
        .collect();
    groups.sort_unstable();
    groups.dedup();
    
    web_sys::console::log_1(&format!(
        "[OPFS]   Unique groups: {:?} (count: {})",
        groups, groups.len()
    ).into());

    // Generate all block combinations
    let mut blocks = Vec::new();
    for tile in start_tile..=end_tile {
        for &group in &groups {
            let block = DataBlock { lod, tile, group };
            web_sys::console::log_1(&format!(
                "[OPFS]   Required block: lod={}, tile={}, group={}",
                lod, tile, group
            ).into());
            blocks.push(block);
        }
    }
    
    web_sys::console::log_1(&format!(
        "[OPFS]   Total blocks to check: {}",
        blocks.len()
    ).into());

    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_group_bin_serialization() {
        let group_data = GroupData {
            signals: vec![
                SignalData {
                    draw_sig_id: 0,
                    transitions: vec![
                        Transition { time: 0, value: vec![0] },
                        Transition { time: 100, value: vec![1] },
                    ],
                },
                SignalData {
                    draw_sig_id: 1,
                    transitions: vec![
                        Transition { time: 0, value: vec![0x78, 0x56, 0x34, 0x12] },
                    ],
                },
            ],
        };

        let bytes = serialize_group_data(&group_data);
        let decoded = deserialize_group_data(&bytes).unwrap();

        assert_eq!(decoded.signals.len(), 2);
        assert_eq!(decoded.signals[0].draw_sig_id, 0);
        assert_eq!(decoded.signals[0].transitions.len(), 2);
        assert_eq!(decoded.signals[1].transitions[0].value, vec![0x78, 0x56, 0x34, 0x12]);
    }

    #[test]
    fn test_data_block_path() {
        let block = DataBlock { lod: 0, tile: 42, group: 5 };
        assert_eq!(block.to_path(), "lod0/tile_0042/group_5.bin");

        let parsed = DataBlock::from_path(&block.to_path()).unwrap();
        assert_eq!(parsed.lod, 0);
        assert_eq!(parsed.tile, 42);
        assert_eq!(parsed.group, 5);
    }

    #[test]
    fn test_tile_span_calculation() {
        assert_eq!(OpfsCacheManager::get_tile_span(0), 1_000_000);
        assert_eq!(OpfsCacheManager::get_tile_span(1), 16_000_000);
        assert_eq!(OpfsCacheManager::get_tile_span(2), 256_000_000);
    }
}
