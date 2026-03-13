//! LoD 20 专项测试模块
//! 
//! 测试 LoD 20，从时间 0 开始，4 个 tiles，每个 tile 256 个 bucket

use crate::config::ServerConfig;
use crate::state::ServerState;
use crate::services::{WaveService, FstBackend, CompressionAlgorithm, wave_data::MultiTileChunkSerializer};

/// 测试 LoD 20，从时间 0 开始，4 个 tiles，每个 tile 256 个 bucket
pub async fn run_lod20_test(config: &ServerConfig) {
    // 固定使用 riscv2.fst 波形文件
    let wave_name = "riscv2";
    println!("[COMPARE-TEST] 使用波形文件: {}", wave_name);
    
    // 获取信号列表 - 使用 fstapi 获取
    let state = ServerState::new(config.clone());
    let api_service = WaveService::with_backend(state.clone(), FstBackend::FstApi);
    
    let signals = match api_service.list_signals(wave_name).await {
        Ok(s) => s,
        Err(e) => {
            println!("[COMPARE-TEST] 获取信号列表失败 (fstapi): {:?}", e);
            return;
        }
    };
    
    if signals.is_empty() {
        println!("[COMPARE-TEST] 未找到信号");
        return;
    }
    
    // 选取前 2 个信号
    let test_signals: Vec<String> = signals.iter().take(2).map(|s| s.name.clone()).collect();
    println!("[COMPARE-TEST] 测试信号: {:?}", test_signals);
    
    // 创建 fst-reader 服务
    let reader_service = WaveService::with_backend(state.clone(), FstBackend::FstReader);
    
    // LoD 20 测试参数
    let lod = 20u32;
    let num_buckets = 256usize;
    let bucket_size = 2u64.pow(lod); // 1,048,576
    let tile_span = bucket_size * num_buckets as u64; // 268,435,456
    let start_time = 0u64;
    let num_tiles = 4usize;
    
    println!("\n========================================");
    println!("[COMPARE-TEST] ===== LoD 20 测试 =====");
    println!("[COMPARE-TEST] LoD={}", lod);
    println!("[COMPARE-TEST] bucket_size={}", bucket_size);
    println!("[COMPARE-TEST] num_buckets={}", num_buckets);
    println!("[COMPARE-TEST] tile_span={}", tile_span);
    println!("[COMPARE-TEST] start_time={}", start_time);
    println!("[COMPARE-TEST] num_tiles={}", num_tiles);
    println!("========================================\n");
    
    // 使用 fst-reader 读取
    let (reader_data, _) = match reader_service.get_wave_data_tiles(
        &wave_name, 
        &test_signals, 
        lod, 
        start_time, 
        tile_span, 
        num_tiles,
        CompressionAlgorithm::None,
    ).await {
        Ok(d) => d,
        Err(e) => {
            println!("[COMPARE-TEST] fst-reader 读取失败 (LoD={}): {:?}", lod, e);
            return;
        }
    };
    
    // 使用 fstapi 读取
    let (api_data, _) = match api_service.get_wave_data_tiles(
        &wave_name, 
        &test_signals, 
        lod, 
        start_time, 
        tile_span, 
        num_tiles,
        CompressionAlgorithm::None,
    ).await {
        Ok(d) => d,
        Err(e) => {
            println!("[COMPARE-TEST] fstapi 读取失败 (LoD={}): {:?}", lod, e);
            return;
        }
    };
    
    println!("[COMPARE-TEST] reader_data.len() = {} bytes", reader_data.len());
    println!("[COMPARE-TEST] api_data.len() = {} bytes", api_data.len());
    
    // 解析并对比
    println!("\n[COMPARE-TEST] ========== 数据对比 ==========");
    let passed = compare_lod20_data(&reader_data, &api_data, lod);
    
    if !passed {
        println!("\n[COMPARE-TEST] ========== 详细对比 ==========");
        compare_lod20_detailed(&reader_data, &api_data);
    }
    
    println!("\n========================================");
    if passed {
        println!("[COMPARE-TEST] LoD 20 测试 ✓ 通过");
    } else {
        println!("[COMPARE-TEST] LoD 20 测试 ✗ 失败");
    }
    println!("========================================");
}

