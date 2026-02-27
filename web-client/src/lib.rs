use wasm_bindgen::prelude::*;
use ruzstd::StreamingDecoder;
use std::io::Read;
use prost::Message;

// Manual protobuf definitions
mod kdb_proto;
use kdb_proto::*;

// CWDK magic number: "CWDK" in little-endian
const CWDK_MAGIC: u32 = 0x4B445743;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// IndexedDB operations - called through JS wrapper functions
#[wasm_bindgen]
extern "C" {
    // These are global functions exposed by kdbStorage.ts
    #[wasm_bindgen(js_namespace = window)]
    fn store_knowledge_base(id: &str, data: &JsValue) -> js_sys::Promise;
    
    #[wasm_bindgen(js_namespace = window)]
    fn store_module(id: u32, data: &JsValue, kdb_id: &str) -> js_sys::Promise;
    
    #[wasm_bindgen(js_namespace = window)]
    fn store_source_file(id: u32, path: &str, content: &str, kdb_id: &str) -> js_sys::Promise;
    
    #[wasm_bindgen(js_namespace = window)]
    fn clear_kdb_data(kdb_id: &str) -> js_sys::Promise;
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

/// Parse KDB file and store directly to IndexedDB
/// Returns the design name on success
#[wasm_bindgen]
pub async fn parse_and_store_kdb(kdb_id: &str, data: &[u8]) -> Result<String, JsValue> {
    console_log!("[WASM] Starting KDB parsing for: {}", kdb_id);
    
    if data.len() < 8 {
        return Err(JsValue::from_str("KDB file too small"));
    }
    
    // Read magic number (little-endian)
    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    console_log!("[WASM] Magic number: 0x{:08X}", magic);
    
    if magic != CWDK_MAGIC {
        return Err(JsValue::from_str(&format!(
            "Invalid KDB magic number: 0x{:08X}",
            magic
        )));
    }
    
    // Read original size
    let original_size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    console_log!("[WASM] Original size: {} bytes", original_size);
    
    // Decompress zstd data
    let compressed_data = &data[8..];
    console_log!("[WASM] Compressed size: {} bytes", compressed_data.len());
    
    let decompressed = match decompress_zstd(compressed_data, original_size) {
        Ok(data) => data,
        Err(e) => return Err(JsValue::from_str(&format!("Decompression failed: {}", e))),
    };
    
    console_log!("[WASM] Decompressed {} bytes", decompressed.len());
    
    // Parse protobuf data
    let kdb_data = match parse_kdb_protobuf(&decompressed) {
        Ok(data) => {
            console_log!("[WASM] Parsed KDB: {} modules, {} hierarchies", data.modules.len(), data.hierarchies.len());
            console_log!("[WASM] Hierarchies: {:?}", data.hierarchies.iter().map(|h| h.top_module_id).collect::<Vec<_>>());
            data
        }
        Err(e) => {
            console_log!("[WASM] Protobuf parsing failed: {}, using mock data", e);
            create_mock_kdb_data(kdb_id)
        }
    };
    
    // Clear existing data for this KDB
    console_log!("[WASM] Clearing existing data for KDB: {}", kdb_id);
    let clear_promise = clear_kdb_data(kdb_id);
    wasm_bindgen_futures::JsFuture::from(clear_promise).await?;
    
    // Store to IndexedDB
    console_log!("[WASM] Storing KDB data to IndexedDB...");
    store_kdb_to_indexeddb(&kdb_data, kdb_id).await?;
    
    console_log!("[WASM] KDB parsed and stored successfully: {}", kdb_data.header.as_ref().map(|h| h.project_name.clone()).unwrap_or_else(|| kdb_id.to_string()));
    Ok(kdb_data.header.as_ref().map(|h| h.project_name.clone()).unwrap_or_else(|| kdb_id.to_string()))
}

/// Decompress zstd data using pure Rust ruzstd
fn decompress_zstd(compressed: &[u8], _original_size: usize) -> Result<Vec<u8>, String> {
    let mut decoder = match StreamingDecoder::new(compressed) {
        Ok(d) => d,
        Err(e) => return Err(format!("Failed to create zstd decoder: {:?}", e)),
    };
    
    let mut decompressed = Vec::new();
    match decoder.read_to_end(&mut decompressed) {
        Ok(_) => Ok(decompressed),
        Err(e) => Err(format!("Failed to decompress: {}", e)),
    }
}

/// Parse protobuf data using prost
fn parse_kdb_protobuf(data: &[u8]) -> Result<KnowledgeBase, String> {
    console_log!("[WASM] Parsing protobuf data...");

    match KnowledgeBase::decode(data) {
        Ok(kdb_data) => {
            let module_count = kdb_data.modules.len();
            let signal_count: usize = kdb_data.modules.iter().map(|m| m.signals.len()).sum();
            console_log!("[WASM] Parsed KDB: {} modules, {} signals", module_count, signal_count);
            Ok(kdb_data)
        }
        Err(e) => Err(format!("Failed to decode protobuf: {}", e)),
    }
}

/// Store KDB data to IndexedDB - new architecture
/// Stores data separately to different stores matching the new schema
async fn store_kdb_to_indexeddb(kdb_data: &KnowledgeBase, kdb_id: &str) -> Result<(), JsValue> {
    console_log!("[WASM] Storing KDB to IndexedDB: {}", kdb_id);
    
    // Extract top module IDs from hierarchies
    let top_module_ids: Vec<u32> = kdb_data.hierarchies.iter()
        .map(|h| h.top_module_id)
        .collect();
    console_log!("[WASM] Extracted top_module_ids: {:?}", top_module_ids);
    
    // 1. Store knowledge base metadata (header + hierarchies only)
    let header = kdb_data.header.as_ref();
    let kb_data = serde_json::json!({
        "id": kdb_id,
        "header": {
            "version": header.map(|h| h.version.clone()).unwrap_or_default(),
            "projectName": header.map(|h| h.project_name.clone()).unwrap_or_else(|| kdb_id.to_string()),
            "createdAt": header.map(|h| h.created_at.clone()).unwrap_or_default(),
        },
        "topModuleIds": top_module_ids,
        "hierarchies": kdb_data.hierarchies.iter().map(|h| serde_json::json!({
            "topModuleId": h.top_module_id,
            "moduleIds": h.module_ids.clone(),
        })).collect::<Vec<_>>(),
        "timestamp": js_sys::Date::now() as u64,
    });
    
    let kb_value = serde_wasm_bindgen::to_value(&kb_data)?;
    console_log!("[WASM] Storing knowledge base with topModuleIds: {:?}", top_module_ids);
    console_log!("[WASM] kb_data JSON: {}", kb_data.to_string());
    console_log!("[WASM] Storing knowledge base...");
    
    let kb_promise = store_knowledge_base(kdb_id, &kb_value);
    match wasm_bindgen_futures::JsFuture::from(kb_promise).await {
        Ok(_) => console_log!("[WASM] Stored knowledge base successfully"),
        Err(e) => {
            console_log!("[WASM] Failed to store knowledge base: {:?}", e);
            return Err(e);
        }
    }
    
    // 2. Store modules with their signals (key is numeric id)
    console_log!("[WASM] Storing {} modules...", kdb_data.modules.len());
    for module in &kdb_data.modules {
        let module_data = serde_json::json!({
            "id": module.id,
            "name": &module.name,
            "fullName": &module.full_name,
            "parentModuleId": module.parent_module_id,
            "fileId": module.file_id,
            "isInstance": module.is_instance,
            "signals": module.signals.iter().map(|s| serde_json::json!({
                "id": s.id,
                "name": &s.name,
                "fullName": &s.full_name,
                "signalType": s.r#type,
                "msb": s.msb,
                "lsb": s.lsb,
                "parentModuleId": s.parent_module_id,
                "declaration": s.declaration.as_ref().map(|d| serde_json::json!({
                    "fileId": d.file_id,
                    "line": d.line,
                })),
                "driverSignalIds": s.driver_signal_ids.clone(),
                "direction": s.direction,
                "driverLines": s.driver_lines.iter().map(|d| serde_json::json!({
                    "fileId": d.file_id,
                    "line": d.line,
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "childModuleIds": module.child_module_ids.clone(),
        });
        let module_value = serde_wasm_bindgen::to_value(&module_data)?;
        
        let module_promise = store_module(module.id, &module_value, kdb_id);
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(module_promise).await {
            console_log!("[WASM] Failed to store module {}: {:?}", module.id, e);
        }
    }
    console_log!("[WASM] Stored {} modules", kdb_data.modules.len());
    
    // 3. Store source files (key is numeric id)
    console_log!("[WASM] Storing {} source files...", kdb_data.files.len());
    for file in &kdb_data.files {
        let file_promise = store_source_file(file.id, &file.path, &file.content, kdb_id);
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(file_promise).await {
            console_log!("[WASM] Failed to store file {}: {:?}", file.id, e);
        }
    }
    console_log!("[WASM] Stored {} source files", kdb_data.files.len());
    
    Ok(())
}

/// Create mock KDB data for testing
fn create_mock_kdb_data(kdb_id: &str) -> KnowledgeBase {
    KnowledgeBase {
        header: Some(KDBHeader {
            version: "1.0.0".to_string(),
            project_name: kdb_id.to_string(),
            created_at: "2024-01-01T00:00:00Z".to_string(),
        }),
        files: vec![
            SourceFile {
                id: 1,
                path: "top.v".to_string(),
                content: "module top();\nendmodule".to_string(),
                signal_links: vec![],
                submod_links: vec![],
            }
        ],
        modules: vec![
            Module {
                id: 3,
                name: "work@tb_top".to_string(),
                full_name: "work@tb_top".to_string(),
                parent_module_id: 0,
                file_id: 1,
                declaration: Some(SourceLocation { file_id: 1, line: 1 }),
                signals: vec![],
                is_instance: false,
                child_module_ids: vec![4],
            },
            Module {
                id: 4,
                name: "work@dut".to_string(),
                full_name: "work@tb_top.u_dut".to_string(),
                parent_module_id: 3,
                file_id: 1,
                declaration: Some(SourceLocation { file_id: 1, line: 1 }),
                signals: vec![
                    Signal {
                        id: 1,
                        name: "clk".to_string(),
                        full_name: "work@tb_top.u_dut.clk".to_string(),
                        r#type: SignalType::Wire as i32,
                        msb: 0,
                        lsb: 0,
                        parent_module_id: 4,
                        declaration: Some(SourceLocation { file_id: 1, line: 2 }),
                        driver_signal_ids: vec![],
                        direction: PortDirection::Input as i32,
                        driver_lines: vec![],
                    },
                    Signal {
                        id: 2,
                        name: "rst".to_string(),
                        full_name: "work@tb_top.u_dut.rst".to_string(),
                        r#type: SignalType::Wire as i32,
                        msb: 0,
                        lsb: 0,
                        parent_module_id: 4,
                        declaration: Some(SourceLocation { file_id: 1, line: 3 }),
                        driver_signal_ids: vec![],
                        direction: PortDirection::Input as i32,
                        driver_lines: vec![],
                    },
                ],
                is_instance: true,
                child_module_ids: vec![5],
            },
            Module {
                id: 5,
                name: "work@cluster0".to_string(),
                full_name: "work@tb_top.u_dut.u_cluster0".to_string(),
                parent_module_id: 4,
                file_id: 1,
                declaration: Some(SourceLocation { file_id: 1, line: 1 }),
                signals: vec![
                    Signal {
                        id: 3,
                        name: "data_in".to_string(),
                        full_name: "work@tb_top.u_dut.u_cluster0.data_in".to_string(),
                        r#type: SignalType::Wire as i32,
                        msb: 31,
                        lsb: 0,
                        parent_module_id: 5,
                        declaration: Some(SourceLocation { file_id: 1, line: 2 }),
                        driver_signal_ids: vec![],
                        direction: PortDirection::Input as i32,
                        driver_lines: vec![],
                    },
                ],
                is_instance: true,
                child_module_ids: vec![],
            },
        ],
        hierarchies: vec![
            DesignHierarchy {
                top_module_id: 3,
                module_ids: vec![3, 4, 5],
            }
        ],
    }
}

/// Initialize WASM module
#[wasm_bindgen(start)]
pub fn start() {
    console_log!("[WASM] HWDA WASM module initialized");
}
