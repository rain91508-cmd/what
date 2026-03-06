use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use js_sys::{Object, Array, Reflect};
use ruzstd::StreamingDecoder;
use std::io::Read;
use prost::Message;

// Manual protobuf definitions
mod kdb_proto;
use kdb_proto::*;

// Waveform data provider
mod waveform_provider;
pub use waveform_provider::WaveformDataProvider;

// OPFS cache
mod opfs_cache;

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
    fn store_signal_inst(global_index: u32, data: &JsValue, kdb_id: &str) -> js_sys::Promise;
    
    // Store file info (metadata) to IndexedDB
    #[wasm_bindgen(js_namespace = window)]
    fn store_source_file_info(id: u32, path: &str, name: &str, full_name: &str, total_lines: u32, line_index_offset: &[i32], kdb_id: &str) -> js_sys::Promise;
    
    // Store file content (large data) to OPFS
    #[wasm_bindgen(js_namespace = window)]
    fn store_source_file_content_opfs(id: u32, content: &[u8], kdb_id: &str) -> js_sys::Promise;
    
    // Get content by byte range from OPFS (using index offset)
    #[wasm_bindgen(js_namespace = window)]
    fn get_source_file_content_by_range(file_id: u32, start_byte: u32, end_byte: u32, kdb_id: &str) -> js_sys::Promise;
    
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
            let module_count = data.modules.len();
            let signal_inst_count = data.all_signal_insts.len();
            console_log!("[WASM] Parsed KDB: {} modules, {} signal instances", module_count, signal_inst_count);
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
fn decompress_zstd(compressed: &[u8], original_size: usize) -> Result<Vec<u8>, String> {
    console_log!("[WASM] Decompressing {} bytes (expected: {})...", compressed.len(), original_size);
    
    // Try to decode with FrameDecoder
    use ruzstd::frame_decoder::FrameDecoder;
    
    let mut decompressed = Vec::with_capacity(original_size);
    let mut decoder = FrameDecoder::new();
    
    match decoder.decode_all(compressed, &mut decompressed) {
        Ok(_) => {
            console_log!("[WASM] Decompressed {} bytes", decompressed.len());
            if decompressed.len() != original_size {
                console_log!("[WASM] WARNING: Decompressed size mismatch (expected {}, got {})", 
                    original_size, decompressed.len());
            }
            Ok(decompressed)
        }
        Err(e) => {
            console_log!("[WASM] FrameDecoder failed: {:?}", e);
            // Try streaming decoder as fallback
            console_log!("[WASM] Trying StreamingDecoder...");
            let mut decoder = match StreamingDecoder::new(compressed) {
                Ok(d) => d,
                Err(e) => return Err(format!("Failed to create zstd decoder: {:?}", e)),
            };
            
            let mut decompressed2 = Vec::with_capacity(original_size);
            match decoder.read_to_end(&mut decompressed2) {
                Ok(_) => {
                    console_log!("[WASM] StreamingDecoder decompressed {} bytes", decompressed2.len());
                    Ok(decompressed2)
                }
                Err(e) => Err(format!("Failed to decompress: {}", e))
            }
        }
    }
}

