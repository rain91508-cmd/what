//! WASM Waveform Data Provider
//!
//! This module provides waveform data fetching from server,
//! chunk parsing, and segment calculation for rendering.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use base64::{Engine as _, engine::general_purpose};

use crate::opfs_cache::{
    OpfsCacheManager, SignalWithId, DataBlock, MissingBlock, 
    PrepareDataResult, CacheStats
};

// Console logging
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

/// Signal information for waveform rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalInfo {
    pub name: String,
    pub row: usize,
    pub width: u32,
    /// For bit extraction signals (format: parent_name@[bit_index] or parent_name@[msb:lsb])
    /// Stores (parent_name, bit_range) if this signal should extract bits from parent
    pub bit_extract: Option<(String, (u32, u32))>,  // (parent_name, (msb, lsb))
}

/// Viewport configuration
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Viewport {
    pub time_start: f64,
    pub time_end: f64,
}

/// Render segment for a single signal transition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderSegment {
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
    pub value: ValueInfo,
    pub signal_name: String,
}

/// Value information for rendering
/// For LoD 0: only min_value is used
/// For LoD 1+: both min_value and max_value are used (min/max bucket)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValueInfo {
    #[serde(rename = "type")]
    pub value_type: String,  // "zero", "one", "all_x", "all_z", "numeric", "mixed", "min_max"
    #[serde(rename = "displayStr")]
    pub display_str: String, // Display string (for LoD 0, or when min==max)
    pub width: u32,
    #[serde(rename = "hasXZ")]
    pub has_xz: bool,
    // LoD 1+ min/max support
    #[serde(rename = "minValue")]
    pub min_value: Option<String>,  // Min value for bucket (LoD 1+)
    #[serde(rename = "maxValue")]
    pub max_value: Option<String>,  // Max value for bucket (LoD 1+)
    #[serde(rename = "isMinMax")]
    pub is_min_max: bool,           // True if this is a min/max bucket segment
}

/// Transition data point
#[derive(Debug, Clone)]
pub struct Transition {
    pub time: u64,  // For LoD 0: absolute time; For LoD 1+: bucket offset (0-255)
    pub value: String,
}

/// Bucket data for LoD 1+ (First/Last format)
#[derive(Debug, Clone)]
pub struct BucketData {
    pub offset: u32,        // Bucket offset within tile (0-255)
    pub first: Transition,  // First transition in bucket
    pub last: Option<Transition>, // Last transition (None if only one transition)
}

impl BucketData {
    /// Check if this bucket has both first and last (toggle bucket)
    pub fn has_toggle(&self) -> bool {
        self.last.is_some()
    }
    
    /// Get the value to continue after this bucket
    pub fn get_continue_value(&self) -> String {
        match &self.last {
            Some(last) => last.value.clone(),
            None => self.first.value.clone(),
        }
    }
}

/// Signal waveform data with tile information
#[derive(Debug, Clone)]
pub struct SignalWaveData {
    pub name: String,
    pub width: u32,
    pub transitions: Vec<Transition>,
    /// Tile information for proper segment generation
    /// Each tuple: (tile_start, tile_end, start_value_time, start_value)
    pub tile_info: Vec<(u64, u64, u64, String)>,
    /// LoD 1+ bucket data: (tile_start, buckets HashMap)
    pub bucket_data: Vec<(u64, HashMap<u32, BucketData>)>,
}

impl SignalWaveData {
    pub fn new(name: String, width: u32) -> Self {
        Self {
            name,
            width,
            transitions: Vec::new(),
            tile_info: Vec::new(),
            bucket_data: Vec::new(),
        }
    }
}

/// LoD (Level of Detail) configuration
/// resolution = time units per bucket (each transition represents this many time units)
/// Based on server API: resolution = 2^lod, max level = 32
const LOD_TABLE: [(u32, u64); 33] = [
    (0, 1),                    // LOD0: resolution 1 (原始数据)
    (1, 2),                    // LOD1: resolution 2
    (2, 4),                    // LOD2: resolution 4
    (3, 8),                    // LOD3: resolution 8
    (4, 16),                   // LOD4: resolution 16
    (5, 32),                   // LOD5: resolution 32
    (6, 64),                   // LOD6: resolution 64
    (7, 128),                  // LOD7: resolution 128
    (8, 256),                  // LOD8: resolution 256
    (9, 512),                  // LOD9: resolution 512
    (10, 1_024),               // LOD10: resolution 1K
    (11, 2_048),               // LOD11: resolution 2K
    (12, 4_096),               // LOD12: resolution 4K
    (13, 8_192),               // LOD13: resolution 8K
    (14, 16_384),              // LOD14: resolution 16K
    (15, 32_768),              // LOD15: resolution 32K
    (16, 65_536),              // LOD16: resolution 64K
    (17, 131_072),             // LOD17: resolution 128K
    (18, 262_144),             // LOD18: resolution 256K
    (19, 524_288),             // LOD19: resolution 512K
    (20, 1_048_576),           // LOD20: resolution 1M
    (21, 2_097_152),           // LOD21: resolution 2M
    (22, 4_194_304),           // LOD22: resolution 4M
    (23, 8_388_608),           // LOD23: resolution 8M
    (24, 16_777_216),          // LOD24: resolution 16M
    (25, 33_554_432),          // LOD25: resolution 32M
    (26, 67_108_864),          // LOD26: resolution 64M
    (27, 134_217_728),         // LOD27: resolution 128M
    (28, 268_435_456),         // LOD28: resolution 256M
    (29, 536_870_912),         // LOD29: resolution 512M
    (30, 1_073_741_824),       // LOD30: resolution 1G
    (31, 2_147_483_648),       // LOD31: resolution 2G
    (32, 4_294_967_296),       // LOD32: resolution 4G
];

/// Special timestamp for boundary value (start of time range)
/// When no transitions exist in the requested range, server returns this boundary value
const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;

/// Calculate appropriate LoD based on viewport and canvas width
/// 
/// Algorithm:
/// 1. Calculate time_per_pixel = time_span / canvas_width
///    This is the time range represented by each pixel
/// 2. Select the finest LoD where lod.resolution >= time_per_pixel
///    This ensures each pixel shows at most one transition point
/// 3. If no LoD satisfies, use max LoD
fn select_lod(viewport: &Viewport, canvas_width: f64) -> u32 {
    if canvas_width <= 0.0 {
        return 0;
    }
    
    let time_span = viewport.time_end - viewport.time_start;
    // Calculate time per pixel directly
    let time_per_pixel = time_span as f64 / canvas_width;
    
    // Find the finest LoD where resolution >= time_per_pixel
    // This ensures we don't over-sample (multiple transitions per pixel)
    for (lod, resolution) in LOD_TABLE.iter() {
        if (*resolution as f64) >= time_per_pixel {
            return *lod;
        }
    }
    
    // If none found, use max LoD
    LOD_TABLE.last().unwrap().0
}

/// Chunk header (32 bytes)
#[derive(Debug, Clone)]
pub struct ChunkHeader {
    pub magic: u32,
    pub version: u16,
    pub level: u16,
    pub chunk_id: u32,
    pub time_start: u64,
    pub time_end: u64,
    pub signal_count: u32,
}

impl ChunkHeader {
    pub const MAGIC: u32 = 0x57415645; // 'WAVE'
    pub const SIZE: usize = 32;

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Chunk header too small".to_string());
        }

        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if magic != Self::MAGIC {
            return Err(format!("Invalid magic: 0x{:08X}", magic));
        }

        Ok(Self {
            magic,
            version: u16::from_le_bytes([data[4], data[5]]),
            level: u16::from_le_bytes([data[6], data[7]]),
            chunk_id: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
            time_start: u64::from_le_bytes([
                data[12], data[13], data[14], data[15],
                data[16], data[17], data[18], data[19],
            ]),
            time_end: u64::from_le_bytes([
                data[20], data[21], data[22], data[23],
                data[24], data[25], data[26], data[27],
            ]),
            signal_count: u32::from_le_bytes([data[28], data[29], data[30], data[31]]),
        })
    }
}

/// Signal block header (17 bytes)
#[derive(Debug, Clone)]
pub struct SignalBlockHeader {
    pub signal_handle: u32,
    pub time_array_offset: u32,
    pub value_array_offset: u32,
    pub transition_count: u32,
    pub compression: u8,
}

impl SignalBlockHeader {
    pub const SIZE: usize = 17;

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Signal block header too small".to_string());
        }

        Ok(Self {
            signal_handle: u32::from_le_bytes([data[0], data[1], data[2], data[3]]),
            time_array_offset: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
            value_array_offset: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
            transition_count: u32::from_le_bytes([data[12], data[13], data[14], data[15]]),
            compression: data[16],
        })
    }
}

/// Multi-tile chunk header (40 bytes) - for tile-based API
#[derive(Debug, Clone)]
pub struct MultiTileHeader {
    pub magic: u32,
    pub version: u16,
    pub lod: u16,
    pub num_tiles: u32,
    pub start_time: u64,
    pub tile_span: u64,
    pub signal_count: u32,
    pub reserved: u32,
    pub compression: u32,
}

impl MultiTileHeader {
    pub const MAGIC: u32 = 0x57415449; // 'WATI'
    pub const SIZE: usize = 40;

    pub fn from_bytes(data: &[u8]) -> Result<Self, String> {
        if data.len() < Self::SIZE {
            return Err("Multi-tile header too small".to_string());
        }

        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if magic != Self::MAGIC {
            return Err(format!("Invalid multi-tile magic: 0x{:08X}", magic));
        }

        Ok(Self {
            magic,
            version: u16::from_le_bytes([data[4], data[5]]),
            lod: u16::from_le_bytes([data[6], data[7]]),
            num_tiles: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
            start_time: u64::from_le_bytes([
                data[12], data[13], data[14], data[15],
                data[16], data[17], data[18], data[19],
            ]),
            tile_span: u64::from_le_bytes([
                data[20], data[21], data[22], data[23],
                data[24], data[25], data[26], data[27],
            ]),
            signal_count: u32::from_le_bytes([data[28], data[29], data[30], data[31]]),
            reserved: u32::from_le_bytes([data[32], data[33], data[34], data[35]]),
            compression: u32::from_le_bytes([data[36], data[37], data[38], data[39]]),
        })
    }
}

/// Waveform data provider
#[wasm_bindgen]
pub struct WaveformDataProvider {
    server_url: String,
    waveform_name: String,
    signal_prefix: String,
    space_before_bracket: bool,
    time_stamp: u64,  // Waveform modification timestamp for CDN cache
    display_format: String,  // "hex", "bin", "oct", "dec"
    signals: Vec<SignalInfo>,
    viewport: Viewport,
    canvas_width: f64,
    canvas_height: f64,
    row_height: f64,
    signal_data: HashMap<String, SignalWaveData>,
    // OPFS cache
    opfs_cache: OpfsCacheManager,
    signals_with_id: Vec<SignalWithId>,  // Signals with draw_sig_id
    enable_opfs: bool,  // OPFS cache enabled flag
    current_lod: Option<u32>,  // Current LoD level for bucket size calculation
}

#[wasm_bindgen]
impl WaveformDataProvider {
    /// Create a new waveform data provider
    #[wasm_bindgen(constructor)]
    pub fn new(
        server_url: String,
        waveform_name: String,
        signal_prefix: String,
        space_before_bracket: bool,
        time_stamp: u64,
    ) -> Self {


        Self {
            server_url: server_url.clone(),
            waveform_name: waveform_name.clone(),
            signal_prefix,
            space_before_bracket,
            time_stamp,
            display_format: "hex".to_string(),  // Default to hex
            signals: Vec::new(),
            viewport: Viewport { time_start: 0.0, time_end: 1000.0 },
            canvas_width: 800.0,
            canvas_height: 400.0,
            row_height: 24.0,  // Must match CSS .waveform-signal-signal-item height
            signal_data: HashMap::new(),
            opfs_cache: OpfsCacheManager::new(),
            signals_with_id: Vec::new(),
            enable_opfs: false,  // Disabled by default
            current_lod: None,  // Will be set when fetching data
        }
    }

    /// Initialize with OPFS callbacks
    /// 
    /// # Arguments
    /// * `opfs_read` - JS callback: (path: string) -> Promise<Uint8Array | null>
    /// * `opfs_write` - JS callback: (path: string, data: Uint8Array) -> Promise<()>
    /// * `opfs_exists` - JS callback: (path: string) -> Promise<bool>
    /// * `enable_opfs` - Whether to enable OPFS cache
    #[wasm_bindgen]
    pub fn init_with_opfs(
        &mut self,
        opfs_read: js_sys::Function,
        opfs_write: js_sys::Function,
        opfs_exists: js_sys::Function,
        enable_opfs: bool,
    ) {
        self.enable_opfs = enable_opfs;
        self.opfs_cache.init(opfs_read, opfs_write, opfs_exists, enable_opfs);
        self.opfs_cache.set_waveform(self.waveform_name.clone());

    }

    /// Set signals with draw_sig_id (new API)
    /// 
    /// # Arguments
    /// * `signals_js` - Array of { global_id, name, row, width, draw_sig_id }
    #[wasm_bindgen]
    pub fn set_draw_list(&mut self, signals_js: JsValue) -> Result<(), JsValue> {
        let signals_with_id: Vec<SignalWithId> = serde_wasm_bindgen::from_value(signals_js)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse signals: {}", e)))?;

        // Set draw list with signals
        let signals: Vec<SignalInfo> = signals_with_id.iter().map(|s| {
            let bit_extract = Self::parse_bit_extract(&s.name);
            SignalInfo {
                name: s.name.clone(),
                row: s.row,
                width: s.width,
                bit_extract,
            }
        }).collect();

        self.signals_with_id = signals_with_id;
        self.signals = signals;
        Ok(())
    }

