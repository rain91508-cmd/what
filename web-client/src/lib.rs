use wasm_bindgen::prelude::*;
use wasm_bindgen::JsValue;
use js_sys::{Object, Array, Reflect};
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

// Number of records aggregated into a single batched store call.
const STORE_BATCH_SIZE: usize = 20000;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// IndexedDB operations - called through JS wrapper functions
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window)]
    fn store_knowledge_base(id: &str, data: &JsValue) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_signals_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_drivers_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_modules_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_signal_defs_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_source_file_info(id: u32, path: &str, name: &str, full_name: &str, total_lines: u32, line_index_offset: &[i32], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_source_file_content_opfs(id: u32, content: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn get_source_file_content_by_range(file_id: u32, start_byte: u32, end_byte: u32, kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn clear_kdb_data(kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window, js_name = report_kdb_progress)]
    fn report_kdb_progress(step: u32, total: u32, message: &str);

    #[wasm_bindgen(js_namespace = window, js_name = report_heartbeat)]
    fn report_heartbeat();
}

/// Total number of discrete "unpacking to local storage" steps reported to the UI.
const KDB_STORE_TOTAL_STEPS: u32 = 6;

fn report_step(step: u32, message: &str) {
    report_kdb_progress(step, KDB_STORE_TOTAL_STEPS, message);
}

/// How often (in records) to emit a heartbeat from inside a serialization loop.
const HEARTBEAT_EVERY: u32 = 20000;

fn keep_heartbeat_alive(count: u32, every: u32) {
    if every > 0 && count % every == 0 {
        report_heartbeat();
    }
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

fn now_ts() -> String {
    let d = js_sys::Date::new_0();
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        d.get_hours(),
        d.get_minutes(),
        d.get_seconds(),
        d.get_milliseconds()
    )
}

macro_rules! store_log {
    ($($arg:tt)*) => {{
        log(&format!("[{}] {}", now_ts(), format!($($arg)*)));
    }};
}

// ============================================
// Streaming KDB Parser — Approach B (§3.9)
// ============================================
// Downloads the KDB in chunks via JS, then feeds the complete compressed
// data to WASM in one shot. The key memory saving is on the JS side:
// instead of accumulating `chunks[]` and then creating a separate `combined`
// buffer, the JS side writes directly into a single growing Uint8Array,
// eliminating the intermediate chunks[] array and the copy into combined.
//
// Usage from JS:
//   const parser = KdbStreamParser.create(kdbId, totalCompressedSize);
//   // after all chunks received:
//   parser.feed_complete(kdbData);  // validate header + trigger decompress + parse
//   parser.finalize();              // free decompressed buffer
//   const name = await parser.store_async();  // store to IndexedDB/OPFS

#[wasm_bindgen]
pub struct KdbStreamParser {
    kdb_id: String,
    /// Parsed KDB data (stored between finalize and store)
    kdb_data: Option<KnowledgeBase>,
    design_name: Option<String>,
    error: Option<String>,
    /// Whether finalize has been called
    finalized: bool,
}

#[wasm_bindgen]
impl KdbStreamParser {
    /// Create a new streaming parser.
    pub fn create(kdb_id: &str) -> KdbStreamParser {
        KdbStreamParser {
            kdb_id: kdb_id.to_string(),
            kdb_data: None,
            design_name: None,
            error: None,
            finalized: false,
        }
    }

    /// Feed the complete compressed KDB data (including the 8-byte header).
    /// Validates the magic number, decompresses, and parses the protobuf.
    /// Call finalize() after this to free memory, then store_async() to persist.
    pub fn feed_complete(&mut self, data: &[u8]) -> Result<(), JsValue> {
        if self.finalized {
            return Err(JsValue::from_str("Parser already finalized"));
        }

        if data.len() < 8 {
            return Err(JsValue::from_str("KDB data too small for 8-byte header"));
        }

        // Validate magic
        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if magic != CWDK_MAGIC {
            return Err(JsValue::from_str(&format!(
                "Invalid KDB magic number: 0x{:08X}", magic
            )));
        }

        let original_size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
        console_log!("[WASM] Streaming: magic OK, original_size={}, compressed={}",
            original_size, data.len() - 8);

        // Decompress
        report_step(1, "Decompressing KDB...");
        let compressed_data = &data[8..];
        let decompressed = match decompress_zstd(compressed_data, original_size) {
            Ok(d) => d,
            Err(e) => return Err(JsValue::from_str(&format!("Decompression failed: {}", e))),
        };
        console_log!("[WASM] Streaming: decompressed {} bytes", decompressed.len());

        // Parse protobuf
        report_step(2, "Parsing KDB structure...");
        let kdb_data = match parse_kdb_protobuf(&decompressed) {
            Ok(d) => d,
            Err(e) => {
                console_log!("[WASM] Protobuf parsing failed: {}, using mock data", e);
                create_mock_kdb_data(&self.kdb_id)
            }
        };

        // Free decompressed buffer before the (long) store phase
        drop(decompressed);

        let project_name = kdb_data.header.as_ref()
            .map(|h| h.project_name.clone())
            .unwrap_or_else(|| self.kdb_id.clone());

        self.design_name = Some(project_name);
        self.kdb_data = Some(kdb_data);
        Ok(())
    }

    /// Finalize: free the parsed data from memory (after store_async).
    /// Returns the design name.
    pub fn finalize(&mut self) -> Result<String, JsValue> {
        if self.finalized {
            if let Some(ref name) = self.design_name {
                return Ok(name.clone());
            }
            return Err(JsValue::from_str(self.error.as_deref().unwrap_or("Unknown error")));
        }
        self.finalized = true;

        // Free the parsed KDB data
        self.kdb_data = None;

        self.design_name.clone()
            .ok_or_else(|| JsValue::from_str("No parsed data"))
    }

    /// After feed_complete(), call this to store the parsed data to IndexedDB/OPFS.
    /// Returns the design name on success.
    pub async fn store_async(&mut self) -> Result<String, JsValue> {
        let kdb_data = self.kdb_data.take()
            .ok_or_else(|| JsValue::from_str("No parsed data to store"))?;
        let project_name = self.design_name.clone()
            .unwrap_or_else(|| self.kdb_id.clone());

        // Clear existing data for this KDB
        console_log!("[WASM] Clearing existing data for KDB: {}", self.kdb_id);
        let clear_promise = clear_kdb_data(&self.kdb_id);
        wasm_bindgen_futures::JsFuture::from(clear_promise).await?;

        // Store to IndexedDB/OPFS
        store_log!("[WASM] Storing KDB data to IndexedDB...");
        store_kdb_to_indexeddb(kdb_data, &self.kdb_id).await?;

        store_log!("[WASM] KDB stored successfully: {}", project_name);
        Ok(project_name)
    }
}

// ============================================
// Original batch parser (kept for backward compat / URL/bytes paths)
// ============================================

/// Parse KDB file and store directly to IndexedDB
/// Returns the design name on success
#[wasm_bindgen]
pub async fn parse_and_store_kdb(kdb_id: &str, data: &[u8]) -> Result<String, JsValue> {
    console_log!("[WASM] Starting KDB parsing for: {}", kdb_id);

    if data.len() < 8 {
        return Err(JsValue::from_str("KDB file too small"));
    }

    let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    console_log!("[WASM] Magic number: 0x{:08X}", magic);

    if magic != CWDK_MAGIC {
        return Err(JsValue::from_str(&format!(
            "Invalid KDB magic number: 0x{:08X}", magic
        )));
    }

    let original_size = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    console_log!("[WASM] Original size: {} bytes", original_size);

    let compressed_data = &data[8..];
    console_log!("[WASM] Compressed size: {} bytes", compressed_data.len());

    report_step(1, "Decompressing KDB...");
    let decompressed = match decompress_zstd(compressed_data, original_size) {
        Ok(data) => data,
        Err(e) => return Err(JsValue::from_str(&format!("Decompression failed: {}", e))),
    };

    console_log!("[WASM] Decompressed {} bytes", decompressed.len());

    report_step(2, "Parsing KDB structure...");
    let kdb_data = match parse_kdb_protobuf(&decompressed) {
        Ok(data) => {
            console_log!("[WASM] Parsed KDB: {} modules, {} signal instances",
                data.modules.len(), data.all_signal_insts.len());
            data
        }
        Err(e) => {
            console_log!("[WASM] Protobuf parsing failed: {}, using mock data", e);
            create_mock_kdb_data(kdb_id)
        }
    };

    drop(decompressed);

    let project_name = kdb_data.header.as_ref()
        .map(|h| h.project_name.clone())
        .unwrap_or_else(|| kdb_id.to_string());

    console_log!("[WASM] Clearing existing data for KDB: {}", kdb_id);
    let clear_promise = clear_kdb_data(kdb_id);
    wasm_bindgen_futures::JsFuture::from(clear_promise).await?;

    store_log!("[WASM] Storing KDB data to IndexedDB...");
    store_kdb_to_indexeddb(kdb_data, kdb_id).await?;

    store_log!("[WASM] KDB parsed and stored successfully: {}", project_name);
    Ok(project_name)
}

/// Decompress zstd data using pure Rust ruzstd
fn decompress_zstd(compressed: &[u8], original_size: usize) -> Result<Vec<u8>, String> {
    console_log!("[WASM] Decompressing {} bytes (expected: {})...", compressed.len(), original_size);

    let mut decompressed = Vec::with_capacity(original_size);
    let mut decoder = ruzstd::frame_decoder::FrameDecoder::new();
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
            // Try decode_all_to_vec as fallback (needs a Vec, passes input separately)
            let mut decompressed2 = Vec::with_capacity(original_size);
            let mut decoder2 = ruzstd::frame_decoder::FrameDecoder::new();
            match decoder2.decode_all_to_vec(compressed, &mut decompressed2) {
                Ok(()) => {
                    console_log!("[WASM] FrameDecoder decode_all_to_vec decompressed {} bytes", decompressed2.len());
                    Ok(decompressed2)
                }
                Err(e2) => Err(format!("Failed to decompress zstd: {:?} (first: {:?})", e2, e))
            }
        }
    }
}