/// Parse protobuf data using prost
fn parse_kdb_protobuf(data: &[u8]) -> Result<KnowledgeBase, String> {
    console_log!("[WASM] Parsing protobuf data...");
    console_log!("[WASM] Data size: {} bytes", data.len());
    
    // Print first 100 bytes in hex
    let hex_str: String = data.iter().take(100).map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ");
    console_log!("[WASM] First 100 bytes: {}", hex_str);

    // Try to parse KnowledgeBase
    match KnowledgeBase::decode(data) {
        Ok(kdb_data) => {
            let module_count = kdb_data.modules.len();
            let signal_inst_count = kdb_data.all_signal_insts.len();
            console_log!("[WASM] SUCCESS! Parsed KDB: {} modules, {} signal instances", module_count, signal_inst_count);
            
            // Debug: print first module info
            if let Some(first_mod) = kdb_data.modules.first() {
                console_log!("[WASM] First module: name='{}', parent_id={}, is_instance={}", 
                    first_mod.name, first_mod.parent_module_id, first_mod.is_instance);
            }
            
            Ok(kdb_data)
        }
        Err(e) => {
            console_log!("[WASM] ERROR: Protobuf decode failed: {}", e);
            
            // Try to decode header separately for debugging
            match KDBHeader::decode(data) {
                Ok(header) => {
                    console_log!("[WASM] Header OK: version='{}', project='{}'", 
                        header.version, header.project_name);
                }
                Err(header_err) => {
                    console_log!("[WASM] Header also failed: {}", header_err);
                }
            }
            
            // Try to manually parse first few fields
            console_log!("[WASM] Manual parse attempt:");
            if data.len() >= 2 {
                let tag = data[0];
                let field_num = tag >> 3;
                let wire_type = tag & 0x07;
                console_log!("[WASM]   Byte 0: tag=0x{:02x}, field={}, wire_type={}", tag, field_num, wire_type);
            }
            
            Err(format!("Failed to decode protobuf: {}", e))
        }
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
    
    // 1. Store knowledge base metadata (header + hierarchies only, no topModuleIds)
    let header = kdb_data.header.as_ref();
    let kb_obj = Object::new();
    Reflect::set(&kb_obj, &"id".into(), &kdb_id.into())?;
    
    // Header object
    let header_obj = Object::new();
    Reflect::set(&header_obj, &"version".into(), &header.map(|h| h.version.clone()).unwrap_or_default().into())?;
    Reflect::set(&header_obj, &"projectName".into(), &header.map(|h| h.project_name.clone()).unwrap_or_else(|| kdb_id.to_string()).into())?;
    Reflect::set(&header_obj, &"createdAt".into(), &header.map(|h| h.created_at.clone()).unwrap_or_default().into())?;
    Reflect::set(&kb_obj, &"header".into(), &header_obj)?;
    
    // Hierarchies array
    let hierarchies_arr = Array::new();
    for h in &kdb_data.hierarchies {
        let h_obj = Object::new();
        Reflect::set(&h_obj, &"topModuleId".into(), &h.top_module_id.into())?;
        let module_ids_arr = h.module_ids.iter().map(|&id| JsValue::from(id)).collect::<Array>();
        Reflect::set(&h_obj, &"moduleIds".into(), &module_ids_arr)?;
        hierarchies_arr.push(&h_obj);
    }
    Reflect::set(&kb_obj, &"hierarchies".into(), &hierarchies_arr)?;
    Reflect::set(&kb_obj, &"timestamp".into(), &(js_sys::Date::now() as u64).into())?;
    
    console_log!("[WASM] Storing knowledge base...");
    let kb_promise = store_knowledge_base(kdb_id, &kb_obj);
    match wasm_bindgen_futures::JsFuture::from(kb_promise).await {
        Ok(_) => console_log!("[WASM] Stored knowledge base successfully"),
        Err(e) => {
            console_log!("[WASM] Failed to store knowledge base: {:?}", e);
            return Err(e);
        }
    }
    
    // 2. Store modules (key is 1-based index)
    console_log!("[WASM] Storing {} modules...", kdb_data.modules.len());
    for (index, module) in kdb_data.modules.iter().enumerate() {
        let module_id = (index + 1) as u32;  // 1-based ID
        
        // Create module object using js_sys
        let module_obj = Object::new();
        Reflect::set(&module_obj, &"name".into(), &module.name.clone().into())?;
        Reflect::set(&module_obj, &"parentModuleId".into(), &module.parent_module_id.into())?;
        
        // Definition object
        if let Some(def) = &module.definition {
            let def_obj = Object::new();
            Reflect::set(&def_obj, &"fileId".into(), &def.file_id.into())?;
            Reflect::set(&def_obj, &"startLine".into(), &def.start_line.into())?;
            Reflect::set(&def_obj, &"endLine".into(), &def.end_line.into())?;
            Reflect::set(&module_obj, &"definition".into(), &def_obj)?;
        }
        
        // Signal definitions array
        let signal_defs_arr = Array::new();
        for s in &module.signal_defs {
            let s_obj = Object::new();
            Reflect::set(&s_obj, &"name".into(), &s.name.clone().into())?;
            Reflect::set(&s_obj, &"type".into(), &s.r#type.into())?;
            if let Some(decl) = &s.declaration {
                let decl_obj = Object::new();
                Reflect::set(&decl_obj, &"fileId".into(), &decl.file_id.into())?;
                Reflect::set(&decl_obj, &"line".into(), &decl.line.into())?;
                Reflect::set(&s_obj, &"declaration".into(), &decl_obj)?;
            }
            Reflect::set(&s_obj, &"direction".into(), &s.direction.into())?;
            signal_defs_arr.push(&s_obj);
        }
        Reflect::set(&module_obj, &"signalDefs".into(), &signal_defs_arr)?;
        
        Reflect::set(&module_obj, &"isInstance".into(), &module.is_instance.into())?;
        
        // Child module IDs array
        let child_ids_arr = module.child_module_ids.iter().map(|&id| JsValue::from(id)).collect::<Array>();
        Reflect::set(&module_obj, &"childModuleIds".into(), &child_ids_arr)?;
        
        Reflect::set(&module_obj, &"defModuleId".into(), &module.def_module_id.into())?;
        Reflect::set(&module_obj, &"signalInstsStartId".into(), &module.signal_insts_start_id.into())?;
        
        let module_promise = store_module(module_id, &module_obj, kdb_id);
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(module_promise).await {
            console_log!("[WASM] Failed to store module {}: {:?}", module_id, e);
        }
    }
    console_log!("[WASM] Stored {} modules", kdb_data.modules.len());
    
    // 3. Store signal instances (key is global index 0-based)
    console_log!("[WASM] Storing {} signal instances...", kdb_data.all_signal_insts.len());
    
    for (global_index, signal_inst) in kdb_data.all_signal_insts.iter().enumerate() {
        // Create JavaScript object directly using js_sys
        let inst_obj = Object::new();
        Reflect::set(&inst_obj, &"msb".into(), &signal_inst.msb.into())?;
        Reflect::set(&inst_obj, &"lsb".into(), &signal_inst.lsb.into())?;
        Reflect::set(&inst_obj, &"parentModuleId".into(), &signal_inst.parent_module_id.into())?;
        
        // Create driverLocations array
        let driver_locations_arr = Array::new();
        for driver in &signal_inst.driver_locations {
            let driver_obj = Object::new();
            Reflect::set(&driver_obj, &"driverSignalGlobalId".into(), &driver.driver_signal_global_id.into())?;
            Reflect::set(&driver_obj, &"line".into(), &driver.line.into())?;
            driver_locations_arr.push(&driver_obj);
        }
        Reflect::set(&inst_obj, &"driverLocations".into(), &driver_locations_arr)?;
        
        let inst_promise = store_signal_inst(global_index as u32, &inst_obj, kdb_id);
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(inst_promise).await {
            console_log!("[WASM] Failed to store signal instance {}: {:?}", global_index, e);
        }
    }
    console_log!("[WASM] Stored {} signal instances", kdb_data.all_signal_insts.len());
    
    // 4. Store source files - separate info and content
    // Note: file_infos and file_contents have same length and order
    let file_count = kdb_data.file_infos.len();
    console_log!("[WASM] Storing {} source files...", file_count);
    
    for i in 0..file_count {
        let file_info = &kdb_data.file_infos[i];
        let file_content = &kdb_data.file_contents[i];
        let file_id = (i + 1) as u32;  // 1-based ID
        
        // Extract file name from path
        let name = file_info.path.split('/').last().unwrap_or(&file_info.path);
        
        // Store file info (metadata) to IndexedDB
        let info_promise = store_source_file_info(
            file_id, 
            &file_info.path, 
            name, 
            &file_info.path,  // full_name same as path for now
            file_info.total_lines,
            &file_info.line_index_offset.iter().map(|&x| x as i32).collect::<Vec<i32>>(),
            kdb_id
        );
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(info_promise).await {
            console_log!("[WASM] Failed to store file info {}: {:?}", file_id, e);
        }
        
        // Store file content (large data) to OPFS via JS
        let content_promise = store_source_file_content_opfs(
            file_id, 
            &file_content.content,  // bytes
            kdb_id
        );
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(content_promise).await {
            console_log!("[WASM] Failed to store file content {}: {:?}", file_id, e);
        }
    }
    console_log!("[WASM] Stored {} source files", file_count);
    
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
        file_infos: vec![
            SourceFileInfo {
                path: "top.v".to_string(),
                total_lines: 2,
                line_index_offset: vec![0],  // Line 1 starts at byte 0
            }
        ],
        file_contents: vec![
            SourceFileContent {
                content: "module top();\nendmodule".as_bytes().to_vec(),
            }
        ],
        modules: vec![
            Module {
                name: "work@tb_top".to_string(),
                parent_module_id: 0,
                definition: Some(ModuleSourceLocation {
                    file_id: 1,
                    start_line: 1,
                    end_line: 10,
                }),
                signal_defs: vec![],
                is_instance: false,
                child_module_ids: vec![2],
                def_module_id: 0,
                signal_insts_start_id: 0,
            },
            Module {
                name: "u_dut".to_string(),
                parent_module_id: 1,
                definition: Some(ModuleSourceLocation {
                    file_id: 1,
                    start_line: 5,
                    end_line: 8,
                }),
                signal_defs: vec![
                    SignalDef {
                        name: "clk".to_string(),
                        r#type: SignalType::Wire as i32,
                        declaration: Some(SourceLocation { file_id: 1, line: 6 }),
                        direction: PortDirection::Input as i32,
                    },
                ],
                is_instance: true,
                child_module_ids: vec![],
                def_module_id: 3,
                signal_insts_start_id: 0,
            },
            Module {
                name: "work@dut".to_string(),
                parent_module_id: 0,
                definition: Some(ModuleSourceLocation {
                    file_id: 1,
                    start_line: 1,
                    end_line: 20,
                }),
                signal_defs: vec![
                    SignalDef {
                        name: "clk".to_string(),
                        r#type: SignalType::Wire as i32,
                        declaration: Some(SourceLocation { file_id: 1, line: 2 }),
                        direction: PortDirection::Input as i32,
                    },
                ],
                is_instance: false,
                child_module_ids: vec![],
                def_module_id: 0,
                signal_insts_start_id: 0,
            },
        ],
        hierarchies: vec![
            DesignHierarchy {
                top_module_id: 1,
                module_ids: vec![1, 2, 3],
            }
        ],
        all_signal_insts: vec![
            SignalInst {
                msb: 0,
                lsb: 0,
                parent_module_id: 2,
                driver_locations: vec![],
            },
        ],
    }
}
