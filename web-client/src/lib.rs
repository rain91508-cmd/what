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

// Number of records aggregated into a single batched store call.
// The original code called store_signal_inst / store_module once PER record
// (2,005,030 times for n900) and awaited a JS Promise each time. That turned
// into 2M wasm suspensions + wasm->JS FFI object builds, which completely
// saturated the worker event loop (starving the heartbeat timer) and was the
// actual bottleneck. Batching collapses this to ~ (records / STORE_BATCH_SIZE)
// calls, one IndexedDB transaction each.
const STORE_BATCH_SIZE: usize = 20000;

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
    
    // Flat binary signal/driver store: the dominant path. WASM serializes the
    // signals and drivers into two contiguous byte buffers (matching the proto's
    // flat layout) and streams each to a single OPFS file. This avoids building
    // millions of JS objects / IndexedDB records entirely.
    //
    //   signals.bin : 18 bytes/record, indexed by signal global id
    //                 msb:u32, lsb:u32, parent_module_id:u32,
    //                 driver_start:u32, driver_count:u16   (all little-endian)
    //   drivers.bin : 12 bytes/record, indexed by signals.bin's driver_start
    //                 driver_signal_global_id:u64, line:u32 (little-endian)
    #[wasm_bindgen(js_namespace = window)]
    fn store_signals_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_drivers_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    // Flat binary module store: mirrors the signals/drivers path. WASM
    // serializes the whole module hierarchy into one contiguous little-endian
    // buffer (modules.bin) and the (heavy, lazily-read) signal definitions into a
    // second range-readable file (module_signal_defs.bin); each is written as a
    // single OPFS file, replacing 125k individual IndexedDB record reads.
    #[wasm_bindgen(js_namespace = window)]
    fn store_modules_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

    #[wasm_bindgen(js_namespace = window)]
    fn store_signal_defs_opfs(bytes: &[u8], kdb_id: &str) -> js_sys::Promise;

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

    // Report a coarse-grained "unpacking to local storage" step to the host so
    // the UI can show discrete progress (e.g. "Step 4/6: Storing 1234 source
    // files"). This is best-effort UI feedback only; the host defines a no-op if
    // it does not care. `step`/`total` are 1-based step indices, `message`
    // describes the current step.
    #[wasm_bindgen(js_namespace = window, js_name = report_kdb_progress)]
    fn report_kdb_progress(step: u32, total: u32, message: &str);

    // Lightweight heartbeat to the host's worker-stall watchdog. Called from
    // inside the long synchronous serialization loops (modules / signal defs /
    // signals / drivers) so the main thread keeps re-arming its heartbeat
    // timeout even while the worker is CPU-bound in a tight WASM loop where the
    // worker's own setInterval timer cannot fire. A postMessage to the main
    // thread is delivered independently of the worker yielding, so the host
    // receives it in real time.
    #[wasm_bindgen(js_namespace = window, js_name = report_heartbeat)]
    fn report_heartbeat();
}

/// Total number of discrete "unpacking to local storage" steps reported to the
/// UI (decompress, parse, metadata, source files, modules, signals+drivers).
const KDB_STORE_TOTAL_STEPS: u32 = 6;

/// Best-effort progress report to the host UI. Never fails the store.
fn report_step(step: u32, message: &str) {
    report_kdb_progress(step, KDB_STORE_TOTAL_STEPS, message);
}

/// How often (in records) to emit a heartbeat from inside a serialization loop.
/// Small enough that no synchronous loop stretch can outlast the host's
/// 'storing'-phase watchdog window; large enough that the wasm->JS FFI cost is
/// negligible (a handful of calls even for hundreds of thousands of records).
const HEARTBEAT_EVERY: u32 = 20000;