/// 对比 LoD 20 数据
fn compare_lod20_data(reader_data: &[u8], api_data: &[u8], lod: u32) -> bool {
    // 尝试解析 MultiTileChunk
    let reader_multi = MultiTileChunkSerializer::deserialize(reader_data);
    let api_multi = MultiTileChunkSerializer::deserialize(api_data);
    
    match (reader_multi, api_multi) {
        (Ok((reader_header, reader_tiles)), Ok((api_header, api_tiles))) => {
            println!("[COMPARE-TEST] Header 对比:");
            println!("  reader: lod={}, tiles={}, time=[{}, span={}]", 
                reader_header.lod, reader_header.num_tiles, 
                reader_header.start_time, reader_header.tile_span);
            println!("  api:    lod={}, tiles={}, time=[{}, span={}]", 
                api_header.lod, api_header.num_tiles,
                api_header.start_time, api_header.tile_span);
            
            // 对比 tile 数量
            if reader_tiles.len() != api_tiles.len() {
                println!("[COMPARE-TEST] ✗ tile 数量不匹配: reader={}, api={}", 
                    reader_tiles.len(), api_tiles.len());
                return false;
            }
            
            // 对比每个 tile
            let mut total_diff = 0usize;
            for (tile_idx, ((r_chunk_header, r_signals), (a_chunk_header, a_signals))) in 
                reader_tiles.iter().zip(api_tiles.iter()).enumerate() {
                
                println!("\n[COMPARE-TEST] Tile {}:", tile_idx);
                println!("  reader: signals={}, time=[{}, {}]", 
                    r_chunk_header.signal_count, r_chunk_header.time_start, r_chunk_header.time_end);
                println!("  api:    signals={}, time=[{}, {}]",
                    a_chunk_header.signal_count, a_chunk_header.time_start, a_chunk_header.time_end);
                
                // 对比每个信号
                for (sig_idx, ((r_sig_header, r_trans), (a_sig_header, a_trans))) in 
                    r_signals.iter().zip(a_signals.iter()).enumerate() {
                    
                    // 过滤掉 pre-start value
                    let r_count = r_trans.iter().filter(|t| t.time != u64::MAX).count();
                    let a_count = a_trans.iter().filter(|t| t.time != u64::MAX).count();
                    
                    println!("[COMPARE-TEST]   信号 {} (handle={}):", sig_idx, r_sig_header.signal_handle);
                    println!("    reader: {} transitions (过滤前: {})", r_count, r_trans.len());
                    println!("    api:    {} transitions (过滤前: {})", a_count, a_trans.len());
                    
                    let diff = if r_count > a_count { r_count - a_count } else { a_count - r_count };
                    total_diff += diff;
                    
                    if diff > 0 {
                        println!("    ⚠️  transition 数量差异: {}", diff);
                    }
                    
                    // 显示前几个 transition
                    let min_len = r_count.min(a_count).min(3);
                    for j in 0..min_len {
                        println!("      transition[{}]: reader(time={}, value={:?}) vs api(time={}, value={:?})",
                            j, r_trans[j].time, r_trans[j].value,
                            a_trans[j].time, a_trans[j].value);
                    }
                }
            }
            
            println!("\n[COMPARE-TEST] 总差异: {} transitions", total_diff);
            total_diff == 0
        }
        (Err(e), _) => {
            println!("[COMPARE-TEST] 反序列化 reader 数据失败: {:?}", e);
            false
        }
        (_, Err(e)) => {
            println!("[COMPARE-TEST] 反序列化 api 数据失败: {:?}", e);
            false
        }
    }
}

/// 详细对比（用于失败时）
fn compare_lod20_detailed(reader_data: &[u8], api_data: &[u8]) {
    // 这里可以添加更详细的对比逻辑
    println!("[COMPARE-TEST] reader_data: {} bytes", reader_data.len());
    println!("[COMPARE-TEST] api_data: {} bytes", api_data.len());
    
    // 显示前 64 字节的十六进制
    println!("\n[COMPARE-TEST] reader_data 前 64 字节:");
    for (i, byte) in reader_data.iter().take(64).enumerate() {
        if i % 16 == 0 {
            print!("  {:04x}: ", i);
        }
        print!("{:02x} ", byte);
        if i % 16 == 15 {
            println!();
        }
    }
    
    println!("\n[COMPARE-TEST] api_data 前 64 字节:");
    for (i, byte) in api_data.iter().take(64).enumerate() {
        if i % 16 == 0 {
            print!("  {:04x}: ", i);
        }
        print!("{:02x} ", byte);
        if i % 16 == 15 {
            println!();
        }
    }
}
