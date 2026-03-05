//! WASM Waveform Data Provider
//!
//! This module provides waveform data fetching from server,
//! chunk parsing, and segment calculation for rendering.

use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use base64::{Engine as _, engine::general_purpose};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValueInfo {
    pub value_type: String,  // "zero", "one", "all_x", "all_z", "numeric", "mixed"
    pub display_str: String,
    pub width: u32,
    pub has_xz: bool,
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
    signals: Vec<SignalInfo>,
    viewport: Viewport,
    canvas_width: f64,
    canvas_height: f64,
    row_height: f64,
    signal_data: HashMap<String, SignalWaveData>,
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
    ) -> Self {
        console_log!("[WASM] WaveformDataProvider created: waveform={}, prefix='{}', space={}",
            waveform_name, signal_prefix, space_before_bracket);

        Self {
            server_url: server_url.clone(),
            waveform_name: waveform_name.clone(),
            signal_prefix,
            space_before_bracket,
            signals: Vec::new(),
            viewport: Viewport { time_start: 0.0, time_end: 1000.0 },
            canvas_width: 800.0,
            canvas_height: 400.0,
            row_height: 25.0,
            signal_data: HashMap::new(),
        }
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

    /// Set signals to render
    pub fn set_signals(&mut self, signals_js: JsValue) -> Result<(), JsValue> {
        let signals: Vec<SignalInfo> = serde_wasm_bindgen::from_value(signals_js)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse signals: {}", e)))?;

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

    /// Set canvas dimensions
    pub fn set_canvas_dimensions(&mut self, width: f64, height: f64, row_height: f64) {
        console_log!("[WASM] Set canvas dimensions: width={}, height={}, row_height={}", width, height, row_height);
        self.canvas_width = width;
        self.canvas_height = height;
        self.row_height = row_height;
    }

    /// Build server signal name from local name
    fn build_server_signal_name(&self, local_name: &str) -> String {
        // Remove prefix if present
        let mut server_name = if self.signal_prefix.is_empty() || !local_name.starts_with(&self.signal_prefix) {
            local_name.to_string()
        } else {
            local_name[self.signal_prefix.len()..].to_string()
        };

        // Add space before bracket if needed
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
        console_log!("[WASM] Converted '{}' -> '{}'", local_name, server_name);
        server_name
    }

    /// Fetch signal data from server
    /// signal_name: local signal name (from KDB)
    pub async fn fetch_signal_data(&mut self, local_signal_name: &str) -> Result<(), JsValue> {
        // Step 1 & 2: Convert local name to server name
        let server_name = self.local_to_server_name(local_signal_name);

        // Step 3: Base64 encode (no regex escaping needed)
        let encoded = general_purpose::STANDARD.encode(&server_name);

        let url = format!("{}/api/wave/{}/lod/0/signals/b64:{}/data",
            self.server_url,
            self.waveform_name,
            encoded);

        console_log!("[WASM] Fetching signal '{}' (server name: '{}')", local_signal_name, server_name);
        console_log!("[WASM] URL: {}", url);

        // Use web-sys to fetch data
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

        console_log!("[WASM] Received {} bytes for signal {}", bytes.len(), local_signal_name);

        // Parse chunk data (store under local name for lookup)
        self.parse_chunk_data(local_signal_name, &bytes)?;

        Ok(())
    }

    /// Parse chunk binary data
    fn parse_chunk_data(&mut self, signal_name: &str, data: &[u8]) -> Result<(), JsValue> {
        // Parse header
        let header = ChunkHeader::from_bytes(data)
            .map_err(|e| JsValue::from_str(&e))?;

        console_log!("[WASM] Chunk: level={}, signals={}, time={}-{}",
            header.level, header.signal_count, header.time_start, header.time_end);

        // For now, just store mock data
        // TODO: Implement full chunk parsing
        let width = 1; // TODO: Get from signal info

        let transitions = vec![
            Transition { time: header.time_start, value: "0".to_string() },
            Transition { time: (header.time_start + header.time_end) / 2, value: "1".to_string() },
            Transition { time: header.time_end, value: "0".to_string() },
        ];

        self.signal_data.insert(signal_name.to_string(), SignalWaveData {
            name: signal_name.to_string(),
            width,
            transitions,
        });

        Ok(())
    }

    /// Get render segments for current viewport
    pub fn get_segments(&self) -> Result<JsValue, JsValue> {
        let mut segments = Vec::new();
        let time_range = self.viewport.time_end - self.viewport.time_start;

        console_log!("[WASM] get_segments: {} signals, viewport={}-{}, canvas={}x{}",
            self.signals.len(), self.viewport.time_start, self.viewport.time_end,
            self.canvas_width, self.canvas_height);
        console_log!("[WASM] signal_data cache: {} signals", self.signal_data.len());

        for (row, signal) in self.signals.iter().enumerate() {
            let y = 20.0 + row as f64 * self.row_height + self.row_height / 2.0;

            console_log!("[WASM] Processing signal[{}]: name='{}', y={}", row, signal.name, y);

            if let Some(data) = self.signal_data.get(&signal.name) {
                // Count transitions in viewport
                let total_transitions = data.transitions.len();
                let viewport_transitions = data.transitions.iter()
                    .filter(|t| {
                        let t_end = t.time as f64;
                        let t_start = if let Some(idx) = data.transitions.iter().position(|x| x.time == t.time) {
                            if idx > 0 { data.transitions[idx - 1].time as f64 } else { 0.0 }
                        } else { 0.0 };
                        !(t_end < self.viewport.time_start || t_start > self.viewport.time_end)
                    })
                    .count();
                console_log!("[WASM]   Total transitions: {}, In viewport: {}", total_transitions, viewport_transitions);
                // Generate segments from transitions
                for i in 0..data.transitions.len() {
                    let t0 = data.transitions[i].time as f64;
                    let t1 = if i + 1 < data.transitions.len() {
                        data.transitions[i + 1].time as f64
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

                    let value_str = &data.transitions[i].value;
                    let (value_type, has_xz) = Self::classify_value(value_str, data.width);

                    // Debug first few segments
                    if segments.len() < 3 {
                        console_log!("[WASM]     Segment[{}]: x0={:.2}, x1={:.2}, value='{}'", segments.len(), x0, x1, value_str);
                    }

                    segments.push(RenderSegment {
                        x0,
                        x1,
                        y,
                        value: ValueInfo {
                            value_type,
                            display_str: value_str.clone(),
                            width: data.width,
                            has_xz,
                        },
                        signal_name: signal.name.clone(),
                    });
                }
                console_log!("[WASM]   Generated {} segments for signal '{}'", segments.len(), signal.name);
            } else {
                console_log!("[WASM]   No data found for signal '{}'", signal.name);
            }
        }

        console_log!("[WASM] Total segments generated: {}", segments.len());

        serde_wasm_bindgen::to_value(&segments)
            .map_err(|e| JsValue::from_str(&format!("Serialization error: {}", e)))
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

    /// Get signal names (for testing)
    pub fn get_signal_names(&self) -> JsValue {
        let names: Vec<&str> = self.signals.iter().map(|s| s.name.as_str()).collect();
        serde_wasm_bindgen::to_value(&names).unwrap_or(JsValue::NULL)
    }

    /// Test signal name conversion (for debugging)
    pub fn test_name_conversion(&self, local_name: &str) -> String {
        let server_name = self.local_to_server_name(local_name);
        let encoded = general_purpose::STANDARD.encode(&server_name);
        format!("Local: '{}' -> Server: '{}' -> Base64: '{}'", local_name, server_name, encoded)
    }
}
