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

/// LOD multiplier: each level has 2x time span (based on server API: bucket_size = 2^level)
pub const LOD_MULTIPLIER: u64 = 2;

/// LOD 0 base resolution: 1 time_unit
pub const LOD0_RESOLUTION: u64 = 1;

/// Tile span multiplier for LOD 0: 256 time_units (2^8, smaller granularity)
pub const TILE_SPAN_MULTIPLIER: u64 = 256;

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

/// Signal information with draw_sig_id (unified structure for rendering and cache)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalWithId {
    pub global_id: u64,      // KDB global_id
    pub name: String,        // Signal name for display
    pub row: usize,          // Display row
    pub width: u32,          // Bit width
    pub draw_sig_id: u32,    // JS-allocated monotonic ID
    #[serde(skip)]          // Not serialized, computed on demand
    pub bit_extract: Option<(String, (u32, u32))>,  // For bit extraction signals
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

/// Transition data point (stores original server format)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    pub time: u64,
    pub value_type: u8,   // Original value type from server (0=Numeric, 1=String, 2=Real, 3=BinaryCompressed)
    pub value_len: u16,  // Original value length from server
    pub value: Vec<u8>,  // Original value bytes from server
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

// =============================================================================
// Group Bin File Format
// =============================================================================

/// Group bin file header V2 (16 bytes)
/// Format: [magic: u32][version: u8][reserved: u8][signal_count: u16][data_area_offset: u32][reserved2: u32]
#[derive(Debug, Clone)]
pub struct GroupBinHeaderV2 {
    pub magic: u32,           // Magic number: 0x47524F55 ("GROU")
    pub version: u8,          // Version: 2
    pub reserved: u8,         // Reserved
    pub signal_count: u16,    // Actual number of signals in this group
    pub data_area_offset: u32, // Offset to data area from start of file
}

impl GroupBinHeaderV2 {
    pub const MAGIC: u32 = 0x47524F55; // "GROU"
    pub const VERSION: u8 = 2;
    pub const SIZE: usize = 16;
    pub const SIGNAL_DIRECTORY_SIZE: usize = 256 * 4; // 256 slots × 4 bytes

    pub fn new(signal_count: u16, data_area_offset: u32) -> Self {
        Self {
            magic: Self::MAGIC,
            version: Self::VERSION,
            reserved: 0,
            signal_count,
            data_area_offset,
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::SIZE);
        bytes.extend_from_slice(&self.magic.to_le_bytes());
        bytes.push(self.version);
        bytes.push(self.reserved);
        bytes.extend_from_slice(&self.signal_count.to_le_bytes());
        bytes.extend_from_slice(&self.data_area_offset.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 4]); // reserved2
        bytes
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Group bin header too small".to_string());
        }

        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if magic != Self::MAGIC {
            return Err(format!("Invalid magic: {:08X}, expected {:08X}", magic, Self::MAGIC));
        }

        let version = data[4];
        if version != Self::VERSION {
            return Err(format!("Unsupported version: {}, expected {}", version, Self::VERSION));
        }

        Ok(Self {
            magic,
            version,
            reserved: data[5],
            signal_count: u16::from_le_bytes([data[6], data[7]]),
            data_area_offset: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
        })
    }
}

/// Signal directory entry (4 bytes)
/// Format: [exists: 1 bit][offset: 31 bits]
/// - Bit 31 (MSB): 1 = signal exists, 0 = empty slot
/// - Bits 0-30: offset to signal data in data area
#[derive(Debug, Clone)]
pub struct SignalDirectoryEntry {
    pub exists: bool,
    pub offset: u32, // Max 2GB offset (sufficient for group data)
}

impl SignalDirectoryEntry {
    pub const EMPTY: u32 = 0;

    pub fn new(exists: bool, offset: u32) -> Self {
        Self { exists, offset }
    }

    pub fn to_u32(&self) -> u32 {
        if self.exists {
            (1u32 << 31) | (self.offset & 0x7FFFFFFF)
        } else {
            0
        }
    }

