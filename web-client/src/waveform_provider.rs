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
    pub time: u64,
    pub value: String,
}

/// Signal waveform data
#[derive(Debug, Clone)]
pub struct SignalWaveData {
    pub name: String,
    pub width: u32,
    pub transitions: Vec<Transition>,
}

/// LoD (Level of Detail) configuration
/// Bucket size = 16^lod (number of transitions merged into one)
const LOD_TABLE: [(u32, u64); 8] = [
    (0, 1),           // LOD0: bucket size 1 (原始数据)
    (1, 16),          // LOD1: bucket size 16 (16:1 压缩)
    (2, 256),         // LOD2: bucket size 256 (256:1 压缩)
    (3, 4_096),       // LOD3: bucket size 4096
    (4, 65_536),      // LOD4: bucket size 65536
    (5, 1_048_576),   // LOD5: bucket size ~1M
    (6, 16_777_216),  // LOD6: bucket size ~16M
    (7, 268_435_456), // LOD7: bucket size ~268M
];

/// Special timestamp for boundary value (start of time range)
/// When no transitions exist in the requested range, server returns this boundary value
const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;

/// Calculate appropriate LoD based on viewport and canvas width
/// Goal: 1-2 transitions per pixel (avoid over-sampling)
/// 
/// Algorithm:
/// 1. Estimate total transitions at LoD 0 (based on time_span and assumed density)
/// 2. Target: canvas_width * 2 transitions (1-2 per pixel)
/// 3. Select LoD where bucket_size reduces transitions to target range
fn select_lod(viewport: &Viewport, canvas_width: f64) -> u32 {
    if canvas_width <= 0.0 {
        return 0;
    }
    
    let time_span = viewport.time_end - viewport.time_start;
    
    // Estimate transition density: from test data, ~1 transition per 500k time units
    // This is a heuristic - actual density varies by signal
    const ESTIMATED_TRANSITION_DENSITY: f64 = 1.0 / 500_000.0;
    
    // Estimate total transitions at LoD 0
    let estimated_transitions = time_span * ESTIMATED_TRANSITION_DENSITY;
    
    // Target: 1-2 transitions per pixel
    let target_transitions = canvas_width * 2.0;
    
    // Calculate required compression ratio
    let required_compression = estimated_transitions / target_transitions;
    
    console_log!("[WASM] LoD selection: time_span={}, est_transitions={:.0}, target={:.0}, required_compression={:.1}", 
        time_span, estimated_transitions, target_transitions, required_compression);
    
    // Find the LoD with bucket_size >= required_compression
    // This ensures we don't over-sample (too many transitions per pixel)
    for (lod, bucket_size) in LOD_TABLE.iter() {
        if (*bucket_size as f64) >= required_compression {
            console_log!("[WASM] Selected LoD {} (bucket_size: {}, est_transitions_at_lod: {:.0})", 
                lod, bucket_size, estimated_transitions / (*bucket_size as f64));
            return *lod;
        }
    }
    
    // If none found, use max LoD
    let max_lod = LOD_TABLE.last().unwrap().0;
    console_log!("[WASM] Selected max LoD {}", max_lod);
    max_lod
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
        console_log!("[WASM] WaveformDataProvider created: waveform={}, prefix='{}', space={}, time_stamp={}",
            waveform_name, signal_prefix, space_before_bracket, time_stamp);

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
        console_log!("[WASM] init_with_opfs: enabled={}", enable_opfs);
    }

    /// Set signals with draw_sig_id (new API)
    /// 
    /// # Arguments
    /// * `signals_js` - Array of { global_id, name, row, width, draw_sig_id }
    #[wasm_bindgen]
    pub fn set_draw_list(&mut self, signals_js: JsValue) -> Result<(), JsValue> {
        let signals: Vec<SignalWithId> = serde_wasm_bindgen::from_value(signals_js)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse signals: {}", e)))?;

        console_log!("[WASM] Set draw list: {} signals", signals.len());
        for (i, s) in signals.iter().enumerate() {
            console_log!("[WASM]   Signal[{}]: global_id={}, name='{}', draw_sig_id={}", 
                i, s.global_id, s.name, s.draw_sig_id);
        }

        self.signals_with_id = signals;
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

        console_log!("[WASM] prepare_data: {} signals, LoD={}, time={}-{}",
            self.signals_with_id.len(), lod, time_start, time_end);

        // Calculate required blocks
        let blocks = crate::opfs_cache::compute_required_blocks(
            &self.signals_with_id,
            time_start,
            time_end,
            lod
        );

        console_log!("[WASM] Required blocks: {}", blocks.len());
        console_log!("[WASM] OPFS Cache enabled: {}", self.opfs_cache.enabled);

        // Check each block in cache
        let mut missing_blocks: Vec<MissingBlock> = Vec::new();
        let mut memory_hits = 0u32;
        let mut opfs_hits = 0u32;

        for (idx, block) in blocks.iter().enumerate() {
            console_log!("[WASM] Checking block {}/{}: lod={}, tile={}, group={}", 
                idx + 1, blocks.len(), block.lod, block.tile, block.group);
            
            match self.opfs_cache.read(block).await? {
                Some(data) => {
                    // Data found in cache
                    console_log!("[WASM]   Block FOUND in cache, data size={} bytes", data.len());
                    if self.opfs_cache.enabled {
                        opfs_hits += 1;
                    } else {
                        memory_hits += 1;
                    }
                }
                None => {
                    // Data not found, add to missing list
                    console_log!("[WASM]   Block NOT FOUND in cache, adding to missing list");
                    let draw_sig_ids: Vec<u32> = self.signals_with_id.iter()
                        .filter(|s| OpfsCacheManager::get_group_id(s.draw_sig_id) == block.group)
                        .map(|s| s.draw_sig_id)
                        .collect();

                    console_log!("[WASM]   Missing block affects {} signals: {:?}", 
                        draw_sig_ids.len(), draw_sig_ids);

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
        console_log!("[WASM] Cache check complete: memory_hits={}, opfs_hits={}, misses={}",
            memory_hits, opfs_hits, misses);
        
        if !missing_blocks.is_empty() {
            console_log!("[WASM] Missing blocks summary:");
            for (idx, block) in missing_blocks.iter().enumerate() {
                console_log!("[WASM]   Missing[{}]: lod={}, tile={}, group={}, signals={}",
                    idx, block.lod, block.tile, block.group, block.draw_sig_ids.len());
            }
        }

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
            console_log!("[WASM] Error: Data too small for chunk header ({} < {})", bytes.len(), ChunkHeader::SIZE);
            return Err(JsValue::from_str(&format!("Data too small: {} bytes", bytes.len())));
        }

        // Parse chunk and store in cache
        self.process_server_chunk(&bytes).await?;

        Ok(())
    }

    /// Process server chunk data and store in cache
    async fn process_server_chunk(&mut self, data: &[u8]) -> Result<(), JsValue> {
        // Parse chunk header
        let header = ChunkHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;

        console_log!("[WASM] Processing server chunk: level={}, signals={}, time={}-{}",
            header.level, header.signal_count, header.time_start, header.time_end);

        // Calculate tile information
        let lod = header.level as u32;
        let tile_span = OpfsCacheManager::get_tile_span(lod);
        let tile_id = header.time_start / tile_span;
        
        console_log!("[WASM]   Calculated tile: lod={}, tile_span={}, tile_id={}",
            lod, tile_span, tile_id);

        // Group signals by their group_id
        let mut signals_by_group: std::collections::HashMap<u32, Vec<crate::opfs_cache::SignalData>> = 
            std::collections::HashMap::new();

        // Parse each signal block
        let mut offset = ChunkHeader::SIZE;
        
        for signal_idx in 0..header.signal_count {
            if offset + SignalBlockHeader::SIZE > data.len() {
                console_log!("[WASM] Warning: Not enough data for signal block {}", signal_idx);
                break;
            }

            // Parse signal block header
            let block_header = SignalBlockHeader::from_bytes(&data[offset..])
                .map_err(|e| JsValue::from_str(&e))?;

            console_log!("[WASM]   Processing signal block {}: handle={}, transitions={}",
                signal_idx, block_header.signal_handle, block_header.transition_count);

            // Parse transitions for this signal
            let transitions = self.parse_transitions_for_cache(
                data,
                &block_header,
                signal_idx as usize
            )?;

            // Get draw_sig_id from signal index (for now, use signal_idx as draw_sig_id)
            // In real implementation, we need to map signal handle to draw_sig_id
            let draw_sig_id = signal_idx as u32;
            let group_id = OpfsCacheManager::get_group_id(draw_sig_id);
            
            console_log!("[WASM]     Signal {}: draw_sig_id={} -> group_id={}",
                signal_idx, draw_sig_id, group_id);

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

        // Write each group to cache
        let group_count = signals_by_group.len();
        console_log!("[WASM]   Grouping complete: {} groups", group_count);
        
        for (group_id, signals) in &signals_by_group {
            let block = crate::opfs_cache::DataBlock {
                lod,
                tile: tile_id,
                group: *group_id,
            };

            console_log!("[WASM]   Writing group {} to cache: {} signals", 
                group_id, signals.len());
            console_log!("[WASM]     Block: lod={}, tile={}, group={}", 
                lod, tile_id, group_id);

            let group_data = crate::opfs_cache::GroupData { signals: signals.clone() };
            let bin_data = crate::opfs_cache::serialize_group_data(&group_data);

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
    /// 1. Check cache using prepare_data
    /// 2. Fetch only missing tiles from server
    /// 3. Store fetched data in cache using supplement_data
    pub async fn fetch_signals_data_batch(&mut self, signal_names: Vec<String>) -> Result<(), JsValue> {
        const MAX_BATCH_SIZE: usize = 256;
        
        let total_signals = signal_names.len();
        
        // Calculate appropriate LoD based on current viewport and canvas
        let lod = select_lod(&self.viewport, self.canvas_width);

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
        let mut tiles_to_fetch: Vec<u64> = Vec::new();
        for tile_id in start_tile..=end_tile {
            tiles_to_fetch.push(tile_id);
        }
        console_log!("[WASM]   Total tiles to check: {}", tiles_to_fetch.len());

        // Step 2: Check cache and find missing tiles
        console_log!("[WASM] Step 2: Checking OPFS cache...");
        let mut missing_tiles: Vec<u64> = Vec::new();
        let mut cache_hits = 0u32;
        
        for tile_id in &tiles_to_fetch {
            // Check if any group in this tile is missing from cache
            // For simplicity, we check group 0 (all signals in group 0 for now)
            let block = crate::opfs_cache::DataBlock {
                lod,
                tile: *tile_id,
                group: 0, // TODO: Check all groups
            };
            
            match self.opfs_cache.read(&block).await {
                Ok(Some(_)) => {
                    console_log!("[WASM]   Tile {}: FOUND in cache", tile_id);
                    cache_hits += 1;
                }
                Ok(None) => {
                    console_log!("[WASM]   Tile {}: NOT FOUND in cache", tile_id);
                    missing_tiles.push(*tile_id);
                }
                Err(e) => {
                    console_log!("[WASM]   Tile {}: ERROR reading cache - {:?}", tile_id, e);
                    missing_tiles.push(*tile_id);
                }
            }
        }
        
        console_log!("[WASM]   Cache hits: {}, Missing tiles: {}", cache_hits, missing_tiles.len());
        
        if missing_tiles.is_empty() {
            console_log!("[WASM] All tiles found in cache, no server fetch needed!");
            return Ok(());
        }
        
        // Show which tiles are missing
        let missing_tiles_str: Vec<String> = missing_tiles.iter().map(|t| t.to_string()).collect();
        console_log!("[WASM] Missing tiles: [{}]", missing_tiles_str.join(", "));
        
        console_log!("[WASM] Step 3: Fetching {} missing tiles from server", missing_tiles.len());
        
        // Step 3: Fetch missing tiles from server
        for (tile_idx, tile_id) in missing_tiles.iter().enumerate() {
            let tile_time_start = *tile_id * tile_span;
            let tile_time_end = ((*tile_id + 1) * tile_span).min(time_end);
            
            console_log!("[WASM] Fetching tile {}/{}: tile_id={}, time={}-{} (span={})",
                tile_idx + 1, missing_tiles.len(), tile_id, tile_time_start, tile_time_end, tile_span);
            
            // Use all signals for this tile (not filtered by group for now)
            let tile_signal_names = signals_to_fetch.clone();
            console_log!("[WASM]   Tile {} needs {} signals", tile_id, tile_signal_names.len());
            
            // Fetch this tile's data from server
            for (batch_idx, batch) in tile_signal_names.chunks(MAX_BATCH_SIZE).enumerate() {
                let batch_size = batch.len();
                console_log!("[WASM]   Processing batch {}: {} signals", batch_idx + 1, batch_size);

                // Convert all signal names to server names
                let server_names: Vec<String> = batch.iter()
                    .map(|local_name| self.build_server_signal_name(local_name))
                    .collect();

                // Join server names with comma, then base64 encode
                let names_batch = server_names.join(",");
                let encoded_batch = general_purpose::STANDARD.encode(&names_batch);

                // Build URL for this tile's time range
                let url = format!("{}/api/wave/{}/lod/{}/time/{}/{}/compress/none/signals/b64:{}/data?time_stamp={}",
                    self.server_url,
                    self.waveform_name,
                    lod,
                    tile_time_start,
                    tile_time_end,
                    encoded_batch,
                    self.time_stamp);

                console_log!("[WASM]   Tile {} Batch {} URL: {}", 
                    tile_id, batch_idx + 1, url);
                
                // Fetch batch data
                let window = web_sys::window().ok_or(JsValue::from_str("No window"))?;
                let resp_value: JsValue = wasm_bindgen_futures::JsFuture::from(
                    window.fetch_with_str(&url)
                ).await?;
                
                let resp: web_sys::Response = resp_value.dyn_into()
                    .map_err(|_| JsValue::from_str("Invalid response"))?;
                
                let status = resp.status();
                let content_type = resp.headers().get("content-type").ok().flatten().unwrap_or_else(|| "unknown".to_string());
                console_log!("[WASM]   Response status: {}, content-type: {}", status, content_type);
                
                if !resp.ok() {
                    return Err(JsValue::from_str(&format!("HTTP error: {}", status)));
                }
                
                // Get array buffer
                let data_result = wasm_bindgen_futures::JsFuture::from(
                    resp.array_buffer()?
                ).await;
                
                let data: JsValue = match data_result {
                    Ok(d) => d,
                    Err(e) => {
                        console_log!("[WASM]   Error getting array buffer: {:?}", e);
                        return Err(JsValue::from_str("Failed to get array buffer"));
                    }
                };
                
                let array_buffer: js_sys::ArrayBuffer = match data.dyn_into() {
                    Ok(ab) => ab,
                    Err(_) => {
                        console_log!("[WASM]   Error: Response is not an ArrayBuffer");
                        return Err(JsValue::from_str("Invalid array buffer"));
                    }
                };
                
                let uint8_array = js_sys::Uint8Array::new(&array_buffer);
                let mut bytes = vec![0u8; uint8_array.length() as usize];
                uint8_array.copy_to(&mut bytes);
                
                console_log!("[WASM]   Tile {} Batch {} received {} bytes", 
                    tile_id, batch_idx + 1, bytes.len());
                
                // Debug: Show first 64 bytes of received data
                let preview_len = bytes.len().min(64);
                let preview: Vec<String> = bytes[..preview_len].iter()
                    .map(|b| format!("{:02X}", b))
                    .collect();
                console_log!("[WASM]   Data preview (first {} bytes): {}", 
                    preview_len, preview.join(" "));
                
                // Step 3: Store fetched data in cache and parse for rendering
                console_log!("[WASM]   Step 3: Storing data in OPFS cache and parsing for rendering...");
                
                // First, parse chunk data and store in signal_data for rendering
                console_log!("[WASM]   Parsing chunk data for {} signals...", tile_signal_names.len());
                self.parse_chunk_data_for_batch(&tile_signal_names, &bytes)?;
                console_log!("[WASM]   Chunk data parsed and stored in signal_data");
                
                // Then, store in OPFS cache for future use
                // Create ArrayBuffer from bytes and pass to supplement_data
                let array_buffer = js_sys::ArrayBuffer::new(bytes.len() as u32);
                let uint8_array = js_sys::Uint8Array::new(&array_buffer);
                uint8_array.copy_from(&bytes[..]);
                self.supplement_data(array_buffer.into()).await?;
                console_log!("[WASM]   Data stored in cache successfully");
            }
        }
        
        console_log!("[WASM] Finished fetching {} tiles", missing_tiles.len());
        
        Ok(())
    }

    /// Parse chunk data for a batch of signals
    /// The batch order must match the order in the chunk
    fn parse_chunk_data_for_batch(&mut self, batch: &[String], data: &[u8]) -> Result<(), JsValue> {
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

            console_log!("[WASM] Signal block {}: handle={}, transitions={}",
                signal_idx, block_header.signal_handle, block_header.transition_count);
            console_log!("[WASM]   time_array_offset={}, value_array_offset={}",
                block_header.time_array_offset, block_header.value_array_offset);

            // Get signal name from batch (same order as server)
            let signal_name = &batch[signal_idx as usize];

            // Debug: print first 32 bytes of data area
            let data_area_start = ChunkHeader::SIZE + (header.signal_count as usize * SignalBlockHeader::SIZE);
            if data.len() > data_area_start {
                let debug_len = std::cmp::min(32, data.len() - data_area_start);
                let debug_bytes: Vec<String> = data[data_area_start..data_area_start + debug_len]
                    .iter()
                    .map(|b| format!("{:02X}", b))
                    .collect();
                console_log!("[WASM]   Data area (first {} bytes): {}", debug_len, debug_bytes.join(" "));
            } else {
                console_log!("[WASM]   Warning: No data area (data_len={} <= data_area_start={})", data.len(), data_area_start);
            }

            // Parse transitions for this signal
            let transitions = self.parse_transitions_from_block(
                data,
                &block_header,
                &header,
                signal_idx as usize
            )?;

            // Get width from signal info
            let width = self.get_signal_width(signal_name);

            // Store signal data - merge with existing data if present
            if let Some(existing_data) = self.signal_data.get_mut(signal_name) {
                // Append new transitions to existing ones
                console_log!("[WASM]   Merging transitions: existing={}, new={}", 
                    existing_data.transitions.len(), transitions.len());
                existing_data.transitions.extend(transitions);
                console_log!("[WASM]   Total transitions after merge: {}", existing_data.transitions.len());
            } else {
                // Insert new signal data
                self.signal_data.insert(signal_name.clone(), SignalWaveData {
                    name: signal_name.clone(),
                    width,
                    transitions,
                });
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
            self.signal_data.insert(signal_name.clone(), SignalWaveData {
                name: signal_name,
                width,
                transitions,
            });

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

        self.signal_data.insert(signal_name.to_string(), SignalWaveData {
            name: signal_name.to_string(),
            width,
            transitions,
        });

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

        console_log!("[WASM] Parsed {} transitions at LoD {}", transitions.len(), chunk_header.level);
        Ok(transitions)
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

        console_log!("[WASM] get_segments: {} signals, viewport={}-{}, canvas={}x{}",
            self.signals.len(), self.viewport.time_start, self.viewport.time_end,
            self.canvas_width, self.canvas_height);
        console_log!("[WASM] signal_data cache: {} signals", self.signal_data.len());

        for signal in self.signals.iter() {
            // Use signal.row provided by UI (accounts for group headers)
            let y = 20.0 + signal.row as f64 * self.row_height + self.row_height / 2.0;

            console_log!("[WASM] Processing signal[row={}]: name='{}', y={}", signal.row, signal.name, y);

            // Check if this is a bit extraction signal
            if let Some((ref parent_name, (msb, lsb))) = signal.bit_extract {
                console_log!("[WASM]   Bit extraction: extract [{}:{}] from parent '{}'", msb, lsb, parent_name);
                
                // Get parent signal data
                if let Some(parent_data) = self.signal_data.get(parent_name) {
                    // Extract bits from parent signal
                    let extracted_transitions = self.extract_bits_from_transitions(
                        &parent_data.transitions, parent_data.width, msb, lsb);
                    
                    let width = if msb == lsb { 1 } else { msb - lsb + 1 };
                    console_log!("[WASM]   Extracted {} transitions, width={}", extracted_transitions.len(), width);
                    
                    // Generate segments from extracted data
                    let is_lod_min_max = self.detect_min_max_format(&extracted_transitions);
                    if is_lod_min_max {
                        self.generate_min_max_segments(&extracted_transitions, width, y, &signal.name,
                            time_range, &mut segments);
                    } else {
                        self.generate_normal_segments(&extracted_transitions, width, y, &signal.name,
                            time_range, &mut segments);
                    }
                } else {
                    console_log!("[WASM]   No parent data found for '{}'", parent_name);
                }
                continue;
            }

            if let Some(data) = self.signal_data.get(&signal.name) {
                let total_transitions = data.transitions.len();
                console_log!("[WASM]   Total transitions: {}", total_transitions);

                // Check if this is LoD 1+ data (min/max format)
                // LoD 1+ has transitions with same timestamp in pairs (min, max)
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

                console_log!("[WASM]   Generated {} segments for signal '{}'", 
                    segments.len(), signal.name);
            } else {
                console_log!("[WASM]   No data found for signal '{}'", signal.name);
            }
        }

        console_log!("[WASM] Total segments generated: {}", segments.len());

        serde_wasm_bindgen::to_value(&segments)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    /// Detect if transitions are in min/max format (LoD 1+)
    /// Returns true if consecutive transitions have the same timestamp
    fn detect_min_max_format(&self, transitions: &[Transition]) -> bool {
        if transitions.len() < 2 {
            return false;
        }
        // Check first few transitions for same timestamp pattern
        for i in 0..transitions.len().min(4).saturating_sub(1) {
            if transitions[i].time == transitions[i + 1].time {
                return true;
            }
        }
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

    /// Generate segments for LoD 0 (normal format)
    /// Handles boundary value (0xFFFFFFFFFFFFFFFF) for start-of-range value
    fn generate_normal_segments(&self, transitions: &[Transition], width: u32, y: f64,
        signal_name: &str, time_range: f64, segments: &mut Vec<RenderSegment>) {

        // Check for boundary value (special timestamp indicating start-of-range value)
        let boundary_value = transitions.iter()
            .find(|t| t.time == BOUNDARY_TIME_START)
            .map(|t| t.value.clone());

        // Filter out boundary values for normal processing
        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .cloned()
            .collect();

        // If no normal transitions, use boundary value to draw horizontal line
        if normal_transitions.is_empty() {
            if let Some(boundary_val) = boundary_value {
                console_log!("[WASM] No transitions in range, using boundary value: {}", boundary_val);
                let (value_type, has_xz) = Self::classify_value(&boundary_val, width);

                // Format display string with prefix for multi-bit values
                let display_str = if width > 1 {
                    self.format_multi_bit_value(&boundary_val, width)
                } else {
                    boundary_val.clone()
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

        // If we have boundary value, draw segment from viewport start to first transition
        if let Some(ref boundary_val) = boundary_value {
            if let Some(first_trans) = normal_transitions.first() {
                let t0 = self.viewport.time_start;
                let t1 = first_trans.time as f64;

                // Only draw if within viewport
                if t1 >= self.viewport.time_start && t0 <= self.viewport.time_end {
                    let t1_clamped = t1.min(self.viewport.time_end);
                    let x0 = 0.0; // viewport start
                    let x1 = ((t1_clamped - self.viewport.time_start) / time_range) * self.canvas_width;

                    if x1 > x0 {
                        let (value_type, has_xz) = Self::classify_value(boundary_val, width);

                        // Format display string with prefix for multi-bit values
                        let display_str = if width > 1 {
                            self.format_multi_bit_value(boundary_val, width)
                        } else {
                            boundary_val.clone()
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
        }

        // Process normal transitions
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

            // Format display string with prefix for multi-bit values
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

    /// Generate segments for LoD 1+ (min/max format)
    /// Groups transitions by timestamp and creates min/max segments
    /// Handles boundary value (0xFFFFFFFFFFFFFFFF) for start-of-range value
    fn generate_min_max_segments(&self, transitions: &[Transition], width: u32, y: f64,
        signal_name: &str, time_range: f64, segments: &mut Vec<RenderSegment>) {

        // Check for boundary value (special timestamp indicating start-of-range value)
        let boundary_value = transitions.iter()
            .find(|t| t.time == BOUNDARY_TIME_START)
            .map(|t| t.value.clone());

        // Filter out boundary values for normal processing
        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .cloned()
            .collect();

        // If no normal transitions, use boundary value to draw horizontal line
        if normal_transitions.is_empty() {
            if let Some(boundary_val) = boundary_value {
                console_log!("[WASM] No transitions in range (LoD 1+), using boundary value: {}", boundary_val);
                let (value_type, has_xz) = Self::classify_value(&boundary_val, width);

                // Format display string with prefix for multi-bit values
                let display_str = if width > 1 {
                    self.format_multi_bit_value(&boundary_val, width)
                } else {
                    boundary_val.clone()
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
                        min_value: Some(boundary_val.clone()),
                        max_value: Some(boundary_val),
                        is_min_max: false,
                    },
                    signal_name: signal_name.to_string(),
                });
            }
            return;
        }

        // If we have boundary value, draw segment from viewport start to first transition
        if let Some(ref boundary_val) = boundary_value {
            if let Some(first_trans) = normal_transitions.first() {
                let t0 = self.viewport.time_start;
                let t1 = first_trans.time as f64;

                // Only draw if within viewport
                if t1 >= self.viewport.time_start && t0 <= self.viewport.time_end {
                    let t1_clamped = t1.min(self.viewport.time_end);
                    let x0 = 0.0; // viewport start
                    let x1 = ((t1_clamped - self.viewport.time_start) / time_range) * self.canvas_width;

                    if x1 > x0 {
                        let (value_type, has_xz) = Self::classify_value(boundary_val, width);

                        // Format display string with prefix for multi-bit values
                        let display_str = if width > 1 {
                            self.format_multi_bit_value(boundary_val, width)
                        } else {
                            boundary_val.clone()
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
                                min_value: Some(boundary_val.clone()),
                                max_value: Some(boundary_val.clone()),
                                is_min_max: false,
                            },
                            signal_name: signal_name.to_string(),
                        });
                    }
                }
            }
        }

        // Group transitions by timestamp
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

            // Extract min and max values
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

            let (value_type, display_str) = if is_changing {
                if width == 1 {
                    // Single bit: draw vertical line
                    ("min_max".to_string(), format!("{}/{}", min_val, max_val))
                } else {
                    // Multi-bit: grid pattern
                    ("min_max".to_string(), format!("{}..{}", min_val, max_val))
                }
            } else {
                // min == max or has X/Z, treat as normal value
                let (vt, _) = Self::classify_value(&min_val, width);
                (vt, min_val.clone())
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
                    min_value: Some(min_val),
                    max_value: Some(max_val),
                    is_min_max: is_changing,
                },
                signal_name: signal_name.to_string(),
            });

            i = j;
        }
    }

    /// Classify value for rendering
    fn classify_value(value: &str, width: u32) -> (String, bool) {
        if width == 1 {
            match value {
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

    /// Test signal name conversion (for debugging)
    pub fn test_name_conversion(&self, local_name: &str) -> String {
        let server_name = self.local_to_server_name(local_name);
        let encoded = general_purpose::STANDARD.encode(&server_name);
        format!("Local: '{}' -> Server: '{}' -> Base64: '{}'", local_name, server_name, encoded)
    }
}
