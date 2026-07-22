//! WASM Waveform Data Provider
//!
//! This module provides waveform data fetching from server,
//! chunk parsing, and segment calculation for rendering.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use base64::{Engine as _, engine::general_purpose};

use crate::opfs_cache::{
    OpfsCacheManager, SignalWithId, DataBlock
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

/// Get the global object (window in main thread, WorkerGlobalScope in worker)
/// This function is compatible with both main thread and Web Worker environments
fn get_global() -> Result<js_sys::Object, JsValue> {
    // Try to get window (main thread)
    if let Ok(window) = web_sys::window().ok_or(JsValue::UNDEFINED) {
        return Ok(window.into());
    }
    
    // Try to get WorkerGlobalScope (worker thread)
    js_sys::global().dyn_into::<js_sys::Object>()
        .map_err(|_| JsValue::from_str("No global object available"))
}

/// Fetch data from URL, compatible with both main thread and Web Worker
async fn fetch_data(url: &str) -> Result<js_sys::ArrayBuffer, JsValue> {
    let global = get_global()?;
    
    // Get the fetch function from global object
    let fetch_fn = js_sys::Reflect::get(&global, &JsValue::from_str("fetch"))
        .map_err(|_| JsValue::from_str("fetch not available"))?;
    
    // Call fetch
    let promise = js_sys::Reflect::apply(
        &fetch_fn.dyn_into::<js_sys::Function>()?,
        &global,
        &js_sys::Array::of1(&JsValue::from_str(url)),
    )?;
    
    // Convert to Promise
    let promise: js_sys::Promise = promise.dyn_into()
        .map_err(|_| JsValue::from_str("fetch did not return a Promise"))?;
    
    // Await the fetch promise
    let resp_value: JsValue = wasm_bindgen_futures::JsFuture::from(promise).await?;
    
    let resp: web_sys::Response = resp_value.dyn_into()
        .map_err(|_| JsValue::from_str("Invalid response"))?;
    
    if !resp.ok() {
        // Capture the response body so callers (and the UI) can see which signal
        // the server reported as missing (e.g. SIGNAL_NOT_FOUND), and add debug
        // prints to make stalled renders diagnosable.
        let status = resp.status();
        let body = wasm_bindgen_futures::JsFuture::from(
            resp.text().map_err(|_| JsValue::from_str("Failed to read error body"))?
        ).await
            .ok()
            .and_then(|v| v.as_string())
            .unwrap_or_default();
        // console_log!("[WASM] fetch_data HTTP {} for url: {}", status, url);
        if !body.is_empty() {
            // console_log!("[WASM] fetch_data error body: {}", body);
        }
        let err_msg = if body.is_empty() {
            format!("HTTP error: {}", status)
        } else {
            format!("HTTP error: {} - {}", status, body)
        };
        return Err(JsValue::from_str(&err_msg));
    }
    
    // Get array buffer
    let data: JsValue = wasm_bindgen_futures::JsFuture::from(
        resp.array_buffer()?
    ).await?;
    
    data.dyn_into()
        .map_err(|_| JsValue::from_str("Invalid array buffer"))
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
    pub display_format: Option<String>,  // Display format for this signal
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

/// Transition data point (stores original server format)
#[derive(Debug, Clone)]
pub struct Transition {
    pub time: u64,        // For LoD 0: absolute time; For LoD 1+: bucket offset (0-255)
    pub actual_time: u64, // Actual transition timestamp (for LoD 1+ precise drawing), same as time for LoD 0
    pub value_type: u8,   // Original value type from server (0=Numeric, 1=String, 2=Real, 3=BinaryCompressed)
    pub value_len: u16,   // Original value length from server
    pub value: Vec<u8>,   // Original value bytes from server
}

/// Bucket data for LoD 1+ (First/Last format)
#[derive(Debug, Clone)]
pub struct BucketData {
    pub offset: u16,        // Bucket offset within tile (0-255)
    pub first: Transition,  // First transition in bucket
    pub last: Option<Transition>, // Last transition (None if only one transition)
}

/// Convert original server value format to display string
fn server_value_to_string(value_type: u8, value_len: u16, value: &[u8]) -> String {
    match value_type {
        0 => {
            // Numeric type: ASCII string
            String::from_utf8_lossy(value).trim().to_string()
        }
        1 => {
            // String type: ASCII string, trim null terminators
            String::from_utf8_lossy(value).trim_end_matches('\0').to_string()
        }
        2 => {
            // Real type: f64
            if value_len == 8 && value.len() >= 8 {
                let bytes = [value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7]];
                let f = f64::from_le_bytes(bytes);
                format!("{:.6}", f)
            } else {
                format!("Real({}bytes)", value_len)
            }
        }
        3 => {
            // BinaryCompressed type: hex format
            value.iter().map(|b| format!("{:02X}", b)).collect()
        }
        _ => {
            format!("Type{}:{:?}", value_type, &value[..value.len().min(8)])
        }
    }
}

/// Convert original server value format to u64 (for bit extraction)
fn server_value_to_u64(value_type: u8, value_len: u16, value: &[u8]) -> Option<u64> {
    match value_type {
        0 => {
            // Numeric type: ASCII string
            let s = String::from_utf8_lossy(value).trim().to_string();
            if s.starts_with("0x") || s.starts_with("0X") {
                u64::from_str_radix(s.trim_start_matches("0x").trim_start_matches("0X"), 16).ok()
            } else {
                s.parse::<u64>().ok()
            }
        }
        _ => None
    }
}

impl BucketData {
    /// Check if this bucket has both first and last (toggle bucket)
    pub fn has_toggle(&self) -> bool {
        self.last.is_some()
    }
    
    /// Get the value to continue after this bucket
    pub fn get_continue_value(&self) -> String {
        match &self.last {
            Some(last) => server_value_to_string(last.value_type, last.value_len, &last.value),
            None => server_value_to_string(self.first.value_type, self.first.value_len, &self.first.value),
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
    pub tile_info: Vec<(u64, u64, u64, Transition)>,
    /// LoD 1+ bucket data: (tile_start, buckets HashMap)
    pub bucket_data: Vec<(u64, HashMap<u16, BucketData>)>,
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

// ============================================================================
// Get Signal Values at Transitions - Data Structures
// ============================================================================

/// Signal information with display format for get_signal_values_at_transitions
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalWithFormat {
    pub global_id: u32,
    pub name: String,
    pub row: u32,
    pub width: u32,
    pub draw_sig_id: u32,
    pub bit_extract: Option<BitExtractInfo>,
    pub display_format: String, // "hex" | "bin" | "oct" | "dec"
}

/// Bit extraction information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BitExtractInfo {
    pub parent_name: String,
    pub msb: u32,
    pub lsb: u32,
}

/// Raw value at a specific time point for a single signal
#[derive(Debug, Clone, Serialize)]
pub struct RawValue {
    #[serde(rename = "displayStr")]
    pub display_str: String,
    #[serde(rename = "valueType")]
    pub value_type: String, // "has_x" | "has_z" | "mixed" | "numeric"
    #[serde(rename = "hasTransition")]
    pub has_transition: bool,
    #[serde(rename = "hasToggle")]
    pub has_toggle: bool,
}

/// All signal values at a specific time point
#[derive(Debug, Clone, Serialize)]
pub struct RawSignalValuesAtTime {
    pub time: u64,
    pub values: Vec<RawValue>,
}

/// Complete result for get_signal_values_at_transitions
#[derive(Debug, Clone, Serialize)]
pub struct RawSignalValuesResult {
    #[serde(rename = "searchStartTime")]
    pub search_start_time: u64,
    #[serde(rename = "searchEndTime")]
    pub search_end_time: u64,
    pub data: Vec<RawSignalValuesAtTime>,
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

/// Signal block header (v1: 17 bytes, v2: 21 bytes)
#[derive(Debug, Clone)]
pub struct SignalBlockHeader {
    pub signal_handle: u32,
    pub time_array_offset: u32,
    pub value_array_offset: u32,
    pub transition_count: u32,
    pub compression: u8,
    pub transition_time_array_offset: u32, // v2 only, 0 means not present
}

impl SignalBlockHeader {
    pub const SIZE_V1: usize = 17;
    pub const SIZE_V2: usize = 21;

    pub fn from_bytes(data: &[u8], version: u16) -> Result<Self, String> {
        if version >= 2 {
            // v2: 21 bytes with transition_time_array_offset
            if data.len() < Self::SIZE_V2 {
                return Err("Signal block header too small for v2".to_string());
            }
            Ok(Self {
                signal_handle: u32::from_le_bytes([data[0], data[1], data[2], data[3]]),
                time_array_offset: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
                value_array_offset: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
                transition_count: u32::from_le_bytes([data[12], data[13], data[14], data[15]]),
                compression: data[16],
                transition_time_array_offset: u32::from_le_bytes([data[17], data[18], data[19], data[20]]),
            })
        } else {
            // v1: 17 bytes without transition_time_array_offset
            if data.len() < Self::SIZE_V1 {
                return Err("Signal block header too small for v1".to_string());
            }
            Ok(Self {
                signal_handle: u32::from_le_bytes([data[0], data[1], data[2], data[3]]),
                time_array_offset: u32::from_le_bytes([data[4], data[5], data[6], data[7]]),
                value_array_offset: u32::from_le_bytes([data[8], data[9], data[10], data[11]]),
                transition_count: u32::from_le_bytes([data[12], data[13], data[14], data[15]]),
                compression: data[16],
                transition_time_array_offset: 0, // Not present in v1
            })
        }
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
    signal_prefix: String,  // Local prefix (removed from local signal name)
    server_prefix: String,  // Server prefix (added to server signal name)
    space_before_bracket: bool,
    time_stamp: u64,  // Waveform modification timestamp for CDN cache
    display_format: String,  // "hex", "bin", "oct", "dec"
    signals: Vec<SignalInfo>,
    viewport: Viewport,
    canvas_width: f64,
    canvas_height: f64,
    row_height: f64,
    signal_data: HashMap<String, SignalWaveData>,
    // OPFS cache - uses global shared instance via Arc
    opfs_cache: Arc<OpfsCacheManager>,
    signals_with_id: Vec<SignalWithId>,  // Signals with draw_sig_id
    enable_opfs: bool,  // OPFS cache enabled flag
    current_lod: Option<u32>,  // Current LoD level for bucket size calculation
    display_unit_per_lod0_unit: f64,  // Time unit conversion factor (display unit / LoD0 unit)
    // Signals the server reported as not found (SIGNAL_NOT_FOUND / 404). Tracked so a
    // single missing signal does not block the rest of the render and we avoid spamming
    // the server with the same doomed request on every tile/viewport.
    not_found_signals: std::collections::HashSet<String>,
}

#[wasm_bindgen]
impl WaveformDataProvider {
    /// Create a new waveform data provider
    #[wasm_bindgen(constructor)]
    pub fn new(
        server_url: String,
        waveform_name: String,
        signal_prefix: String,
        server_prefix: String,
        space_before_bracket: bool,
        time_stamp: u64,
    ) -> Self {


        // Get or wait for global cache initialization
        let opfs_cache = loop {
            if let Some(cache) = crate::opfs_cache::get_global_cache() {
                break Arc::new(cache.clone());
            }
            // If global cache not initialized yet, create a temporary one
            // This should only happen during testing
            break Arc::new(OpfsCacheManager::new());
        };
        
        Self {
            server_url: server_url.clone(),
            waveform_name: waveform_name.clone(),
            signal_prefix,
            server_prefix,
            space_before_bracket,
            time_stamp,
            display_format: "hex".to_string(),  // Default to hex
            signals: Vec::new(),
            viewport: Viewport { time_start: 0.0, time_end: 1000.0 },
            canvas_width: 800.0,
            canvas_height: 400.0,
            row_height: 24.0,  // Must match CSS .waveform-signal-signal-item height
            signal_data: HashMap::new(),
            opfs_cache,
            signals_with_id: Vec::new(),
            enable_opfs: false,  // Disabled by default
            current_lod: None,  // Will be set when fetching data
            display_unit_per_lod0_unit: 1.0,  // Default to 1.0 (no conversion)
            not_found_signals: std::collections::HashSet::new(),
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
        
        // Initialize global shared cache
        crate::opfs_cache::init_global_cache(
            opfs_read, 
            opfs_write, 
            opfs_exists, 
            enable_opfs
        );
        
        // Update our reference to use the global cache
        if let Some(cache) = crate::opfs_cache::get_global_cache() {
            self.opfs_cache = Arc::new(cache.clone());
            self.opfs_cache.set_waveform(self.waveform_name.clone());
        }
    }

    /// Set signals with draw_sig_id (new API)
    /// 
    /// # Arguments
    /// * `signals_js` - Array of { global_id, name, row, width, draw_sig_id, display_format }
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
                display_format: s.display_format.clone(),
            }
        }).collect();

        self.signals_with_id = signals_with_id;
        self.signals = signals;
        // The set of rendered signals changed; forget any previously-missing
        // signals so a signal that was removed and re-added is not silently skipped.
        self.not_found_signals.clear();
        Ok(())
    }

    /// Returns the list of signal names the server reported as not found during
    /// the last fetch. The UI uses this to drop signals that don't exist.
    /// Built manually with js_sys to avoid any (de)serialization dependency.
    #[wasm_bindgen]
    pub fn get_not_found_signals(&self) -> JsValue {
        let arr = js_sys::Array::new();
        for name in self.not_found_signals.iter() {
            arr.push(&JsValue::from_str(name));
        }
        arr.into()
    }

    /// Process server chunk data and store in cache using pre-computed draw_sig_ids
    /// signal_names: list of signal names in the same order as server response
    /// draw_sig_ids: pre-computed draw_sig_ids for each signal (parallel array)
    async fn process_server_chunk_with_ids(&mut self, data: &[u8], signal_names: &[String], draw_sig_ids: &[u32]) -> Result<(), JsValue> {
        // Skip if both OPFS and memory cache are disabled
        if !self.is_cache_enabled() {
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
        let chunk_version = header.version;
        
        for signal_idx in 0..header.signal_count {
            let block_header_size = if chunk_version >= 2 { 
                SignalBlockHeader::SIZE_V2 
            } else { 
                SignalBlockHeader::SIZE_V1 
            };
            
            if offset + block_header_size > data.len() {
                break;
            }

            // Parse signal block header (pass version)
            let block_header = SignalBlockHeader::from_bytes(&data[offset..], chunk_version)
                .map_err(|e| JsValue::from_str(&e))?;

            // Parse transitions for this signal (pass version and lod for v2 API support)
            let transitions = self.parse_transitions_for_cache(
                data,
                &block_header,
                signal_idx as usize,
                chunk_version,
                lod
            )?;

            // Use pre-computed draw_sig_id directly (no lookup needed)
            let draw_sig_id = if (signal_idx as usize) < draw_sig_ids.len() {
                draw_sig_ids[signal_idx as usize]
            } else {
                // Fallback: should not happen if arrays are parallel
                signal_idx as u32
            };
            let group_id = OpfsCacheManager::get_group_id(draw_sig_id);

            // Convert transitions to opfs_cache format (already have original server format
            let opfs_transitions: Vec<crate::opfs_cache::Transition> = transitions
                .into_iter()
                .map(|t| {
                    crate::opfs_cache::Transition {
                        time: t.time,
                        actual_time: t.actual_time,
                        value_type: t.value_type,
                        value_len: t.value_len,
                        value: t.value,
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

            offset += block_header_size;
        }

        // Write each group to cache (with merge support for V2 format)
        let group_count = signals_by_group.len();
        // console_log!("[WASM]   Grouping complete: {} groups", group_count);
        
        for (group_id, new_signals) in &signals_by_group {
            let block = crate::opfs_cache::DataBlock {
                lod,
                tile: tile_id,
                group: *group_id,
            };

            // console_log!("[WASM]   Processing group {}: {} new signals", 
            //     group_id, new_signals.len());
            // console_log!("[WASM]     Block: lod={}, tile={}, group={}", 
            //     lod, tile_id, group_id);

            // Try to read existing group data from cache
            let mut merged_signals: Vec<crate::opfs_cache::SignalData> = Vec::new();
            
            match self.opfs_cache.read(&block).await {
                Ok(Some(existing_data)) => {
                    // console_log!("[WASM]     Existing group data found: {} bytes", existing_data.len());
                    // Deserialize existing data using V2 format
                    match crate::opfs_cache::deserialize_group_data_v2(&existing_data, lod) {
                        Ok(existing_group) => {
                            // console_log!("[WASM]     Existing signals: {}", existing_group.signals.len());
                            
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
                            // console_log!("[WASM]     Merged signals: {} (existing + new)", merged_signals.len());
                        }
                        Err(e) => {
                            // console_log!("[WASM]     Error deserializing existing data: {}, using new signals only", e);
                            merged_signals = new_signals.clone();
                        }
                    }
                }
                Ok(None) => {
                    // console_log!("[WASM]     No existing group data, using new signals only");
                    merged_signals = new_signals.clone();
                }
                Err(e) => {
                    // console_log!("[WASM]     Error reading existing cache: {:?}, using new signals only", e);
                    merged_signals = new_signals.clone();
                }
            }

            // Serialize merged data using V2 format
            let group_data = crate::opfs_cache::GroupData { signals: merged_signals };
            let bin_data = crate::opfs_cache::serialize_group_data_v2(&group_data, lod);

            // console_log!("[WASM]     Serialized size: {} bytes", bin_data.len());

            // Write to cache (OPFS + Memory)
            self.opfs_cache.write(&block, bin_data).await?;
            // console_log!("[WASM]     Block written to cache successfully");
        }

        // console_log!("[WASM] Server chunk processed: {} groups written to cache", group_count);

        Ok(())
    }

    /// Parse transitions from a signal block for cache storage
    /// 
    /// Data format according to API:
    /// v1 API:
    ///   - Time array: [start_time(u64), t0(u64), t1(u64), ...] (u64 array)
    /// v2 API:
    ///   - Time array: [start_time(u64), bucket_idx0(u16), bucket_idx1(u16), ...] (LoD > 0)
    ///   - Transition time array (optional): [actual_time0(u64), actual_time1(u64), ...]
    /// - Value array: [start_value, value0, value1, ...]
    /// - transition_count: number of actual transitions (NOT including start value)
    fn parse_transitions_for_cache(
        &self,
        data: &[u8],
        block_header: &SignalBlockHeader,
        _signal_index: usize,
        chunk_version: u16,
        lod: u32,
    ) -> Result<Vec<Transition>, JsValue> {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        let mut transitions = Vec::new();
        let is_v2 = chunk_version >= 2;

        let time_array_start = block_header.time_array_offset as usize;
        let value_array_start = block_header.value_array_offset as usize;

        // First, read the start value (bucket index = u16::MAX for v2/LoD>0, or u64::MAX for v1/LoD0)
        // Start value is always present and comes first in the arrays
        let is_start_value = if lod == 0 {
            // LoD 0: time is u64
            if time_array_start + 8 <= data.len() {
                let start_time = u64::from_le_bytes([
                    data[time_array_start], data[time_array_start + 1],
                    data[time_array_start + 2], data[time_array_start + 3],
                    data[time_array_start + 4], data[time_array_start + 5],
                    data[time_array_start + 6], data[time_array_start + 7],
                ]);
                start_time == BOUNDARY_TIME_START
            } else {
                false
            }
        } else if is_v2 {
            // v2 API, LoD > 0: bucket index is u16, start value is u16::MAX
            if time_array_start + 2 <= data.len() {
                let start_bucket_idx = u16::from_le_bytes([data[time_array_start], data[time_array_start + 1]]);
                start_bucket_idx == u16::MAX
            } else {
                false
            }
        } else {
            // v1 API, LoD > 0: bucket index is stored as u64
            if time_array_start + 8 <= data.len() {
                let start_time = u64::from_le_bytes([
                    data[time_array_start], data[time_array_start + 1],
                    data[time_array_start + 2], data[time_array_start + 3],
                    data[time_array_start + 4], data[time_array_start + 5],
                    data[time_array_start + 6], data[time_array_start + 7],
                ]);
                start_time == BOUNDARY_TIME_START
            } else {
                false
            }
        };

        // Parse start value if marker found
        if is_start_value {
            // Parse start value from value array
            let mut value_idx = value_array_start;
            if value_idx + 3 <= data.len() {
                let value_type = data[value_idx];
                let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
                value_idx += 3;

                if value_idx + value_len <= data.len() {
                    let value = data[value_idx..value_idx + value_len].to_vec();

                    // Add start value transition with special time marker (always use u64::MAX internally)
                    transitions.push(Transition {
                        time: BOUNDARY_TIME_START,
                        actual_time: BOUNDARY_TIME_START,
                        value_type,
                        value_len: value_len as u16,
                        value,
                    });
                }
            }
        }

        // Then, read the actual transitions (transition_count of them)
        // They start at index 1 in the time array (after start value)
        let mut value_idx = value_array_start;
        // Skip start value in value array
        if value_idx + 3 <= data.len() {
            let _value_type = data[value_idx];
            let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
            value_idx += 3 + value_len;
        }

        // Check if we have transition_time_array (v2 API)
        let has_transition_time_array = is_v2 && block_header.transition_time_array_offset > 0;
        let transition_time_array_start = if has_transition_time_array {
            block_header.transition_time_array_offset as usize
        } else {
            0
        };

        for i in 0..block_header.transition_count {
            // Parse value first (same for v1 and v2)
            if value_idx + 3 > data.len() {
                break;
            }

            let value_type = data[value_idx];
            let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
            value_idx += 3;

            if value_idx + value_len > data.len() {
                break;
            }

            let value = data[value_idx..value_idx + value_len].to_vec();
            value_idx += value_len;

            // Parse time based on API version and LoD
            let time: u64;
            let actual_time: u64;

            if lod == 0 {
                // LoD 0: always u64 time (absolute timestamp)
                let time_idx = time_array_start + ((i + 1) as usize * 8);
                if time_idx + 8 > data.len() {
                    break;
                }
                time = u64::from_le_bytes([
                    data[time_idx], data[time_idx + 1], data[time_idx + 2], data[time_idx + 3],
                    data[time_idx + 4], data[time_idx + 5], data[time_idx + 6], data[time_idx + 7],
                ]);
                // For LoD 0, actual_time is same as time
                actual_time = time;
            } else if is_v2 {
                // v2 API, LoD > 0: bucket index is u16 (0-255)
                // time_array_offset points to u16 array: [u16::MAX (start), bucket_idx0, bucket_idx1, ...]
                let time_idx = time_array_start + 2 + ((i as usize) * 2); // +2 to skip u16 start marker
                if time_idx + 2 > data.len() {
                    break;
                }
                let bucket_idx = u16::from_le_bytes([data[time_idx], data[time_idx + 1]]);
                // Handle u16::MAX (0xFFFF) as start value marker (convert to u64::MAX)
                time = if bucket_idx == u16::MAX {
                    u64::MAX
                } else {
                    bucket_idx as u64
                };

                // Read actual transition time from transition_time_array (v2 API)
                if has_transition_time_array {
                    let actual_time_idx = transition_time_array_start + ((i + 1) as usize * 8); // +8 to skip start marker
                    if actual_time_idx + 8 <= data.len() {
                        actual_time = u64::from_le_bytes([
                            data[actual_time_idx], data[actual_time_idx + 1],
                            data[actual_time_idx + 2], data[actual_time_idx + 3],
                            data[actual_time_idx + 4], data[actual_time_idx + 5],
                            data[actual_time_idx + 6], data[actual_time_idx + 7],
                        ]);
                    } else {
                        actual_time = time; // Fallback to bucket index
                    }
                } else {
                    actual_time = time; // Fallback to bucket index
                }
            } else {
                // v1 API, LoD > 0: bucket index was stored as u64 (but values are 0-255)
                let time_idx = time_array_start + ((i + 1) as usize * 8);
                if time_idx + 8 > data.len() {
                    break;
                }
                let bucket_idx = u64::from_le_bytes([
                    data[time_idx], data[time_idx + 1], data[time_idx + 2], data[time_idx + 3],
                    data[time_idx + 4], data[time_idx + 5], data[time_idx + 6], data[time_idx + 7],
                ]);
                time = bucket_idx;
                actual_time = time; // For v1, actual_time is same as bucket index
            }

            transitions.push(Transition {
                time,
                actual_time,
                value_type,
                value_len: value_len as u16,
                value,
            });
        }

        Ok(transitions)
    }

    /// Clear all cache data
    #[wasm_bindgen]
    pub fn clear_cache(&mut self) {
        self.opfs_cache.clear_memory();
        // console_log!("[WASM] Cache cleared");
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

    /// Get signal prefix (local prefix)
    #[wasm_bindgen(getter)]
    pub fn signal_prefix(&self) -> String {
        self.signal_prefix.clone()
    }

    /// Get server prefix
    #[wasm_bindgen(getter)]
    pub fn server_prefix(&self) -> String {
        self.server_prefix.clone()
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

    /// Set signal prefix (local prefix)
    #[wasm_bindgen(setter)]
    pub fn set_signal_prefix(&mut self, prefix: String) {
        // console_log!("[WASM] Updated signal_prefix: '{}' -> '{}'", self.signal_prefix, prefix);
        self.signal_prefix = prefix;
    }

    /// Set server prefix
    #[wasm_bindgen(setter)]
    pub fn set_server_prefix(&mut self, prefix: String) {
        // console_log!("[WASM] Updated server_prefix: '{}' -> '{}'", self.server_prefix, prefix);
        self.server_prefix = prefix;
    }

    /// Set space before bracket
    #[wasm_bindgen(setter)]
    pub fn set_space_before_bracket(&mut self, space: bool) {
        // console_log!("[WASM] Updated space_before_bracket: {} -> {}", self.space_before_bracket, space);
        self.space_before_bracket = space;
    }

    /// Get display unit per LoD0 unit (time conversion factor)
    #[wasm_bindgen(getter)]
    pub fn display_unit_per_lod0_unit(&self) -> f64 {
        self.display_unit_per_lod0_unit
    }

    /// Set display unit per LoD0 unit (time conversion factor)
    #[wasm_bindgen(setter)]
    pub fn set_display_unit_per_lod0_unit(&mut self, factor: f64) {
        web_sys::console::log_1(&JsValue::from_str(&format!(
            "[WASM] Updated display_unit_per_lod0_unit: {} -> {}",
            self.display_unit_per_lod0_unit, factor
        )));
        self.display_unit_per_lod0_unit = factor;
    }

    /// Get display format
    #[wasm_bindgen(getter)]
    pub fn display_format(&self) -> String {
        self.display_format.clone()
    }

    /// Set display format (hex, bin, oct, dec)
    #[wasm_bindgen(setter)]
    pub fn set_display_format(&mut self, format: String) {
        // console_log!("[WASM] Updated display_format: '{}' -> '{}'", self.display_format, format);
        self.display_format = format;
    }

    /// Set memory cache enabled
    #[wasm_bindgen]
    pub fn set_memory_cache_enabled(&mut self, enabled: bool) {
        // console_log!("[WASM] Setting memory cache enabled: {}", enabled);
        self.opfs_cache.set_memory_cache_enabled(enabled);
    }

    /// Get memory cache enabled status
    #[wasm_bindgen(getter)]
    pub fn memory_cache_enabled(&self) -> bool {
        self.opfs_cache.is_memory_cache_enabled()
    }

    /// Set OPFS cache enabled (dynamic toggle)
    #[wasm_bindgen]
    pub fn set_opfs_enabled(&mut self, enabled: bool) {
        // console_log!("[WASM] Setting OPFS cache enabled: {}", enabled);
        // Note: This only affects the local reference, not the global cache
        // For global changes, reinitialize with init_with_opfs
        self.enable_opfs = enabled;
    }

    /// Get OPFS cache enabled status
    #[wasm_bindgen(getter)]
    pub fn opfs_enabled(&self) -> bool {
        self.opfs_cache.is_enabled()
    }
    
    /// Check if any cache is enabled (helper method)
    ///
    /// Uses `self.enable_opfs` (the live OPFS toggle, also set during
    /// `init_with_opfs`) rather than `opfs_cache.is_enabled()`, because the
    /// worker path initializes the global cache only once and the live
    /// `set_opfs_enabled` toggle only updates `self.enable_opfs`. Gating on
    /// `self.enable_opfs` makes the OPFS switch actually take effect at
    /// runtime without requiring a provider recreation.
    fn is_cache_enabled(&self) -> bool {
        self.enable_opfs || self.opfs_cache.is_memory_cache_enabled()
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
                // console_log!("[WASM]   Signal '{}': extract bits [{}:{}] from parent '{}'", 
                //     s.name, msb, lsb, parent);
            }
            s
        }).collect();

        // console_log!("[WASM] Set {} signals", signals.len());
        for (i, s) in signals.iter().enumerate() {
            // console_log!("[WASM]   Signal[{}]: name='{}', row={}, width={}", i, s.name, s.row, s.width);
        }
        self.signals = signals;
        Ok(())
    }

    /// Set viewport
    pub fn set_viewport(&mut self, time_start: f64, time_end: f64) {
        // console_log!("[WASM] Set viewport: time_start={}, time_end={}", time_start, time_end);
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
        // console_log!("[WASM] Set canvas dimensions: width={}, height={}, row_height={}", width, height, row_height);
        
        // If canvas width changes, adjust time_end to maintain time-to-pixel ratio
        if self.canvas_width > 0.0 && width != self.canvas_width {
            let old_width = self.canvas_width;
            let time_range = self.viewport.time_end - self.viewport.time_start;
            let time_per_pixel = time_range / old_width;
            
            // Calculate new time_end based on new width
            let new_time_range = time_per_pixel * width;
            let new_time_end = self.viewport.time_start + new_time_range;
            
            // console_log!("[WASM] Adjusting viewport: time_start={}, old_time_end={}, new_time_end={}", 
            //     self.viewport.time_start, self.viewport.time_end, new_time_end);
            
            self.viewport.time_end = new_time_end;
        }
        
        self.canvas_width = width;
        self.canvas_height = height;
        self.row_height = row_height;
    }

    /// Build server signal name from local name
    /// 
    /// Process:
    /// 1. Remove local prefix (signal_prefix) from local_name
    /// 2. Get shared name
    /// 3. Add server prefix (server_prefix) to shared name
    /// 4. Add space before bracket if space_before_bracket is true
    fn build_server_signal_name(&self, local_name: &str) -> String {
        // Step 1: Remove local prefix to get shared name
        let shared_name = if self.signal_prefix.is_empty() || !local_name.starts_with(&self.signal_prefix) {
            local_name.to_string()
        } else {
            local_name[self.signal_prefix.len()..].to_string()
        };

        // Step 2: Add server prefix
        let mut server_name = format!("{}{}", self.server_prefix, shared_name);

        // Step 3: Add space before bracket if needed
        if self.space_before_bracket {
            if let Some(bracket_idx) = server_name.find('[') {
                if bracket_idx > 0 && !server_name[..bracket_idx].ends_with(' ') {
                    server_name.insert(bracket_idx, ' ');
                }
            }
        }

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
        // console_log!("[WASM] Converted '{}' -> '{}'", local_name, server_name);
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
    /// 
    /// This is an internal function, use fetch_and_get_segments for JS calls
    /// Uses automatic LoD selection based on viewport
    async fn fetch_signals_data_batch(&mut self, signal_names: Vec<String>) -> Result<(), JsValue> {
        // Calculate appropriate LoD based on current viewport and canvas
        let lod = select_lod(&self.viewport, self.canvas_width);
        self.fetch_signals_data_batch_internal(signal_names, lod, None).await
    }

    /// Internal version with explicit LoD parameter
    /// 
    /// # Arguments
    /// * `signal_names` - List of signal names to fetch
    /// * `lod` - Level of Detail to use (0 for raw data)
    async fn fetch_signals_data_batch_internal(
        &mut self, 
        signal_names: Vec<String>, 
        lod: u32,
        custom_time_range: Option<(u64, u64)>,
    ) -> Result<(), JsValue> {
        // Clear signal_data cache for new viewport
        // signal_data is temporary cache for current viewport only
        self.signal_data.clear();
        
        const MAX_BATCH_SIZE: usize = 256;
        
        let total_signals = signal_names.len();
        
        // Store current LoD for bucket size calculation
        self.current_lod = Some(lod);

        // Get time range from custom range or viewport
        let (time_start, time_end) = match custom_time_range {
            Some((start, end)) => (start, end),
            None => (self.viewport.time_start as u64, self.viewport.time_end as u64),
        };

        // Calculate tile information for debugging
        let tile_span = OpfsCacheManager::get_tile_span(lod);
        let start_tile = time_start / tile_span;
        let end_tile = time_end / tile_span;
        
        // console_log!("[WASM] Fetching {} signals in batches (max {} per batch) at LoD {}, time {}-{}",
        //     total_signals, MAX_BATCH_SIZE, lod, time_start, time_end);
        // console_log!("[WASM]   Tile info: span={}, start_tile={}, end_tile={}, tiles={}",
        //     tile_span, start_tile, end_tile, end_tile - start_tile + 1);

        // Filter out bit extraction signals - they don't need server data
        let signals_to_fetch: Vec<String> = signal_names.iter()
            .filter(|name| !name.contains("@["))
            .cloned()
            .collect();

        // console_log!("[WASM] Total signals: {}, fetching {} (excluding {} bit-extract signals)",
        //     signal_names.len(), signals_to_fetch.len(), signal_names.len() - signals_to_fetch.len());

        // Optimization: if no signals to fetch, return early
        if signals_to_fetch.is_empty() {
            // console_log!("[WASM] No signals to fetch, skipping cache check and server request");
            return Ok(());
        }

        // Step 1: Calculate all required tiles based on time range
        // console_log!("[WASM] Step 1: Calculating required tiles...");
        let tiles_to_fetch: Vec<u64> = (start_tile..=end_tile).collect();
        // console_log!("[WASM]   Total tiles to check: {}", tiles_to_fetch.len());

        // Step 2: Per-signal per-tile cache check
        // Structure: tile_id -> Vec<(signal_name, draw_sig_id)> that need to be fetched for this tile
        // console_log!("[WASM] Step 2: Checking cache per signal per tile...");
        let mut tile_missing_signals: std::collections::HashMap<u64, Vec<(String, u32)>> = std::collections::HashMap::new();
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
                            match crate::opfs_cache::read_signal_from_group_v2(&data, draw_sig_id, lod) {
                                Ok(Some(signal_data)) => {
                                    // Signal found in cache, load into signal_data
                                    tile_hits += 1;
                                    
                                    // Convert opfs_cache::SignalData to SignalWaveData
                                    // For LoD 1+, directly parse into bucket_data (like server fetch)
                                    let lod = self.current_lod.unwrap_or(25);
                                    
                                    // Debug: print raw cache transitions with bucket info (disabled for performance)
                                    let bucket_size = 1u64 << lod;
                                    let tile_span = OpfsCacheManager::get_tile_span(lod);
                                    let canvas_width = self.canvas_width;
                                    let time_range = self.viewport.time_end - self.viewport.time_start;
                                    let view_start = self.viewport.time_start as u64;
                                    let view_end = self.viewport.time_end as u64;
                                    
                                    // console_log!("[WASM] Cache raw data for tile {}: {} transitions, tile_start={}, bucket_size={}, canvas_width={}", 
                                    //     tile_id, signal_data.transitions.len(), tile_start, bucket_size, canvas_width);
                                    
                                    // for (i, t) in signal_data.transitions.iter().take(10).enumerate() {
                                    //     let value_str = if t.value.len() <= 8 {
                                    //         let mut bytes = [0u8; 8];
                                    //         bytes[..t.value.len()].copy_from_slice(&t.value);
                                    //         format!("0x{:X}", u64::from_le_bytes(bytes))
                                    //     } else {
                                    //         format!("0x{}", t.value.iter().map(|b| format!("{:02X}", b)).collect::<String>())
                                    //     };
                                        
                                    //     // Calculate bucket start time and view x position
                                    //     let bucket_start_time = if t.time == u64::MAX {
                                    //         // BOUNDARY_TIME_START - use tile start
                                    //         tile_start
                                    //     } else {
                                    //         tile_start + t.time * bucket_size
                                    //     };
                                        
                                    //     // Calculate x position in viewport (if within view)
                                    //     let view_x = if bucket_start_time >= view_start && bucket_start_time <= view_end {
                                    //         let relative_time = (bucket_start_time - view_start) as f64;
                                    //         let x_pixel = (relative_time / time_range) * canvas_width;
                                    //         format!("{:.1}px", x_pixel)
                                    //     } else {
                                    //         "out-of-view".to_string()
                                    //     };
                                        
                                    //     console_log!("[WASM]   Raw[{}]: time={}, bucket_start={}, value={}, view_x={}", 
                                    //         i, t.time, bucket_start_time, value_str, view_x);
                                    // }
                                    
                                    // Convert cache transitions to our Transition format (already have original format
                                    let transitions: Vec<Transition> = signal_data.transitions
                                        .into_iter()
                                        .map(|t| Transition {
                                            time: t.time,
                                            actual_time: t.actual_time,
                                            value_type: t.value_type,
                                            value_len: t.value_len,
                                            value: t.value,
                                        })
                                        .collect();

                                    // [DEBUG] LoD 0 cache format diagnostic: cached LoD 0 data stores
                                    // time == 0 (only actual_time is persisted). Count how many are in the
                                    // "cache zero-time" form vs carrying a real time, so we can confirm the
                                    // format mismatch that previously dropped all transitions.
                                    if lod == 0 {
                                        let total = transitions.len();
                                        let zero_time = transitions.iter().filter(|t| t.time == 0).count();
                                        let boundary = transitions.iter().filter(|t| t.time == 0xFFFFFFFFFFFFFFFF).count();
                                        console_log!(
                                            "[WASM][DEBUG] cache lod0 read: signal='{}' tile={} total={} time==0={} boundary={} (actual_time sample={:?})",
                                            signal_name, tile_id, total, zero_time, boundary,
                                            transitions.iter().take(3).map(|t| t.actual_time).collect::<Vec<_>>()
                                        );
                                    }

                                    // For LoD 0: use same processing as server fetch
                                    // For LoD 1+: parse into bucket_data
                                    if lod == 0 {
                                        let tile_end = tile_start + tile_span;
                                        
                                        // Use same function as server fetch to get start_value and filtered_transitions
                                        let (start_value, filtered_transitions) = self.process_tile_transitions(
                                            transitions,
                                            true, // is_first_tile
                                            tile_start,
                                            tile_end,
                                            tile_start, // viewport_start = tile_start for cache data
                                            tile_end,   // viewport_end = tile_end for cache data
                                        );
                                        
                                        // Store LoD 0 signal data
                                        self.store_lod0_signal_data(
                                            signal_name,
                                            None, // width will be looked up from signal info
                                            tile_start,
                                            tile_end,
                                            start_value,
                                            filtered_transitions,
                                        );
                                    } else {
                                        // Parse into bucket_data directly (like server fetch)
                                        let (start_value, buckets) = self.parse_buckets_from_transitions(&transitions);
                                        let tile_end = tile_start + tile_span;

                                        // Store LoD 1+ signal data (merge buckets if tile exists)
                                        self.store_lod1_signal_data(
                                            signal_name,
                                            None, // width will be looked up from signal info
                                            tile_start,
                                            tile_end,
                                            start_value,
                                            buckets,
                                            true, // merge_buckets = true (unified with server fetch)
                                        );
                                    }
                                }
                                Ok(None) => {
                                    // Group file exists but signal not found
                                    tile_misses += 1;
                                    tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push((signal_name.clone(), draw_sig_id));
                                }
                                Err(_e) => {
                            tile_misses += 1;
                            tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push((signal_name.clone(), draw_sig_id));
                        }
                    }
                }
                Ok(None) => {
                    // Group file not in cache
                    tile_misses += 1;
                    tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push((signal_name.clone(), draw_sig_id));
                }
                Err(_e) => {
                    tile_misses += 1;
                    tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push((signal_name.clone(), draw_sig_id));
                }
            }
        } else {
            // Signal not found in draw list, treat as miss
            tile_misses += 1;
            // Use a default draw_sig_id (should not happen in normal case)
            tile_missing_signals.entry(*tile_id).or_insert_with(Vec::new).push((signal_name.clone(), 0));
        }
    }
    
    total_cache_hits += tile_hits;
    total_cache_misses += tile_misses;
}

// Log OPFS lookup result (disabled for performance)
// if tile_missing_signals.is_empty() {
//     console_log!("[WASM] 2. OPFS lookup complete, all data cached, no fetch needed");
// } else {
//     let missing_tiles = tile_missing_signals.len();
//     let total_tiles = (end_tile - start_tile + 1) as usize;
//     console_log!("[WASM] 2. OPFS lookup complete, need fetch from server: {}/{} tiles missing", missing_tiles, total_tiles);
// }

if tile_missing_signals.is_empty() {
    return Ok(());
}
        
        // Step 3: Fetch missing signals using tile-based API
        // Group tiles by contiguous ranges to minimize HTTP requests
        const MAX_TILES_PER_REQUEST: usize = 100;
        
        // Collect only missing signal names and draw_sig_ids from all tiles
        // Only request signals that are actually missing from cache
        let mut missing_signals_map: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for signals in tile_missing_signals.values() {
            for (signal_name, draw_sig_id) in signals {
                // Skip signals the server already told us don't exist, so we don't
                // keep hitting the server with doomed requests every render.
                if self.not_found_signals.contains(signal_name) {
                    continue;
                }
                missing_signals_map.insert(signal_name.clone(), *draw_sig_id);
            }
        }
        let missing_signal_names: Vec<String> = missing_signals_map.keys().cloned().collect();
        
        // console_log!("[WASM] Fetching {} missing signals from server (out of {} total)",
        //     missing_signal_names.len(), signals_to_fetch.len());
        
        for batch in missing_signal_names.chunks(MAX_BATCH_SIZE) {
            // Build server names, local names, and draw_sig_ids in the same order
            // Use a single pass to ensure order consistency
            let mut seen = std::collections::HashSet::new();
            let mut server_names: Vec<String> = Vec::new();
            let mut unique_local_names: Vec<String> = Vec::new();
            let mut unique_draw_sig_ids: Vec<u32> = Vec::new();
            
            for local_name in batch.iter() {
                let server_name = self.build_server_signal_name(local_name);
                // Only add if we haven't seen this server name before
                if seen.insert(server_name.clone()) {
                    server_names.push(server_name);
                    unique_local_names.push(local_name.clone());
                    // Get draw_sig_id from the map (should always exist)
                    if let Some(&draw_sig_id) = missing_signals_map.get(local_name) {
                        unique_draw_sig_ids.push(draw_sig_id);
                    }
                }
            }

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
                
                // Fetch batch data with a 404 (signal-not-found) fallback so a single
                // missing signal does not abort the whole render.
                self.fetch_tile_range(
                    lod,
                    start_time,
                    tile_span,
                    num_tiles as u64,
                    time_start,
                    time_end,
                    &server_names,
                    &unique_local_names,
                    &unique_draw_sig_ids,
                ).await?;
                
                tile_idx += num_tiles;
            }
        }
        
        // console_log!("[WASM] 3. finish fetching from server");
        // console_log!("[WASM] 4. finish store to OPFS");
        
        Ok(())
    }

    /// Fetch one tile range for a batch of signals, then parse and cache it.
    ///
    /// If the combined request fails with HTTP 404 (the server returns
    /// `SIGNAL_NOT_FOUND` for the *whole* batch as soon as any one signal is
    /// missing), fall back to fetching each signal individually. This isolates
    /// the missing signal(s) so the rest of the waveform still renders instead of
    /// the entire tab stalling. Signals that individually 404 are recorded in
    /// `not_found_signals` so they are skipped on subsequent renders.
    async fn fetch_tile_range(
        &mut self,
        lod: u32,
        start_time: u64,
        tile_span: u64,
        num_tiles: u64,
        time_start: u64,
        time_end: u64,
        server_names: &[String],
        local_names: &[String],
        draw_sig_ids: &[u32],
    ) -> Result<(), JsValue> {
        let names_batch = server_names.join(",");
        let encoded_batch = general_purpose::STANDARD.encode(&names_batch);
        let url = format!(
            "{}/api/wave/{}/lod/{}/tile/{}/{}/{}/compress/none/signals/b64:{}/data?time_stamp={}",
            self.server_url,
            self.waveform_name,
            lod,
            start_time,
            tile_span,
            num_tiles,
            encoded_batch,
            self.time_stamp
        );

        match fetch_data(&url).await {
            Ok(array_buffer) => {
                let uint8_array = js_sys::Uint8Array::new(&array_buffer);
                let mut bytes = vec![0u8; uint8_array.length() as usize];
                uint8_array.copy_to(&mut bytes);
                self.parse_multi_tile_response(&bytes, local_names, draw_sig_ids, time_start, time_end, tile_span).await?;
                Ok(())
            }
            Err(e) => {
                let msg = e.as_string().unwrap_or_default();
                if msg.contains("404") {
                    // console_log!(
                    //     "[WASM] Tile batch 404 (signal not found); falling back to per-signal fetch for {} signals",
                    //     server_names.len()
                    // );
                    for i in 0..server_names.len() {
                        let single = vec![server_names[i].clone()];
                        let enc = general_purpose::STANDARD.encode(single.join(",").as_str());
                        let u = format!(
                            "{}/api/wave/{}/lod/{}/tile/{}/{}/{}/compress/none/signals/b64:{}/data?time_stamp={}",
                            self.server_url,
                            self.waveform_name,
                            lod,
                            start_time,
                            tile_span,
                            num_tiles,
                            enc,
                            self.time_stamp
                        );
                        match fetch_data(&u).await {
                            Ok(ab) => {
                                let ua = js_sys::Uint8Array::new(&ab);
                                let mut b = vec![0u8; ua.length() as usize];
                                ua.copy_to(&mut b);
                                self.parse_multi_tile_response(
                                    &b,
                                    &[local_names[i].clone()],
                                    &[draw_sig_ids[i]],
                                    time_start,
                                    time_end,
                                    tile_span,
                                ).await?;
                            }
                            Err(e2) => {
                                let m2 = e2.as_string().unwrap_or_default();
                                // console_log!("[WASM] Signal not found, skipping: {} (err: {})", local_names[i], m2);
                                self.not_found_signals.insert(local_names[i].clone());
                            }
                        }
                    }
                    Ok(())
                } else {
                    Err(e)
                }
            }
        }
    }

    /// Fetch data and get segments in one call
    /// 
    /// This is a convenience function that combines fetch_signals_data_batch and get_segments
    /// to reduce JS-Rust boundary crossings and simplify the calling code.
    /// 
    /// # Arguments
    /// * `signal_names` - List of signal names to fetch and render
    /// 
    /// # Returns
    /// * Serialized RenderSegment array
    #[wasm_bindgen]
    pub async fn fetch_and_get_segments(&mut self, signal_names: Vec<String>) -> Result<JsValue, JsValue> {
        // console_log!("[WASM] 1. start fetch_and_get_segments, signals: {}", signal_names.len());
        
        // Render and prefetch can now run in parallel
        // OPFS operations are protected by global OPFS_LOCK in opfs_cache.rs
        
        // Step 1: Fetch data using the existing internal function
        self.fetch_signals_data_batch(signal_names).await?;
        
        // Step 2: Generate segments using the existing get_segments logic
        // console_log!("[WASM] 5. start draw segments");
        let result = self.get_segments();
        // console_log!("[WASM] 5. finish draw segments");
        
        result
    }

    /// Check if there are pending render requests in the worker queue
    /// This is called by prefetch to determine if it should yield
    fn has_pending_render_requests(&self) -> bool {
        // Access the global function exposed by the worker
        if let Ok(global) = js_sys::global().dyn_into::<js_sys::Object>() {
            if let Ok(func) = js_sys::Reflect::get(&global, &JsValue::from_str("hasPendingRenderRequests")) {
                if let Ok(func) = func.dyn_into::<js_sys::Function>() {
                    if let Ok(result) = func.call0(&JsValue::UNDEFINED) {
                        return result.as_bool().unwrap_or(false);
                    }
                }
            }
        }
        false
    }

    /// Prefetch tiles for the current viewport signals
    /// 
    /// This function prefetches tiles in the background to improve user experience.
    /// It checks tiles 4x before and after the current viewport, fetches missing data,
    /// and stores it in OPFS cache only (not in signal_data memory cache).
    /// 
    /// # Arguments
    /// * `signal_names` - List of signal names to prefetch (typically the current draw list)
    /// 
    /// # Returns
    /// * Ok(()) if prefetch completed (errors are logged but not returned)
    #[wasm_bindgen]
    pub async fn prefetch_tiles(&mut self, signal_names: Vec<String>) -> Result<(), JsValue> {
        // Skip if both OPFS and memory cache are disabled
        if !self.is_cache_enabled() {
            console_log!("[WASM] prefetch_tiles skipped: is_cache_enabled=false (enable_opfs={}, memory_cache_enabled={})",
                self.enable_opfs, self.opfs_cache.is_memory_cache_enabled());
            return Ok(());
        }

        // Skip if no signals
        if signal_names.is_empty() {
            return Ok(());
        }

        // Filter out bit extraction signals
        let signals_to_prefetch: Vec<String> = signal_names.iter()
            .filter(|name| !name.contains("@["))
            .cloned()
            .collect();

        if signals_to_prefetch.is_empty() {
            return Ok(());
        }

        // Get current LOD and calculate LOD range (current ± 2, within 0-32)
        let current_lod = self.current_lod.unwrap_or_else(|| select_lod(&self.viewport, self.canvas_width));
        let min_lod = current_lod.saturating_sub(2);
        let max_lod = (current_lod + 2).min(32);

        // console_log!("[WASM] Prefetch: current LOD {}, range [{}-{}]", current_lod, min_lod, max_lod);

        // Prefetch for each LOD in range
        for lod in min_lod..=max_lod {
            let tile_span = OpfsCacheManager::get_tile_span(lod);
            
            // Calculate tile range that covers current viewport for this LOD
            let current_start_tile = self.viewport.time_start as u64 / tile_span;
            let current_end_tile = self.viewport.time_end as u64 / tile_span;
            let current_tile_count = current_end_tile - current_start_tile + 1;

            // Calculate prefetch ranges: 4x for current LOD, 1x for other LODs
            let prefetch_multiplier = if lod == current_lod { 4 } else { 1 };
            let prefetch_range = prefetch_multiplier * current_tile_count;
            
            // Forward prefetch: [end_tile + 1, end_tile + prefetch_range]
            let forward_start = current_end_tile + 1;
            let forward_end = current_end_tile + prefetch_range;
            
            // Backward prefetch: [start_tile - prefetch_range, start_tile - 1]
            let backward_start = if current_start_tile >= prefetch_range {
                current_start_tile - prefetch_range
            } else {
                0
            };
            let backward_end = if current_start_tile > 0 {
                current_start_tile - 1
            } else {
                0
            };

            // console_log!("[WASM] Prefetch LOD {}: current tiles [{}-{}], forward [{}-{}], backward [{}-{}]",
            //     lod, current_start_tile, current_end_tile, forward_start, forward_end, backward_start, backward_end);

            // Prefetch forward tiles
            if forward_start <= forward_end {
                self.prefetch_tile_range(forward_start, forward_end, lod, tile_span, &signals_to_prefetch).await;
            }

            // Prefetch backward tiles
            if backward_start <= backward_end {
                self.prefetch_tile_range(backward_start, backward_end, lod, tile_span, &signals_to_prefetch).await;
            }
        }

        // console_log!("[WASM] Prefetch completed");
        Ok(())
    }

    /// Asynchronous prefetch that runs in a separate task without blocking render
    /// 
    /// This function spawns a local async task to perform prefetch, allowing
    /// render operations to continue in parallel.
    /// OPFS and Memory cache are shared between render and prefetch via Arc.
    /// 
    /// # Arguments
    /// * `signal_names` - List of signal names to prefetch
    #[wasm_bindgen]
    pub fn prefetch_tiles_async(&self, signal_names: Vec<String>) {
        console_log!("[WASM] Prefetch async started for {} signals", signal_names.len());
        
        // Clone necessary data for the async task
        let viewport = self.viewport.clone();
        let canvas_width = self.canvas_width;
        let current_lod = self.current_lod;
        let waveform_name = self.waveform_name.clone();
        let server_url = self.server_url.clone();
        let signal_prefix = self.signal_prefix.clone();
        let server_prefix = self.server_prefix.clone();
        let space_before_bracket = self.space_before_bracket;
        let time_stamp = self.time_stamp;
        let signals_with_id = self.signals_with_id.clone();
        let enable_opfs = self.enable_opfs;
        
        // Clone the Arc to share the same cache instance
        let opfs_cache = self.opfs_cache.clone();
        
        // Spawn the prefetch task
        wasm_bindgen_futures::spawn_local(async move {
            // Create a temporary provider for prefetch
            // It shares the same opfs_cache (both memory and OPFS) via Arc
            let mut prefetch_provider = WaveformDataProvider {
                server_url,
                waveform_name,
                signal_prefix,
                server_prefix,
                space_before_bracket,
                time_stamp,
                display_format: "hex".to_string(),
                signals: Vec::new(),
                viewport,
                canvas_width,
                canvas_height: 400.0,
                row_height: 24.0,
                signal_data: HashMap::new(),  // Independent signal_data (not shared)
                opfs_cache,  // Shared cache via Arc
                signals_with_id,
                enable_opfs,
                current_lod,
                display_unit_per_lod0_unit: 1.0,
                not_found_signals: std::collections::HashSet::new(),
            };
            
            // Execute prefetch
            let result = prefetch_provider.prefetch_tiles_internal(&signal_names).await;
            
            match result {
                Ok(_) => console_log!("[WASM] Prefetch async completed"),
                Err(e) => console_log!("[WASM] Prefetch async failed: {:?}", e),
            }
        });
    }

    /// Internal prefetch implementation (shared between sync and async)
    async fn prefetch_tiles_internal(&mut self, signal_names: &[String]) -> Result<(), JsValue> {
        // Skip if both OPFS and memory cache are disabled
        if !self.is_cache_enabled() {
            return Ok(());
        }

        // Skip if no signals
        if signal_names.is_empty() {
            return Ok(());
        }

        // Filter out bit extraction signals
        let signals_to_prefetch: Vec<String> = signal_names.iter()
            .filter(|name| !name.contains("@["))
            .cloned()
            .collect();

        if signals_to_prefetch.is_empty() {
            return Ok(());
        }

        // Get current LOD and calculate LOD range (current ± 2, within 0-32)
        let current_lod = self.current_lod.unwrap_or_else(|| select_lod(&self.viewport, self.canvas_width));
        let min_lod = current_lod.saturating_sub(2);
        let max_lod = (current_lod + 2).min(32);

        // Prefetch for each LOD in range
        for lod in min_lod..=max_lod {
            let tile_span = OpfsCacheManager::get_tile_span(lod);
            
            // Calculate tile range that covers current viewport for this LOD
            let current_start_tile = self.viewport.time_start as u64 / tile_span;
            let current_end_tile = self.viewport.time_end as u64 / tile_span;
            let current_tile_count = current_end_tile - current_start_tile + 1;

            // Calculate prefetch ranges: 4x for current LOD, 1x for other LODs
            let prefetch_multiplier = if lod == current_lod { 4 } else { 1 };
            let prefetch_range = prefetch_multiplier * current_tile_count;
            
            // Forward prefetch: [end_tile + 1, end_tile + prefetch_range]
            let forward_start = current_end_tile + 1;
            let forward_end = current_end_tile + prefetch_range;
            
            // Backward prefetch: [start_tile - prefetch_range, start_tile - 1]
            let backward_start = if current_start_tile >= prefetch_range {
                current_start_tile - prefetch_range
            } else {
                0
            };
            let backward_end = if current_start_tile > 0 {
                current_start_tile - 1
            } else {
                0
            };

            // Prefetch forward tiles
            if forward_start <= forward_end {
                self.prefetch_tile_range_internal(forward_start, forward_end, lod, tile_span, &signals_to_prefetch).await;
            }

            // Prefetch backward tiles
            if backward_start <= backward_end {
                self.prefetch_tile_range_internal(backward_start, backward_end, lod, tile_span, &signals_to_prefetch).await;
            }
        }

        Ok(())
    }

    /// Prefetch a specific tile range for given signals (original sync version)
    /// 
    /// This function:
    /// 1. Checks OPFS cache for each signal+tile combination
    /// 2. Collects missing tiles
    /// 3. Fetches missing data from server
    /// 4. Stores data in OPFS only (not in signal_data)
    async fn prefetch_tile_range(
        &mut self,
        start_tile: u64,
        end_tile: u64,
        lod: u32,
        tile_span: u64,
        signal_names: &[String],
    ) {
        self.prefetch_tile_range_internal(start_tile, end_tile, lod, tile_span, signal_names).await;
    }

    /// Internal implementation of prefetch_tile_range
    async fn prefetch_tile_range_internal(
        &mut self,
        start_tile: u64,
        end_tile: u64,
        lod: u32,
        tile_span: u64,
        signal_names: &[String],
    ) {
        // console_log!("[WASM] Prefetching tile range [{}-{}] for {} signals", start_tile, end_tile, signal_names.len());

        // Collect missing tiles and signals
        let mut tile_missing_signals: std::collections::HashMap<u64, Vec<(String, u32)>> = std::collections::HashMap::new();

        for tile_id in start_tile..=end_tile {
            for signal_name in signal_names {
                if let Some(draw_sig_id) = self.get_draw_sig_id(signal_name) {
                    let group_id = OpfsCacheManager::get_group_id(draw_sig_id);
                    let block = crate::opfs_cache::DataBlock {
                        lod,
                        tile: tile_id,
                        group: group_id,
                    };

                    // Check if signal exists in cache
                    let cache_hit = match self.opfs_cache.read(&block).await {
                        Ok(Some(data)) => {
                            match crate::opfs_cache::read_signal_from_group_v2(&data, draw_sig_id, lod) {
                                Ok(Some(_)) => true,
                                _ => false,
                            }
                        }
                        _ => false,
                    };

                    if !cache_hit {
                        tile_missing_signals.entry(tile_id)
                            .or_insert_with(Vec::new)
                            .push((signal_name.clone(), draw_sig_id));
                    }
                }
            }
        }

        if tile_missing_signals.is_empty() {
            // console_log!("[WASM] Prefetch: all data already cached for range [{}-{}]", start_tile, end_tile);
            return;
        }

        console_log!("[WASM] Prefetch: {} tiles need fetch from server for LOD {}", tile_missing_signals.len(), lod);

        // Fetch missing data from server
        self.fetch_missing_for_opfs_only(tile_missing_signals, lod, tile_span).await;
    }

    /// Fetch missing data from server and store only in OPFS (not in signal_data)
    /// 
    /// This is similar to fetch_signals_data_batch_internal but:
    /// 1. Only fetches specific missing tiles
    /// 2. Only stores to OPFS (not to signal_data memory cache)
    async fn fetch_missing_for_opfs_only(
        &mut self,
        tile_missing_signals: std::collections::HashMap<u64, Vec<(String, u32)>>,
        lod: u32,
        tile_span: u64,
    ) {
        const MAX_BATCH_SIZE: usize = 256;
        const MAX_TILES_PER_REQUEST: usize = 100;

        // Collect unique missing signals
        let mut missing_signals_map: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        for signals in tile_missing_signals.values() {
            for (signal_name, draw_sig_id) in signals {
                // Skip signals the server already told us don't exist, so we don't
                // keep hitting the server with doomed requests every render.
                if self.not_found_signals.contains(signal_name) {
                    continue;
                }
                missing_signals_map.insert(signal_name.clone(), *draw_sig_id);
            }
        }

        if missing_signals_map.is_empty() {
            return;
        }

        let missing_signal_names: Vec<String> = missing_signals_map.keys().cloned().collect();
        
        // console_log!("[WASM] Prefetch: fetching {} signals from server", missing_signal_names.len());

        // Get tile IDs sorted
        let mut tile_ids: Vec<u64> = tile_missing_signals.keys().cloned().collect();
        tile_ids.sort();

        // Fetch data in batches
        for batch in missing_signal_names.chunks(MAX_BATCH_SIZE) {
            // Build server names and local names
            let mut seen = std::collections::HashSet::new();
            let mut server_names: Vec<String> = Vec::new();
            let mut unique_local_names: Vec<String> = Vec::new();
            let mut unique_draw_sig_ids: Vec<u32> = Vec::new();

            for local_name in batch.iter() {
                let server_name = self.build_server_signal_name(local_name);
                if seen.insert(server_name.clone()) {
                    server_names.push(server_name);
                    unique_local_names.push(local_name.clone());
                    if let Some(&draw_sig_id) = missing_signals_map.get(local_name) {
                        unique_draw_sig_ids.push(draw_sig_id);
                    }
                }
            }

            // Join and encode signal names
            let names_batch = server_names.join(",");
            let encoded_batch = general_purpose::STANDARD.encode(&names_batch);

            // Group contiguous tiles
            let mut tile_idx = 0;
            while tile_idx < tile_ids.len() {
                let start_tile = tile_ids[tile_idx];
                let start_time = start_tile * tile_span;

                // Find contiguous tiles
                let mut num_tiles = 1;
                while tile_idx + num_tiles < tile_ids.len()
                    && tile_ids[tile_idx + num_tiles] == start_tile + num_tiles as u64
                    && num_tiles < MAX_TILES_PER_REQUEST {
                    num_tiles += 1;
                }

                // Build URL
                let url = format!("{}/api/wave/{}/lod/{}/tile/{}/{}/{}/compress/none/signals/b64:{}/data?time_stamp={}",
                    self.server_url,
                    self.waveform_name,
                    lod,
                    start_time,
                    tile_span,
                    num_tiles,
                    encoded_batch,
                    self.time_stamp);

                // Fetch data
                console_log!("[WASM] Prefetch: fetching from server - LOD {} tile {} num_tiles {} signals {}", lod, start_tile, num_tiles, unique_local_names.len());
                match fetch_data(&url).await {
                    Ok(array_buffer) => {
                        let uint8_array = js_sys::Uint8Array::new(&array_buffer);
                        let mut bytes = vec![0u8; uint8_array.length() as usize];
                        uint8_array.copy_to(&mut bytes);

                        // Store to OPFS using multi-tile response parser (same as normal render)
                        // Use a dummy viewport range since we only care about caching
                        let viewport_start = start_time;
                        let viewport_end = start_time + (num_tiles as u64 * tile_span);
                        match self.parse_multi_tile_response_for_prefetch(&bytes, &unique_local_names, &unique_draw_sig_ids, viewport_start, viewport_end, tile_span).await {
                            Ok(_) => {
                                console_log!("[WASM] Prefetch: successfully stored {} bytes to OPFS for tile {}", bytes.len(), start_tile);
                            }
                            Err(e) => {
                                console_log!("[WASM] Prefetch: error storing to OPFS: {:?}", e);
                            }
                        }
                    }
                    Err(e) => {
                        console_log!("[WASM] Prefetch: error fetching data: {:?}", e);
                        // Continue with next batch even if this one fails
                    }
                }

                tile_idx += num_tiles;
            }
        }

        // console_log!("[WASM] Prefetch: fetch completed for OPFS only");
    }

    // ============================================================================
    // Get Signal Values at Transitions - Main Implementation
    // ============================================================================

    /// Get raw signal values at all transition points within a time range
    /// 
    /// This function fetches LoD 0 data for the specified signals and time range,
    /// then returns all signal values at each transition point.
    /// 
    /// # Arguments
    /// * `signal_names` - List of signal names to query
    /// * `search_start_time` - Start of search range (inclusive)
    /// * `search_end_time` - End of search range (inclusive)
    /// * `result_max` - Maximum number of time points to return
    /// * `signals_with_format` - Signal list with display format for each signal
    /// 
    /// # Returns
    /// * Serialized RawSignalValuesResult
    #[wasm_bindgen]
    pub async fn get_signal_values_at_transitions(
        &mut self,
        signal_names: Vec<String>,
        search_start_time: u64,
        search_end_time: u64,
        result_max: usize,
        signals_with_format: JsValue,
        lod: Option<u32>,
        enable_opfs: Option<bool>,
        enable_memory_cache: Option<bool>,
        early_exit_on_insufficient_transitions: Option<bool>,
    ) -> Result<JsValue, JsValue> {
        
        // Apply cache settings if provided (override global settings for this call)
        let saved_enable_opfs = self.enable_opfs;
        let saved_enable_memory_cache = self.opfs_cache.is_memory_cache_enabled();
        
        if let Some(enabled) = enable_opfs {
            self.enable_opfs = enabled;
        }
        if let Some(enabled) = enable_memory_cache {
            self.opfs_cache.set_memory_cache_enabled(enabled);
        }
        
        // Parse signals_with_format from JS
        let signals_format: Vec<SignalWithFormat> = serde_wasm_bindgen::from_value(signals_with_format)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse signals_with_format: {:?}", e)))?;
        
        // Build format lookup map by signal name
        let format_map: HashMap<String, String> = signals_format
            .iter()
            .map(|s| (s.name.clone(), s.display_format.clone()))
            .collect();
        
        // Build width lookup map
        let width_map: HashMap<String, u32> = signals_format
            .iter()
            .map(|s| (s.name.clone(), s.width))
            .collect();
        
        // Step 1: Save current state
        let saved_viewport = self.viewport;
        let saved_lod = self.current_lod;
        
        // Determine LoD to use
        let requested_lod = lod.unwrap_or(0);
        let early_exit = early_exit_on_insufficient_transitions.unwrap_or(false);
        
        // Step 2: Set independent viewport for this query
        self.viewport = Viewport {
            time_start: search_start_time as f64,
            time_end: search_end_time as f64,
        };
        self.current_lod = Some(requested_lod);
        
        // Calculate tile span based on requested LoD
        let tile_span = OpfsCacheManager::get_tile_span(requested_lod);
        
        // Step 3: Fetch data in batches of 10 tiles at a time
        // This prevents requesting too much data at once and causing server timeout
        const TILES_PER_BATCH: u64 = 10;
        let start_tile = search_start_time / tile_span;
        let end_tile = search_end_time / tile_span;
        
        let mut all_times: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
        all_times.insert(search_start_time); // Always include start time
        
        let mut current_tile = start_tile;
        let mut real_transition_count = 0;
        let mut is_first_batch = true;
        
        while current_tile <= end_tile && all_times.len() < result_max {
            // Calculate batch range (10 tiles at a time)
            let batch_end_tile = (current_tile + TILES_PER_BATCH - 1).min(end_tile);
            let batch_start_time = current_tile * tile_span;
            let batch_end_time = (batch_end_tile + 1) * tile_span - 1;
            

            
            // Clear signal_data for this batch
            self.signal_data.clear();
            
            // Fetch this batch with custom time range
            if let Err(e) = self.fetch_signals_data_batch_internal(
                signal_names.clone(), 
                requested_lod, 
                Some((batch_start_time, batch_end_time))
            ).await {
                // Restore state before returning error
                self.viewport = saved_viewport;
                self.current_lod = saved_lod;
                return Err(e);
            }
            
            // Collect transition times from this batch
            for name in &signal_names {
                if let Some(data) = self.signal_data.get(name) {
                    if requested_lod > 0 {
                        // For LoD > 0: collect both first and last transition times from bucket_data
                        let bucket_size = 1u64 << requested_lod;
                        for (tile_start, buckets) in &data.bucket_data {
                            for (bucket_offset, bucket) in buckets {
                                let bucket_start_time = tile_start + (*bucket_offset as u64) * bucket_size;
                                
                                // Use actual_time from the first transition, not bucket start time
                                let first_actual_time = bucket.first.actual_time;
                                if first_actual_time >= search_start_time && first_actual_time <= search_end_time {
                                    all_times.insert(first_actual_time);
                                    real_transition_count += 1;
                                }
                                
                                // If has last transition (toggle), use its actual_time too
                                if let Some(ref last) = bucket.last {
                                    let last_actual_time = last.actual_time;
                                    if last_actual_time >= search_start_time && last_actual_time <= search_end_time {
                                        all_times.insert(last_actual_time);
                                        real_transition_count += 1;
                                    }
                                }
                            }
                        }
                    } else {
                        // For LoD 0: collect from transitions directly
                        for t in &data.transitions {
                            let transition_time = t.time;
                            
                            if transition_time >= search_start_time && transition_time <= search_end_time {
                                all_times.insert(transition_time);
                                
                                // Count real transitions (excluding start value marker)
                                const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
                                if t.time != BOUNDARY_TIME_START {
                                    real_transition_count += 1;
                                }
                            }
                        }
                    }
                }
            }
            
            // Early exit check after first batch if enabled
            if early_exit && is_first_batch {
                is_first_batch = false;
                if real_transition_count < 2 {
                    break;
                }
            }
            
            // Move to next batch
            current_tile = batch_end_tile + 1;
        }
        
        // Step 4: Build result for each time point (limited by result_max)
        let times: Vec<u64> = all_times.into_iter().take(result_max).collect();
        
        // Calculate actual search time range from collected transitions (before consuming times)
        let actual_search_start_time = times.first().copied().unwrap_or(search_start_time);
        let actual_search_end_time = times.last().copied().unwrap_or(search_end_time);
        
        let mut result_data = Vec::new();
        
        // We need to re-fetch data to get all values for the collected times
        // First, fetch the full range (or we could optimize by fetching only needed tiles)
        self.signal_data.clear();
        
        // Calculate the tiles needed for the collected times
        if !times.is_empty() {
            let min_time = *times.first().unwrap();
            let max_time = *times.last().unwrap();
            let min_tile = min_time / tile_span;
            let max_tile = max_time / tile_span;
            
            if let Err(e) = self.fetch_signals_data_batch_internal(
                signal_names.clone(), 
                requested_lod, 
                Some((min_time, max_time))
            ).await {
                self.viewport = saved_viewport;
                self.current_lod = saved_lod;
                return Err(e);
            }
        }
        
        for time in times {
            let mut values = Vec::new();
            let mut has_any_transition = false;
            
            for name in &signal_names {
                let (transition, has_transition, has_toggle) = self.find_value_at_time_in_signal(name, time, requested_lod);
                
                // Track if any signal has a transition at this time
                if has_transition {
                    has_any_transition = true;
                }
                
                // Get signal width
                let width = *width_map.get(name).unwrap_or(&1);
                
                // Get display format
                let display_format = format_map.get(name).map(|s| s.as_str()).unwrap_or("hex");
                
                // Format the value
                let display_str = self.format_value_with_format(&transition, width, display_format);
                
                // Classify value type
                let value_type = Self::classify_value_type(&display_str);
                
                values.push(RawValue {
                    display_str,
                    value_type: value_type.to_string(),
                    has_transition,
                    has_toggle,
                });
            }
            
            // Skip rows that only contain start values (no transitions at all)
            if !has_any_transition {
                continue;
            }
            
            // Convert time from LoD0 units to display units for display
            // Divide by display_unit_per_lod0_unit to get display units
            let display_time = (time as f64 / self.display_unit_per_lod0_unit) as u64;
            
            result_data.push(RawSignalValuesAtTime { time: display_time, values });
        }
        
        // Step 5: Restore state
        self.viewport = saved_viewport;
        self.current_lod = saved_lod;
        
        // Step 8: Restore cache settings
        self.enable_opfs = saved_enable_opfs;
        self.opfs_cache.set_memory_cache_enabled(saved_enable_memory_cache);
        
        // Step 9: Build and return result
        // search_start_time and search_end_time remain in LoD0 units (internal use)
        // Only time column in data is converted to display units for user display
        let result = RawSignalValuesResult {
            search_start_time: actual_search_start_time,
            search_end_time: actual_search_end_time,
            data: result_data,
        };
        
        serde_wasm_bindgen::to_value(&result)
            .map_err(|e| JsValue::from_str(&format!("Failed to serialize result: {:?}", e)))
    }

    /// Find the value of a signal at a specific time
    /// Returns (transition, has_transition_at_exact_time, has_toggle)
    fn find_value_at_time_in_signal(
        &self,
        signal_name: &str,
        target_time: u64,
        requested_lod: u32,
    ) -> (Transition, bool, bool) {
        let default_transition = Transition {
            time: 0,
            actual_time: 0,
            value_type: 0,
            value_len: 1,
            value: vec![b'0'],
        };
        
        let signal_data = match self.signal_data.get(signal_name) {
            Some(data) => data,
            None => {
                // web_sys::console::log_1(&JsValue::from_str(&format!(
                //     "[WASM] Signal not found: {}", signal_name
                // )));
                return (default_transition, false, false);
            }
        };
        
        // For LoD > 0: find value from bucket_data using actual_time
        if requested_lod > 0 {
            // First, check if target_time matches exactly a first or last transition's actual_time
            for (tile_start, buckets) in &signal_data.bucket_data {
                for (bucket_offset, bucket) in buckets {
                    let first_actual_time = bucket.first.actual_time;
                    let has_toggle = bucket.last.is_some();
                    
                    // Check if target_time matches first transition's actual_time
                    if target_time == first_actual_time {
                        let mut first_trans = bucket.first.clone();
                        return (first_trans, true, has_toggle);
                    }
                    
                    // Check if target_time matches last transition's actual_time
                    if has_toggle {
                        if let Some(ref last) = bucket.last {
                            let last_actual_time = last.actual_time;
                            if target_time == last_actual_time {
                                let mut last_trans = last.clone();
                                return (last_trans, true, has_toggle);
                            }
                        }
                    }
                }
            }
            
            // If no exact match, find the most recent transition before target_time
            // Search all buckets in all tiles using actual_time
            let mut most_recent_trans: Option<(u64, Transition, bool)> = None;
            
            for (tile_start, buckets) in &signal_data.bucket_data {
                for (bucket_offset, bucket) in buckets {
                    let has_toggle = bucket.last.is_some();
                    
                    // Check first transition using actual_time
                    let first_actual_time = bucket.first.actual_time;
                    if first_actual_time < target_time {
                        if most_recent_trans.is_none() || first_actual_time > most_recent_trans.as_ref().unwrap().0 {
                            let trans = bucket.first.clone();
                            most_recent_trans = Some((first_actual_time, trans, has_toggle));
                        }
                    }
                    
                    // Check last transition using actual_time (if exists)
                    if has_toggle {
                        if let Some(ref last) = bucket.last {
                            let last_actual_time = last.actual_time;
                            if last_actual_time < target_time {
                                if most_recent_trans.is_none() || last_actual_time > most_recent_trans.as_ref().unwrap().0 {
                                    let trans = last.clone();
                                    most_recent_trans = Some((last_actual_time, trans, has_toggle));
                                }
                            }
                        }
                    }
                }
            }
            
            if let Some((_, trans, has_toggle)) = most_recent_trans {
                return (trans, false, has_toggle);
            }
            
            // If no transition found, use tile start value
            for (tile_start, tile_end, _start_time, start_value) in &signal_data.tile_info {
                if target_time >= *tile_start && target_time <= *tile_end {
                    let mut start_trans = start_value.clone();
                    start_trans.actual_time = target_time;
                    return (start_trans, false, false);
                }
            }
            
            return (default_transition, false, false);
        }
        
        // For LoD 0: use the original logic with transitions
        let mut has_toggle = false;
        
        // Check for exact match
        let mut found_transition = None;
        
        for (idx, t) in signal_data.transitions.iter().enumerate() {
            if t.time == target_time {
                found_transition = Some((idx, true));
                break;
            }
        }
        
        if let Some((idx, is_exact)) = found_transition {
            return (signal_data.transitions[idx].clone(), is_exact, has_toggle);
        }
        
        // Find most recent transition before target_time
        let mut most_recent: Option<&Transition> = None;
        for t in signal_data.transitions.iter() {
            if t.time < target_time {
                most_recent = Some(t);
            }
        }
        
        if let Some(trans) = most_recent {
            return (trans.clone(), false, has_toggle);
        }
        
        // Use tile start value
        for (tile_start, tile_end, _start_time, start_value) in &signal_data.tile_info {
            if target_time >= *tile_start && target_time <= *tile_end {
                return (start_value.clone(), false, has_toggle);
            }
        }
        
        // Default to '0'
        (default_transition, false, has_toggle)
    }

    /// Format a transition value with the specified display format
    /// Uses the same approach as render functions: convert to string first, then format
    fn format_value_with_format(
        &self,
        transition: &Transition,
        width: u32,
        display_format: &str,
    ) -> String {
        // Convert raw bytes to string first (same as render functions)
        let raw_str = server_value_to_string(
            transition.value_type,
            transition.value_len,
            &transition.value,
        );
        
        // For single-bit signals, return as-is
        if width == 1 {
            return raw_str;
        }
        
        // For multi-bit signals, use the same formatting as render functions
        self.format_multi_bit_value(&raw_str, width, Some(display_format))
    }

    /// Classify value type based on display string
    fn classify_value_type(display_str: &str) -> &'static str {
        // For hex values like "0x1234", we should not count the "0x" prefix as containing 'x'
        // Check if it's a hex prefix and skip it for X/Z detection
        let check_str = if display_str.starts_with("0x") || display_str.starts_with("0X") {
            &display_str[2..]
        } else {
            display_str
        };
        
        let has_x = check_str.contains('X') || check_str.contains('x');
        let has_z = check_str.contains('Z') || check_str.contains('z');
        
        match (has_x, has_z) {
            (true, true) => "mixed",
            (true, false) => "has_x",
            (false, true) => "has_z",
            (false, false) => "numeric",
        }
    }

    /// Parse multi-tile response and process each tile
    /// signal_names and draw_sig_ids must be in the same order (parallel arrays)
    async fn parse_multi_tile_response(
        &mut self,
        data: &[u8],
        signal_names: &[String],
        draw_sig_ids: &[u32],
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
            // Use draw_sig_ids directly instead of looking up from signal_names
            self.process_server_chunk_with_ids(tile_data, signal_names, draw_sig_ids).await?;
        }
        
        Ok(())
    }

    /// Parse multi-tile response for prefetch - only stores to OPFS, no memory parsing
    /// This is a lightweight version that doesn't load data into signal_data
    async fn parse_multi_tile_response_for_prefetch(
        &mut self,
        data: &[u8],
        signal_names: &[String],
        draw_sig_ids: &[u32],
        _viewport_start: u64,
        _viewport_end: u64,
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
        
        // Process each tile - only store to OPFS, don't parse to memory
        for (tile_idx, offset) in tile_offsets.iter().enumerate() {
            // Extract tile data (from offset to next tile or end of data)
            let tile_end_offset = if tile_idx + 1 < tile_offsets.len() {
                tile_offsets[tile_idx + 1]
            } else {
                data.len() as u64
            };
            
            let tile_data = &data[*offset as usize..tile_end_offset as usize];
            
            // Store in OPFS cache only (no memory parsing for prefetch)
            self.process_server_chunk_with_ids(tile_data, signal_names, draw_sig_ids).await?;
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

        // console_log!("[WASM] Chunk for batch: level={}, signals={}, time={}-{}",
        //     header.level, header.signal_count, header.time_start, header.time_end);

        if header.signal_count as usize != batch.len() {
            // console_log!("[WASM] Warning: Chunk signal count ({}) != batch size ({})",
            //     header.signal_count, batch.len());
        }

        // Parse each signal block
        let mut offset = ChunkHeader::SIZE;
        let chunk_version = header.version;
        
        for signal_idx in 0..header.signal_count.min(batch.len() as u32) {
            let block_header_size = if chunk_version >= 2 { 
                SignalBlockHeader::SIZE_V2 
            } else { 
                SignalBlockHeader::SIZE_V1 
            };
            
            if offset + block_header_size > data.len() {
                // console_log!("[WASM] Warning: Not enough data for signal block {}", signal_idx);
                break;
            }

            // Parse signal block header (pass version)
            let block_header = SignalBlockHeader::from_bytes(&data[offset..], chunk_version)
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

                // Store LoD 1+ signal data (merge buckets if tile exists)
                self.store_lod1_signal_data(
                    signal_name,
                    Some(width),
                    tile_start,
                    tile_end,
                    start_value,
                    buckets,
                    true, // merge_buckets = true for server fetch
                );
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

                // Store LoD 0 signal data
                self.store_lod0_signal_data(
                    signal_name,
                    Some(width),
                    tile_start,
                    tile_end,
                    start_value,
                    filtered_transitions,
                );
            }

            offset += block_header_size;
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

        // Filter normal transitions within viewport.
        //
        // IMPORTANT (LoD 0 / cache bug):
        // For LoD 0 the cache format stores `time = 0` (only `actual_time` is
        // persisted, see opfs_cache.rs serialize/read_group_data_v2). The server
        // path, by contrast, sets `time == actual_time` for LoD 0. Filtering on
        // `t.time` therefore silently drops every transition when the data comes
        // from the OPFS/memory cache (0 >= tile_start is always false), which is
        // exactly why zooming to LoD 0 with cache enabled renders no transitions.
        // `process_tile_transitions` is only ever called for LoD 0 (both callers
        // guard on lod/level == 0), so filtering on `actual_time` is correct for
        // every caller: server path has time == actual_time anyway, and the cache
        // path keeps the real timestamp in `actual_time`.
        let normal_transitions: Vec<Transition> = transitions.into_iter()
            .filter(|t| {
                if t.time == BOUNDARY_TIME_START {
                    return false;
                }
                let at = t.actual_time;
                at >= viewport_start && at <= viewport_end
            })
            .collect();

        // [DEBUG] LoD 0 transition filtering diagnostic
        console_log!(
            "[WASM][DEBUG] process_tile_transitions: viewport=[{},{}], start_value={}, normal_transitions={}",
            viewport_start, viewport_end,
            if start_value.is_some() { "some" } else { "none" },
            normal_transitions.len()
        );

        (start_value, normal_transitions)
    }

    /// Store LoD 0 signal data (transitions and tile_info) into signal_data
    /// 
    /// # Arguments
    /// * `signal_name` - Name of the signal
    /// * `width` - Signal width (if None, will be looked up from signal info)
    /// * `tile_start` - Start time of the tile
    /// * `tile_end` - End time of the tile
    /// * `start_value` - Optional start value transition
    /// * `filtered_transitions` - Filtered transitions within viewport
    fn store_lod0_signal_data(
        &mut self,
        signal_name: &str,
        width: Option<u32>,
        tile_start: u64,
        tile_end: u64,
        start_value: Option<Transition>,
        filtered_transitions: Vec<Transition>,
    ) {
        if let Some(existing_data) = self.signal_data.get_mut(signal_name) {
            // Append filtered transitions
            existing_data.transitions.extend(filtered_transitions);
            existing_data.transitions.sort_by_key(|t| t.time);
            // Store tile info
            if let Some(sv) = start_value {
                existing_data.tile_info.push((tile_start, tile_end, sv.time, sv));
            }
        } else {
            let width = width.unwrap_or_else(|| self.get_signal_width(signal_name));
            let mut signal_data = SignalWaveData::new(signal_name.to_string(), width);
            signal_data.transitions = filtered_transitions;
            // Store tile info
            if let Some(sv) = start_value {
                signal_data.tile_info.push((tile_start, tile_end, sv.time, sv));
            }
            self.signal_data.insert(signal_name.to_string(), signal_data);
        }
    }

    /// Store LoD 1+ signal data (bucket_data and tile_info) into signal_data
    ///
    /// # Arguments
    /// * `signal_name` - Name of the signal
    /// * `width` - Signal width (if None, will be looked up from signal info)
    /// * `tile_start` - Start time of the tile
    /// * `tile_end` - End time of the tile
    /// * `start_value` - Optional start value transition
    /// * `buckets` - Bucket data (offset -> BucketData map)
    /// * `merge_buckets` - If true, merge with existing buckets; if false, skip if tile exists
    fn store_lod1_signal_data(
        &mut self,
        signal_name: &str,
        width: Option<u32>,
        tile_start: u64,
        tile_end: u64,
        start_value: Option<Transition>,
        buckets: HashMap<u16, BucketData>,
        merge_buckets: bool,
    ) {
        if let Some(existing_data) = self.signal_data.get_mut(signal_name) {
            // Check if this tile already exists
            let tile_exists = existing_data.bucket_data.iter().any(|(ts, _)| *ts == tile_start);

            if tile_exists {
                if merge_buckets {
                    // Merge with existing buckets for this tile
                    if let Some((_, existing_buckets)) = existing_data.bucket_data.iter_mut()
                        .find(|(start, _)| *start == tile_start) {
                        for (offset, bucket) in buckets {
                            existing_buckets.insert(offset, bucket);
                        }
                    }
                }
                // If not merge_buckets, skip (do nothing)
            } else {
                // Add new tile bucket data
                existing_data.bucket_data.push((tile_start, buckets));
            }

            // Store start value in tile_info for compatibility
            if let Some(sv) = start_value {
                existing_data.tile_info.push((tile_start, tile_end, BOUNDARY_TIME_START, sv));
            }
        } else {
            let width = width.unwrap_or_else(|| self.get_signal_width(signal_name));
            let mut signal_data = SignalWaveData::new(signal_name.to_string(), width);
            signal_data.bucket_data.push((tile_start, buckets));
            if let Some(sv) = start_value {
                signal_data.tile_info.push((tile_start, tile_end, BOUNDARY_TIME_START, sv));
            }
            self.signal_data.insert(signal_name.to_string(), signal_data);
        }
    }

    /// Parse chunk binary data for single signal (legacy method)
    fn parse_chunk_data(&mut self, signal_name: &str, data: &[u8]) -> Result<(), JsValue> {
        // Parse header
        let header = ChunkHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;

        // console_log!("[WASM] Chunk: level={}, signals={}, time={}-{}",
        //     header.level, header.signal_count, header.time_start, header.time_end);

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
        let chunk_version = header.version;

        // Parse each signal block
        for signal_idx in 0..header.signal_count {
            let block_header_size = if chunk_version >= 2 { 
                SignalBlockHeader::SIZE_V2 
            } else { 
                SignalBlockHeader::SIZE_V1 
            };
            
            if offset + block_header_size > data.len() {
                // console_log!("[WASM] Warning: Not enough data for signal block {}", signal_idx);
                break;
            }

            // Parse signal block header (pass version)
            let block_header = SignalBlockHeader::from_bytes(&data[offset..], chunk_version)
                .map_err(|e| JsValue::from_str(&e))?;

            // console_log!("[WASM] Signal block {}: handle={}, transitions={}",
            //     signal_idx, block_header.signal_handle, block_header.transition_count);

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

            offset += block_header_size;
        }

        Ok(())
    }

    /// Parse single signal chunk
    fn parse_single_signal_chunk(&mut self, signal_name: &str, data: &[u8], header: &ChunkHeader) -> Result<(), JsValue> {
        let chunk_version = header.version;
        let block_header_size = if chunk_version >= 2 { 
            SignalBlockHeader::SIZE_V2 
        } else { 
            SignalBlockHeader::SIZE_V1 
        };
        
        if data.len() < ChunkHeader::SIZE + block_header_size {
            // console_log!("[WASM] Error: Not enough data for single signal chunk, got {} bytes", data.len());
            return Err(JsValue::from_str("Not enough data for single signal chunk"));
        }

        // Parse signal block header (pass version)
        let block_header = SignalBlockHeader::from_bytes(&data[ChunkHeader::SIZE..], chunk_version)
            .map_err(|e| JsValue::from_str(&e))?;

        // console_log!("[WASM] Single signal block: handle={}, transitions={}",
        //     block_header.signal_handle, block_header.transition_count);

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
    /// v1 API:
    ///   - Time array: [start_time(u64), t0(u64), t1(u64), ...] (start_time = 0xFFFFFFFFFFFFFFFF)
    ///   - Value array: [start_value, value0, value1, ...]
    /// v2 API:
    ///   - Time array: [start_time(u64), bucket_idx0(u16), bucket_idx1(u16), ...] (LoD > 0)
    ///   - Transition time array (optional): [actual_time0(u64), actual_time1(u64), ...]
    ///   - Value array: [start_value, value0, value1, ...]
    /// - transition_count only counts actual transitions, not including start value
    fn parse_transitions_from_block(
        &self,
        data: &[u8],
        block_header: &SignalBlockHeader,
        chunk_header: &ChunkHeader,
        _signal_index: usize,
    ) -> Result<Vec<Transition>, JsValue> {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        let mut transitions = Vec::new();
        let lod = chunk_header.level;
        let is_v2 = chunk_header.version >= 2;
        let has_transition_time_array = is_v2 && block_header.transition_time_array_offset > 0;

        // Calculate offsets based on SignalBlockHeader
        // Note: time_array_offset and value_array_offset are ABSOLUTE from start of chunk
        // NOT relative to data_area_start
        let time_array_start = block_header.time_array_offset as usize;
        let value_array_start = block_header.value_array_offset as usize;
        let transition_time_array_start = if has_transition_time_array {
            block_header.transition_time_array_offset as usize
        } else {
            0
        };

        // First, read the start value (bucket index = u16::MAX for v2/LoD>0, or u64::MAX for v1/LoD0)
        // Start value is always present and comes first in the arrays
        let is_start_value = if lod == 0 {
            // LoD 0: time is u64
            if time_array_start + 8 <= data.len() {
                let start_time = u64::from_le_bytes([
                    data[time_array_start], data[time_array_start + 1],
                    data[time_array_start + 2], data[time_array_start + 3],
                    data[time_array_start + 4], data[time_array_start + 5],
                    data[time_array_start + 6], data[time_array_start + 7],
                ]);
                start_time == BOUNDARY_TIME_START
            } else {
                false
            }
        } else if is_v2 {
            // v2 API, LoD > 0: bucket index is u16, start value is u16::MAX
            if time_array_start + 2 <= data.len() {
                let start_bucket_idx = u16::from_le_bytes([data[time_array_start], data[time_array_start + 1]]);
                start_bucket_idx == u16::MAX
            } else {
                false
            }
        } else {
            // v1 API, LoD > 0: bucket index is stored as u64
            if time_array_start + 8 <= data.len() {
                let start_time = u64::from_le_bytes([
                    data[time_array_start], data[time_array_start + 1],
                    data[time_array_start + 2], data[time_array_start + 3],
                    data[time_array_start + 4], data[time_array_start + 5],
                    data[time_array_start + 6], data[time_array_start + 7],
                ]);
                start_time == BOUNDARY_TIME_START
            } else {
                false
            }
        };

        // Parse start value if marker found
        if is_start_value {
            // Parse start value from value array
            let mut value_idx = value_array_start;
            if value_idx + 3 <= data.len() {
                let _value_type = data[value_idx];
                let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
                value_idx += 3;

                if value_idx + value_len <= data.len() {
                    let value = data[value_idx..value_idx + value_len].to_vec();

                    // Add start value transition with special time marker (always use u64::MAX internally)
                    transitions.push(Transition {
                        time: BOUNDARY_TIME_START,
                        actual_time: BOUNDARY_TIME_START,
                        value_type: _value_type,
                        value_len: value_len as u16,
                        value,
                    });
                }
            }
        }

        // Then, read the actual transitions (transition_count of them)
        // They start at index 1 in the time array (after start value)
        let mut value_idx = value_array_start;
        // Skip start value in value array
        if value_idx + 3 <= data.len() {
            let _value_type = data[value_idx];
            let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
            value_idx += 3 + value_len;
        }

        for i in 0..block_header.transition_count {
            // Parse value first (same for v1 and v2)
            if value_idx + 3 > data.len() {
                break;
            }

            let value_type = data[value_idx];
            let value_len = u16::from_le_bytes([data[value_idx + 1], data[value_idx + 2]]) as usize;
            value_idx += 3;

            if value_idx + value_len > data.len() {
                break;
            }

            let value = data[value_idx..value_idx + value_len].to_vec();
            value_idx += value_len;

            // Parse time based on API version and LoD
            let time: u64;
            let actual_time: u64;

            if lod == 0 {
                // LoD 0: always u64 time (absolute timestamp)
                let time_idx = time_array_start + ((i + 1) as usize * 8);
                if time_idx + 8 > data.len() {
                    break;
                }
                time = u64::from_le_bytes([
                    data[time_idx], data[time_idx + 1], data[time_idx + 2], data[time_idx + 3],
                    data[time_idx + 4], data[time_idx + 5], data[time_idx + 6], data[time_idx + 7],
                ]);
                // For LoD 0, actual_time is same as time
                actual_time = time;
            } else if is_v2 {
                // v2 API, LoD > 0: bucket index is u16 (0-255)
                // time_array_offset points to u16 array: [u16::MAX (start), bucket_idx0, bucket_idx1, ...]
                let time_idx = time_array_start + 2 + ((i as usize) * 2); // +2 to skip u16 start marker
                if time_idx + 2 > data.len() {
                    break;
                }
                let bucket_idx = u16::from_le_bytes([data[time_idx], data[time_idx + 1]]);
                // Handle u16::MAX (0xFFFF) as start value marker (convert to u64::MAX)
                // Otherwise use bucket index as time for first/last pairing
                time = if bucket_idx == u16::MAX {
                    u64::MAX
                } else {
                    bucket_idx as u64
                };

                // Read actual transition time from transition_time_array (v2 API)
                if has_transition_time_array {
                    let actual_time_idx = transition_time_array_start + ((i + 1) as usize * 8); // +8 to skip start marker
                    if actual_time_idx + 8 <= data.len() {
                        actual_time = u64::from_le_bytes([
                            data[actual_time_idx], data[actual_time_idx + 1],
                            data[actual_time_idx + 2], data[actual_time_idx + 3],
                            data[actual_time_idx + 4], data[actual_time_idx + 5],
                            data[actual_time_idx + 6], data[actual_time_idx + 7],
                        ]);
                    } else {
                        // Fallback: calculate from bucket index
                        actual_time = chunk_header.time_start + (time * (1u64 << lod));
                    }
                } else {
                    // Fallback: calculate from bucket index
                    actual_time = chunk_header.time_start + (time * (1u64 << lod));
                }
            } else {
                // v1 API, LoD > 0: bucket index was stored as u64 (but values are 0-255)
                let time_idx = time_array_start + ((i + 1) as usize * 8);
                if time_idx + 8 > data.len() {
                    break;
                }
                let bucket_idx = u64::from_le_bytes([
                    data[time_idx], data[time_idx + 1], data[time_idx + 2], data[time_idx + 3],
                    data[time_idx + 4], data[time_idx + 5], data[time_idx + 6], data[time_idx + 7],
                ]);
                time = bucket_idx;
                // For v1, calculate actual_time from bucket index
                actual_time = chunk_header.time_start + (time * (1u64 << lod));
            }

            transitions.push(Transition {
                time,
                actual_time,
                value_type,
                value_len: value_len as u16,
                value,
            });
        }

        if transitions.is_empty() {
            // Fallback: create at least one transition
            transitions.push(Transition {
                time: chunk_header.time_start,
                actual_time: chunk_header.time_start,
                value_type: 0,
                value_len: 1,
                value: vec![b'0'],
            });
        }

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
    ) -> (Option<Transition>, HashMap<u16, BucketData>) {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        
        let mut start_value: Option<Transition> = None;
        let mut buckets: HashMap<u16, BucketData> = HashMap::new();
        let mut pending_first: Option<(u16, Transition)> = None;
        
        // Debug: Print all transitions (disabled)
        // if !transitions.is_empty() {
        //     console_log!("[WASM] parse_buckets_from_transitions: {} transitions", transitions.len());
        //     for (i, t) in transitions.iter().enumerate() {
        //         let val = String::from_utf8_lossy(&t.value);
        //         if t.time == BOUNDARY_TIME_START {
        //             console_log!("[WASM]   Transition[{}]: time=MAX (start_value), value={}", i, val);
        //         } else {
        //             console_log!("[WASM]   Transition[{}]: time={}, value={}", i, t.time, val);
        //         }
        //     }
        // }
        
        for transition in transitions {
            // Check for start value (boundary time)
            if transition.time == BOUNDARY_TIME_START {
                start_value = Some(transition.clone());
                continue;
            }
            
            // For LoD 1+, time is bucket offset (0-255)
            let offset = transition.time as u16;
            
            match pending_first {
                None => {
                    // No pending first, this is a first transition
                    pending_first = Some((offset, transition.clone()));
                }
                Some((pending_offset, first_trans)) => {
                    if offset == pending_offset {
                        // Same offset: this is the last transition (first/last pair)
                        let bucket = BucketData {
                            offset: pending_offset,
                            first: first_trans,
                            last: Some(transition.clone()),
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
                        pending_first = Some((offset, transition.clone()));
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
        
        // Debug: Print generated buckets (disabled)
        // if !buckets.is_empty() {
        //     console_log!("[WASM] parse_buckets_from_transitions: {} buckets generated", buckets.len());
        //     for (offset, bucket) in &buckets {
        //         let first_val = String::from_utf8_lossy(&bucket.first.value);
        //         let last_info = if let Some(ref last) = bucket.last {
        //             format!(", last={}", String::from_utf8_lossy(&last.value))
        //         } else {
        //             ", last=None".to_string()
        //         };
        //         console_log!("[WASM]   Bucket[{}]: first={}{}", offset, first_val, last_info);
        //     }
        // }
        
        (start_value, buckets)
    }

    /// Get render segments for current viewport
    /// 
    /// This is an internal function, use fetch_and_get_segments for JS calls
    fn get_segments(&self) -> Result<JsValue, JsValue> {
        // Optimization: if no signals to draw, return empty segments early
        if self.signals.is_empty() {
            // console_log!("[WASM] get_segments: no signals to draw, returning empty segments");
            return serde_wasm_bindgen::to_value(&Vec::<RenderSegment>::new())
                .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)));
        }

        let mut segments = Vec::new();
        let time_range = self.viewport.time_end - self.viewport.time_start;

        for signal in self.signals.iter() {
            // Use signal.row provided by UI (accounts for group headers)
            let y = 20.0 + signal.row as f64 * self.row_height + self.row_height / 2.0;
            let display_format = signal.display_format.as_deref();

            // Check if this is a bit extraction signal
            if let Some((ref parent_name, (msb, lsb))) = signal.bit_extract {
                // Get parent signal data
                if let Some(parent_data) = self.signal_data.get(parent_name) {
                    let width = if msb == lsb { 1 } else { msb - lsb + 1 };
                    let lod = self.current_lod.unwrap_or(0);
                    
                    // LoD 1+: Use bucket data format
                    if lod > 0 {
                        // Extract bits from bucket data
                        let extracted_buckets = self.extract_bits_from_buckets(
                            &parent_data.bucket_data, parent_data.width, msb, lsb);
                        
                        // Generate segments from extracted bucket data
                        self.generate_lod_segments_from_buckets(
                            &extracted_buckets,
                            width,
                            y,
                            &signal.name,
                            time_range,
                            &mut segments,
                            display_format,
                        );
                    } else {
                        // LoD 0: Extract bits from transitions (even if empty)
                        let extracted_transitions = self.extract_bits_from_transitions(
                            &parent_data.transitions, parent_data.width, msb, lsb);
                        // For bit-extracted signals, pass empty tile_info (start value not available)
                        self.generate_normal_segments(&extracted_transitions, width, y, &signal.name,
                            time_range, &mut segments, display_format, &[]);
                    }
                }
                continue;
            }

            if let Some(data) = self.signal_data.get(&signal.name) {
                // Determine which format to use based on current LoD
                let lod = self.current_lod.unwrap_or(0);
                
                if lod > 0 {
                    // LoD 1+: Use bucket-based segment generation
                    self.generate_lod_segments_from_buckets(
                        &data.bucket_data,
                        data.width,
                        y,
                        &signal.name,
                        time_range,
                        &mut segments,
                        display_format,
                    );
                } else {
                    // LoD 0: Use transitions format
                    self.generate_normal_segments(&data.transitions, data.width, y, &signal.name,
                        time_range, &mut segments, display_format, &data.tile_info);
                }
            }
        }

        serde_wasm_bindgen::to_value(&segments)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
    }

    /// Detect if transitions are in LoD bucket format (First/Last format)
    /// Returns true if actual_time values are small (0-255), indicating bucket offsets
    /// Note: For LoD 1+ data stored in OPFS, actual_time contains the real timestamp,
    /// but for the format detection we check if it's in the bucket offset range
    fn detect_lod_bucket_format(&self, transitions: &[Transition]) -> bool {
        const BOUNDARY_TIME_START: u64 = 0xFFFFFFFFFFFFFFFF;
        
        if transitions.len() < 2 {
            return false;
        }
        
        // Check first few non-boundary transitions
        // For LoD 1+ bucket format, time field contains bucket index (0-255)
        // For LoD 0, time field contains actual timestamp (which could be any value)
        // We use time field (not actual_time) for format detection
        let mut checked = 0;
        for t in transitions.iter() {
            if t.time == BOUNDARY_TIME_START {
                continue;
            }
            // If time is small (0-255), it's likely a bucket offset (LoD 1+)
            // If time is large, it's likely LoD 0 with actual timestamp
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
            // console_log!("[WASM] detect_min_max_format: transitions.len() < 2, returning false");
            return false;
        }
        
        // Skip boundary value (first transition with time = BOUNDARY_TIME_START)
        // and check remaining transitions for same timestamp pattern (min/max pairs)
        let start_idx = if transitions[0].time == BOUNDARY_TIME_START {
            1
        } else {
            0
        };
        
        // console_log!("[WASM] detect_min_max_format: transitions={}, start_idx={}", transitions.len(), start_idx);
        
        // Check for same timestamp pattern (min/max pairs)
        // Check up to 20 transitions to find min/max pairs
        let check_limit = transitions.len().min(start_idx + 20).saturating_sub(1);
        for i in start_idx..check_limit {
            // console_log!("[WASM]   Checking transitions[{}].time={} vs transitions[{}].time={}", 
            //     i, transitions[i].time, i+1, transitions[i+1].time);
            if transitions[i].time == transitions[i + 1].time {
                // console_log!("[WASM]   Found min/max pair at index {}", i);
                return true;
            }
        }
        // console_log!("[WASM] detect_min_max_format: no min/max pairs found in first {} transitions", check_limit);
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
        
        // console_log!("[WASM] extract_bits_from_transitions: msb={}, lsb={}, bit_count={}, mask={:#x}", msb, lsb, bit_count, mask);
        
        let mut result = Vec::new();
        let mut last_value: Option<u64> = None;
        
        for t in transitions.iter() {
            // Parse value to u64 using original server format
            let value_u64 = match server_value_to_u64(t.value_type, t.value_len, &t.value) {
                Some(v) => v,
                None => continue,
            };
            let extracted_value = (value_u64 & mask) >> lsb;
            let extracted_str = format!("{}", extracted_value);
            let extracted_bytes = extracted_str.into_bytes();
            
            // Only add transition if value changed (or it's the first one)
            if last_value != Some(extracted_value) {
                result.push(Transition {
                    time: t.time,
                    actual_time: t.actual_time,
                    value_type: 0,
                    value_len: extracted_bytes.len() as u16,
                    value: extracted_bytes,
                });
                last_value = Some(extracted_value);
            }
        }
        
        // console_log!("[WASM] extract_bits_from_transitions: {} transitions after dedup", result.len());
        result
    }

    /// Extract bits from bucket data for bit-extraction signals
    fn extract_bits_from_buckets(
        &self,
        bucket_data: &[(u64, HashMap<u16, BucketData>)],
        _parent_width: u32,
        msb: u32,
        lsb: u32,
    ) -> Vec<(u64, HashMap<u16, BucketData>)> {
        // Handle edge case: if range is 64 bits, mask would overflow
        let bit_count = msb - lsb + 1;
        let mask = if bit_count >= 64 {
            u64::MAX
        } else {
            ((1u64 << bit_count) - 1) << lsb
        };
        
        let mut result = Vec::new();
        
        for (tile_start, buckets) in bucket_data.iter() {
            let mut extracted_buckets: HashMap<u16, BucketData> = HashMap::new();
            
            for (bucket_idx, bucket) in buckets.iter() {
                // Extract bits from first value
                let first_value_u64 = match server_value_to_u64(bucket.first.value_type, bucket.first.value_len, &bucket.first.value) {
                    Some(v) => v,
                    None => continue,
                };
                let extracted_first = (first_value_u64 & mask) >> lsb;
                let extracted_first_str = format!("{}", extracted_first);
                let extracted_first_bytes = extracted_first_str.into_bytes();
                
                // Extract bits from last value if present
                let extracted_last = bucket.last.as_ref().and_then(|last| {
                    let last_value_u64 = server_value_to_u64(last.value_type, last.value_len, &last.value)?;
                    let extracted = (last_value_u64 & mask) >> lsb;
                    let extracted_str = format!("{}", extracted);
                    let extracted_bytes = extracted_str.into_bytes();
                    Some(Transition {
                        time: last.time,
                        actual_time: last.actual_time,
                        value_type: 0,
                        value_len: extracted_bytes.len() as u16,
                        value: extracted_bytes,
                    })
                });

                // Create new bucket with extracted values
                let extracted_bucket = BucketData {
                    offset: bucket.offset,
                    first: Transition {
                        time: bucket.first.time,
                        actual_time: bucket.first.actual_time,
                        value_type: 0,
                        value_len: extracted_first_bytes.len() as u16,
                        value: extracted_first_bytes,
                    },
                    last: extracted_last,
                };
                
                extracted_buckets.insert(*bucket_idx, extracted_bucket);
            }
            
            if !extracted_buckets.is_empty() {
                result.push((*tile_start, extracted_buckets));
            }
        }
        
        result
    }

    /// Generate segments for LoD 0 (normal format) according to the drawing spec
    /// 
    /// Drawing Rules:
    /// - First transition at/after viewport start: start value -> first transition
    /// - Then draw each transition's value until next transition
    /// - Last transition -> viewport end
    fn generate_normal_segments(&self, transitions: &[Transition], width: u32, y: f64,
        signal_name: &str, time_range: f64, segments: &mut Vec<RenderSegment>, display_format: Option<&str>,
        tile_info: &[(u64, u64, u64, Transition)]) {

        // Get start value from tile_info for the current viewport
        // tile_info: (tile_start, tile_end, start_time, start_value_transition)
        let viewport_start = self.viewport.time_start as u64;
        let viewport_end = self.viewport.time_end as u64;

        // Filter transitions: exclude start value and only keep those in viewport range
        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .filter(|t| {
                let time = t.actual_time as f64;
                time >= self.viewport.time_start && time <= self.viewport.time_end
            })
            .cloned()
            .collect();

        // Find the tile that contains the viewport start time
        let start_value = tile_info.iter()
            .find(|(tile_start, tile_end, _, _)| *tile_start <= viewport_start && viewport_start < *tile_end)
            .map(|(_, _, _, sv)| sv.clone());
        
        // Debug warning if start value not found
        if start_value.is_none() {
            console_log!("[WASM] Warning: No start value found for viewport {}-{}. Available tiles: {:?}", 
                viewport_start, viewport_end, 
                tile_info.iter().map(|(ts, te, _, _)| (*ts, *te)).collect::<Vec<_>>());
        }

        // Helper to convert Transition to display string and classify value
        let transition_to_display = |t: &Transition| -> (String, String, bool) {
            let display_str = server_value_to_string(t.value_type, t.value_len, &t.value);
            let (value_type_str, has_xz) = Self::classify_value(&display_str, width);
            (display_str, value_type_str, has_xz)
        };

        // Helper to format multi-bit value
        let format_multi_bit = |t: &Transition| -> String {
            let display_str = server_value_to_string(t.value_type, t.value_len, &t.value);
            self.format_multi_bit_value(&display_str, width, display_format)
        };

        // If no normal transitions, draw start value across viewport
        if normal_transitions.is_empty() {
            if let Some(start_val) = start_value {
                let display_str = server_value_to_string(start_val.value_type, start_val.value_len, &start_val.value);
                let (value_type_str, has_xz) = Self::classify_value(&display_str, width);
                let final_display_str = if width > 1 {
                    format_multi_bit(&start_val)
                } else {
                    display_str
                };

                segments.push(RenderSegment {
                    x0: 0.0,
                    x1: self.canvas_width,
                    y,
                    value: ValueInfo {
                        value_type: value_type_str,
                        display_str: final_display_str,
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
        // For LoD 0, use actual_time (time field is not used)
        let viewport_start_u64 = self.viewport.time_start as u64;
        let first_visible_idx = normal_transitions.iter()
            .position(|t| t.actual_time >= viewport_start_u64)
            .unwrap_or(0);

        // If first visible transition is after viewport start, draw start value segment
        if first_visible_idx < normal_transitions.len() {
            let first_trans_time = normal_transitions[first_visible_idx].actual_time as f64;
            
            // Check if we need an initial segment (first transition is after viewport start)
            if first_trans_time > self.viewport.time_start {
                // Determine the value for the initial segment
                // Use the value from the transition just before viewport start, or start value
                let initial_trans = if first_visible_idx > 0 {
                    // Use the previous transition's value
                    &normal_transitions[first_visible_idx - 1]
                } else if let Some(ref sv) = start_value {
                    // Use start value
                    sv
                } else {
                    // Fallback: use first transition's value
                    &normal_transitions[first_visible_idx]
                };

                let t0 = self.viewport.time_start;
                let t1 = first_trans_time.min(self.viewport.time_end);
                let x0 = 0.0;
                let x1 = ((t1 - self.viewport.time_start) / time_range) * self.canvas_width;

                if x1 > x0 {
                    let display_str = server_value_to_string(initial_trans.value_type, initial_trans.value_len, &initial_trans.value);
                    let (value_type_str, has_xz) = Self::classify_value(&display_str, width);
                    let final_display_str = if width > 1 {
                        format_multi_bit(initial_trans)
                    } else {
                        display_str
                    };

                    segments.push(RenderSegment {
                        x0,
                        x1,
                        y,
                        value: ValueInfo {
                            value_type: value_type_str.clone(),
                            display_str: final_display_str.clone(),
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
        // For LoD 0, use actual_time (time field is not used)
        for i in 0..normal_transitions.len() {
            let t0 = normal_transitions[i].actual_time as f64;
            let t1 = if i + 1 < normal_transitions.len() {
                normal_transitions[i + 1].actual_time as f64
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

            let current_trans = &normal_transitions[i];
            let display_str = server_value_to_string(current_trans.value_type, current_trans.value_len, &current_trans.value);
            let (value_type_str, has_xz) = Self::classify_value(&display_str, width);

            let final_display_str = if width > 1 {
                format_multi_bit(current_trans)
            } else {
                display_str
            };

            segments.push(RenderSegment {
                x0,
                x1,
                y,
                value: ValueInfo {
                    value_type: value_type_str.clone(),
                    display_str: final_display_str.clone(),
                    width,
                    has_xz,
                    min_value: None,
                    max_value: None,
                    is_min_max: false,
                },
                signal_name: signal_name.to_string(),
            });
        }

        // [DEBUG] LoD 0 segment generation diagnostic
        console_log!(
            "[WASM][DEBUG] generate_normal_segments: signal='{}' width={} normal_transitions_input={} segments_produced={}",
            signal_name, width, transitions.len(), segments.len()
        );
    }
    /// 
    /// Drawing Rules:
    /// - First transition at/after viewport start: start value -> first transition
    /// - Then draw min/max pairs
    /// - Last transition -> viewport end
    /// - Min/Max pairs: same timestamp, min first, max second
    fn generate_min_max_segments(&self, transitions: &[Transition], width: u32, y: f64,
        signal_name: &str, time_range: f64, segments: &mut Vec<RenderSegment>, display_format: Option<&str>) {
        
        // console_log!("[WASM] generate_min_max_segments: viewport={}-{}, transitions={}", 
            // self.viewport.time_start, self.viewport.time_end, transitions.len());

        // Helper to convert Transition to display string and classify value
        let transition_to_display = |t: &Transition| -> (String, String, bool) {
            let display_str = server_value_to_string(t.value_type, t.value_len, &t.value);
            let (value_type_str, has_xz) = Self::classify_value(&display_str, width);
            (display_str, value_type_str, has_xz)
        };

        // Helper to format multi-bit value
        let format_multi_bit = |t: &Transition| -> String {
            let display_str = server_value_to_string(t.value_type, t.value_len, &t.value);
            self.format_multi_bit_value(&display_str, width, display_format)
        };

        // Separate start value (boundary) from normal transitions
        let start_value = transitions.iter()
            .find(|t| t.time == BOUNDARY_TIME_START)
            .cloned();

        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .cloned()
            .collect();

        // If no normal transitions, draw start value across viewport
        if normal_transitions.is_empty() {
            if let Some(start_val) = start_value {
                let (display_str, value_type_str, has_xz) = transition_to_display(&start_val);
                let final_display_str = if width > 1 {
                    format_multi_bit(&start_val)
                } else {
                    display_str.clone()
                };

                segments.push(RenderSegment {
                    x0: 0.0,
                    x1: self.canvas_width,
                    y,
                    value: ValueInfo {
                        value_type: value_type_str,
                        display_str: final_display_str,
                        width,
                        has_xz,
                        min_value: Some(display_str),
                        max_value: Some(server_value_to_string(start_val.value_type, start_val.value_len, &start_val.value)),
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
                let initial_trans = if first_visible_idx > 0 {
                    // Use the previous transition's value
                    &normal_transitions[first_visible_idx - 1]
                } else if let Some(ref sv) = start_value {
                    // Use start value
                    sv
                } else {
                    // Fallback: use first transition's value
                    &normal_transitions[first_visible_idx]
                };

                let t0 = self.viewport.time_start;
                let t1 = first_trans_time.min(self.viewport.time_end);
                let x0 = 0.0;
                let x1 = ((t1 - self.viewport.time_start) / time_range) * self.canvas_width;

                if x1 > x0 {
                    let (display_str, _value_type_str, has_xz) = transition_to_display(initial_trans);
                    let final_display_str = if width > 1 {
                        format_multi_bit(initial_trans)
                    } else {
                        display_str.clone()
                    };

                    // For LoD > 0, always use 'min_max' type to ensure proper grouping
                    segments.push(RenderSegment {
                        x0,
                        x1,
                        y,
                        value: ValueInfo {
                            value_type: "min_max".to_string(),
                            display_str: final_display_str,
                            width,
                            has_xz,
                            min_value: Some(display_str.clone()),
                            max_value: Some(display_str),
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
            let mut value_transitions = vec![&normal_transitions[i]];

            // Collect all values with the same timestamp (min/max pair)
            let mut j = i + 1;
            while j < normal_transitions.len() && normal_transitions[j].time == time {
                value_transitions.push(&normal_transitions[j]);
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
            let (min_trans, max_trans) = if value_transitions.len() >= 2 {
                (value_transitions[0], value_transitions[1])
            } else {
                (value_transitions[0], value_transitions[0])
            };
            
            let min_val_raw = server_value_to_string(min_trans.value_type, min_trans.value_len, &min_trans.value);
            let max_val_raw = server_value_to_string(max_trans.value_type, max_trans.value_len, &max_trans.value);

            // Format min/max values according to display_format
            let min_val_str = if width > 1 {
                self.format_multi_bit_value(&min_val_raw, width, display_format)
            } else {
                min_val_raw.clone()
            };
            let max_val_str = if width > 1 {
                self.format_multi_bit_value(&max_val_raw, width, display_format)
            } else {
                max_val_raw.clone()
            };

            // Check if min != max and neither is X/Z (use raw values for comparison)
            let min_upper = min_val_raw.to_uppercase();
            let max_upper = max_val_raw.to_uppercase();
            let has_xz = min_upper.contains('X') || min_upper.contains('Z') ||
                        max_upper.contains('X') || max_upper.contains('Z');
            let is_changing = min_val_raw != max_val_raw && !has_xz;

            // For LoD > 0, always use 'min_max' type to ensure proper grouping
            // For multi-bit signals that are changing, display "toggling" instead of min..max
            let display_str = if is_changing {
                "toggling".to_string()
            } else {
                // min == max or has X/Z
                min_val_str.clone()
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
                    min_value: Some(min_val_str),
                    max_value: Some(max_val_str),
                    is_min_max: is_changing,
                },
                signal_name: signal_name.to_string(),
            });

            i = j;
        }
    }

    /// Generate segments from bucket data for LoD 1+ (First/Last format)
    /// 
    /// Generate segments for LoD 1+ using the three-step algorithm:
    /// Step 1: Sort tiles by tile_start (already sorted by caller)
    /// Step 2: Generate full segments for all tiles (no viewport clipping)
    /// Step 3: Clip segments to viewport
    fn generate_lod_segments_from_buckets(
        &self,
        bucket_data: &[(u64, HashMap<u16, BucketData>)],
        width: u32,
        y: f64,
        signal_name: &str,
        time_range: f64,
        segments: &mut Vec<RenderSegment>,
        display_format: Option<&str>,
    ) {
        const TILE_SPAN_MULTIPLIER: u32 = 256;
        
        // Helper to convert Transition to display string and classify value
        let transition_to_display = |t: &Transition| -> (String, String, bool) {
            let display_str = server_value_to_string(t.value_type, t.value_len, &t.value);
            let (value_type_str, has_xz) = Self::classify_value(&display_str, width);
            (display_str, value_type_str, has_xz)
        };

        // Helper to format multi-bit value
        let format_multi_bit = |t: &Transition| -> String {
            let display_str = server_value_to_string(t.value_type, t.value_len, &t.value);
            self.format_multi_bit_value(&display_str, width, display_format)
        };
        
        // Get LoD and calculate bucket size
        let lod = self.current_lod.unwrap_or(25);
        let bucket_size = 1u64 << lod;
        let tile_span = bucket_size * TILE_SPAN_MULTIPLIER as u64;
        
        // Step 1: Ensure tiles are sorted by tile_start (they should already be)
        // bucket_data is already sorted by the caller
        
        // Step 2: Generate full segments for all tiles (no viewport clipping yet)
        // This generates segments for the entire time range covered by all tiles
        let mut full_segments: Vec<RenderSegment> = Vec::new();
        let mut current_value: Option<Transition> = None;

        for (tile_idx, (tile_start, buckets)) in bucket_data.iter().enumerate() {
            // Get start_value for this tile
            let start_value = self.signal_data.get(signal_name)
                .and_then(|data| data.tile_info.iter()
                    .find(|(start, _, _, _)| *start == *tile_start)
                    .map(|(_, _, _, value)| value.clone()));

            // Initialize current_value for the first tile
            if tile_idx == 0 {
                // For first tile, use start_value as initial value
                let start_val = start_value.clone().unwrap_or_else(|| Transition {
                    time: 0,
                    actual_time: 0,
                    value_type: 0,
                    value_len: 1,
                    value: vec![b'0'],
                });
                current_value = Some(start_val);
            } else {
                // For subsequent tiles, current_value is already set from previous tile's last bucket
                // Verify continuity: tile's start_value should match current_value
                // (this is guaranteed by server, but we use current_value for continuity)
            }
            
            // Process all 256 buckets in this tile
            for bucket_idx in 0..TILE_SPAN_MULTIPLIER as u16 {
                let bucket_start_time = tile_start + (bucket_idx as u64) * bucket_size;
                let bucket_end_time = bucket_start_time + bucket_size;  // Exclusive end
                
                match buckets.get(&bucket_idx) {
                    None => {
                        // Empty bucket: draw current value for entire bucket
                        let value = current_value.as_ref().unwrap();
                        let (display_str, value_type_str, has_xz) = transition_to_display(value);
                        let final_display_str = if width > 1 {
                            format_multi_bit(value)
                        } else {
                            display_str.clone()
                        };
                        let min_max_val = if width > 1 {
                            format_multi_bit(value)
                        } else {
                            display_str.clone()
                        };

                        full_segments.push(RenderSegment {
                            x0: bucket_start_time as f64,
                            x1: bucket_end_time as f64,
                            y,
                            value: ValueInfo {
                                value_type: value_type_str,
                                display_str: final_display_str,
                                width,
                                has_xz,
                                min_value: Some(min_max_val.clone()),
                                max_value: Some(min_max_val),
                                is_min_max: false,
                            },
                            signal_name: signal_name.to_string(),
                        });
                    }
                    Some(bucket) => {
                        // Skip start_value transitions (BOUNDARY_TIME_START)
                        if bucket.first.actual_time == BOUNDARY_TIME_START {
                            // Update current_value to this transition's value
                            current_value = Some(bucket.first.clone());
                            if let Some(ref last) = bucket.last {
                                current_value = Some(last.clone());
                            }
                            continue;
                        }
                        
                        if bucket.has_toggle() {
                            // Toggle bucket: draw toggling for entire bucket
                            let first_trans = &bucket.first;
                            let last_trans = bucket.last.as_ref().unwrap();
                            let first_val_raw = server_value_to_string(first_trans.value_type, first_trans.value_len, &first_trans.value);
                            let last_val_raw = server_value_to_string(last_trans.value_type, last_trans.value_len, &last_trans.value);

                            let first_val_str = if width > 1 {
                                self.format_multi_bit_value(&first_val_raw, width, display_format)
                            } else {
                                first_val_raw.clone()
                            };
                            let last_val_str = if width > 1 {
                                self.format_multi_bit_value(&last_val_raw, width, display_format)
                            } else {
                                last_val_raw.clone()
                            };

                            full_segments.push(RenderSegment {
                                x0: bucket_start_time as f64,
                                x1: bucket_end_time as f64,
                                y,
                                value: ValueInfo {
                                    value_type: "min_max".to_string(),
                                    display_str: "toggling".to_string(),
                                    width,
                                    has_xz: false,
                                    min_value: Some(first_val_str),
                                    max_value: Some(last_val_str),
                                    is_min_max: true,
                                },
                                signal_name: signal_name.to_string(),
                            });

                            // Update current value to last
                            current_value = Some(last_trans.clone());
                        } else {
                            // Single transition: draw with precise timing
                            let value_trans = &bucket.first;
                            let actual_transition_time = value_trans.actual_time;
                            
                            // Per spec Rule 1: check if actual_time is within bucket range
                            // bucket_start_time < actual_time <= bucket_end_time
                            if bucket_start_time < actual_transition_time && actual_transition_time <= bucket_end_time {
                                // Draw previous value before transition
                                let (prev_display_str, prev_value_type_str, prev_has_xz) = 
                                    transition_to_display(current_value.as_ref().unwrap());
                                let prev_final_display_str = if width > 1 {
                                    format_multi_bit(current_value.as_ref().unwrap())
                                } else {
                                    prev_display_str.clone()
                                };

                                full_segments.push(RenderSegment {
                                    x0: bucket_start_time as f64,
                                    x1: actual_transition_time as f64,
                                    y,
                                    value: ValueInfo {
                                        value_type: prev_value_type_str,
                                        display_str: prev_final_display_str,
                                        width,
                                        has_xz: prev_has_xz,
                                        min_value: Some(prev_display_str.clone()),
                                        max_value: Some(prev_display_str),
                                        is_min_max: false,
                                    },
                                    signal_name: signal_name.to_string(),
                                });

                                // Draw new value from transition point to bucket end
                                let (display_str, value_type_str, has_xz) = transition_to_display(value_trans);
                                let final_display_str = if width > 1 {
                                    format_multi_bit(value_trans)
                                } else {
                                    display_str.clone()
                                };

                                full_segments.push(RenderSegment {
                                    x0: actual_transition_time as f64,
                                    x1: bucket_end_time as f64,
                                    y,
                                    value: ValueInfo {
                                        value_type: value_type_str,
                                        display_str: final_display_str,
                                        width,
                                        has_xz,
                                        min_value: Some(display_str.clone()),
                                        max_value: Some(display_str),
                                        is_min_max: false,
                                    },
                                    signal_name: signal_name.to_string(),
                                });
                            } else {
                                // Transition time not in valid range, draw entire bucket with first value
                                let (display_str, value_type_str, has_xz) = transition_to_display(value_trans);
                                let final_display_str = if width > 1 {
                                    format_multi_bit(value_trans)
                                } else {
                                    display_str.clone()
                                };

                                full_segments.push(RenderSegment {
                                    x0: bucket_start_time as f64,
                                    x1: bucket_end_time as f64,
                                    y,
                                    value: ValueInfo {
                                        value_type: value_type_str,
                                        display_str: final_display_str,
                                        width,
                                        has_xz,
                                        min_value: Some(display_str.clone()),
                                        max_value: Some(display_str),
                                        is_min_max: false,
                                    },
                                    signal_name: signal_name.to_string(),
                                });
                            }

                            // Update current value
                            current_value = Some(value_trans.clone());
                        }
                    }
                }
            }
        }
        
        // Merge adjacent segments with same value before clipping
        self.merge_adjacent_segments(&mut full_segments);
        
        // Step 3: Clip segments to viewport and convert to pixel coordinates
        let viewport_start = self.viewport.time_start;
        let viewport_end = self.viewport.time_end;

        for segment in full_segments {
            // Check if segment is completely outside viewport
            if segment.x1 <= viewport_start || segment.x0 >= viewport_end {
                continue;
            }

            // Clip segment to viewport
            let clipped_x0 = segment.x0.max(viewport_start);
            let clipped_x1 = segment.x1.min(viewport_end);

            if clipped_x1 <= clipped_x0 {
                continue;
            }

            // Convert to pixel coordinates
            let pixel_x0 = ((clipped_x0 - viewport_start) / time_range) * self.canvas_width;
            let pixel_x1 = ((clipped_x1 - viewport_start) / time_range) * self.canvas_width;

            if pixel_x1 <= pixel_x0 {
                continue;
            }

            segments.push(RenderSegment {
                x0: pixel_x0,
                x1: pixel_x1,
                y: segment.y,
                value: segment.value,
                signal_name: segment.signal_name,
            });
        }
    }
    
    /// Merge adjacent segments with the same value to avoid vertical lines at tile boundaries
    /// For multi-bit signals, also merges segments with same value even if not strictly adjacent
    fn merge_adjacent_segments(&self, segments: &mut Vec<RenderSegment>) {
        if segments.len() < 2 {
            return;
        }

        let mut merged: Vec<RenderSegment> = Vec::new();
        let mut current = segments[0].clone();

        for i in 1..segments.len() {
            let next = &segments[i];

            // Check if can merge: same y, same signal, same value, not toggle
            let same_value = current.y == next.y
                && current.signal_name == next.signal_name
                && !current.value.is_min_max  // Not a toggle segment
                && !next.value.is_min_max     // Not a toggle segment
                && current.value.display_str == next.value.display_str;  // Same value

            // For merging, check if adjacent OR overlapping (within 2 pixels tolerance)
            // This handles floating point precision issues and small gaps
            let can_merge = same_value
                && (next.x0 <= current.x1 + 2.0);  // Next starts before or shortly after current ends

            if can_merge {
                // Merge: extend current segment to next's end (if next extends further)
                if next.x1 > current.x1 {
                    current.x1 = next.x1;
                }
            } else {
                // Cannot merge: push current and start new
                merged.push(current);
                current = next.clone();
            }
        }

        // Push final segment
        merged.push(current);

        // Replace original segments with merged
        *segments = merged;
    }
    
    /// Find the value at a specific time within a single tile
    /// 
    /// Algorithm:
    /// 1. Only search within the tile that contains target_time
    ///    (tile_start <= target_time < tile_start + tile_span)
    /// 2. Search all buckets in this tile for transitions with actual_time <= target_time
    ///    - Check both first and last transitions in each bucket
    ///    - Find the transition with the largest actual_time that is <= target_time
    /// 3. If no such transition found, use the tile's start_value
    ///
    /// # Arguments
    /// * `buckets` - Buckets in current tile
    /// * `target_time` - Time to find value at
    /// * `start_value` - Start value of current tile (from tile_info), used as fallback
    fn find_value_at_time(
        &self,
        _signal_name: &str,
        tile_start: u64,
        buckets: &HashMap<u16, BucketData>,
        target_time: u64,
        lod: u32,
        _tile_idx: usize,
        _all_bucket_data: &[(u64, HashMap<u16, BucketData>)],
        start_value: Option<&Transition>,
    ) -> Transition {
        const TILE_SPAN_MULTIPLIER: u32 = 256;
        let bucket_size = 1u64 << lod;
        let tile_span = bucket_size * TILE_SPAN_MULTIPLIER as u64;
        
        // Default transition (used if no start_value provided)
        let default_transition = Transition {
            time: 0,
            actual_time: 0,
            value_type: 0,
            value_len: 1,
            value: vec![b'0'],
        };
        
        // Verify target_time is within this tile
        // tile_start <= target_time < tile_start + tile_span
        if target_time < tile_start || target_time >= tile_start + tile_span {
            // Target time is outside this tile, use start_value or default
            return start_value.map(|s| s.clone()).unwrap_or(default_transition);
        }
        
        // Search all buckets in this tile for the transition with largest actual_time <= target_time
        // Check both first and last transitions
        let mut best_transition: Option<(u64, Transition)> = None; // (actual_time, transition)
        
        for (bucket_idx, bucket) in buckets.iter() {
            // Check first transition
            let first_time = bucket.first.actual_time;
            // Skip start_value transitions (BOUNDARY_TIME_START)
            if first_time != BOUNDARY_TIME_START && first_time <= target_time {
                if best_transition.is_none() || first_time > best_transition.as_ref().unwrap().0 {
                    best_transition = Some((first_time, bucket.first.clone()));
                }
            }
            
            // Check last transition if exists
            if let Some(ref last) = bucket.last {
                let last_time = last.actual_time;
                // Skip start_value transitions
                if last_time != BOUNDARY_TIME_START && last_time <= target_time {
                    if best_transition.is_none() || last_time > best_transition.as_ref().unwrap().0 {
                        best_transition = Some((last_time, last.clone()));
                    }
                }
            }
        }
        
        // If found a valid transition, return it
        if let Some((_, trans)) = best_transition {
            return trans;
        }
        
        // No transition found with actual_time <= target_time
        // Use start_value as fallback
        if let Some(start) = start_value {
            return start.clone();
        }
        
        // Last resort: return default
        default_transition
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
    fn format_multi_bit_value(&self, value: &str, width: u32, display_format: Option<&str>) -> String {
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

        // Determine which format to use
        let format = display_format.unwrap_or(&self.display_format);
        
        // Format based on display_format
        match format {
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
        // console_log!("[WASM] find_transitions_around: signal='{}', time={}", signal_name, time);

        if let Some(data) = self.signal_data.get(signal_name) {
            let lod = self.current_lod.unwrap_or(0);
            
            // LoD 1+: Use bucket_data format
            if lod > 0 {
                return self.find_transitions_around_from_buckets(data, time);
            }
            
            // LoD 0: Use transitions
            // console_log!("[WASM]   Found signal data, transitions count: {}", data.transitions.len());

            let mut prev: Option<u64> = None;
            let mut next: Option<u64> = None;

            for transition in &data.transitions {
                // Skip boundary value - it's not a real transition
                if transition.time == BOUNDARY_TIME_START {
                    continue;
                }

                // Use actual_time for cursor snapping (precise transition time)
                // For LoD 0, actual_time == time; for LoD 1+, actual_time is the real timestamp
                let actual_t = transition.actual_time as f64;
                if actual_t < time {
                    prev = Some(transition.actual_time);
                } else if actual_t > time && next.is_none() {
                    next = Some(transition.actual_time);
                    break; // Found next, no need to continue
                }
            }

            // console_log!("[WASM]   Result: prev={:?}, next={:?}", prev, next);

            let result = vec![prev, next];
            serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
        } else {
            // console_log!("[WASM]   Signal data not found in cache!");
            JsValue::NULL
        }
    }
    
    /// Find transitions around time from bucket_data (LoD 1+ format)
    /// Uses actual transition times from bucket first/last for precise cursor snapping
    fn find_transitions_around_from_buckets(&self, data: &SignalWaveData, time: f64) -> JsValue {
        let lod = self.current_lod.unwrap_or(25);
        let bucket_size = 1u64 << lod;
        let time_u64 = time as u64;

        // console_log!("[WASM]   Using bucket_data with actual_time, lod={}, bucket_size={}", lod, bucket_size);

        // Sort bucket_data by tile_start
        let mut sorted_bucket_data: Vec<(u64, &HashMap<u16, BucketData>)> = data.bucket_data
            .iter()
            .map(|(start, buckets)| (*start, buckets))
            .collect();
        sorted_bucket_data.sort_by_key(|(start, _)| *start);

        let mut all_transition_times: Vec<u64> = Vec::new();

        // Collect all actual transition times from all buckets
        for (tile_start, buckets) in &sorted_bucket_data {
            for bucket_idx in 0..256u16 {
                if let Some(bucket) = buckets.get(&bucket_idx) {
                    // Use actual transition time from bucket.first
                    let first_actual_time = bucket.first.actual_time;
                    // Only add if it's a valid time (not BOUNDARY_TIME_START)
                    if first_actual_time != BOUNDARY_TIME_START {
                        all_transition_times.push(first_actual_time);
                    }

                    // If toggle bucket, also add the last transition actual_time
                    if let Some(ref last) = bucket.last {
                        let last_actual_time = last.actual_time;
                        if last_actual_time != BOUNDARY_TIME_START {
                            all_transition_times.push(last_actual_time);
                        }
                    }
                }
            }
        }

        // Sort and deduplicate
        all_transition_times.sort();
        all_transition_times.dedup();

        // console_log!("[WASM]   Total transition times: {}", all_transition_times.len());

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

        // console_log!("[WASM]   Result from buckets: prev={:?}, next={:?}", prev, next);

        let result = vec![prev, next];
        serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
    }

    /// Get signal value at a specific time
    /// Returns the value of the signal at the given time (from cached data)
    /// If data is not cached, returns null
    /// Handles BOUNDARY_TIME_START (0xFFFFFFFFFFFFFFFF) as the start-of-range value
    /// display_format: optional display format override ("hex", "bin", "oct", "dec")
    #[wasm_bindgen(js_name = get_signal_value_at_time)]
    pub fn get_signal_value_at_time_js(&self, signal_name: &str, time: f64, display_format: Option<String>) -> JsValue {
        self.get_signal_value_at_time_internal(signal_name, time, display_format.as_deref())
    }

    /// Check if signal_data has data for the given signal
    /// Returns an object with transition count and bucket count, or null if signal not found
    #[wasm_bindgen(js_name = getSignalDataStats)]
    pub fn get_signal_data_stats(&self, signal_name: &str) -> JsValue {
        if let Some(data) = self.signal_data.get(signal_name) {
            let obj = js_sys::Object::new();
            js_sys::Reflect::set(&obj, &"transitions".into(), &JsValue::from(data.transitions.len() as i32)).unwrap();
            js_sys::Reflect::set(&obj, &"buckets".into(), &JsValue::from(data.bucket_data.len() as i32)).unwrap();
            js_sys::Reflect::set(&obj, &"tiles".into(), &JsValue::from(data.tile_info.len() as i32)).unwrap();
            obj.into()
        } else {
            JsValue::NULL
        }
    }
 
    /// Internal implementation of get_signal_value_at_time
    /// Structure mirrors get_segments() to ensure consistency
    fn get_signal_value_at_time_internal(&self, signal_name: &str, time: f64, display_format: Option<&str>) -> JsValue {
        let signal_display_format = display_format;
        let time_u64 = time as u64;
        let lod = self.current_lod.unwrap_or(0);
        
        // Check if this is a bit extraction signal (same logic as get_segments)
        if let Some((ref parent_name, (msb, lsb))) = Self::parse_bit_extract(signal_name) {
            // Get parent signal data
            if let Some(parent_data) = self.signal_data.get(parent_name) {
                let width = if msb == lsb { 1 } else { msb - lsb + 1 };
                
                // Same LoD branching as get_segments
                if lod > 0 {
                    // LoD 1+: Extract bits from bucket data, then get value
                    let extracted_buckets = self.extract_bits_from_buckets(
                        &parent_data.bucket_data, parent_data.width, msb, lsb);
                    return self.get_value_from_buckets(parent_name, &extracted_buckets, time_u64, width, signal_display_format);
                } else {
                    // LoD 0: Extract bits from transitions, then get value
                    let extracted_transitions = self.extract_bits_from_transitions(
                        &parent_data.transitions, parent_data.width, msb, lsb);
                    return self.get_value_from_transitions(&extracted_transitions, time_u64, width, signal_display_format, &[]);
                }
            }
            return JsValue::NULL;
        }
        
        // Normal signal lookup (same structure as get_segments)
        if let Some(data) = self.signal_data.get(signal_name) {
            if lod > 0 {
                // LoD 1+: Use bucket-based value lookup
                return self.get_value_from_buckets(signal_name, &data.bucket_data, time_u64, data.width, signal_display_format);
            } else {
                // LoD 0: Use transitions-based value lookup
                return self.get_value_from_transitions(&data.transitions, time_u64, data.width, signal_display_format, &data.tile_info);
            }
        }
        
        // Signal data not cached
        JsValue::NULL
    }
    
    /// Get value at time from transitions (LoD 0)
    /// Algorithm matches generate_normal_segments exactly
    fn get_value_from_transitions(
        &self,
        transitions: &[Transition],
        time_u64: u64,
        width: u32,
        display_format: Option<&str>,
        tile_info: &[(u64, u64, u64, Transition)],
    ) -> JsValue {
        // Step 1: Get start value from tile_info for the tile containing time_u64
        // (same method as generate_normal_segments, but for time_u64 instead of viewport_start)
        let start_value = if !tile_info.is_empty() {
            tile_info.iter()
                .find(|(tile_start, tile_end, _, _)| *tile_start <= time_u64 && time_u64 < *tile_end)
                .map(|(_, _, _, sv)| sv.clone())
        } else {
            None
        };

        // Step 2: Filter transitions - exclude start value (same as generate_normal_segments)
        let normal_transitions: Vec<_> = transitions.iter()
            .filter(|t| t.time != BOUNDARY_TIME_START)
            .collect();

        // Step 3: If no transitions, return start value (same as generate_normal_segments)
        if normal_transitions.is_empty() {
            if let Some(start_val) = start_value {
                return self.transition_to_value_info(&start_val, width, display_format);
            }
            return JsValue::NULL;
        }

        // Step 4: Find the last transition at or before time_u64
        // (same logic as generate_normal_segments when building segments)
        let mut current_value_trans: Option<&Transition> = None;
        
        for transition in &normal_transitions {
            if transition.actual_time <= time_u64 {
                current_value_trans = Some(transition);
            } else {
                break;
            }
        }

        // Step 5: Use found transition, or fall back to start value
        let value_trans = if let Some(trans) = current_value_trans {
            trans
        } else if let Some(ref start_val) = start_value {
            start_val
        } else {
            return JsValue::NULL;
        };

        // Step 6: Convert to ValueInfo
        self.transition_to_value_info(value_trans, width, display_format)
    }
    
    /// Get value at time from bucket_data (LoD 1+)
    /// Algorithm matches generate_lod_segments_from_buckets exactly
    fn get_value_from_buckets(
        &self,
        signal_name: &str,
        bucket_data: &[(u64, HashMap<u16, BucketData>)],
        time_u64: u64,
        width: u32,
        display_format: Option<&str>,
    ) -> JsValue {
        let lod = self.current_lod.unwrap_or(25);
        let bucket_size = 1u64 << lod;
        let tile_span = bucket_size * 256; // TILE_SPAN_MULTIPLIER = 256
        
        // Find which tile contains this time (same as generate_lod_segments_from_buckets)
        for (tile_idx, (tile_start, buckets)) in bucket_data.iter().enumerate() {
            let tile_end = tile_start + tile_span;
            
            if time_u64 >= *tile_start && time_u64 < tile_end {
                // Calculate bucket index (same as generate_lod_segments_from_buckets)
                let offset_in_tile = (time_u64 - *tile_start) / bucket_size;
                let bucket_idx = offset_in_tile as u16;
                
                // Get the value transition for this bucket
                // Logic mirrors generate_lod_segments_from_buckets
                let value_transition = self.find_bucket_value_at_time(
                    signal_name, bucket_data, tile_idx, *tile_start, buckets, bucket_idx, lod
                );
                
                return self.transition_to_value_info(&value_transition, width, display_format);
            }
        }
        
        JsValue::NULL
    }
    
    /// Find the value transition at a specific bucket index
    /// Mirrors the logic in generate_lod_segments_from_buckets for handling empty buckets
    fn find_bucket_value_at_time(
        &self,
        signal_name: &str,
        bucket_data: &[(u64, HashMap<u16, BucketData>)],
        tile_idx: usize,
        tile_start: u64,
        buckets: &HashMap<u16, BucketData>,
        bucket_idx: u16,
        lod: u32,
    ) -> Transition {
        // Try to find the bucket at this index
        if let Some(bucket) = buckets.get(&bucket_idx) {
            // Found bucket at exact index
            // For toggle bucket, use last value; for single transition, use first value
            // (same logic as generate_lod_segments_from_buckets)
            if bucket.has_toggle() {
                return bucket.last.as_ref().unwrap().clone();
            } else {
                return bucket.first.clone();
            }
        }
        
        // Empty bucket - need to find previous non-empty bucket
        // (same logic as generate_lod_segments_from_buckets)
        
        // Search backwards from bucket_idx-1 to 0 within current tile
        for prev_idx in (0..bucket_idx).rev() {
            if let Some(prev_bucket) = buckets.get(&prev_idx) {
                return if prev_bucket.has_toggle() {
                    prev_bucket.last.as_ref().unwrap().clone()
                } else {
                    prev_bucket.first.clone()
                };
            }
        }
        
        // Not found in current tile - use previous tile's last value or start value
        if tile_idx > 0 {
            // Use previous tile's last bucket value
            let (_, prev_buckets) = &bucket_data[tile_idx - 1];
            let mut last_transition: Option<Transition> = None;
            
            for idx in 0..256u16 {
                if let Some(bucket) = prev_buckets.get(&idx) {
                    last_transition = Some(if bucket.has_toggle() {
                        bucket.last.as_ref().unwrap().clone()
                    } else {
                        bucket.first.clone()
                    });
                }
            }
            
            if let Some(trans) = last_transition {
                return trans;
            }
        }
        
        // First tile - use start value from tile_info (same as generate_lod_segments_from_buckets)
        if let Some(data) = self.signal_data.get(signal_name) {
            if let Some(start_value) = data.tile_info.iter()
                .find(|(start, _, _, _)| *start == tile_start)
                .map(|(_, _, _, value)| value.clone()) {
                return start_value;
            }
        }
        
        // Fallback: return a default transition
        Transition {
            time: 0,
            actual_time: tile_start,
            value_type: 0,
            value_len: 1,
            value: vec![b'0'],
        }
    }
    
    /// Convert a Transition to ValueInfo
    fn transition_to_value_info(&self, transition: &Transition, width: u32, display_format: Option<&str>) -> JsValue {
        let value_str = server_value_to_string(transition.value_type, transition.value_len, &transition.value);
        let (value_type, has_xz) = Self::classify_value(&value_str, width);

        let display_str = if width > 1 {
            self.format_multi_bit_value(&value_str, width, display_format)
        } else {
            value_str
        };

        let value_info = ValueInfo {
            value_type,
            display_str,
            width,
            has_xz,
            min_value: None,
            max_value: None,
            is_min_max: false,
        };
        
        serde_wasm_bindgen::to_value(&value_info).unwrap_or(JsValue::NULL)
    }

    /// Test signal name conversion (for debugging)
    pub fn test_name_conversion(&self, local_name: &str) -> String {
        let server_name = self.local_to_server_name(local_name);
        let encoded = general_purpose::STANDARD.encode(&server_name);
        format!("Local: '{}' -> Server: '{}' -> Base64: '{}'", local_name, server_name, encoded)
    }
}