    pub fn from_u32(value: u32) -> Self {
        let exists = (value & (1u32 << 31)) != 0;
        let offset = value & 0x7FFFFFFF;
        Self { exists, offset }
    }
}

/// Signal directory with 256 fixed slots
/// Index = draw_sig_id % 256
pub struct SignalDirectory {
    pub entries: [u32; 256],
}

impl SignalDirectory {
    pub const SIZE: usize = 256 * 4; // 1024 bytes

    pub fn new() -> Self {
        Self { entries: [0; 256] }
    }

    pub fn get(&self, index: usize) -> SignalDirectoryEntry {
        if index < 256 {
            SignalDirectoryEntry::from_u32(self.entries[index])
        } else {
            SignalDirectoryEntry::new(false, 0)
        }
    }

    pub fn set(&mut self, index: usize, entry: SignalDirectoryEntry) {
        if index < 256 {
            self.entries[index] = entry.to_u32();
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(Self::SIZE);
        for entry in &self.entries {
            bytes.extend_from_slice(&entry.to_le_bytes());
        }
        bytes
    }

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Signal directory too small".to_string());
        }

        let mut entries = [0u32; 256];
        for i in 0..256 {
            let offset = i * 4;
            entries[i] = u32::from_le_bytes([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]]);
        }

        Ok(Self { entries })
    }
}

/// Serialize group data to bin format V2 (fixed 256 slots)
/// Format: [HeaderV2][SignalDirectory(256×4bytes)][DataArea]
/// Each signal is placed at directory index = draw_sig_id % 256
pub fn serialize_group_data_v2(group_data: &GroupData) -> Vec<u8> {
    // Calculate data area offset (header + signal directory)
    let data_area_offset = (GroupBinHeaderV2::SIZE + SignalDirectory::SIZE) as u32;
    
    // Create signal directory and collect signal data
    let mut directory = SignalDirectory::new();
    let mut signal_data_bytes: Vec<u8> = Vec::new();
    let mut actual_signal_count = 0u16;

    for signal in &group_data.signals {
        let index_in_group = (signal.draw_sig_id % 256) as usize;
        let offset = data_area_offset as u32 + signal_data_bytes.len() as u32;
        
        // Set directory entry
        directory.set(index_in_group, SignalDirectoryEntry::new(true, offset));
        actual_signal_count += 1;

        // Serialize signal data: [draw_sig_id: u32][transition_count: u32] + [time: u64, value_type: u8, value_len: u16, value: bytes] × count
        signal_data_bytes.extend_from_slice(&signal.draw_sig_id.to_le_bytes());
        signal_data_bytes.extend_from_slice(&(signal.transitions.len() as u32).to_le_bytes());
        for transition in &signal.transitions {
            signal_data_bytes.extend_from_slice(&transition.time.to_le_bytes());
            signal_data_bytes.push(transition.value_type);
            signal_data_bytes.extend_from_slice(&transition.value_len.to_le_bytes());
            signal_data_bytes.extend_from_slice(&transition.value);
        }
    }

    // Create header
    let header = GroupBinHeaderV2::new(actual_signal_count, data_area_offset);

    // Combine all parts
    let mut result = Vec::new();
    result.extend_from_slice(&header.to_bytes());
    result.extend_from_slice(&directory.to_bytes());
    result.extend_from_slice(&signal_data_bytes);

    result
}