/// Feed the host's worker-stall watchdog from inside a long synchronous loop.
/// `count` is the 1-based record index; we fire once every `HEARTBEAT_EVERY`
/// records. Delivery does not require the worker to yield (postMessage is
/// independent of the worker event loop), so the main thread keeps resetting
/// its heartbeat timeout throughout the CPU-bound serialize.
fn keep_heartbeat_alive(count: u32, every: u32) {
    if every > 0 && count % every == 0 {
        report_heartbeat();
    }
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

/// Current local time as HH:MM:SS.mmm, for timestamping store-step logs.
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

/// Like console_log! but prefixes a timestamp; used for the discrete
/// "storing step" boundary prints so each step can be timed.
macro_rules! store_log {
    ($($arg:tt)*) => {{
        log(&format!("[{}] {}", now_ts(), format!($($arg)*)));
    }};
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
    
    report_step(1, "Decompressing KDB...");
    let decompressed = match decompress_zstd(compressed_data, original_size) {
        Ok(data) => data,
        Err(e) => return Err(JsValue::from_str(&format!("Decompression failed: {}", e))),
    };
    
    console_log!("[WASM] Decompressed {} bytes", decompressed.len());
    
    // Parse protobuf data
    report_step(2, "Parsing KDB structure...");
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
    
    // The decompressed protobuf buffer is no longer needed once decoded; drop it
    // now to free ~80 MB of WASM linear memory before the (long) store phase.
    drop(decompressed);
    
    // Capture the project name before moving kdb_data into the store function.
    let project_name = kdb_data.header.as_ref().map(|h| h.project_name.clone()).unwrap_or_else(|| kdb_id.to_string());
    
    // Clear existing data for this KDB
    console_log!("[WASM] Clearing existing data for KDB: {}", kdb_id);
    let clear_promise = clear_kdb_data(kdb_id);
    wasm_bindgen_futures::JsFuture::from(clear_promise).await?;
    
    // Store to IndexedDB
    store_log!("[WASM] Storing KDB data to IndexedDB...");
    store_kdb_to_indexeddb(kdb_data, kdb_id).await?;
    
    store_log!("[WASM] KDB parsed and stored successfully: {}", project_name);
    Ok(project_name)
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
async fn store_kdb_to_indexeddb(mut kdb_data: KnowledgeBase, kdb_id: &str) -> Result<(), JsValue> {
    store_log!("[WASM] Storing KDB to IndexedDB: {}", kdb_id);
    
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
    
    store_log!("[WASM] Storing knowledge base...");
    report_step(3, "Storing design metadata...");
    let kb_promise = store_knowledge_base(kdb_id, &kb_obj);
    match wasm_bindgen_futures::JsFuture::from(kb_promise).await {
        Ok(_) => store_log!("[WASM] Stored knowledge base successfully"),
        Err(e) => {
            store_log!("[WASM] Failed to store knowledge base: {:?}", e);
            return Err(e);
        }
    }
    
    // 2. Store source files FIRST and free their (potentially huge) bytes as we
    //    go. Storing files last previously kept the entire file_contents Vec
    //    alive for the whole module+signal store; doing it first and draining
    //    the Vecs drops that memory before the large signal-instance phase.
    let file_count = kdb_data.file_infos.len();
    store_log!("[WASM] Storing {} source files...", file_count);
    report_step(4, "Storing source files...");
    {
      let mut file_infos = std::mem::take(&mut kdb_data.file_infos).into_iter();
      let mut file_contents = std::mem::take(&mut kdb_data.file_contents).into_iter();
      let mut file_id: u32 = 0;
      // Report live sub-progress (a handful of times) so the UI shows the
      // source-file storing step advancing, instead of a single instant step.
      let report_every: u32 = ((file_count / 50) as u32).max(1);
      while let (Some(file_info), Some(file_content)) = (file_infos.next(), file_contents.next()) {
        file_id += 1; // 1-based ID
        if file_count > 0 && file_id % report_every == 0 {
          report_kdb_progress(
            4,
            KDB_STORE_TOTAL_STEPS,
            &format!("Storing source files... {}/{}", file_id, file_count),
          );
        }
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
                kdb_id,
            );
            if let Err(e) = wasm_bindgen_futures::JsFuture::from(info_promise).await {
                store_log!("[WASM] Failed to store file info {}: {:?}", file_id, e);
            }
            // Store file content (large data) to OPFS via JS
            let content_promise = store_source_file_content_opfs(file_id, &file_content.content, kdb_id);
            if let Err(e) = wasm_bindgen_futures::JsFuture::from(content_promise).await {
                store_log!("[WASM] Failed to store file content {}: {:?}", file_id, e);
            }
            // file_info and file_content are dropped at the end of this iteration.
        }
    }
    store_log!("[WASM] Stored {} source files", file_count);
    // Report the final source-file count so the UI's step-4 line reaches the
    // true total. The per-file sub-progress above only lands on multiples of
    // `report_every`, so without this the line would freeze at e.g. "236/239"
    // and never show the completed count. Emitting it here lets step 4 finish
    // on its own (the next step appends its own line without overwriting this).
    report_kdb_progress(
        4,
        KDB_STORE_TOTAL_STEPS,
        &format!("Storing source files... {}/{}", file_count, file_count),
    );

    // 3. Store module skeletons + signal definitions as two flat binary files in
    //    OPFS, mirroring the signals/drivers path. The module hierarchy is the
    //    data read at KDB load time; serializing every module into one contiguous
    //    little-endian buffer and writing it as a single OPFS file replaces the
    //    ~125k individual IndexedDB record reads (one cursor walk) with a single
    //    file read + a linear parse — much faster to load. Signal definitions are
    //    heavy and read lazily per module, so they go in a second file that is
    //    range-readable by module id (no per-record objects, no IDB transactions).
    let module_count = kdb_data.modules.len();
    store_log!("[WASM] Storing {} modules (OPFS binary)...", module_count);
    report_step(5, &format!("Storing {} modules...", module_count));

    // --- modules.bin: skeleton table + child-id pool + name pool ---
    // Record layout (all little-endian, 42 bytes/record):
    //   name_off:u32, name_len:u32, parent_module_id:u32,
    //   has_def:u8, def_file_id:u32, def_start_line:u32, def_end_line:u32,
    //   is_instance:u8, def_module_id:u32, signal_insts_start_id:u32,
    //   child_count:u32, child_off:u32
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
        Err(e) => {
            store_log!("[WASM] Failed to store modules.bin: {:?}", e);
            return Err(e);
        }
    }
    drop(modules_buf);

    // --- module_signal_defs.bin: per-module region, range-readable by id ---
    // Header: module_count:u32, table_offset:u32
    // Table:  (module_count + 1) entries of (def_count:u32, region_offset:u32).
    //         entry[i] covers module id (i+1); the final sentinel entry marks the
    //         end of the last region so one module's region = [entry[i], entry[i+1]).
    // Per-module region: def_count:u32, name_pool_len:u32, name_pool bytes,
    //                    def_count * 25-byte records:
    //   name_off:u32, name_len:u32, type:i32, has_decl:u8,
    //   decl_file_id:u32, decl_line:u32, direction:i32
    let mut regions: Vec<Vec<u8>> = Vec::with_capacity(module_count);
    let mut def_counts: Vec<u32> = Vec::with_capacity(module_count);
    for (di, module) in kdb_data.modules.iter().enumerate() {
        keep_heartbeat_alive(di as u32 + 1, HEARTBEAT_EVERY);
        // Visibility into this otherwise-silent synchronous loop: log every
        // 2000 modules so the console shows the signal-def serialization
        // advancing (the worker yields nowhere here, so without this the gap
        // between "Stored 17559 modules" and "Stored signal defs" looks hung).
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
    for r in &regions {
        offsets.push(cur);
        cur += r.len() as u32;
    }
    offsets.push(cur); // sentinel = end of file
    let mut sigdefs_buf: Vec<u8> = Vec::with_capacity(cur as usize);
    sigdefs_buf.extend_from_slice(&(module_count as u32).to_le_bytes());
    sigdefs_buf.extend_from_slice(&table_offset.to_le_bytes());
    for i in 0..module_count {
        sigdefs_buf.extend_from_slice(&def_counts[i].to_le_bytes());
        sigdefs_buf.extend_from_slice(&offsets[i].to_le_bytes());
    }
    sigdefs_buf.extend_from_slice(&0u32.to_le_bytes());
    sigdefs_buf.extend_from_slice(&offsets[module_count].to_le_bytes());
    for r in &regions {
        sigdefs_buf.extend_from_slice(r);
    }

    let sd_promise = store_signal_defs_opfs(&sigdefs_buf, kdb_id);
    match wasm_bindgen_futures::JsFuture::from(sd_promise).await {
        Ok(_) => store_log!("[WASM] Stored signal defs ({} bytes)", sigdefs_buf.len()),
        Err(e) => {
            store_log!("[WASM] Failed to store signal defs: {:?}", e);
            return Err(e);
        }
    }
    drop(sigdefs_buf);
    drop(kdb_data.modules);
    store_log!("[WASM] Stored {} modules", module_count);
    
    // 4. Store signal instances + drivers as two flat binary arrays in OPFS.
    //    The proto already stores drivers flat (all_driver_locations) with each
    //    signal holding a (driver_start, driver_count) slice, so we just copy the
    //    fields into contiguous little-endian byte buffers and stream each to a
    //    single OPFS file — no per-record JS objects, no IndexedDB transactions.
    let signal_count = kdb_data.all_signal_insts.len();
    let driver_count = kdb_data.all_driver_locations.len();
    store_log!(
        "[WASM] Storing {} signal instances + {} drivers (OPFS binary arrays)...",
        signal_count, driver_count
    );
    report_step(
        6,
        &format!("Storing {} signals + {} drivers...", signal_count, driver_count),
    );

    let signal_insts = std::mem::take(&mut kdb_data.all_signal_insts);
    let driver_locs = std::mem::take(&mut kdb_data.all_driver_locations);

    // signals.bin : 18 bytes/record (msb u32, lsb u32, parent u32, driver_start u32, driver_count u16)
    const SIGNAL_RECORD_SIZE: usize = 18;
    let mut signals_buf: Vec<u8> = Vec::with_capacity(signal_insts.len() * SIGNAL_RECORD_SIZE);
    for (si, s) in signal_insts.iter().enumerate() {
        keep_heartbeat_alive(si as u32 + 1, HEARTBEAT_EVERY);
        // Visibility into this otherwise-silent synchronous loop (the biggest
        // one: 541k records). Log every HEARTBEAT_EVERY records so the console
        // shows the signal serialization advancing between the surrounding
        // "Stored ..." prints.
        if (si as u32 + 1) % HEARTBEAT_EVERY == 0 {
            store_log!("[WASM] Serializing signals... {}/{}", si + 1, signal_count);
        }
        signals_buf.extend_from_slice(&s.msb.to_le_bytes());
        signals_buf.extend_from_slice(&s.lsb.to_le_bytes());
        signals_buf.extend_from_slice(&s.parent_module_id.to_le_bytes());
        signals_buf.extend_from_slice(&s.driver_start.to_le_bytes());
        // driver_count is semantically u16; clamp defensively (a net with >65535
        // drivers is not representable in this compact layout).
        let dc: u16 = if s.driver_count > u16::MAX as u32 { u16::MAX } else { s.driver_count as u16 };
        signals_buf.extend_from_slice(&dc.to_le_bytes());
    }
    drop(signal_insts);

    let sig_promise = store_signals_opfs(&signals_buf, kdb_id);
    match wasm_bindgen_futures::JsFuture::from(sig_promise).await {
        Ok(_) => store_log!("[WASM] Stored {} signal instances ({} bytes)", signal_count, signals_buf.len()),
        Err(e) => {
            store_log!("[WASM] Failed to store signals.bin: {:?}", e);
            return Err(e);
        }
    }
    drop(signals_buf);

    // drivers.bin : 12 bytes/record (driver_signal_global_id u64, line u32)
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
        Err(e) => {
            store_log!("[WASM] Failed to store drivers.bin: {:?}", e);
            return Err(e);
        }
    }
    drop(drivers_buf);

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
                driver_start: 0,
                driver_count: 0,
            },
        ],
        all_driver_locations: vec![],
    }
}