    /// Prepare data (check cache and return missing blocks)
    /// 
    /// This is the main entry point for data loading.
    /// WASM checks Memory LRU -> OPFS LRU -> returns missing blocks for server fetch.
    /// 
    /// # Returns
    /// * Object with missing_blocks and cache_stats
    #[wasm_bindgen]
    pub async fn prepare_data(&mut self) -> Result<JsValue, JsValue> {
        if self.signals_with_id.is_empty() {
            console_log!("[WASM] prepare_data: no signals");
            return serde_wasm_bindgen::to_value(&PrepareDataResult {
                missing_blocks: vec![],
                cache_stats: CacheStats { memory_hits: 0, opfs_hits: 0, misses: 0 },
            }).map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)));
        }

        let lod = self.current_lod();
        let time_start = self.viewport.time_start as u64;
        let time_end = self.viewport.time_end as u64;

        // Calculate required blocks
        let blocks = crate::opfs_cache::compute_required_blocks(
            &self.signals_with_id,
            time_start,
            time_end,
            lod
        );

        // Check each block in cache
        let mut missing_blocks: Vec<MissingBlock> = Vec::new();
        let mut memory_hits = 0u32;
        let mut opfs_hits = 0u32;

        for block in blocks.iter() {
            match self.opfs_cache.read(block).await? {
                Some(_data) => {
                    // Data found in cache
                    if self.opfs_cache.enabled {
                        opfs_hits += 1;
                    } else {
                        memory_hits += 1;
                    }
                }
                None => {
                    // Data not found, add to missing list
                    let draw_sig_ids: Vec<u32> = self.signals_with_id.iter()
                        .filter(|s| OpfsCacheManager::get_group_id(s.draw_sig_id) == block.group)
                        .map(|s| s.draw_sig_id)
                        .collect();

                    missing_blocks.push(MissingBlock {
                        lod: block.lod,
                        tile: block.tile,
                        group: block.group,
                        draw_sig_ids,
                    });
                }
            }
        }

        let misses = missing_blocks.len() as u32;
        console_log!("[Cache] LoD{} tiles:{} mem_hit:{} opfs_hit:{} miss:{}",
            lod, blocks.len(), memory_hits, opfs_hits, misses);

        let result = PrepareDataResult {
            missing_blocks,
            cache_stats: CacheStats { memory_hits, opfs_hits, misses },
        };

        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    /// Supplement data from server response
    /// 
    /// WASM 直接处理服务器返回的原始 chunk 数据：
    /// 1. 解析服务器 chunk 数据
    /// 2. 按 (lod, tile, group) 重组为 Group Bin 格式
    /// 3. 写入 OPFS（通过 JS 回调）
    /// 4. 存入 Memory LRU
    /// 
    /// # Arguments
    /// * `server_data_js` - Server response data (ArrayBuffer)
    #[wasm_bindgen]
    pub async fn supplement_data(&mut self, server_data_js: JsValue) -> Result<(), JsValue> {
        console_log!("[WASM] supplement_data: processing server response");

        // Convert JsValue to Vec<u8>
        let array_buffer: js_sys::ArrayBuffer = server_data_js.dyn_into()
            .map_err(|_| JsValue::from_str("Invalid array buffer"))?;
        let uint8_array = js_sys::Uint8Array::new(&array_buffer);
        let mut bytes = vec![0u8; uint8_array.length() as usize];
        uint8_array.copy_to(&mut bytes);

        console_log!("[WASM] supplement_data: received {} bytes", bytes.len());

        // Check minimum size for valid chunk
        if bytes.len() < ChunkHeader::SIZE {
            return Err(JsValue::from_str(&format!("Data too small: {} bytes", bytes.len())));
        }

        // Parse chunk and store in cache
        self.process_server_chunk(&bytes, &[]).await?;

        Ok(())
    }

    /// Process server chunk data and store in cache
    /// signal_names: optional list of signal names in the same order as server response
    /// Used to map signal_handle to draw_sig_id
    async fn process_server_chunk(&mut self, data: &[u8], signal_names: &[String]) -> Result<(), JsValue> {
        // Skip if both OPFS and memory cache are disabled
        if !self.opfs_cache.enabled && !self.opfs_cache.memory_cache_enabled {
            return Ok(());
        }

        // Parse chunk header
        let header = ChunkHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;

        // Calculate tile information
        let lod = header.level as u32;
        let tile_span = OpfsCacheManager::get_tile_span(lod);
        let tile_id = header.time_start / tile_span;

        // Group signals by their group_id
        let mut signals_by_group: std::collections::HashMap<u32, Vec<crate::opfs_cache::SignalData>> = 
            std::collections::HashMap::new();

        // Parse each signal block
        let mut offset = ChunkHeader::SIZE;
        
        for signal_idx in 0..header.signal_count {
            if offset + SignalBlockHeader::SIZE > data.len() {
                break;
            }

            // Parse signal block header
            let block_header = SignalBlockHeader::from_bytes(&data[offset..])
                .map_err(|e| JsValue::from_str(&e))?;

            // Parse transitions for this signal
            let transitions = self.parse_transitions_for_cache(
                data,
                &block_header,
                signal_idx as usize
            )?;

            // Get draw_sig_id from signal name mapping
            let draw_sig_id = if (signal_idx as usize) < signal_names.len() {
                let signal_name = &signal_names[signal_idx as usize];
                match self.get_draw_sig_id(signal_name) {
                    Some(id) => id,
                    None => signal_idx as u32
                }
            } else {
                signal_idx as u32
            };
            let group_id = OpfsCacheManager::get_group_id(draw_sig_id);

            // Convert transitions to opfs_cache format
            let opfs_transitions: Vec<crate::opfs_cache::Transition> = transitions
                .into_iter()
                .map(|t| {
                    // Convert string value to bytes
                    let value_bytes = if t.value.starts_with("0x") || t.value.starts_with("0X") {
                        // Hex value - parse and convert to bytes
                        match u64::from_str_radix(&t.value[2..], 16) {
                            Ok(v) => v.to_le_bytes().to_vec(),
                            Err(_) => t.value.into_bytes(),
                        }
                    } else if t.value.chars().all(|c| c == '0' || c == '1') && t.value.len() <= 64 {
                        // Binary value
                        match u64::from_str_radix(&t.value, 2) {
                            Ok(v) => v.to_le_bytes().to_vec(),
                            Err(_) => t.value.into_bytes(),
                        }
                    } else {
                        // String value
                        t.value.into_bytes()
                    };
                    crate::opfs_cache::Transition {
                        time: t.time,
                        value: value_bytes,
                    }
                })
                .collect();

            // Add to group
            let signal_data = crate::opfs_cache::SignalData {
                draw_sig_id,
                transitions: opfs_transitions,
            };

            signals_by_group.entry(group_id)
                .or_insert_with(Vec::new)
                .push(signal_data);

            offset += SignalBlockHeader::SIZE;
        }

        // Write each group to cache (with merge support for V2 format)
        let group_count = signals_by_group.len();
        console_log!("[WASM]   Grouping complete: {} groups", group_count);
        
        for (group_id, new_signals) in &signals_by_group {
            let block = crate::opfs_cache::DataBlock {
                lod,
                tile: tile_id,
                group: *group_id,
            };

            console_log!("[WASM]   Processing group {}: {} new signals", 
                group_id, new_signals.len());
            console_log!("[WASM]     Block: lod={}, tile={}, group={}", 
                lod, tile_id, group_id);

            // Try to read existing group data from cache
            let mut merged_signals: Vec<crate::opfs_cache::SignalData> = Vec::new();
            
            match self.opfs_cache.read(&block).await {
                Ok(Some(existing_data)) => {
                    console_log!("[WASM]     Existing group data found: {} bytes", existing_data.len());
                    // Deserialize existing data using V2 format
                    match crate::opfs_cache::deserialize_group_data_v2(&existing_data) {
                        Ok(existing_group) => {
                            console_log!("[WASM]     Existing signals: {}", existing_group.signals.len());
                            
                            // Merge: keep existing signals, add new ones or update existing ones
                            let mut signal_map: std::collections::HashMap<u32, crate::opfs_cache::SignalData> = 
                                std::collections::HashMap::new();
                            
                            // Add existing signals
                            for sig in existing_group.signals {
                                signal_map.insert(sig.draw_sig_id, sig);
                            }
                            
                            // Add or update with new signals
                            for sig in new_signals.clone() {
                                signal_map.insert(sig.draw_sig_id, sig);
                            }
                            
                            merged_signals = signal_map.into_values().collect();
                            console_log!("[WASM]     Merged signals: {} (existing + new)", merged_signals.len());
                        }
                        Err(e) => {
                            console_log!("[WASM]     Error deserializing existing data: {}, using new signals only", e);
                            merged_signals = new_signals.clone();
                        }
                    }
                }
                Ok(None) => {
                    console_log!("[WASM]     No existing group data, using new signals only");
                    merged_signals = new_signals.clone();
                }
                Err(e) => {
                    console_log!("[WASM]     Error reading existing cache: {:?}, using new signals only", e);
                    merged_signals = new_signals.clone();
                }
            }

            // Serialize merged data using V2 format
            let group_data = crate::opfs_cache::GroupData { signals: merged_signals };
            let bin_data = crate::opfs_cache::serialize_group_data_v2(&group_data);

            console_log!("[WASM]     Serialized size: {} bytes", bin_data.len());

            // Write to cache (OPFS + Memory)
            self.opfs_cache.write(&block, bin_data).await?;
            console_log!("[WASM]     Block written to cache successfully");
        }

        console_log!("[WASM] Server chunk processed: {} groups written to cache", group_count);

        Ok(())
    }

    /// Parse transitions from a signal block for cache storage
    fn parse_transitions_for_cache(
        &self,
        data: &[u8],
        block_header: &SignalBlockHeader,
        _signal_index: usize,
    ) -> Result<Vec<Transition>, JsValue> {
        let mut transitions = Vec::new();

        let time_array_start = block_header.time_array_offset as usize;
        let value_array_start = block_header.value_array_offset as usize;

        let mut value_idx = value_array_start;
        for i in 0..block_header.transition_count {
            let time_idx = time_array_start + (i as usize * 8);

            if time_idx + 8 > data.len() {
                break;
            }

            let time = u64::from_le_bytes([
                data[time_idx], data[time_idx + 1], data[time_idx + 2], data[time_idx + 3],
                data[time_idx + 4], data[time_idx + 5], data[time_idx + 6], data[time_idx + 7],
            ]);

            if value_idx + 3 > data.len() {
                break;
            }

            let value_type = data[value_idx];
            let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
            value_idx += 3;

            if value_idx + value_len > data.len() {
                break;
            }

            let value = match value_type {
                0 => String::from_utf8_lossy(&data[value_idx..value_idx + value_len]).trim().to_string(),
                1 => String::from_utf8_lossy(&data[value_idx..value_idx + value_len])
                    .trim_end_matches('\0').to_string(),
                2 => {
                    if value_len == 8 {
                        let bytes = &data[value_idx..value_idx + 8];
                        let f = f64::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3],
                                                    bytes[4], bytes[5], bytes[6], bytes[7]]);
                        format!("{:.6}", f)
                    } else {
                        format!("Real({}bytes)", value_len)
                    }
                }
                3 => {
                    data[value_idx..value_idx + value_len]
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect()
                }
                _ => format!("Type{}:{:?}", value_type, &data[value_idx..value_idx + value_len.min(8)]),
            };

            value_idx += value_len;
            transitions.push(Transition { time, value });
        }

        Ok(transitions)
    }

    /// Clear all cache data
    #[wasm_bindgen]
    pub fn clear_cache(&mut self) {
        self.opfs_cache.clear_memory();
        console_log!("[WASM] Cache cleared");
    }

    /// Get server URL
    #[wasm_bindgen(getter)]
    pub fn server_url(&self) -> String {
        self.server_url.clone()
    }

    /// Get waveform name
    #[wasm_bindgen(getter)]
    pub fn waveform_name(&self) -> String {
        self.waveform_name.clone()
    }

    /// Get signal prefix
    #[wasm_bindgen(getter)]
    pub fn signal_prefix(&self) -> String {
        self.signal_prefix.clone()
    }

    /// Get space before bracket setting
    #[wasm_bindgen(getter)]
    pub fn space_before_bracket(&self) -> bool {
        self.space_before_bracket
    }

    /// Get current LoD based on viewport and canvas
    #[wasm_bindgen(getter)]
    pub fn current_lod(&self) -> u32 {
        select_lod(&self.viewport, self.canvas_width)
    }

    /// Set signal prefix
    #[wasm_bindgen(setter)]
    pub fn set_signal_prefix(&mut self, prefix: String) {
        console_log!("[WASM] Updated signal_prefix: '{}' -> '{}'", self.signal_prefix, prefix);
        self.signal_prefix = prefix;
    }

    /// Set space before bracket
    #[wasm_bindgen(setter)]
    pub fn set_space_before_bracket(&mut self, space: bool) {
        console_log!("[WASM] Updated space_before_bracket: {} -> {}", self.space_before_bracket, space);
        self.space_before_bracket = space;
    }

    /// Get display format
    #[wasm_bindgen(getter)]
    pub fn display_format(&self) -> String {
        self.display_format.clone()
    }

    /// Set display format (hex, bin, oct, dec)
    #[wasm_bindgen(setter)]
    pub fn set_display_format(&mut self, format: String) {
        console_log!("[WASM] Updated display_format: '{}' -> '{}'", self.display_format, format);
        self.display_format = format;
    }

    /// Set memory cache enabled
    #[wasm_bindgen]
    pub fn set_memory_cache_enabled(&mut self, enabled: bool) {
        console_log!("[WASM] Setting memory cache enabled: {}", enabled);
        self.opfs_cache.set_memory_cache_enabled(enabled);
    }

    /// Get memory cache enabled status
    #[wasm_bindgen(getter)]
    pub fn memory_cache_enabled(&self) -> bool {
        self.opfs_cache.memory_cache_enabled
    }

    /// Set OPFS cache enabled (dynamic toggle)
    #[wasm_bindgen]
    pub fn set_opfs_enabled(&mut self, enabled: bool) {
        console_log!("[WASM] Setting OPFS cache enabled: {}", enabled);
        self.opfs_cache.enabled = enabled;
    }

    /// Get OPFS cache enabled status
    #[wasm_bindgen(getter)]
    pub fn opfs_enabled(&self) -> bool {
        self.opfs_cache.enabled
    }

    /// Parse @[...] format for bit extraction
    /// Format: parent_name@[bit_index] or parent_name@[msb:lsb]
    /// Examples:
    ///   - "sig@[0]" -> extract bit 0 from "sig"
    ///   - "sig@[7:0]" -> extract bits [7:0] from "sig"
    fn parse_bit_extract(name: &str) -> Option<(String, (u32, u32))> {
        let at_idx = name.find("@[")?;
        let parent_name = &name[..at_idx];
        // Find the closing bracket after "@["
        let bracket_end = name[at_idx..].find(']')?;
        let range_str = &name[at_idx + 2..at_idx + bracket_end];

        // Parse the range (either "bit_index" or "msb:lsb")
        let (msb, lsb) = if range_str.contains(':') {
            let parts: Vec<&str> = range_str.split(':').collect();
            if parts.len() != 2 {
                return None;
            }
            (parts[0].parse().ok()?, parts[1].parse().ok()?)
        } else {
            let idx: u32 = range_str.parse().ok()?;
            (idx, idx)
        };

        Some((parent_name.to_string(), (msb, lsb)))
    }

    /// Set signals to render
    pub fn set_signals(&mut self, signals_js: JsValue) -> Result<(), JsValue> {
        let signals: Vec<SignalInfo> = serde_wasm_bindgen::from_value(signals_js)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse signals: {}", e)))?;

        // Parse bit extraction info for each signal
        let signals: Vec<SignalInfo> = signals.into_iter().map(|mut s| {
            s.bit_extract = Self::parse_bit_extract(&s.name);
            if let Some((ref parent, (msb, lsb))) = s.bit_extract {
                console_log!("[WASM]   Signal '{}': extract bits [{}:{}] from parent '{}'", 
                    s.name, msb, lsb, parent);
            }
            s
        }).collect();

        console_log!("[WASM] Set {} signals", signals.len());
        for (i, s) in signals.iter().enumerate() {
            console_log!("[WASM]   Signal[{}]: name='{}', row={}, width={}", i, s.name, s.row, s.width);
        }
        self.signals = signals;
        Ok(())
    }

    /// Set viewport
    pub fn set_viewport(&mut self, time_start: f64, time_end: f64) {
        console_log!("[WASM] Set viewport: time_start={}, time_end={}", time_start, time_end);
        self.viewport = Viewport { time_start, time_end };
    }

    /// Get viewport time_start
    #[wasm_bindgen(getter)]
    pub fn viewport_time_start(&self) -> f64 {
        self.viewport.time_start
    }

    /// Get viewport time_end
    #[wasm_bindgen(getter)]
    pub fn viewport_time_end(&self) -> f64 {
        self.viewport.time_end
    }

    /// Set canvas dimensions
    /// When width changes, adjust time_end to maintain the same time-to-pixel ratio
    /// time_start remains fixed
    pub fn set_canvas_dimensions(&mut self, width: f64, height: f64, row_height: f64) {
        console_log!("[WASM] Set canvas dimensions: width={}, height={}, row_height={}", width, height, row_height);
        
        // If canvas width changes, adjust time_end to maintain time-to-pixel ratio
        if self.canvas_width > 0.0 && width != self.canvas_width {
            let old_width = self.canvas_width;
            let time_range = self.viewport.time_end - self.viewport.time_start;
            let time_per_pixel = time_range / old_width;
            
            // Calculate new time_end based on new width
            let new_time_range = time_per_pixel * width;
            let new_time_end = self.viewport.time_start + new_time_range;
            
            console_log!("[WASM] Adjusting viewport: time_start={}, old_time_end={}, new_time_end={}", 
                self.viewport.time_start, self.viewport.time_end, new_time_end);
            
            self.viewport.time_end = new_time_end;
        }
        
        self.canvas_width = width;
        self.canvas_height = height;
        self.row_height = row_height;
    }

    /// Build server signal name from local name
    /// 
    /// NOTE: 根据搜索时确定的prefix和space_before_bracket来构建服务器信号名
    fn build_server_signal_name(&self, local_name: &str) -> String {
        console_log!("[WASM] build_server_signal_name: local='{}', prefix='{}', space={}", 
            local_name, self.signal_prefix, self.space_before_bracket);
        
        // 移除 prefix（如 work@）
        let mut server_name = if self.signal_prefix.is_empty() || !local_name.starts_with(&self.signal_prefix) {
            local_name.to_string()
        } else {
            local_name[self.signal_prefix.len()..].to_string()
        };
        
        console_log!("[WASM]   After removing prefix '{}': '{}'", self.signal_prefix, server_name);
        
        // 根据 space_before_bracket 设置，在方括号前添加空格
        if self.space_before_bracket {
            if let Some(bracket_idx) = server_name.find('[') {
                if bracket_idx > 0 && !server_name[..bracket_idx].ends_with(' ') {
                    server_name.insert(bracket_idx, ' ');
                    console_log!("[WASM]   Added space before bracket: '{}'", server_name);
                }
            }
        }

        console_log!("[WASM]   Final server name: '{}'", server_name);
        server_name
    }

    /// Escape regex special characters
    fn escape_regex(s: &str) -> String {
        s.replace(r".", r"\.")
            .replace(r"[", r"\[")
            .replace(r"]", r"\]")
            .replace(r"(", r"\(")
            .replace(r")", r"\)")
            .replace(r"{", r"\{")
            .replace(r"}", r"\}")
            .replace(r"^", r"\^")
            .replace(r"$", r"\$")
            .replace(r"*", r"\*")
            .replace(r"+", r"\+")
            .replace(r"?", r"\?")
            .replace(r"|", r"\|")
    }

    /// Convert local signal name to server signal name
    /// Step 1: Remove prefix (e.g., "work@tb_top.u_dut.signal" -> "tb_top.u_dut.signal")
    /// Step 2: Add space before bracket if needed (e.g., "signal[7:0]" -> "signal [7:0]")
    /// Note: No regex escaping needed for base64 encoding
    pub fn local_to_server_name(&self, local_name: &str) -> String {
        let server_name = self.build_server_signal_name(local_name);
        console_log!("[WASM] Converted '{}' -> '{}'", local_name, server_name);
        server_name
    }



    /// Fetch multiple signals data from server in batch with dynamic LoD
    /// signal_names: array of local signal names (from KDB)
    /// max_batch_size: maximum number of signals per request (default 256)
    /// 
    /// NOTE: This function now integrates with OPFS cache:
    /// 1. Check cache per signal per tile
    /// 2. Fetch only missing signal+tile combinations from server
    /// 3. Store fetched data in cache using supplement_data
    pub async fn fetch_signals_data_batch(&mut self, signal_names: Vec<String>) -> Result<(), JsValue> {
        // Clear signal_data cache for new viewport
        // signal_data is temporary cache for current viewport only
        self.signal_data.clear();
        
        const MAX_BATCH_SIZE: usize = 256;
        
        let total_signals = signal_names.len();
        
        // Calculate appropriate LoD based on current viewport and canvas
        let lod = select_lod(&self.viewport, self.canvas_width);
        
        // Store current LoD for bucket size calculation
        self.current_lod = Some(lod);

        // Get time range from viewport
        let time_start = self.viewport.time_start as u64;
        let time_end = self.viewport.time_end as u64;

        // Calculate tile information for debugging
        let tile_span = OpfsCacheManager::get_tile_span(lod);
        let start_tile = time_start / tile_span;
        let end_tile = time_end / tile_span;
        
        console_log!("[WASM] Fetching {} signals in batches (max {} per batch) at LoD {}, time {}-{}",
            total_signals, MAX_BATCH_SIZE, lod, time_start, time_end);
        console_log!("[WASM]   Tile info: span={}, start_tile={}, end_tile={}, tiles={}",
            tile_span, start_tile, end_tile, end_tile - start_tile + 1);

        // Filter out bit extraction signals - they don't need server data
        let signals_to_fetch: Vec<String> = signal_names.iter()
            .filter(|name| !name.contains("@["))
            .cloned()
            .collect();

        console_log!("[WASM] Total signals: {}, fetching {} (excluding {} bit-extract signals)",
            signal_names.len(), signals_to_fetch.len(), signal_names.len() - signals_to_fetch.len());

        // Optimization: if no signals to fetch, return early
        if signals_to_fetch.is_empty() {
            console_log!("[WASM] No signals to fetch, skipping cache check and server request");
            return Ok(());
        }

        // Step 1: Calculate all required tiles based on time range
        console_log!("[WASM] Step 1: Calculating required tiles...");
        let tiles_to_fetch: Vec<u64> = (start_tile..=end_tile).collect();
        console_log!("[WASM]   Total tiles to check: {}", tiles_to_fetch.len());

        // Step 2: Per-signal per-tile cache check
        // Structure: tile_id -> Vec<signal_names> that need to be fetched for this tile
        console_log!("[WASM] Step 2: Checking cache per signal per tile...");
        let mut tile_missing_signals: std::collections::HashMap<u64, Vec<String>> = std::collections::HashMap::new();
        let mut total_cache_hits = 0u32;
        let mut total_cache_misses = 0u32;
        
        for (tile_idx, tile_id) in tiles_to_fetch.iter().enumerate() {
            let mut tile_hits = 0u32;
            let mut tile_misses = 0u32;
            let is_first_tile = tile_idx == 0;  // First tile in the fetch list
            let tile_start = tile_id * tile_span;  // Calculate tile start time
            
            for signal_name in &signals_to_fetch {
                // Always check OPFS cache for per-tile data
                // Signal may exist in memory but only have data for some tiles
                if let Some(draw_sig_id) = self.get_draw_sig_id(signal_name) {
                    let group_id = OpfsCacheManager::get_group_id(draw_sig_id);
                    let block = crate::opfs_cache::DataBlock {
                        lod,
                        tile: *tile_id,
                        group: group_id,
                    };
                    
                    // Check if group file exists in cache
                    match self.opfs_cache.read(&block).await {
                        Ok(Some(data)) => {
                            // Group file exists, check if specific signal exists using V2 format
                            match crate::opfs_cache::read_signal_from_group_v2(&data, draw_sig_id) {
                                Ok(Some(signal_data)) => {
                                    // Signal found in cache, load into signal_data
                                    tile_hits += 1;
                                    
                                    // Convert opfs_cache::SignalData to SignalWaveData
                                    // For LoD 1+, directly parse into bucket_data (like server fetch)
                                    let lod = self.current_lod.unwrap_or(25);
                                    
                                    // Debug: print raw cache transitions
                                    console_log!("[WASM] Cache raw data for tile {}: {} transitions", tile_id, signal_data.transitions.len());
                                    for (i, t) in signal_data.transitions.iter().take(10).enumerate() {
                                        let value_str = if t.value.len() <= 8 {
                                            let mut bytes = [0u8; 8];
                                            bytes[..t.value.len()].copy_from_slice(&t.value);
                                            format!("0x{:X}", u64::from_le_bytes(bytes))
                                        } else {
                                            format!("0x{}", t.value.iter().map(|b| format!("{:02X}", b)).collect::<String>())
                                        };
                                        console_log!("[WASM]   Raw[{}]: time={}, value={}", i, t.time, value_str);
                                    }
                                    
                                    // Convert cache transitions to our Transition format
                                    let transitions: Vec<Transition> = signal_data.transitions
                                        .into_iter()
                                        .map(|t| {
                                            let value = if t.value.len() <= 8 {
                                                let mut bytes = [0u8; 8];
                                                bytes[..t.value.len()].copy_from_slice(&t.value);
                                                format!("0x{:X}", u64::from_le_bytes(bytes))
                                            } else {
                                                format!("0x{}", t.value.iter().map(|b| format!("{:02X}", b)).collect::<String>())
                                            };
                                            Transition { time: t.time, value }
                                        })
                                        .collect();
                                    
                                    // Parse into bucket_data directly (like server fetch)
                                    let (start_value, buckets) = self.parse_buckets_from_transitions(&transitions);
                                    let tile_end = tile_start + tile_span;
                                    
                                    // Merge with existing signal_data
                                    if let Some(existing) = self.signal_data.get_mut(signal_name) {
                                        // Add bucket_data for this tile
                                        existing.bucket_data.push((tile_start, buckets));
                                        // Store tile info
                                        if let Some(sv) = start_value {
                                            existing.tile_info.push((tile_start, tile_end, BOUNDARY_TIME_START, sv));
                                        }
                                    } else {
                                        // Insert new signal_data with bucket_data
                                        let width = self.get_signal_width(signal_name);
                                        let mut signal_data = SignalWaveData::new(signal_name.clone(), width);
                                        signal_data.bucket_data.push((tile_start, buckets));
                                        if let Some(sv) = start_value {
                                            signal_data.tile_info.push((tile_start, tile_end, BOUNDARY_TIME_START, sv));
                                        }
                                        self.signal_data.insert(signal_name.clone(), signal_data);
                                    }
                                }
                                Ok(None) => {
                                    // Group file exists but signal not found
                                    tile_misses += 1;
                                    tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push(signal_name.clone());
                                }
                                Err(_e) => {
                            tile_misses += 1;
                            tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push(signal_name.clone());
                        }
                    }
                }
                Ok(None) => {
                    // Group file not in cache
                    tile_misses += 1;
                    tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push(signal_name.clone());
                }
                Err(_e) => {
                    tile_misses += 1;
                    tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push(signal_name.clone());
                }
            }
        } else {
            // Signal not found in draw list, treat as miss
            tile_misses += 1;
            tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push(signal_name.clone());
        }
    }
    
    total_cache_hits += tile_hits;
    total_cache_misses += tile_misses;
}

if tile_missing_signals.is_empty() {
    return Ok(());
}
        
        // Step 3: Fetch missing signals using tile-based API
        // Group tiles by contiguous ranges to minimize HTTP requests
        const MAX_TILES_PER_REQUEST: usize = 100;
        
        // Collect all unique signal names from all tiles
        // Note: We must request ALL signals in the viewport, not just missing ones
        // because server returns all requested signals and we need to maintain
        // the correct order for signal identification
        let all_signal_names: Vec<String> = signals_to_fetch.clone();
        
        for batch in all_signal_names.chunks(MAX_BATCH_SIZE) {
            // Convert all signal names to server names
            let server_names: Vec<String> = batch.iter()
                .map(|local_name| self.build_server_signal_name(local_name))
                .collect();

            // Join server names with comma, then base64 encode
            let names_batch = server_names.join(",");
            let encoded_batch = general_purpose::STANDARD.encode(&names_batch);

            // Group contiguous tiles for batch request
            // Sort tile_ids to ensure consistent order
            let mut tile_ids: Vec<u64> = tile_missing_signals.keys().cloned().collect();
            tile_ids.sort();
            let mut tile_idx = 0;
            
            while tile_idx < tile_ids.len() {
                // Find contiguous tile range
                let start_tile = tile_ids[tile_idx];
                let start_time = start_tile * tile_span;
                
                // Count contiguous tiles (up to MAX_TILES_PER_REQUEST)
                let mut num_tiles = 1;
                while tile_idx + num_tiles < tile_ids.len() 
                    && tile_ids[tile_idx + num_tiles] == start_tile + num_tiles as u64
                    && num_tiles < MAX_TILES_PER_REQUEST {
                    num_tiles += 1;
                }
                
                // Build URL for tile-based API
                let url = format!("{}/api/wave/{}/lod/{}/tile/{}/{}/{}/compress/none/signals/b64:{}/data?time_stamp={}",
                    self.server_url,
                    self.waveform_name,
                    lod,
                    start_time,
                    tile_span,
                    num_tiles,
                    encoded_batch,
                    self.time_stamp);
                
                // Fetch batch data
                let window = web_sys::window().ok_or(JsValue::from_str("No window"))?;
                let resp_value: JsValue = wasm_bindgen_futures::JsFuture::from(
                    window.fetch_with_str(&url)
                ).await?;
                
                let resp: web_sys::Response = resp_value.dyn_into()
                    .map_err(|_| JsValue::from_str("Invalid response"))?;
                
                if !resp.ok() {
                    return Err(JsValue::from_str(&format!("HTTP error: {}", resp.status())));
                }
                
                // Get array buffer
                let data: JsValue = wasm_bindgen_futures::JsFuture::from(
                    resp.array_buffer()?
                ).await?;
                
                let array_buffer: js_sys::ArrayBuffer = data.dyn_into()
                    .map_err(|_| JsValue::from_str("Invalid array buffer"))?;
                
                let uint8_array = js_sys::Uint8Array::new(&array_buffer);
                let mut bytes = vec![0u8; uint8_array.length() as usize];
                uint8_array.copy_to(&mut bytes);
                
                // Parse multi-tile response
                self.parse_multi_tile_response(&bytes, batch, time_start, time_end, tile_span).await?;
                
                tile_idx += num_tiles;
            }
        }
        
        Ok(())
    }

    /// Parse multi-tile response and process each tile
    async fn parse_multi_tile_response(
        &mut self,
        data: &[u8],
        signal_names: &[String],
        viewport_start: u64,
        viewport_end: u64,
        tile_span: u64,
    ) -> Result<(), JsValue> {
        // Parse multi-tile header
        let header = MultiTileHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;
        
        // Read tile offset table
        let offset_table_start = MultiTileHeader::SIZE;
        let mut tile_offsets = Vec::with_capacity(header.num_tiles as usize);
        
        for i in 0..header.num_tiles {
            let offset_pos = offset_table_start + (i as usize * 8);
            let offset = u64::from_le_bytes([
                data[offset_pos], data[offset_pos + 1], data[offset_pos + 2], data[offset_pos + 3],
                data[offset_pos + 4], data[offset_pos + 5], data[offset_pos + 6], data[offset_pos + 7],
            ]);
            tile_offsets.push(offset);
        }
        
        // Process each tile
        for (tile_idx, offset) in tile_offsets.iter().enumerate() {
            let tile_id = (header.start_time / tile_span) + tile_idx as u64;
            let tile_start = tile_id * tile_span;
            let is_first_tile = tile_idx == 0;
            
            // Extract tile data (from offset to next tile or end of data)
            let tile_end_offset = if tile_idx + 1 < tile_offsets.len() {
                tile_offsets[tile_idx + 1]
            } else {
                data.len() as u64
            };
            
            let tile_data = &data[*offset as usize..tile_end_offset as usize];
            
            // Parse tile data (standard chunk format)
            self.parse_chunk_data_for_batch(signal_names, tile_data, viewport_start, viewport_end, is_first_tile, false, tile_start)?;
            
            // Store in OPFS cache for future use
            self.process_server_chunk(tile_data, signal_names).await?;
        }
        
        Ok(())
    }

    /// Parse chunk data for a batch of signals
    /// The batch order must match the order in the chunk
    /// 
    /// Parameters:
    /// - batch: signal names in the same order as server response
    /// - data: raw chunk data from server
    /// - viewport_start: viewport start time (for filtering)
    /// - viewport_end: viewport end time (for filtering)
    /// - is_first_tile: whether this is the first tile (keep initial value)
    /// - is_last_tile: whether this is the last tile (keep all transitions)
    /// - tile_start: start time of the tile (for finding initial value)
    fn parse_chunk_data_for_batch(
        &mut self,
        batch: &[String],
        data: &[u8],
        viewport_start: u64,
        viewport_end: u64,
        is_first_tile: bool,
        _is_last_tile: bool,
        tile_start: u64,
    ) -> Result<(), JsValue> {
        // Parse header
        let header = ChunkHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;

        console_log!("[WASM] Chunk for batch: level={}, signals={}, time={}-{}",
            header.level, header.signal_count, header.time_start, header.time_end);

        if header.signal_count as usize != batch.len() {
            console_log!("[WASM] Warning: Chunk signal count ({}) != batch size ({})",
                header.signal_count, batch.len());
        }

        // Parse each signal block
        let mut offset = ChunkHeader::SIZE;
        
        for signal_idx in 0..header.signal_count.min(batch.len() as u32) {
            if offset + SignalBlockHeader::SIZE > data.len() {
                console_log!("[WASM] Warning: Not enough data for signal block {}", signal_idx);
                break;
            }

            // Parse signal block header
            let block_header = SignalBlockHeader::from_bytes(&data[offset..])
                .map_err(|e| JsValue::from_str(&e))?;

            // Get signal name from batch (same order as server)
            let signal_name = &batch[signal_idx as usize];

            // Parse transitions for this signal
            let transitions = self.parse_transitions_from_block(
                data,
                &block_header,
                &header,
                signal_idx as usize
            )?;

            // Calculate tile end
            let tile_end = tile_start + OpfsCacheManager::get_tile_span(header.level as u32);

            // Get width from signal info
            let width = self.get_signal_width(signal_name);

            // For LoD 1+, parse into bucket data; for LoD 0, use traditional transitions
            if header.level > 0 {
                // Parse transitions into bucket data (First/Last format)
                let (start_value, buckets) = self.parse_buckets_from_transitions(&transitions);
                
                // Store signal data with bucket info
                if let Some(existing_data) = self.signal_data.get_mut(signal_name) {
                    // Merge bucket data
                    if let Some((_, existing_buckets)) = existing_data.bucket_data.iter_mut()
                        .find(|(start, _)| *start == tile_start) {
                        // Merge with existing buckets for this tile
                        for (offset, bucket) in buckets {
                            existing_buckets.insert(offset, bucket);
                        }
                    } else {
                        // Add new tile bucket data
                        existing_data.bucket_data.push((tile_start, buckets));
                    }
                    // Also store start value in tile_info for compatibility
                    if let Some(ref sv) = start_value {
                        existing_data.tile_info.push((tile_start, tile_end, BOUNDARY_TIME_START, sv.clone()));
                    }
                } else {
                    let mut signal_data = SignalWaveData::new(signal_name.clone(), width);
                    signal_data.bucket_data.push((tile_start, buckets));
                    if let Some(ref sv) = start_value {
                        signal_data.tile_info.push((tile_start, tile_end, BOUNDARY_TIME_START, sv.clone()));
                    }
                    self.signal_data.insert(signal_name.clone(), signal_data);
                }
            } else {
                // LoD 0: use traditional transition processing
                let (start_value, filtered_transitions) = self.process_tile_transitions(
                    transitions,
                    is_first_tile,
                    tile_start,
                    tile_end,
                    viewport_start,
                    viewport_end,
                );

                // Store signal data - merge with existing data if present
                if let Some(existing_data) = self.signal_data.get_mut(signal_name) {
                    existing_data.transitions.extend(filtered_transitions);
                    existing_data.transitions.sort_by_key(|t| t.time);
                    // Store tile info
                    if let Some(sv) = start_value {
                        existing_data.tile_info.push((tile_start, tile_end, sv.time, sv.value));
                    }
                } else {
                    let mut signal_data = SignalWaveData::new(signal_name.clone(), width);
                    signal_data.transitions = filtered_transitions;
                    // Store tile info
                    if let Some(sv) = start_value {
                        signal_data.tile_info.push((tile_start, tile_end, sv.time, sv.value));
                    }
                    self.signal_data.insert(signal_name.clone(), signal_data);
                }
            }

            offset += SignalBlockHeader::SIZE;
        }

        Ok(())
    }

    /// Get signal width from signal info
    fn get_signal_width(&self, signal_name: &str) -> u32 {
        self.signals.iter()
            .find(|s| s.name == signal_name)
            .map(|s| s.width)
            .unwrap_or(1)
    }

    /// Get draw_sig_id for a signal name
    fn get_draw_sig_id(&self, signal_name: &str) -> Option<u32> {
        self.signals_with_id.iter()
            .find(|s| s.name == signal_name)
            .map(|s| s.draw_sig_id)
    }

    /// Process transitions for a tile according to the drawing spec
    /// 
    /// # Arguments
    /// * `transitions` - Raw transitions from server or cache (including start value)
    /// * `is_first_tile` - Whether this is the first tile in the fetch list
    /// * `tile_start` - Start time of the tile
    /// * `tile_end` - End time of the tile
    /// * `viewport_start` - Start time of the viewport
    /// * `viewport_end` - End time of the viewport
    /// 
    /// # Returns
    /// (start_value, normal_transitions) - Separated start value and normal transitions
    fn process_tile_transitions(
        &self,
        transitions: Vec<Transition>,
        _is_first_tile: bool,
        _tile_start: u64,
        _tile_end: u64,
        viewport_start: u64,
        viewport_end: u64,
    ) -> (Option<Transition>, Vec<Transition>) {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        
        // Separate start value (boundary) from normal transitions
        let start_value = transitions.iter()
            .find(|t| t.time == BOUNDARY_TIME_START)
            .cloned();
        
        // Filter normal transitions within viewport
        let normal_transitions: Vec<Transition> = transitions.into_iter()
            .filter(|t| t.time != BOUNDARY_TIME_START && t.time >= viewport_start && t.time <= viewport_end)
            .collect();
        
        (start_value, normal_transitions)
    }

    /// Parse chunk binary data for single signal (legacy method)
    fn parse_chunk_data(&mut self, signal_name: &str, data: &[u8]) -> Result<(), JsValue> {
        // Parse header
        let header = ChunkHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;

        console_log!("[WASM] Chunk: level={}, signals={}, time={}-{}",
            header.level, header.signal_count, header.time_start, header.time_end);

        // If chunk contains multiple signals, parse all of them
        if header.signal_count > 1 {
            self.parse_multi_signal_chunk(data, &header)?;
        } else {
            // Single signal - parse and store with the given name
            self.parse_single_signal_chunk(signal_name, data, &header)?;
        }

        Ok(())
    }

    /// Parse chunk containing multiple signals
    fn parse_multi_signal_chunk(&mut self, data: &[u8], header: &ChunkHeader) -> Result<(), JsValue> {
        let mut offset = ChunkHeader::SIZE;

        // Parse each signal block
        for signal_idx in 0..header.signal_count {
            if offset + SignalBlockHeader::SIZE > data.len() {
                console_log!("[WASM] Warning: Not enough data for signal block {}", signal_idx);
                break;
            }

            // Parse signal block header
            let block_header = SignalBlockHeader::from_bytes(&data[offset..])
                .map_err(|e| JsValue::from_str(&e))?;

            console_log!("[WASM] Signal block {}: handle={}, transitions={}",
                signal_idx, block_header.signal_handle, block_header.transition_count);

            // Find signal name by handle (we need to map handle to name)
            // For now, use the signal at the same index in our signals list
            let signal_name = if (signal_idx as usize) < self.signals.len() {
                self.signals[signal_idx as usize].name.clone()
            } else {
                format!("signal_{}", block_header.signal_handle)
            };

            // Parse transitions for this signal
            let transitions = self.parse_transitions_from_block(
                data,
                &block_header,
                header,
                signal_idx as usize
            )?;

            // Get width from signal info
            let width = if (signal_idx as usize) < self.signals.len() {
                self.signals[signal_idx as usize].width
            } else {
                1
            };

            // Store signal data
            let mut signal_data = SignalWaveData::new(signal_name.clone(), width);
            signal_data.transitions = transitions;
            self.signal_data.insert(signal_name.clone(), signal_data);

            offset += SignalBlockHeader::SIZE;
        }

        Ok(())
    }

    /// Parse single signal chunk
    fn parse_single_signal_chunk(&mut self, signal_name: &str, data: &[u8], header: &ChunkHeader) -> Result<(), JsValue> {
        if data.len() < ChunkHeader::SIZE + SignalBlockHeader::SIZE {
            console_log!("[WASM] Error: Not enough data for single signal chunk, got {} bytes", data.len());
            return Err(JsValue::from_str("Not enough data for single signal chunk"));
        }

        // Parse signal block header
        let block_header = SignalBlockHeader::from_bytes(&data[ChunkHeader::SIZE..])
            .map_err(|e| JsValue::from_str(&e))?;

        console_log!("[WASM] Single signal block: handle={}, transitions={}",
            block_header.signal_handle, block_header.transition_count);

        // Parse transitions
        let transitions = self.parse_transitions_from_block(
            data,
            &block_header,
            header,
            0
        )?;

        // Get width from signal info if available
        let width = self.get_signal_width(signal_name);

        let mut signal_data = SignalWaveData::new(signal_name.to_string(), width);
        signal_data.transitions = transitions;
        self.signal_data.insert(signal_name.to_string(), signal_data);

        Ok(())
    }

    /// Parse transitions from a signal block
    /// Data format from server:
    /// - Time array: [time0(u64), time1(u64), ...] (compressed)
    /// - Value array: [type(u8), len(u16), value_bytes...] × transition_count
    fn parse_transitions_from_block(
        &self,
        data: &[u8],
        block_header: &SignalBlockHeader,
        chunk_header: &ChunkHeader,
        signal_index: usize,
    ) -> Result<Vec<Transition>, JsValue> {
        let mut transitions = Vec::new();

        // Calculate offsets based on SignalBlockHeader
        // Note: time_array_offset and value_array_offset are ABSOLUTE from start of chunk
        // NOT relative to data_area_start
        let time_array_start = block_header.time_array_offset as usize;
        let value_array_start = block_header.value_array_offset as usize;

        console_log!("[WASM] Parsing transitions for signal {}: time_start={}, value_start={}, transitions={}",
            signal_index, time_array_start, value_array_start, block_header.transition_count);
        
        // Debug: print first 64 bytes of time and value arrays
        let time_preview_len = (block_header.transition_count as usize * 8).min(64);
        let value_preview_len = (data.len() - value_array_start).min(64);
        console_log!("[WASM] Time array (first {} bytes): {:?}", 
            time_preview_len,
            &data[time_array_start..time_array_start + time_preview_len]
                .iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" "));
        console_log!("[WASM] Value array (first {} bytes): {:?}",
            value_preview_len,
            &data[value_array_start..value_array_start + value_preview_len]
                .iter()
                .map(|b| format!("{:02X}", b))
                .collect::<Vec<_>>()
                .join(" "));

        // Parse each transition
        let mut value_idx = value_array_start;
        for i in 0..block_header.transition_count {
            let time_idx = time_array_start + (i as usize * 8);

            // Check bounds for time
            if time_idx + 8 > data.len() {
                console_log!("[WASM] Warning: Time data out of bounds at index {}", i);
                break;
            }

            // Parse time (u64, little-endian)
            let time = u64::from_le_bytes([
                data[time_idx], data[time_idx + 1], data[time_idx + 2], data[time_idx + 3],
                data[time_idx + 4], data[time_idx + 5], data[time_idx + 6], data[time_idx + 7],
            ]);

            // Parse value according to FST-like format
            // Format: [type(u8), length(u16), value_bytes...]
            if value_idx + 3 > data.len() {
                console_log!("[WASM] Warning: Value header out of bounds at index {}", i);
                break;
            }

            let value_type = data[value_idx];
            let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
            value_idx += 3;

            if value_idx + value_len > data.len() {
                console_log!("[WASM] Warning: Value data out of bounds at index {} (len={})", i, value_len);
                break;
            }

            // Parse value based on type
            // Type mapping (must match server SignalValueType):
            // 0 = Numeric (wire/reg/logic/integer) - ASCII string like "0", "1", "b1010", "bX1Z0"
            // 1 = String - null-terminated ASCII
            // 2 = Real - IEEE 754 f64
            // 3 = BinaryCompressed - compact binary bytes
            let value = match value_type {
                0 => {
                    // Numeric type - read as UTF-8 string
                    // Format: ASCII string like "0", "1", "b1010", "bX1Z0"
                    String::from_utf8_lossy(&data[value_idx..value_idx + value_len]).trim().to_string()
                }
                1 => {
                    // String type - null-terminated ASCII
                    let s = String::from_utf8_lossy(&data[value_idx..value_idx + value_len]);
                    s.trim_end_matches('\0').to_string()
                }
                2 => {
                    // Real type (f64) - IEEE 754 format
                    if value_len == 8 {
                        let bytes = &data[value_idx..value_idx + 8];
                        let f = f64::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3],
                                                    bytes[4], bytes[5], bytes[6], bytes[7]]);
                        format!("{:.6}", f)
                    } else {
                        format!("Real({}bytes)", value_len)
                    }
                }
                3 => {
                    // Binary compressed - compact binary bytes, MSB first
                    // Convert to hex string for display
                    let hex: String = data[value_idx..value_idx + value_len]
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect();
                    hex
                }
                _ => {
                    // Unknown type - show as hex
                    let hex: String = data[value_idx..value_idx + value_len.min(8)]
                        .iter()
                        .map(|b| format!("{:02X}", b))
                        .collect();
                    format!("Type{}:{}", value_type, hex)
                }
            };

            value_idx += value_len;
            transitions.push(Transition { time, value });
        }

        if transitions.is_empty() {
            // Fallback: create at least one transition
            console_log!("[WASM] Warning: No transitions parsed, using fallback");
            transitions.push(Transition { time: chunk_header.time_start, value: "0".to_string() });
        }

        // Debug: print all parsed transitions
        for (i, t) in transitions.iter().enumerate() {
            console_log!("[WASM]   Parsed[{}]: time={}, value={}", i, t.time, t.value);
        }
        
        console_log!("[WASM] Parsed {} transitions at LoD {}", transitions.len(), chunk_header.level);
        Ok(transitions)
    }

    /// Parse transitions into bucket data for LoD 1+ (First/Last format)
    /// 
    /// For LoD 1+, transitions with the same offset form a first/last pair:
    /// - First transition: offset=X, value=first_value
    /// - Last transition:  offset=X, value=last_value (if present)
    /// 
    /// Returns (start_value, buckets HashMap)
    fn parse_buckets_from_transitions(
        &self,
        transitions: &[Transition],
    ) -> (Option<String>, HashMap<u32, BucketData>) {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        
        let mut start_value: Option<String> = None;
        let mut buckets: HashMap<u32, BucketData> = HashMap::new();
        let mut pending_first: Option<(u32, Transition)> = None;
        
        for transition in transitions {
            // Check for start value (boundary time)
            if transition.time == BOUNDARY_TIME_START {
                start_value = Some(transition.value.clone());
                continue;
            }
            
            // For LoD 1+, time is bucket offset (0-255)
            let offset = transition.time as u32;
            
            match pending_first {
                None => {
                    // No pending first, this is a first transition
                    pending_first = Some((offset, Transition {
                        time: offset as u64,
                        value: transition.value.clone(),
                    }));
                }
                Some((pending_offset, first_trans)) => {
                    if offset == pending_offset {
                        // Same offset: this is the last transition (first/last pair)
                        let bucket = BucketData {
                            offset: pending_offset,
                            first: first_trans,
                            last: Some(Transition {
                                time: offset as u64,
                                value: transition.value.clone(),
                            }),
                        };
                        buckets.insert(pending_offset, bucket);
                        pending_first = None;
                    } else {
                        // Different offset: previous was a single transition
                        let bucket = BucketData {
                            offset: pending_offset,
                            first: first_trans,
                            last: None,
                        };
                        buckets.insert(pending_offset, bucket);
                        // This becomes the new first
                        pending_first = Some((offset, Transition {
                            time: offset as u64,
                            value: transition.value.clone(),
                        }));
                    }
                }
            }
        }
        
        // Handle any remaining pending first
        if let Some((pending_offset, first_trans)) = pending_first {
            let bucket = BucketData {
                offset: pending_offset,
                first: first_trans,
                last: None,
            };
            buckets.insert(pending_offset, bucket);
        }
        
        (start_value, buckets)
    }

    /// Get render segments for current viewport
    pub fn get_segments(&self) -> Result<JsValue, JsValue> {
        // Optimization: if no signals to draw, return empty segments early
        if self.signals.is_empty() {
            console_log!("[WASM] get_segments: no signals to draw, returning empty segments");
            return serde_wasm_bindgen::to_value(&Vec::<RenderSegment>::new())
                .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)));
        }

        let mut segments = Vec::new();
        let time_range = self.viewport.time_end - self.viewport.time_start;

        for signal in self.signals.iter() {
            // Use signal.row provided by UI (accounts for group headers)
            let y = 20.0 + signal.row as f64 * self.row_height + self.row_height / 2.0;

            // Check if this is a bit extraction signal
            if let Some((ref parent_name, (msb, lsb))) = signal.bit_extract {
                // Get parent signal data
                if let Some(parent_data) = self.signal_data.get(parent_name) {
                    // Extract bits from parent signal
                    let extracted_transitions = self.extract_bits_from_transitions(
                        &parent_data.transitions, parent_data.width, msb, lsb);
                    
                    let width = if msb == lsb { 1 } else { msb - lsb + 1 };
                    
                    // Generate segments from extracted data
                    let is_lod_min_max = self.detect_min_max_format(&extracted_transitions);
                    if is_lod_min_max {
                        self.generate_min_max_segments(&extracted_transitions, width, y, &signal.name,
                            time_range, &mut segments);
                    } else {
                        self.generate_normal_segments(&extracted_transitions, width, y, &signal.name,
                            time_range, &mut segments);
                    }
                }
                continue;
            }

            if let Some(data) = self.signal_data.get(&signal.name) {
                // Check if we have bucket data (new First/Last format)
                if !data.bucket_data.is_empty() {
                    // Use new bucket-based segment generation
                    self.generate_lod_segments_from_buckets(
                        &data.bucket_data,
                        data.width,
                        y,
                        &signal.name,
                        time_range,
                        &mut segments,
                    );
                } else if !data.transitions.is_empty() {
                    // Check if transitions are in LoD 1+ format (bucket offsets 0-255)
                    // This handles cache data from old format
                    let is_lod_format = self.detect_lod_bucket_format(&data.transitions);
                    
                    if is_lod_format {
                        // Parse transitions into bucket data and generate segments
                        // For LoD 1+ cache data, transitions are bucket offsets (0-255)
                        // We need to group them by tile and convert offsets to absolute times
                        let lod = self.current_lod.unwrap_or(25);
                        let bucket_size = 1u64 << lod;
                        let tile_span = OpfsCacheManager::get_tile_span(lod);
                        
                        let mut tile_buckets: std::collections::HashMap<u64, HashMap<u32, BucketData>> = std::collections::HashMap::new();
                        
                        console_log!("[WASM] Grouping {} transitions by tile (lod={}, bucket_size={})", 
                            data.transitions.len(), lod, bucket_size);
                        
                        // Group transitions by tile_start (from tile_info)
                        // Each tile has its own set of transitions in the cache
                        // We need to filter transitions for each tile based on the tile's time range
                        for (tile_idx, (tile_start, tile_end, _, _)) in data.tile_info.iter().enumerate() {
                            // For each tile, filter transitions that belong to this tile
                            // Transitions with time < tile_end belong to this tile
                            // But we need to handle the case where transitions are sorted by time
                            
                            let tile_transitions: Vec<Transition> = data.transitions
                                .iter()
                                .filter(|t| {
                                    if t.time == BOUNDARY_TIME_START {
                                        return false; // Skip boundary value
                                    }
                                    // For LoD 1+, time is bucket offset (0-255)
                                    // Convert to absolute time to check if in this tile
                                    let abs_time = *tile_start + t.time * bucket_size;
                                    abs_time >= *tile_start && abs_time < *tile_end
                                })
                                .cloned()
                                .collect();
                            
                            console_log!("[WASM]   Tile {}: start={}, end={}, {} transitions", 
                                tile_idx, tile_start, tile_end, tile_transitions.len());
                            
                            // Parse this tile's transitions into buckets
                            if !tile_transitions.is_empty() {
                                let (_, buckets) = self.parse_buckets_from_transitions(&tile_transitions);
                                console_log!("[WASM]   Tile {}: {} buckets parsed", tile_idx, buckets.len());
                                tile_buckets.insert(*tile_start, buckets);
                            }
                        }
                        
                        // Convert to vec for generate_lod_segments_from_buckets
                        // Sort by tile_start to ensure correct order
                        let mut bucket_data: Vec<(u64, HashMap<u32, BucketData>)> = tile_buckets.into_iter().collect();
                        bucket_data.sort_by_key(|(start, _)| *start);
                        
                        console_log!("[WASM] Cache data: {} tiles from tile_info, {} bucket entries (sorted)", 
                            data.tile_info.len(), bucket_data.len());
                        
                        // Debug: print bucket details for each tile
                        for (tile_idx, (tile_start, buckets)) in bucket_data.iter().enumerate() {
                            console_log!("[WASM]   Bucket entry {}: start={}, {} buckets", 
                                tile_idx, tile_start, buckets.len());
                            // Print first few bucket offsets
                            let mut offsets: Vec<u32> = buckets.keys().cloned().collect();
                            offsets.sort();
                            for (i, offset) in offsets.iter().take(5).enumerate() {
                                if let Some(bucket) = buckets.get(offset) {
                                    let last_str = match &bucket.last {
                                        Some(l) => format!(", last={}", l.value),
                                        None => "".to_string(),
                                    };
                                    console_log!("[WASM]     Bucket[{}]: offset={}, first={}{}", 
                                        i, offset, bucket.first.value, last_str);
                                }
                            }
                        }
                        
                        self.generate_lod_segments_from_buckets(
                            &bucket_data,
                            data.width,
                            y,
                            &signal.name,
                            time_range,
                            &mut segments,
                        );
                    } else {
                        // Check if this is LoD 1+ data (min/max format)
                        let is_lod_min_max = self.detect_min_max_format(&data.transitions);

                        if is_lod_min_max {
                            // Process LoD 1+ min/max format
                            self.generate_min_max_segments(&data.transitions, data.width, y, &signal.name, 
                                time_range, &mut segments);
                        } else {
                            // Process LoD 0 format (original)
                            self.generate_normal_segments(&data.transitions, data.width, y, &signal.name,
                                time_range, &mut segments);
                        }
                    }
                }
            }
        }

        serde_wasm_bindgen::to_value(&segments)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    /// Detect if transitions are in LoD bucket format (First/Last format)
    /// Returns true if time values are small (0-255), indicating bucket offsets
    fn detect_lod_bucket_format(&self, transitions: &[Transition]) -> bool {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        
        if transitions.len() < 2 {
            return false;
        }
        
        // Check first few non-boundary transitions
        let mut checked = 0;
        for t in transitions.iter() {
            if t.time == BOUNDARY_TIME_START {
                continue;
            }
            // If time is small (0-255), it's likely a bucket offset
            if t.time <= 255 {
                checked += 1;
                if checked >= 3 {
                    return true;
                }
            } else {
                return false;
            }
        }
        
        false
    }

    /// Detect if transitions are in min/max format (LoD 1+)
    /// Returns true if consecutive transitions have the same timestamp
    fn detect_min_max_format(&self, transitions: &[Transition]) -> bool {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        
        if transitions.len() < 2 {
            console_log!("[WASM] detect_min_max_format: transitions.len() < 2, returning false");
            return false;
        }
        
        // Skip boundary value (first transition with time = BOUNDARY_TIME_START)
        // and check remaining transitions for same timestamp pattern (min/max pairs)
        let start_idx = if transitions[0].time == BOUNDARY_TIME_START {
            1
        } else {
            0
        };
        
        console_log!("[WASM] detect_min_max_format: transitions={}, start_idx={}", transitions.len(), start_idx);
        
        // Check for same timestamp pattern (min/max pairs)
        // Check up to 20 transitions to find min/max pairs
        let check_limit = transitions.len().min(start_idx + 20).saturating_sub(1);
        for i in start_idx..check_limit {
            console_log!("[WASM]   Checking transitions[{}].time={} vs transitions[{}].time={}", 
                i, transitions[i].time, i+1, transitions[i+1].time);
            if transitions[i].time == transitions[i + 1].time {
                console_log!("[WASM]   Found min/max pair at index {}", i);
                return true;
            }
        }
        console_log!("[WASM] detect_min_max_format: no min/max pairs found in first {} transitions", check_limit);
        false
    }

    /// Extract specific bits from transitions
    /// For example, extract bits [3:0] from a 8-bit signal
    fn extract_bits_from_transitions(&self, transitions: &[Transition], _parent_width: u32, msb: u32, lsb: u32) -> Vec<Transition> {
        // Handle edge case: if range is 64 bits, mask would overflow
        let bit_count = msb - lsb + 1;
        let mask = if bit_count >= 64 {
            u64::MAX
        } else {
            ((1u64 << bit_count) - 1) << lsb
        };
        
        console_log!("[WASM] extract_bits_from_transitions: msb={}, lsb={}, bit_count={}, mask={:#x}", msb, lsb, bit_count, mask);
        
        let mut result = Vec::new();
        let mut last_value: Option<String> = None;
        
        for t in transitions.iter() {
            // Parse value string to u64, handling both decimal and hex formats
            let value_u64 = if t.value.starts_with("0x") || t.value.starts_with("0X") {
                match u64::from_str_radix(t.value.trim_start_matches("0x").trim_start_matches("0X"), 16) {
                    Ok(v) => v,
                    Err(_) => continue,
                }
            } else {
                match t.value.parse::<u64>() {
                    Ok(v) => v,
                    Err(_) => continue,
                }
            };
            let extracted_value = (value_u64 & mask) >> lsb;
            let extracted_str = format!("{}", extracted_value);
            
            // Only add transition if value changed (or it's the first one)
            if last_value.as_ref() != Some(&extracted_str) {
                result.push(Transition {
                    time: t.time,
                    value: extracted_str.clone(),
                });
                last_value = Some(extracted_str);
            }
        }
        
        console_log!("[WASM] extract_bits_from_transitions: {} transitions after dedup", result.len());
        result
    }

    /// Generate segments for LoD 0 (normal format) according to the drawing spec
    /// 
    /// Drawing Rules:
    /// - First transition at/after viewport start: start value -> first transition
    /// - Then draw each transition's value until next transition
    /// - Last transition -> viewport end
    fn generate_normal_segments(&self, transitions: &[Transition], width: u32, y: f64,
        signal_name: &str, time_range: f64, segments: &mut Vec<RenderSegment>) {

        // Separate start value (boundary) from normal transitions
        let start_value = transitions.iter()
            .find(|t| t.time == BOUNDARY_TIME_START)
            .map(|t| t.value.clone());

        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .cloned()
            .collect();

        // If no normal transitions, draw start value across viewport
        if normal_transitions.is_empty() {
            if let Some(start_val) = start_value {
                let (value_type, has_xz) = Self::classify_value(&start_val, width);
                let display_str = if width > 1 {
                    self.format_multi_bit_value(&start_val, width)
                } else {
                    start_val.clone()
                };

                segments.push(RenderSegment {
                    x0: 0.0,
                    x1: self.canvas_width,
                    y,
                    value: ValueInfo {
                        value_type,
                        display_str,
                        width,
                        has_xz,
                        min_value: None,
                        max_value: None,
                        is_min_max: false,
                    },
                    signal_name: signal_name.to_string(),
                });
            }
            return;
        }

        // Find the first transition at or after viewport start
        let viewport_start_u64 = self.viewport.time_start as u64;
        let first_visible_idx = normal_transitions.iter()
            .position(|t| t.time >= viewport_start_u64)
            .unwrap_or(0);

        // If first visible transition is after viewport start, draw start value segment
        if first_visible_idx < normal_transitions.len() {
            let first_trans_time = normal_transitions[first_visible_idx].time as f64;
            
            // Check if we need an initial segment (first transition is after viewport start)
            if first_trans_time > self.viewport.time_start {
                // Determine the value for the initial segment
                // Use the value from the transition just before viewport start, or start value
                let initial_value = if first_visible_idx > 0 {
                    // Use the previous transition's value
                    normal_transitions[first_visible_idx - 1].value.clone()
                } else if let Some(ref sv) = start_value {
                    // Use start value
                    sv.clone()
                } else {
                    // Fallback: use first transition's value
                    normal_transitions[first_visible_idx].value.clone()
                };

                let t0 = self.viewport.time_start;
                let t1 = first_trans_time.min(self.viewport.time_end);
                let x0 = 0.0;
                let x1 = ((t1 - self.viewport.time_start) / time_range) * self.canvas_width;

                if x1 > x0 {
                    let (value_type, has_xz) = Self::classify_value(&initial_value, width);
                    let display_str = if width > 1 {
                        self.format_multi_bit_value(&initial_value, width)
                    } else {
                        initial_value.clone()
                    };

                    segments.push(RenderSegment {
                        x0,
                        x1,
                        y,
                        value: ValueInfo {
                            value_type,
                            display_str,
                            width,
                            has_xz,
                            min_value: None,
                            max_value: None,
                            is_min_max: false,
                        },
                        signal_name: signal_name.to_string(),
                    });
                }
            }
        }

        // Draw transitions
        for i in 0..normal_transitions.len() {
            let t0 = normal_transitions[i].time as f64;
            let t1 = if i + 1 < normal_transitions.len() {
                normal_transitions[i + 1].time as f64
            } else {
                self.viewport.time_end
            };

            // Skip if outside viewport
            if t1 < self.viewport.time_start || t0 > self.viewport.time_end {
                continue;
            }

            // Clamp to viewport
            let t0_clamped = t0.max(self.viewport.time_start);
            let t1_clamped = t1.min(self.viewport.time_end);

            // Convert to pixels
            let x0 = ((t0_clamped - self.viewport.time_start) / time_range) * self.canvas_width;
            let x1 = ((t1_clamped - self.viewport.time_start) / time_range) * self.canvas_width;

            let value_str = &normal_transitions[i].value;
            let (value_type, has_xz) = Self::classify_value(value_str, width);

            let display_str = if width > 1 {
                self.format_multi_bit_value(value_str, width)
            } else {
                value_str.clone()
            };

            segments.push(RenderSegment {
                x0,
                x1,
                y,
                value: ValueInfo {
                    value_type,
                    display_str,
                    width,
                    has_xz,
                    min_value: None,
                    max_value: None,
                    is_min_max: false,
                },
                signal_name: signal_name.to_string(),
            });
        }
    }

    /// Generate segments for LoD 1+ (min/max format) according to the drawing spec
    /// 
    /// Drawing Rules:
    /// - First transition at/after viewport start: start value -> first transition
    /// - Then draw min/max pairs
    /// - Last transition -> viewport end
    /// - Min/Max pairs: same timestamp, min first, max second
    fn generate_min_max_segments(&self, transitions: &[Transition], width: u32, y: f64,
        signal_name: &str, time_range: f64, segments: &mut Vec<RenderSegment>) {
        
        console_log!("[WASM] generate_min_max_segments: viewport={}-{}, transitions={}", 
            self.viewport.time_start, self.viewport.time_end, transitions.len());

        // Separate start value (boundary) from normal transitions
        let start_value = transitions.iter()
            .find(|t| t.time == BOUNDARY_TIME_START)
            .map(|t| t.value.clone());

        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .cloned()
            .collect();

        // If no normal transitions, draw start value across viewport
        if normal_transitions.is_empty() {
            if let Some(start_val) = start_value {
                let (value_type, has_xz) = Self::classify_value(&start_val, width);
                let display_str = if width > 1 {
                    self.format_multi_bit_value(&start_val, width)
                } else {
                    start_val.clone()
                };

                segments.push(RenderSegment {
                    x0: 0.0,
                    x1: self.canvas_width,
                    y,
                    value: ValueInfo {
                        value_type,
                        display_str,
                        width,
                        has_xz,
                        min_value: Some(start_val.clone()),
                        max_value: Some(start_val),
                        is_min_max: false,
                    },
                    signal_name: signal_name.to_string(),
                });
            }
            return;
        }

        // Find the first transition at or after viewport start
        let viewport_start_u64 = self.viewport.time_start as u64;
        let first_visible_idx = normal_transitions.iter()
            .position(|t| t.time >= viewport_start_u64)
            .unwrap_or(0);

        // If first visible transition is after viewport start, draw initial segment
        if first_visible_idx < normal_transitions.len() {
            let first_trans_time = normal_transitions[first_visible_idx].time as f64;
            
            // Check if we need an initial segment (first transition is after viewport start)
            if first_trans_time > self.viewport.time_start {
                // Determine the value for the initial segment
                // Use the value from the transition just before viewport start, or start value
                let initial_value = if first_visible_idx > 0 {
                    // Use the previous transition's value
                    normal_transitions[first_visible_idx - 1].value.clone()
                } else if let Some(ref sv) = start_value {
                    // Use start value
                    sv.clone()
                } else {
                    // Fallback: use first transition's value
                    normal_transitions[first_visible_idx].value.clone()
                };

                let t0 = self.viewport.time_start;
                let t1 = first_trans_time.min(self.viewport.time_end);
                let x0 = 0.0;
                let x1 = ((t1 - self.viewport.time_start) / time_range) * self.canvas_width;

                if x1 > x0 {
                    let (_value_type, has_xz) = Self::classify_value(&initial_value, width);
                    let display_str = if width > 1 {
                        self.format_multi_bit_value(&initial_value, width)
                    } else {
                        initial_value.clone()
                    };

                    // For LoD > 0, always use 'min_max' type to ensure proper grouping
                    segments.push(RenderSegment {
                        x0,
                        x1,
                        y,
                        value: ValueInfo {
                            value_type: "min_max".to_string(),
                            display_str,
                            width,
                            has_xz,
                            min_value: Some(initial_value.clone()),
                            max_value: Some(initial_value),
                            is_min_max: false,  // min == max
                        },
                        signal_name: signal_name.to_string(),
                    });
                }
            }
        }

        // Process min/max pairs (same timestamp)
        let mut i = 0;
        while i < normal_transitions.len() {
            let time = normal_transitions[i].time;
            let mut values = vec![&normal_transitions[i].value];

            // Collect all values with the same timestamp (min/max pair)
            let mut j = i + 1;
            while j < normal_transitions.len() && normal_transitions[j].time == time {
                values.push(&normal_transitions[j].value);
                j += 1;
            }

            // Determine next time (end of this bucket)
            let next_time = if j < normal_transitions.len() {
                normal_transitions[j].time as f64
            } else {
                self.viewport.time_end
            };

            let time_f = time as f64;

            // Skip if outside viewport
            if next_time < self.viewport.time_start || time_f > self.viewport.time_end {
                i = j;
                continue;
            }

            // Clamp to viewport
            let t0_clamped = time_f.max(self.viewport.time_start);
            let t1_clamped = next_time.min(self.viewport.time_end);

            // Convert to pixels
            let x0 = ((t0_clamped - self.viewport.time_start) / time_range) * self.canvas_width;
            let x1 = ((t1_clamped - self.viewport.time_start) / time_range) * self.canvas_width;

            // Extract min and max values (min first, max second)
            let (min_val, max_val) = if values.len() >= 2 {
                (values[0].clone(), values[1].clone())
            } else {
                (values[0].clone(), values[0].clone())
            };

            // Check if min != max and neither is X/Z
            let min_upper = min_val.to_uppercase();
            let max_upper = max_val.to_uppercase();
            let has_xz = min_upper.contains('X') || min_upper.contains('Z') ||
                        max_upper.contains('X') || max_upper.contains('Z');
            let is_changing = min_val != max_val && !has_xz;

            // For LoD > 0, always use 'min_max' type to ensure proper grouping
            let display_str = if is_changing {
                if width == 1 {
                    "toggling".to_string()
                } else {
                    format!("{}..{}", min_val, max_val)
                }
            } else {
                // min == max or has X/Z
                min_val.clone()
            };

            segments.push(RenderSegment {
                x0,
                x1,
                y,
                value: ValueInfo {
                    value_type: "min_max".to_string(),  // Always use min_max for LoD > 0
                    display_str,
                    width,
                    has_xz,
                    min_value: Some(min_val),
                    max_value: Some(max_val),
                    is_min_max: is_changing,
                },
                signal_name: signal_name.to_string(),
            });

            i = j;
        }
    }

    /// Generate segments from bucket data for LoD 1+ (First/Last format)
    /// 
    /// Drawing Rules per spec:
    /// - Empty bucket: continue with current value
    /// - Single transition: draw stable value
    /// - First/Last pair: draw toggling
    fn generate_lod_segments_from_buckets(
        &self,
        bucket_data: &[(u64, HashMap<u32, BucketData>)],
        width: u32,
        y: f64,
        signal_name: &str,
        time_range: f64,
        segments: &mut Vec<RenderSegment>,
    ) {
        const TILE_SPAN_MULTIPLIER: u32 = 256;
        
        console_log!("[WASM] generate_lod_segments_from_buckets: {} tiles, viewport={}-{}",
            bucket_data.len(), self.viewport.time_start, self.viewport.time_end);
        
        // Track current value across tiles for continuity
        let mut cross_tile_value: Option<String> = None;
        
        for (tile_idx, (tile_start, buckets)) in bucket_data.iter().enumerate() {
            // Calculate bucket size from tile span
            let lod = self.current_lod.unwrap_or(25);
            let bucket_size = 1u64 << lod;
            
            console_log!("[WASM]   Processing tile {}: start={}, {} buckets, bucket_size={}",
                tile_idx, tile_start, buckets.len(), bucket_size);
            
            // Get start value for this tile
            // For first tile: use tile's start value
            // For subsequent tiles: use last value from previous tile (cross-tile continuity)
            let start_value = if tile_idx == 0 {
                // First tile: get start value from tile_info
                self.signal_data.get(signal_name)
                    .and_then(|data| data.tile_info.iter()
                        .find(|(start, _, _, _)| start == tile_start)
                        .map(|(_, _, _, value)| value.clone()))
                    .unwrap_or_else(|| "0".to_string())
            } else {
                // Subsequent tiles: use value from previous tile's last bucket
                cross_tile_value.clone().unwrap_or_else(|| "0".to_string())
            };
            
            let mut current_value = start_value.clone();
            let mut segments_in_tile = 0;
            
            // Process each bucket in the tile
            for bucket_idx in 0..TILE_SPAN_MULTIPLIER {
                let bucket_start_time = tile_start + (bucket_idx as u64) * bucket_size;
                let bucket_end_time = bucket_start_time + bucket_size;
                
                // Skip if outside viewport
                if bucket_end_time < self.viewport.time_start as u64 || 
                   bucket_start_time > self.viewport.time_end as u64 {
                    continue;
                }
                
                // Clamp to viewport
                let draw_start = (bucket_start_time as f64).max(self.viewport.time_start);
                let draw_end = (bucket_end_time as f64).min(self.viewport.time_end);
                
                // Convert to pixel coordinates
                let x0 = ((draw_start - self.viewport.time_start) / time_range) * self.canvas_width;
                let x1 = ((draw_end - self.viewport.time_start) / time_range) * self.canvas_width;
                
                if x1 <= x0 {
                    continue;
                }
                
                match buckets.get(&bucket_idx) {
                    None => {
                        // Empty bucket: draw current value
                        let (value_type, has_xz) = Self::classify_value(&current_value, width);
                        let display_str = if width > 1 {
                            self.format_multi_bit_value(&current_value, width)
                        } else {
                            current_value.clone()
                        };
                        
                        segments.push(RenderSegment {
                            x0,
                            x1,
                            y,
                            value: ValueInfo {
                                value_type,
                                display_str,
                                width,
                                has_xz,
                                min_value: Some(current_value.clone()),
                                max_value: Some(current_value.clone()),
                                is_min_max: false,
                            },
                            signal_name: signal_name.to_string(),
                        });
                    }
                    Some(bucket) => {
                        if bucket.has_toggle() {
                            // First/Last pair: draw toggling
                            let first_val = bucket.first.value.clone();
                            let last_val = bucket.last.as_ref().unwrap().value.clone();
                            
                            let display_str = if width == 1 {
                                "toggling".to_string()
                            } else {
                                format!("{}..{}", first_val, last_val)
                            };
                            
                            segments.push(RenderSegment {
                                x0,
                                x1,
                                y,
                                value: ValueInfo {
                                    value_type: "min_max".to_string(),
                                    display_str,
                                    width,
                                    has_xz: false,
                                    min_value: Some(first_val.clone()),
                                    max_value: Some(last_val.clone()),
                                    is_min_max: true,  // This is a toggle bucket
                                },
                                signal_name: signal_name.to_string(),
                            });
                            
                            // Update current value to last
                            current_value = last_val;
                        } else {
                            // Single transition: draw stable value
                            let value = bucket.first.value.clone();
                            let (value_type, has_xz) = Self::classify_value(&value, width);
                            let display_str = if width > 1 {
                                self.format_multi_bit_value(&value, width)
                            } else {
                                value.clone()
                            };
                            
                            segments.push(RenderSegment {
                                x0,
                                x1,
                                y,
                                value: ValueInfo {
                                    value_type,
                                    display_str,
                                    width,
                                    has_xz,
                                    min_value: Some(value.clone()),
                                    max_value: Some(value.clone()),
                                    is_min_max: false,
                                },
                                signal_name: signal_name.to_string(),
                            });
                            
                            // Update current value
                            current_value = value;
                        }
                    }
                }
                
                segments_in_tile += 1;
            }
            
            // Store last value for cross-tile continuity
            cross_tile_value = Some(current_value.clone());
            
            console_log!("[WASM]   Tile {} complete: {} segments generated, last_value={}", 
                tile_idx, segments_in_tile, current_value);
        }
        
        console_log!("[WASM] generate_lod_segments_from_buckets complete: total {} segments", segments.len());
    }

    /// Classify value for rendering
    fn classify_value(value: &str, width: u32) -> (String, bool) {
        if width == 1 {
            // Handle both "0"/"1" and "0x0"/"0x1" formats
            let normalized = if value.starts_with("0x") || value.starts_with("0X") {
                &value[2..]  // Strip "0x" prefix
            } else {
                value
            };
            match normalized {
                "0" => ("zero".to_string(), false),
                "1" => ("one".to_string(), false),
                "X" | "x" => ("all_x".to_string(), true),
                "Z" | "z" => ("all_z".to_string(), true),
                _ => ("mixed".to_string(), value.to_uppercase().contains('X') || value.to_uppercase().contains('Z')),
            }
        } else {
            let has_xz = value.to_uppercase().contains('X') || value.to_uppercase().contains('Z');
            ("numeric".to_string(), has_xz)
        }
    }

    /// Format multi-bit value for display based on configured format
    /// Supports: hex (0x), bin (0b), oct (0o), dec (no prefix)
    fn format_multi_bit_value(&self, value: &str, width: u32) -> String {
        // If contains X/Z, return as-is (but uppercase)
        if value.to_uppercase().contains('X') || value.to_uppercase().contains('Z') {
            return value.to_uppercase();
        }

        // Detect input format and parse accordingly
        let (num, _input_radix) = if value.starts_with("0b") || value.starts_with("0B") {
            // Binary input
            let clean = value.trim_start_matches("0b").trim_start_matches("0B");
            match u64::from_str_radix(clean, 2) {
                Ok(n) => (n, 2),
                Err(_) => return value.to_uppercase(),
            }
        } else if value.starts_with("0x") || value.starts_with("0X") {
            // Hex input
            let clean = value.trim_start_matches("0x").trim_start_matches("0X");
            match u64::from_str_radix(clean, 16) {
                Ok(n) => (n, 16),
                Err(_) => return value.to_uppercase(),
            }
        } else if value.starts_with("0o") || value.starts_with("0O") {
            // Octal input
            let clean = value.trim_start_matches("0o").trim_start_matches("0O");
            match u64::from_str_radix(clean, 8) {
                Ok(n) => (n, 8),
                Err(_) => return value.to_uppercase(),
            }
        } else {
            // No prefix - try to detect based on content
            // If contains only 0-9, treat as decimal
            // If contains a-f, treat as hex
            // Otherwise try hex first (more common in waveform data)
            let clean = value.trim();
            if clean.chars().all(|c| c.is_ascii_digit()) {
                // All digits - could be decimal or binary
                // If only 0 and 1, and length > 1, likely binary
                if clean.len() > 1 && clean.chars().all(|c| c == '0' || c == '1') {
                    match u64::from_str_radix(clean, 2) {
                        Ok(n) => (n, 2),
                        Err(_) => return value.to_uppercase(),
                    }
                } else {
                    match u64::from_str_radix(clean, 10) {
                        Ok(n) => (n, 10),
                        Err(_) => return value.to_uppercase(),
                    }
                }
            } else {
                // Contains hex digits
                match u64::from_str_radix(clean, 16) {
                    Ok(n) => (n, 16),
                    Err(_) => return value.to_uppercase(),
                }
            }
        };

        // Format based on display_format
        match self.display_format.as_str() {
            "bin" => {
                // Binary: 0b prefix, pad to width bits
                format!("0b{:0width$b}", num, width = width as usize)
            }
            "oct" => {
                // Octal: 0o prefix
                format!("0o{:o}", num)
            }
            "dec" => {
                // Decimal: no prefix
                num.to_string()
            }
            "hex" | "auto" | _ => {
                // Hex: 0x prefix, pad to ceil(width/4) hex digits
                let hex_digits = ((width + 3) / 4).max(1) as usize;
                format!("0x{:0width$X}", num, width = hex_digits)
            }
        }
    }

    /// Get signal names (for testing)
    pub fn get_signal_names(&self) -> JsValue {
        let names: Vec<&str> = self.signals.iter().map(|s| s.name.as_str()).collect();
        serde_wasm_bindgen::to_value(&names).unwrap_or(JsValue::NULL)
    }

    /// Find transitions around a specific time for cursor snapping
    /// Returns [prev_time, next_time] where null means no transition found
    /// Note: BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) is excluded from results
    pub fn find_transitions_around(&self, signal_name: &str, time: f64) -> JsValue {
        console_log!("[WASM] find_transitions_around: signal='{}', time={}", signal_name, time);

        if let Some(data) = self.signal_data.get(signal_name) {
            // Check if we have bucket_data (new LoD 1+ format)
            if !data.bucket_data.is_empty() {
                return self.find_transitions_around_from_buckets(data, time);
            }
            
            // Fall back to transitions (LoD 0 or old format)
            console_log!("[WASM]   Found signal data, transitions count: {}", data.transitions.len());

            let mut prev: Option<u64> = None;
            let mut next: Option<u64> = None;

            for transition in &data.transitions {
                // Skip boundary value - it's not a real transition
                if transition.time == BOUNDARY_TIME_START {
                    continue;
                }

                let t = transition.time as f64;
                if t < time {
                    prev = Some(transition.time);
                } else if t > time && next.is_none() {
                    next = Some(transition.time);
                    break; // Found next, no need to continue
                }
            }

            console_log!("[WASM]   Result: prev={:?}, next={:?}", prev, next);

            let result = vec![prev, next];
            serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
        } else {
            console_log!("[WASM]   Signal data not found in cache!");
            JsValue::NULL
        }
    }
    
    /// Find transitions around time from bucket_data (LoD 1+ format)
    fn find_transitions_around_from_buckets(&self, data: &SignalWaveData, time: f64) -> JsValue {
        let lod = self.current_lod.unwrap_or(25);
        let bucket_size = 1u64 << lod;
        let time_u64 = time as u64;
        
        console_log!("[WASM]   Using bucket_data, lod={}, bucket_size={}", lod, bucket_size);
        
        // Sort bucket_data by tile_start
        let mut sorted_bucket_data: Vec<(u64, &HashMap<u32, BucketData>)> = data.bucket_data
            .iter()
            .map(|(start, buckets)| (*start, buckets))
            .collect();
        sorted_bucket_data.sort_by_key(|(start, _)| *start);
        
        let mut all_transition_times: Vec<u64> = Vec::new();
        
        // Collect all transition times from all buckets
        for (tile_start, buckets) in &sorted_bucket_data {
            let tile_span = OpfsCacheManager::get_tile_span(lod);
            
            for bucket_idx in 0..256u32 {
                if let Some(bucket) = buckets.get(&bucket_idx) {
                    // Calculate absolute time for this bucket
                    let bucket_time = *tile_start + (bucket_idx as u64) * bucket_size;
                    
                    // Add first transition time
                    all_transition_times.push(bucket_time);
                    
                    // If toggle bucket, also add the toggle point (approximate as bucket end)
                    if bucket.has_toggle() {
                        let bucket_end_time = bucket_time + bucket_size - 1;
                        all_transition_times.push(bucket_end_time);
                    }
                }
            }
        }
        
        // Sort and deduplicate
        all_transition_times.sort();
        all_transition_times.dedup();
        
        console_log!("[WASM]   Total transition times: {}", all_transition_times.len());
        
        // Find prev and next
        let mut prev: Option<u64> = None;
        let mut next: Option<u64> = None;
        
        for t in &all_transition_times {
            let t_f64 = *t as f64;
            if t_f64 < time {
                prev = Some(*t);
            } else if t_f64 > time && next.is_none() {
                next = Some(*t);
                break;
            }
        }
        
        console_log!("[WASM]   Result from buckets: prev={:?}, next={:?}", prev, next);
        
        let result = vec![prev, next];
        serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
    }

    /// Get signal value at a specific time
    /// Returns the value of the signal at the given time (from cached data)
    /// If data is not cached, returns null
    /// Handles BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) as the start-of-range value
    pub fn get_signal_value_at_time(&self, signal_name: &str, time: f64) -> JsValue {
        // Check if this is a bit extraction signal
        if let Some((parent_name, (msb, lsb))) = Self::parse_bit_extract(signal_name) {
            console_log!("[WASM] get_signal_value_at_time: bit extraction '{}' -> parent '{}' [{}:{}]", 
                signal_name, parent_name, msb, lsb);
            
            // Get parent signal data
            if let Some(parent_data) = self.signal_data.get(&parent_name) {
                let time_u64 = time as u64;
                
                // Check if we have bucket_data (new LoD 1+ format)
                if !parent_data.bucket_data.is_empty() {
                    return self.get_bucket_value_at_time(parent_data, time_u64, 
                        (msb - lsb + 1) as u32, Some((msb, lsb)));
                }
                
                // Check if this is LoD > 0 data (min/max format)
                let is_lod_min_max = self.detect_min_max_format(&parent_data.transitions);
                
                if is_lod_min_max {
                    // Handle LoD > 0 min/max format
                    return self.get_min_max_value_at_time(&parent_data.transitions, time_u64, 
                        (msb - lsb + 1) as u32, Some((msb, lsb)));
                }
                
                // Find the transition that covers this time
                let mut current_value = None;
                let mut boundary_value = None;
                
                for transition in &parent_data.transitions {
                    if transition.time == BOUNDARY_TIME_START {
                        boundary_value = Some(&transition.value);
                    } else if transition.time <= time_u64 {
                        current_value = Some(&transition.value);
                    } else {
                        break;
                    }
                }
                
                if let Some(value_str) = current_value.or(boundary_value) {
                    // Parse and extract bits
                    let value_u64 = if value_str.starts_with("0x") || value_str.starts_with("0X") {
                        u64::from_str_radix(value_str.trim_start_matches("0x").trim_start_matches("0X"), 16).unwrap_or(0)
                    } else {
                        value_str.parse::<u64>().unwrap_or(0)
                    };
                    
                    let bit_count = msb - lsb + 1;
                    let mask = if bit_count >= 64 {
                        u64::MAX
                    } else {
                        ((1u64 << bit_count) - 1) << lsb
                    };
                    let extracted_value = (value_u64 & mask) >> lsb;
                    
                    let display_str = if bit_count == 1 {
                        format!("{}", extracted_value)
                    } else {
                        format!("0x{:X}", extracted_value)
                    };
                    
                    let (value_type, has_xz) = Self::classify_value(&display_str, bit_count as u32);
                    
                    let value_info = ValueInfo {
                        value_type,
                        display_str,
                        width: bit_count as u32,
                        has_xz,
                        min_value: None,
                        max_value: None,
                        is_min_max: false,
                    };
                    return serde_wasm_bindgen::to_value(&value_info).unwrap_or(JsValue::NULL);
                }
            }
            return JsValue::NULL;
        }
        
        // Normal signal lookup
        if let Some(data) = self.signal_data.get(signal_name) {
            let time_u64 = time as u64;

            // Check if we have bucket_data (new LoD 1+ format)
            if !data.bucket_data.is_empty() {
                return self.get_bucket_value_at_time(data, time_u64, data.width, None);
            }

            // Check if this is LoD > 0 data (min/max format)
            let is_lod_min_max = self.detect_min_max_format(&data.transitions);
            
            if is_lod_min_max {
                // Handle LoD > 0 min/max format
                return self.get_min_max_value_at_time(&data.transitions, time_u64, data.width, None);
            }

            // Find the transition that covers this time
            // The value is valid from transition.time until the next transition
            let mut current_value = None;
            let mut boundary_value = None; // Store boundary value separately

            for transition in &data.transitions {
                if transition.time == BOUNDARY_TIME_START {
                    // Boundary value represents the value at range start
                    boundary_value = Some(&transition.value);
                } else if transition.time <= time_u64 {
                    current_value = Some(&transition.value);
                } else {
                    break; // transition.time > time_u64, stop searching
                }
            }

            // Use boundary value if no normal transition found before this time
            let value_to_return = current_value.or(boundary_value);

            // Return the value info
            if let Some(value_str) = value_to_return {
                let (value_type, has_xz) = Self::classify_value(value_str, data.width);

                // Format display string with prefix for multi-bit values
                let display_str = if data.width > 1 {
                    self.format_multi_bit_value(value_str, data.width)
                } else {
                    value_str.clone()
                };

                let value_info = ValueInfo {
                    value_type,
                    display_str,
                    width: data.width,
                    has_xz,
                    min_value: None,
                    max_value: None,
                    is_min_max: false,
                };
                serde_wasm_bindgen::to_value(&value_info).unwrap_or(JsValue::NULL)
            } else {
                // No transition found before this time (and no boundary value)
                JsValue::NULL
            }
        } else {
            // Signal data not cached
            console_log!("[WASM] get_signal_value_at_time: No cached data for signal '{}'", signal_name);
            JsValue::NULL
        }
    }

    /// Get value at time from bucket_data (new LoD 1+ format)
    fn get_bucket_value_at_time(
        &self,
        data: &SignalWaveData,
        time_u64: u64,
        width: u32,
        bit_extract: Option<(u32, u32)>,
    ) -> JsValue {
        let lod = self.current_lod.unwrap_or(25);
        let bucket_size = 1u64 << lod;
        
        // Sort bucket_data by tile_start to ensure correct order
        let mut sorted_bucket_data: Vec<(u64, &HashMap<u32, BucketData>)> = data.bucket_data
            .iter()
            .map(|(start, buckets)| (*start, buckets))
            .collect();
        sorted_bucket_data.sort_by_key(|(start, _)| *start);
        
        // Find which tile contains this time
        for (tile_idx, (tile_start, buckets)) in sorted_bucket_data.iter().enumerate() {
            let tile_end = tile_start + OpfsCacheManager::get_tile_span(lod);
            
            if time_u64 >= *tile_start && time_u64 < tile_end {
                // Calculate bucket index within this tile
                let offset_in_tile = (time_u64 - *tile_start) / bucket_size;
                let bucket_idx = offset_in_tile as u32;
                
                // Try to find the bucket at this index
                let value_to_return = if let Some(bucket) = buckets.get(&bucket_idx) {
                    // Found bucket at exact index
                    // For toggle bucket, use last value; for single transition, use first value
                    if bucket.has_toggle() {
                        bucket.last.as_ref().unwrap().value.clone()
                    } else {
                        bucket.first.value.clone()
                    }
                } else {
                    // Empty bucket - need to find previous non-empty bucket
                    // Search backwards from bucket_idx-1 to 0
                    let mut found_value: Option<String> = None;
                    for prev_idx in (0..bucket_idx).rev() {
                        if let Some(prev_bucket) = buckets.get(&prev_idx) {
                            found_value = Some(if prev_bucket.has_toggle() {
                                prev_bucket.last.as_ref().unwrap().value.clone()
                            } else {
                                prev_bucket.first.value.clone()
                            });
                            break;
                        }
                    }
                    
                    // If not found in current tile, use previous tile's last value
                    // or tile's start value
                    found_value.unwrap_or_else(|| {
                        if tile_idx > 0 {
                            // Use previous tile's last bucket value
                            let (prev_tile_start, prev_buckets) = sorted_bucket_data[tile_idx - 1];
                            let mut last_value = "0".to_string();
                            for idx in 0..256u32 {
                                if let Some(bucket) = prev_buckets.get(&idx) {
                                    last_value = if bucket.has_toggle() {
                                        bucket.last.as_ref().unwrap().value.clone()
                                    } else {
                                        bucket.first.value.clone()
                                    };
                                }
                            }
                            last_value
                        } else {
                            // First tile - use start value from tile_info
                            data.tile_info.iter()
                                .find(|(start, _, _, _)| start == tile_start)
                                .map(|(_, _, _, value)| value.clone())
                                .unwrap_or_else(|| "0".to_string())
                        }
                    })
                };
                
                // Apply bit extraction if needed
                let final_value = if let Some((msb, lsb)) = bit_extract {
                    let value_u64 = Self::parse_value_to_u64(&value_to_return);
                    
                    let bit_count = msb - lsb + 1;
                    let mask = if bit_count >= 64 {
                        u64::MAX
                    } else {
                        ((1u64 << bit_count) - 1) << lsb
                    };
                    
                    let extracted_value = (value_u64 & mask) >> lsb;
                    
                    if bit_count == 1 {
                        format!("{}", extracted_value)
                    } else {
                        format!("0x{:X}", extracted_value)
                    }
                } else {
                    value_to_return
                };
                
                let (value_type, has_xz) = Self::classify_value(&final_value, width);
                
                let value_info = ValueInfo {
                    value_type,
                    display_str: final_value.clone(),
                    width,
                    has_xz,
                    min_value: Some(final_value.clone()),
                    max_value: Some(final_value),
                    is_min_max: false,
                };
                return serde_wasm_bindgen::to_value(&value_info).unwrap_or(JsValue::NULL);
            }
        }
        
        JsValue::NULL
    }

    /// Parse value string to u64
    fn parse_value_to_u64(value: &str) -> u64 {
        if value.starts_with("0x") || value.starts_with("0X") {
            u64::from_str_radix(value.trim_start_matches("0x").trim_start_matches("0X"), 16).unwrap_or(0)
        } else {
            value.parse::<u64>().unwrap_or(0)
        }
    }

    /// Get value at time for LoD > 0 min/max format
    fn get_min_max_value_at_time(
        &self,
        transitions: &[Transition],
        time_u64: u64,
        width: u32,
        bit_extract: Option<(u32, u32)>,
    ) -> JsValue {
        // Filter out boundary values
        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .collect();

        // Group transitions by timestamp and find the bucket containing time_u64
        let mut i = 0;
        while i < normal_transitions.len() {
            let time = normal_transitions[i].time;
            let mut values = vec![&normal_transitions[i].value];

            // Collect all values with the same timestamp
            let mut j = i + 1;
            while j < normal_transitions.len() && normal_transitions[j].time == time {
                values.push(&normal_transitions[j].value);
                j += 1;
            }

            // Determine next time (end of this bucket)
            let next_time = if j < normal_transitions.len() {
                normal_transitions[j].time
            } else {
                u64::MAX
            };

            // Check if time_u64 falls within this bucket
            if time_u64 >= time && time_u64 < next_time {
                // Extract min and max values
                let (min_val, max_val) = if values.len() >= 2 {
                    (values[0].clone(), values[1].clone())
                } else {
                    (values[0].clone(), values[0].clone())
                };

                // Apply bit extraction if needed
                let (final_min, final_max) = if let Some((msb, lsb)) = bit_extract {
                    let extract_bits = |val: &str| -> String {
                        let value_u64 = if val.starts_with("0x") || val.starts_with("0X") {
                            u64::from_str_radix(val.trim_start_matches("0x").trim_start_matches("0X"), 16).unwrap_or(0)
                        } else {
                            val.parse::<u64>().unwrap_or(0)
                        };
                        
                        let bit_count = msb - lsb + 1;
                        let mask = if bit_count >= 64 {
                            u64::MAX
                        } else {
                            ((1u64 << bit_count) - 1) << lsb
                        };
                        let extracted = (value_u64 & mask) >> lsb;
                        
                        if bit_count == 1 {
                            format!("{}", extracted)
                        } else {
                            format!("0x{:X}", extracted)
                        }
                    };
                    
                    (extract_bits(&min_val), extract_bits(&max_val))
                } else {
                    (min_val.clone(), max_val.clone())
                };

                // Check if min != max and neither is X/Z
                let min_upper = final_min.to_uppercase();
                let max_upper = final_max.to_uppercase();
                let has_xz = min_upper.contains('X') || min_upper.contains('Z') ||
                            max_upper.contains('X') || max_upper.contains('Z');
                let is_changing = final_min != final_max && !has_xz;

                let (value_type, display_str) = if is_changing {
                    if width == 1 {
                        // Single bit: show toggling
                        ("min_max".to_string(), "toggling".to_string())
                    } else {
                        // Multi-bit: show range
                        ("min_max".to_string(), format!("{}..{}", final_min, final_max))
                    }
                } else {
                    // min == max or has X/Z, treat as normal value
                    let (vt, _) = Self::classify_value(&final_min, width);
                    (vt, final_min.clone())
                };

                let value_info = ValueInfo {
                    value_type,
                    display_str,
                    width,
                    has_xz,
                    min_value: Some(final_min),
                    max_value: Some(final_max),
                    is_min_max: is_changing,
                };
                return serde_wasm_bindgen::to_value(&value_info).unwrap_or(JsValue::NULL);
            }

            i = j;
        }

        JsValue::NULL
    }

    /// Test signal name conversion (for debugging)
    pub fn test_name_conversion(&self, local_name: &str) -> String {
        let server_name = self.local_to_server_name(local_name);
        let encoded = general_purpose::STANDARD.encode(&server_name);
        format!("Local: '{}' -> Server: '{}' -> Base64: '{}'", local_name, server_name, encoded)
    }
}