/// Deserialize group data from bin format V2 (fixed 256 slots)
/// Format: [HeaderV2][SignalDirectory(256×4bytes)][DataArea]
pub fn deserialize_group_data_v2(data: &[u8]) -> Result<GroupData, String> {
    if data.len() < GroupBinHeaderV2::SIZE {
        return Err("Data too small for header".to_string());
    }

    let header = GroupBinHeaderV2::from_bytes(data)?;
    
    // Parse signal directory
    let directory_start = GroupBinHeaderV2::SIZE;
    let data_area_start = header.data_area_offset as usize;
    
    if data.len() < data_area_start {
        return Err("Data too small for signal directory".to_string());
    }

    let directory = SignalDirectory::from_bytes(&data[directory_start..data_area_start])?;

    let mut signals = Vec::new();

    // Iterate through all 256 slots to find existing signals
    for index_in_group in 0..256 {
        let entry = directory.get(index_in_group);
        
        if !entry.exists {
            continue;
        }

        // Parse signal data at offset
        let offset = entry.offset as usize;
        if offset + 8 > data.len() {
            console_log!("[OPFS] Warning: Signal at index {} offset out of bounds", index_in_group);
            continue;
        }

        // Read draw_sig_id (for verification)
        let stored_draw_sig_id = u32::from_le_bytes([
            data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
        ]);
        
        // Verify the signal is at correct position
        let expected_index = (stored_draw_sig_id % 256) as usize;
        if expected_index != index_in_group {
            console_log!("[OPFS] Warning: Signal {} at wrong index {}, expected {}", 
                stored_draw_sig_id, index_in_group, expected_index);
        }

        let transition_count = u32::from_le_bytes([
            data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
        ]) as usize;

        let mut transitions = Vec::new();
        let mut pos = offset + 8;

        for _ in 0..transition_count {
            if pos + 11 > data.len() {
                break;
            }

            let time = u64::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
            ]);
            pos += 8;

            let value_type = data[pos];
            pos += 1;

            let value_len = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
            pos += 2;

            if pos + value_len > data.len() {
                break;
            }

            let value = data[pos..pos + value_len].to_vec();
            pos += value_len;

            transitions.push(Transition { time, value_type, value_len: value_len as u16, value });
        }

        signals.push(SignalData {
            draw_sig_id: stored_draw_sig_id,
            transitions,
        });
    }

    Ok(GroupData { signals })
}