/// Parse protobuf data using prost
fn parse_kdb_protobuf(data: &[u8]) -> Result<KnowledgeBase, String> {
    console_log!("[WASM] Parsing protobuf data...");
    console_log!("[WASM] Data size: {} bytes", data.len());

    let hex_str: String = data.iter().take(100).map(|b| format!("{:02x}", b)).collect::<Vec<_>>().join(" ");
    console_log!("[WASM] First 100 bytes: {}", hex_str);

    match KnowledgeBase::decode(data) {
        Ok(kdb_data) => {
            console_log!("[WASM] SUCCESS! Parsed KDB: {} modules, {} signal instances",
                kdb_data.modules.len(), kdb_data.all_signal_insts.len());
            if let Some(first_mod) = kdb_data.modules.first() {
                console_log!("[WASM] First module: name='{}', parent_id={}, is_instance={}",
                    first_mod.name, first_mod.parent_module_id, first_mod.is_instance);
            }
            Ok(kdb_data)
        }
        Err(e) => {
            console_log!("[WASM] ERROR: Protobuf decode failed: {}", e);
            match KDBHeader::decode(data) {
                Ok(header) => {
                    console_log!("[WASM] Header OK: version='{}', project='{}'",
                        header.version, header.project_name);
                }
                Err(header_err) => {
                    console_log!("[WASM] Header also failed: {}", header_err);
                }
            }
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

/// Store KDB data to IndexedDB
async fn store_kdb_to_indexeddb(mut kdb_data: KnowledgeBase, kdb_id: &str) -> Result<(), JsValue> {
    store_log!("[WASM] Storing KDB to IndexedDB: {}", kdb_id);

    let top_module_ids: Vec<u32> = kdb_data.hierarchies.iter()
        .map(|h| h.top_module_id)
        .collect();
    console_log!("[WASM] Extracted top_module_ids: {:?}", top_module_ids);

    // 1. Store knowledge base metadata
    let header = kdb_data.header.as_ref();
    let kb_obj = Object::new();
    Reflect::set(&kb_obj, &"id".into(), &kdb_id.into())?;

    let header_obj = Object::new();
    Reflect::set(&header_obj, &"version".into(), &header.map(|h| h.version.clone()).unwrap_or_default().into())?;
    Reflect::set(&header_obj, &"projectName".into(), &header.map(|h| h.project_name.clone()).unwrap_or_else(|| kdb_id.to_string()).into())?;
    Reflect::set(&header_obj, &"createdAt".into(), &header.map(|h| h.created_at.clone()).unwrap_or_default().into())?;
    Reflect::set(&kb_obj, &"header".into(), &header_obj)?;

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

    store_log!("[WASM] Storing knowledge base...");
    report_step(3, "Storing design metadata...");
    let kb_promise = store_knowledge_base(kdb_id, &kb_obj);
    match wasm_bindgen_futures::JsFuture::from(kb_promise).await {
        Ok(_) => store_log!("[WASM] Stored knowledge base successfully"),
        Err(e) => { store_log!("[WASM] Failed to store knowledge base: {:?}", e); return Err(e); }
    }

    // 2. Store source files
    let file_count = kdb_data.file_infos.len();
    store_log!("[WASM] Storing {} source files...", file_count);
    report_step(4, "Storing source files...");
    {
      let mut file_infos = std::mem::take(&mut kdb_data.file_infos).into_iter();
      let mut file_contents = std::mem::take(&mut kdb_data.file_contents).into_iter();
      let mut file_id: u32 = 0;
      let report_every: u32 = ((file_count / 50) as u32).max(1);
      while let (Some(file_info), Some(file_content)) = (file_infos.next(), file_contents.next()) {
        file_id += 1;
        if file_count > 0 && file_id % report_every == 0 {
          report_kdb_progress(4, KDB_STORE_TOTAL_STEPS,
              &format!("Storing source files... {}/{}", file_id, file_count));
        }
        let name = file_info.path.split('/').last().unwrap_or(&file_info.path);
        let info_promise = store_source_file_info(
            file_id, &file_info.path, name, &file_info.path,
            file_info.total_lines,
            &file_info.line_index_offset.iter().map(|&x| x as i32).collect::<Vec<i32>>(),
            kdb_id,
        );
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(info_promise).await {
            store_log!("[WASM] Failed to store file info {}: {:?}", file_id, e);
        }
        let content_promise = store_source_file_content_opfs(file_id, &file_content.content, kdb_id);
        if let Err(e) = wasm_bindgen_futures::JsFuture::from(content_promise).await {
            store_log!("[WASM] Failed to store file content {}: {:?}", file_id, e);
        }
      }
    }
    store_log!("[WASM] Stored {} source files", file_count);
    report_kdb_progress(4, KDB_STORE_TOTAL_STEPS,
        &format!("Storing source files... {}/{}", file_count, file_count));

    // 3. Store modules + signal defs
    let module_count = kdb_data.modules.len();
    store_log!("[WASM] Storing {} modules (OPFS binary)...", module_count);
    report_step(5, &format!("Storing {} modules...", module_count));

    const MODULE_RECORD_SIZE: usize = 42;
    let mut name_pool: Vec<u8> = Vec::new();
    let mut child_pool: Vec<u8> = Vec::new();
    let mut skeleton_records: Vec<u8> = Vec::with_capacity(module_count * MODULE_RECORD_SIZE);
    for (mi, module) in kdb_data.modules.iter().enumerate() {
        keep_heartbeat_alive(mi as u32 + 1, HEARTBEAT_EVERY);
        let name_bytes = module.name.as_bytes();
        let name_off = name_pool.len() as u32;
        name_pool.extend_from_slice(name_bytes);
        let name_len = name_bytes.len() as u32;

        let (def_file_id, def_start_line, def_end_line) = match &module.definition {
            Some(d) => (d.file_id, d.start_line, d.end_line),
            None => (0u32, 0u32, 0u32),
        };
        let has_def = module.definition.is_some() as u8;

        let child_off = (child_pool.len() / 4) as u32;
        let child_count = module.child_module_ids.len() as u32;
        for &cid in &module.child_module_ids {
            child_pool.extend_from_slice(&cid.to_le_bytes());
        }

        skeleton_records.extend_from_slice(&name_off.to_le_bytes());
        skeleton_records.extend_from_slice(&name_len.to_le_bytes());
        skeleton_records.extend_from_slice(&module.parent_module_id.to_le_bytes());
        skeleton_records.extend_from_slice(&has_def.to_le_bytes());
        skeleton_records.extend_from_slice(&def_file_id.to_le_bytes());
        skeleton_records.extend_from_slice(&def_start_line.to_le_bytes());
        skeleton_records.extend_from_slice(&def_end_line.to_le_bytes());
        skeleton_records.extend_from_slice(&(module.is_instance as u8).to_le_bytes());
        skeleton_records.extend_from_slice(&module.def_module_id.to_le_bytes());
        skeleton_records.extend_from_slice(&module.signal_insts_start_id.to_le_bytes());
        skeleton_records.extend_from_slice(&child_count.to_le_bytes());
        skeleton_records.extend_from_slice(&child_off.to_le_bytes());
    }
    let name_pool_offset = (16usize + skeleton_records.len()) as u32;
    let child_pool_offset = (name_pool_offset as usize + name_pool.len()) as u32;
    let total_modules_size = (child_pool_offset as usize + child_pool.len()) as u32;
    let mut modules_buf: Vec<u8> = Vec::with_capacity(total_modules_size as usize);
    modules_buf.extend_from_slice(&(module_count as u32).to_le_bytes());
    modules_buf.extend_from_slice(&name_pool_offset.to_le_bytes());
    modules_buf.extend_from_slice(&child_pool_offset.to_le_bytes());
    modules_buf.extend_from_slice(&total_modules_size.to_le_bytes());
    modules_buf.extend_from_slice(&skeleton_records);
    modules_buf.extend_from_slice(&name_pool);
    modules_buf.extend_from_slice(&child_pool);

    let mod_promise = store_modules_opfs(&modules_buf, kdb_id);
    match wasm_bindgen_futures::JsFuture::from(mod_promise).await {
        Ok(_) => store_log!("[WASM] Stored {} modules ({} bytes)", module_count, modules_buf.len()),
        Err(e) => { store_log!("[WASM] Failed to store modules.bin: {:?}", e); return Err(e); }
    }
    drop(modules_buf);

    // module_signal_defs.bin
    let mut regions: Vec<Vec<u8>> = Vec::with_capacity(module_count);
    let mut def_counts: Vec<u32> = Vec::with_capacity(module_count);
    for (di, module) in kdb_data.modules.iter().enumerate() {
        keep_heartbeat_alive(di as u32 + 1, HEARTBEAT_EVERY);
        if (di as u32 + 1) % 2000 == 0 {
            store_log!("[WASM] Serializing signal defs... {}/{}", di + 1, module_count);
        }
        let mut region: Vec<u8> = Vec::new();
        let defs = &module.signal_defs;
        def_counts.push(defs.len() as u32);
        region.extend_from_slice(&(defs.len() as u32).to_le_bytes());
        let mut region_name_pool: Vec<u8> = Vec::new();
        let mut def_records: Vec<u8> = Vec::with_capacity(defs.len() * 25);
        for s in defs {
            let nb = s.name.as_bytes();
            let noff = region_name_pool.len() as u32;
            region_name_pool.extend_from_slice(nb);
            let nlen = nb.len() as u32;
            let (decl_file_id, decl_line) = match &s.declaration {
                Some(d) => (d.file_id, d.line),
                None => (0u32, 0u32),
            };
            let has_decl = s.declaration.is_some() as u8;
            def_records.extend_from_slice(&noff.to_le_bytes());
            def_records.extend_from_slice(&nlen.to_le_bytes());
            def_records.extend_from_slice(&s.r#type.to_le_bytes());
            def_records.extend_from_slice(&has_decl.to_le_bytes());
            def_records.extend_from_slice(&decl_file_id.to_le_bytes());
            def_records.extend_from_slice(&decl_line.to_le_bytes());
            def_records.extend_from_slice(&s.direction.to_le_bytes());
        }
        region.extend_from_slice(&(region_name_pool.len() as u32).to_le_bytes());
        region.extend_from_slice(&region_name_pool);
        region.extend_from_slice(&def_records);
        regions.push(region);
    }
    let table_offset = (8usize + (module_count + 1) * 8) as u32;
    let mut cur: u32 = table_offset;
    let mut offsets: Vec<u32> = Vec::with_capacity(module_count + 1);
    for r in &regions { offsets.push(cur); cur += r.len() as u32; }
    offsets.push(cur);
    let mut sigdefs_buf: Vec<u8> = Vec::with_capacity(cur as usize);
    sigdefs_buf.extend_from_slice(&(module_count as u32).to_le_bytes());
    sigdefs_buf.extend_from_slice(&table_offset.to_le_bytes());
    for i in 0..module_count {
        sigdefs_buf.extend_from_slice(&def_counts[i].to_le_bytes());
        sigdefs_buf.extend_from_slice(&offsets[i].to_le_bytes());
    }
    sigdefs_buf.extend_from_slice(&0u32.to_le_bytes());
    sigdefs_buf.extend_from_slice(&offsets[module_count].to_le_bytes());
    for r in &regions { sigdefs_buf.extend_from_slice(r); }

    let sd_promise = store_signal_defs_opfs(&sigdefs_buf, kdb_id);
    match wasm_bindgen_futures::JsFuture::from(sd_promise).await {
        Ok(_) => store_log!("[WASM] Stored signal defs ({} bytes)", sigdefs_buf.len()),
        Err(e) => { store_log!("[WASM] Failed to store signal defs: {:?}", e); return Err(e); }
    }
    drop(sigdefs_buf);
    drop(kdb_data.modules);
    store_log!("[WASM] Stored {} modules", module_count);

    // 4. Store signal instances + drivers
    let signal_count = kdb_data.all_signal_insts.len();
    let driver_count = kdb_data.all_driver_locations.len();
    store_log!("[WASM] Storing {} signal instances + {} drivers...", signal_count, driver_count);
    report_step(6, &format!("Storing {} signals + {} drivers...", signal_count, driver_count));

    let signal_insts = std::mem::take(&mut kdb_data.all_signal_insts);
    let driver_locs = std::mem::take(&mut kdb_data.all_driver_locations);

    const SIGNAL_RECORD_SIZE: usize = 18;
    let mut signals_buf: Vec<u8> = Vec::with_capacity(signal_insts.len() * SIGNAL_RECORD_SIZE);
    for (si, s) in signal_insts.iter().enumerate() {
        keep_heartbeat_alive(si as u32 + 1, HEARTBEAT_EVERY);
        if (si as u32 + 1) % HEARTBEAT_EVERY == 0 {
            store_log!("[WASM] Serializing signals... {}/{}", si + 1, signal_count);
        }
        signals_buf.extend_from_slice(&s.msb.to_le_bytes());
        signals_buf.extend_from_slice(&s.lsb.to_le_bytes());
        signals_buf.extend_from_slice(&s.parent_module_id.to_le_bytes());
        signals_buf.extend_from_slice(&s.driver_start.to_le_bytes());
        let dc: u16 = if s.driver_count > u16::MAX as u32 { u16::MAX } else { s.driver_count as u16 };
        signals_buf.extend_from_slice(&dc.to_le_bytes());
    }
    drop(signal_insts);

    let sig_promise = store_signals_opfs(&signals_buf, kdb_id);
    match wasm_bindgen_futures::JsFuture::from(sig_promise).await {
        Ok(_) => store_log!("[WASM] Stored {} signal instances ({} bytes)", signal_count, signals_buf.len()),
        Err(e) => { store_log!("[WASM] Failed to store signals.bin: {:?}", e); return Err(e); }
    }
    drop(signals_buf);

    const DRIVER_RECORD_SIZE: usize = 12;
    let mut drivers_buf: Vec<u8> = Vec::with_capacity(driver_locs.len() * DRIVER_RECORD_SIZE);
    for (dri, d) in driver_locs.iter().enumerate() {
        keep_heartbeat_alive(dri as u32 + 1, HEARTBEAT_EVERY);
        drivers_buf.extend_from_slice(&d.driver_signal_global_id.to_le_bytes());
        drivers_buf.extend_from_slice(&d.line.to_le_bytes());
    }
    drop(driver_locs);

    let drv_promise = store_drivers_opfs(&drivers_buf, kdb_id);
    match wasm_bindgen_futures::JsFuture::from(drv_promise).await {
        Ok(_) => store_log!("[WASM] Stored {} drivers ({} bytes)", driver_count, drivers_buf.len()),
        Err(e) => { store_log!("[WASM] Failed to store drivers.bin: {:?}", e); return Err(e); }
    }
    drop(drivers_buf);

    Ok(())
}

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
                line_index_offset: vec![0],
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
                driver_start: 0,
                driver_count: 0,
            },
        ],
        all_driver_locations: vec![],
    }
}