/// Read a single signal from group data V2 by draw_sig_id
/// Returns None if signal not found
pub fn read_signal_from_group_v2(data: &[u8], draw_sig_id: u32) -> Result<Option<SignalData>, String> {
    if data.len() < GroupBinHeaderV2::SIZE {
        return Err("Data too small for header".to_string());
    }

    let header = GroupBinHeaderV2::from_bytes(data)?;
    
    // Parse signal directory
    let directory_start = GroupBinHeaderV2::SIZE;
    let data_area_start = header.data_area_offset as usize;
    
    if data.len() < data_area_start {
        return Err("Data too small for signal directory".to_string());
    }

    let directory = SignalDirectory::from_bytes(&data[directory_start..data_area_start])?;
    
    // Calculate index in group
    let index_in_group = (draw_sig_id % 256) as usize;
    let entry = directory.get(index_in_group);
    
    if !entry.exists {
        return Ok(None);
    }

    // Parse signal data at offset
    let offset = entry.offset as usize;
    if offset + 8 > data.len() {
        return Err("Signal data offset out of bounds".to_string());
    }

    // Read stored draw_sig_id (for verification)
    let stored_draw_sig_id = u32::from_le_bytes([
        data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
    ]);
    
    if stored_draw_sig_id != draw_sig_id {
        console_log!("[OPFS] Warning: Expected signal {} but found {} at index {}", 
            draw_sig_id, stored_draw_sig_id, index_in_group);
        return Ok(None);
    }

    let transition_count = u32::from_le_bytes([
        data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
    ]) as usize;

    let mut transitions = Vec::new();
        let mut pos = offset + 8;

        for _ in 0..transition_count {
            if pos + 11 > data.len() {
                break;
            }

            let time = u64::from_le_bytes([
                data[pos], data[pos + 1], data[pos + 2], data[pos + 3],
                data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7],
            ]);
            pos += 8;

            let value_type = data[pos];
            pos += 1;

            let value_len = u16::from_le_bytes([data[pos], data[pos + 1]]) as usize;
            pos += 2;

            if pos + value_len > data.len() {
                break;
            }

            let value = data[pos..pos + value_len].to_vec();
            pos += value_len;

            transitions.push(Transition { time, value_type, value_len: value_len as u16, value });
        }

    Ok(Some(SignalData {
        draw_sig_id,
        transitions,
    }))
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
    /// Whether Memory LRU cache is enabled
    pub memory_cache_enabled: bool,
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
            memory_cache_enabled: true,  // Memory cache enabled by default
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

        console_log!("[OpfsCache] Initialized, OPFS enabled: {}, Memory cache enabled: {}", enabled, self.memory_cache_enabled);
    }

    /// Set memory cache enabled
    pub fn set_memory_cache_enabled(&mut self, enabled: bool) {
        self.memory_cache_enabled = enabled;
        console_log!("[OpfsCache] Memory cache enabled: {}", enabled);
        
        // If disabling, clear the memory cache
        if !enabled {
            self.memory_cache.clear();
            console_log!("[OpfsCache] Memory cache cleared");
        }
    }

    /// Set waveform name
    pub fn set_waveform(&mut self, name: String) {
        console_log!("[OpfsCache] Waveform: {}", name);
        self.waveform_name = name;
    }

    /// Calculate tile span for given LOD
    /// Tile span = TILE_SPAN_MULTIPLIER * 2^lod = 65_536 * 2^lod
    /// This ensures each tile covers a reasonable time range for caching
    /// LOD0: 64K, LOD1: 128K, LOD2: 256K, LOD3: 512K, ...
    pub fn get_tile_span(lod: u32) -> u64 {
        TILE_SPAN_MULTIPLIER * LOD_MULTIPLIER.pow(lod)
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

        // 1. Check memory cache (if enabled)
        if self.memory_cache_enabled {
            if let Some(data) = self.memory_cache.get(&path) {
                // console_log!("[OpfsCache] Memory hit: {}", path);
                return Ok(Some(data.clone()));
            }
        }

        // 2. Check OPFS (if enabled)
        if self.enabled {
            if let Some(ref opfs_read) = self.opfs_read {
                // console_log!("[OpfsCache] OPFS read: {}", path);

                // Call JS callback: (path: string) -> Promise<Uint8Array | null>
                let this = JsValue::NULL;
                let path_js = JsValue::from_str(&path);
                let result = opfs_read.call1(&this, &path_js)?;

                // Await the promise
                let promise: js_sys::Promise = result.dyn_into()?;
                let data_js = wasm_bindgen_futures::JsFuture::from(promise).await?;

                // Check if null
                if data_js.is_null() || data_js.is_undefined() {
                    // console_log!("[OpfsCache] OPFS miss: {}", path);
                    return Ok(None);
                }

                // Convert Uint8Array to Vec<u8>
                let uint8_array: js_sys::Uint8Array = data_js.dyn_into()?;
                let mut data = vec![0u8; uint8_array.length() as usize];
                uint8_array.copy_to(&mut data);

                // Store in memory cache
                self.memory_cache.set(path, data.clone());

                // console_log!("[OpfsCache] OPFS hit: {}, size: {}", block.to_path(), data.len());
                return Ok(Some(data));
            }
        }

        Ok(None)
    }

    /// Write data to cache (OPFS + Memory)
    pub async fn write(&mut self, block: &DataBlock, data: Vec<u8>) -> Result<(), JsValue> {
        let path = format!("{}/{}", self.waveform_name, block.to_path());

        // Store in memory cache (if enabled)
        if self.memory_cache_enabled {
            self.memory_cache.set(path.clone(), data.clone());
        }

        // Write to OPFS (if enabled)
        if self.enabled {
            if let Some(ref opfs_write) = self.opfs_write {
                // console_log!("[OpfsCache] OPFS write: {}, size: {}", path, data.len());

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
        // Tile span = TILE_SPAN_MULTIPLIER * 16^lod = 1_000_000 * 16^lod
        assert_eq!(OpfsCacheManager::get_tile_span(0), 1_000_000); // 1M * 1
        assert_eq!(OpfsCacheManager::get_tile_span(1), 16_000_000); // 1M * 16
        assert_eq!(OpfsCacheManager::get_tile_span(2), 256_000_000); // 1M * 256
        assert_eq!(OpfsCacheManager::get_tile_span(7), 268_435_456_000_000); // 1M * 268M
    }
}
