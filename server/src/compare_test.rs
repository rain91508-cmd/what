//! FST Reader 对比测试模块
//! 
//! 提供 fst-reader 和 fstapi 的对比测试功能

use crate::config::ServerConfig;
use crate::state::ServerState;
use crate::services::{WaveService, FstBackend, CompressionAlgorithm, wave_data::MultiTileChunkSerializer};
use crate::services::fst_reader_backend::{read_signals_data_fst_reader_batch_lod_low, read_signals_data_fst_reader_batch_lod_high};
use std::time::{SystemTime, UNIX_EPOCH};
use std::path::PathBuf;

/// 运行 fst-reader 与 fstapi 对比测试（30次随机测试）
pub async fn run_compare_test(config: &ServerConfig) {
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
    
    // 获取波形信息 - 使用 fstapi
    let wave_info = match api_service.get_wave_info(wave_name).await {
        Ok(w) => w,
        Err(e) => {
            println!("[COMPARE-TEST] 获取波形信息失败: {:?}", e);
            return;
        }
    };
    
    let end_time = wave_info.end_time;
    println!("[COMPARE-TEST] 波形结束时间: {}", end_time);
    
    // 创建 fst-reader 服务
    let reader_service = WaveService::with_backend(state.clone(), FstBackend::FstReader);
    
    // 固定 LoD = 30
    let lod: u32 = 30;
    let bucket_size = 2u64.pow(lod);
    
    // 波形实际开始时间（跳过前段没有 transition 的区域）
    let min_start_time = 454423000u64;
    let max_start_time = end_time.saturating_sub(10000000); // 留出一些余量
    let test_duration = max_start_time - min_start_time;
    
    // 使用当前时间作为随机数 seed
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    
    println!("\n========================================");
    println!("[COMPARE-TEST] ===== 10次测试 (LoD=30, 256 buckets, 3 tiles) =====");
    println!("[COMPARE-TEST] 时间范围: [{}, {}]", min_start_time, max_start_time);
    println!("[COMPARE-TEST] 随机种子: {}", seed);
    println!("========================================\n");
    
    // 伪随机数生成器
    let mut rng_state: u64 = seed;
    let mut next_rand = || {
        rng_state = rng_state.wrapping_mul(1103515245).wrapping_add(12345);
        (rng_state >> 16) as u64
    };
    
    // 运行 10 次测试
    let mut total_tests = 0usize;
    let mut passed_tests = 0usize;
    
    // 固定参数：每个 tile 256 个 bucket，共 3 个 tiles
    let num_buckets = 256usize;
    let num_tiles = 3usize;
    
    for test_idx in 0..10 {
        // 固定 tile_span = 256 个 bucket
        let tile_span = bucket_size * num_buckets as u64;
        
        // 随机选择起始时间（在有效范围内平均分布）
        let start_time = min_start_time + (next_rand() % test_duration);
        
        total_tests += 1;
        
        // 使用 fst-reader 读取
        let reader_tiles = match reader_service.get_wave_data_tiles(
            &wave_name, 
            &test_signals, 
            lod, 
            start_time, 
            tile_span, 
            num_tiles,
            CompressionAlgorithm::None,
        ).await {
            Ok(d) => d.0,
            Err(e) => {
                println!("[COMPARE-TEST] 测试 {}/10: fst-reader 读取失败 (LoD={}, start={}): {:?}", 
                    test_idx + 1, lod, start_time, e);
                continue;
            }
        };
        
        // 使用 fstapi 读取
        let api_tiles = match api_service.get_wave_data_tiles(
            &wave_name, 
            &test_signals, 
            lod, 
            start_time, 
            tile_span, 
            num_tiles,
            CompressionAlgorithm::None,
        ).await {
            Ok(d) => d.0,
            Err(e) => {
                println!("[COMPARE-TEST] 测试 {}/10: fstapi 读取失败 (LoD={}, start={}): {:?}", 
                    test_idx + 1, lod, start_time, e);
                continue;
            }
        };
        
        // 对比数据包
        let passed = compare_tile_data(&reader_tiles, &api_tiles, lod);
        
        // 如果 LoD > 10，额外比较 lod_low 和 lod_high 方法并测量运行时间
        if lod > 10 {
            let wave_path = PathBuf::from(&config.wave_dir).join(format!("{}.fst", wave_name));
            let time_end = start_time + tile_span;
            
            // 获取全局缓存
            let cache = crate::services::fst_reader_cache::get_fst_reader_cache();
            
            // ===== 运行时间测试 =====
            println!("\n[PERF-TEST] ===== LoD={}, start={}, span={} =====", lod, start_time, tile_span);
            
            // 测试 1: fstapi
            let api_start = std::time::Instant::now();
            let api_tiles_perf = match api_service.get_wave_data_tiles(
                &wave_name, 
                &test_signals, 
                lod, 
                start_time, 
                tile_span, 
                num_tiles,
                CompressionAlgorithm::None,
            ).await {
                Ok(d) => d.0,
                Err(_) => Vec::new()
            };
            let api_elapsed = api_start.elapsed();
            
            // 测试 2: lod_low
            let lod_low_start = std::time::Instant::now();
            let lod_low_result = match read_signals_data_fst_reader_batch_lod_low(
                &cache,
                &wave_path,
                &test_signals,
                crate::services::LodLevel(lod),
                start_time,
                time_end,
                num_buckets,
            ).await {
                Ok(d) => d,
                Err(_) => Vec::new()
            };
            let lod_low_elapsed = lod_low_start.elapsed();
            
            // 测试 3: lod_high
            let lod_high_start = std::time::Instant::now();
            let lod_high_result = match read_signals_data_fst_reader_batch_lod_high(
                &cache,
                &wave_path,
                &test_signals,
                crate::services::LodLevel(lod),
                start_time,
                time_end,
                num_buckets,
            ).await {
                Ok(d) => d,
                Err(_) => Vec::new()
            };
            let lod_high_elapsed = lod_high_start.elapsed();
            
            // 打印运行时间
            println!("[PERF-TEST] fstapi:  {:?} ({} bytes)", api_elapsed, api_tiles_perf.len());
            println!("[PERF-TEST] lod_low:  {:?} ({} signals)", lod_low_elapsed, lod_low_result.len());
            println!("[PERF-TEST] lod_high: {:?} ({} signals)", lod_high_elapsed, lod_high_result.len());
            
            // 计算速度比
            let base_time = api_elapsed.as_nanos() as f64;
            if base_time > 0.0 {
                println!("[PERF-TEST] 速度比 (以 fstapi 为基准):");
                println!("[PERF-TEST]   fstapi:  {:.2}x", 1.0);
                println!("[PERF-TEST]   lod_low:  {:.2}x", lod_low_elapsed.as_nanos() as f64 / base_time);
                println!("[PERF-TEST]   lod_high: {:.2}x", lod_high_elapsed.as_nanos() as f64 / base_time);
            }
            println!("[PERF-TEST] ========================================\n");
            
            // 比较 lod_low 和 lod_high 的结果
            if !lod_low_result.is_empty() && !lod_high_result.is_empty() {
                let lod_low_passed = compare_signal_wave_data(&lod_low_result, &lod_high_result, lod);
                if !lod_low_passed {
                    println!("[COMPARE-TEST] 测试 {}/10: lod_low vs lod_high 不匹配 (LoD={}, start={}, span={})", 
                        test_idx + 1, lod, start_time, tile_span);
                }
            }
        }
        
        if passed {
            passed_tests += 1;
            if (test_idx + 1) % 10 == 0 {
                println!("[COMPARE-TEST] 测试 {}/10: ✓ 通过 (LoD={}, start={}, span={})", 
                    test_idx + 1, lod, start_time, tile_span);
            }
        } else {
            println!("[COMPARE-TEST] 测试 {}/10: ✗ 失败 (LoD={}, start={}, span={})", 
                test_idx + 1, lod, start_time, tile_span);
        }
    }
    
    println!("\n========================================");
    println!("[COMPARE-TEST] 测试结果: {}/{} 通过 ({:.1}%)", 
        passed_tests, total_tests, (passed_tests as f64 / total_tests as f64) * 100.0);
    if passed_tests == total_tests {
        println!("[COMPARE-TEST] ✓✓✓ 所有测试全部通过! ✓✓✓");
    } else {
        println!("[COMPARE-TEST] ✗ 部分测试失败");
    }
    println!("========================================");
}

/// 解析并对比 tile 数据包
fn compare_tile_data(reader_data: &[u8], api_data: &[u8], lod: u32) -> bool {
    // 尝试解析 MultiTileChunk
    let reader_multi = MultiTileChunkSerializer::deserialize(reader_data);
    let api_multi = MultiTileChunkSerializer::deserialize(api_data);
    
    match (reader_multi, api_multi) {
        (Ok((_, reader_tiles)), Ok((_, api_tiles))) => {
            // 对比每个 tile 的 transition 数量（允许 1 个的误差）
            let mut total_diff = 0usize;
            
            for ((_, r_signals), (_, a_signals)) in 
                reader_tiles.iter().zip(api_tiles.iter()) {
                // 对比每个信号
                for ((r_sig_header, r_trans), (_, a_trans)) in 
                    r_signals.iter().zip(a_signals.iter()) {
                    // 过滤掉 pre-start value
                    let r_count = r_trans.iter().filter(|t| t.time != u64::MAX).count();
                    let a_count = a_trans.iter().filter(|t| t.time != u64::MAX).count();
                    
                    // 计算差异（允许 1 个的误差）
                    let diff = if r_count > a_count { r_count - a_count } else { a_count - r_count };
                    total_diff += diff;
                    
                    if diff > 1 {
                        println!("[COMPARE-TEST] LoD={}: ✗ 失败 - 信号 {} 差异过大 (reader={}, api={})", 
                            lod, r_sig_header.signal_handle, r_count, a_count);
                        return false;
                    }
                }
            }
            
            // 如果总差异在可接受范围内，认为测试通过
            if total_diff <= 2 {
                println!("[COMPARE-TEST] LoD={}: ✓ 通过 (总差异: {} transitions)", lod, total_diff);
                true
            } else {
                println!("[COMPARE-TEST] LoD={}: ✗ 失败 - 总差异过大 ({} transitions)", lod, total_diff);
                // 显示详细信息
                compare_detailed_data(reader_data, api_data);
                false
            }
        }
        _ => {
            // 解析失败，回退到简单的大小比较
            if reader_data.len() == api_data.len() {
                println!("[COMPARE-TEST] LoD={}: ✓ 通过 (大小匹配: {} bytes)", lod, reader_data.len());
                true
            } else {
                println!("[COMPARE-TEST] LoD={}: ✗ 失败 - 数据包大小不匹配 (reader={}, api={})", 
                    lod, reader_data.len(), api_data.len());
                false
            }
        }
    }
}

/// 解析并显示详细的 tile 数据对比
fn compare_detailed_data(reader_data: &[u8], api_data: &[u8]) {
    use crate::services::wave_data::MultiTileChunkSerializer;
    
    println!("\n[COMPARE-TEST] ========== 详细对比 ==========");
    
    // 尝试解析两个数据包
    let reader_result = MultiTileChunkSerializer::deserialize(reader_data);
    let api_result = MultiTileChunkSerializer::deserialize(api_data);
    
    match (&reader_result, &api_result) {
        (Ok((reader_header, reader_tiles)), Ok((api_header, api_tiles))) => {
            println!("[COMPARE-TEST] Header 对比:");
            println!("  reader: lod={}, tiles={}, time=[{}, span={}]", 
                reader_header.lod, reader_header.num_tiles, 
                reader_header.start_time, reader_header.tile_span);
            println!("  api:    lod={}, tiles={}, time=[{}, span={}]", 
                api_header.lod, api_header.num_tiles,
                api_header.start_time, api_header.tile_span);
            
            // 对比每个 tile
            let min_tiles = reader_tiles.len().min(api_tiles.len());
            for tile_idx in 0..min_tiles {
                let (r_chunk_header, r_signals) = &reader_tiles[tile_idx];
                let (a_chunk_header, a_signals) = &api_tiles[tile_idx];
                
                println!("\n[COMPARE-TEST] Tile {}:", tile_idx);
                println!("  reader: signals={}, time=[{}, {}]", 
                    r_chunk_header.signal_count, r_chunk_header.time_start, r_chunk_header.time_end);
                println!("  api:    signals={}, time=[{}, {}]",
                    a_chunk_header.signal_count, a_chunk_header.time_start, a_chunk_header.time_end);
                
                // 对比每个信号
                let min_signals = r_signals.len().min(a_signals.len());
                for sig_idx in 0..min_signals {
                    let (r_sig_header, r_trans) = &r_signals[sig_idx];
                    let (a_sig_header, a_trans) = &a_signals[sig_idx];
                    
                    // 过滤掉 pre-start value
                    let r_trans_filtered: Vec<_> = r_trans.iter().filter(|t| t.time != u64::MAX).collect();
                    let a_trans_filtered: Vec<_> = a_trans.iter().filter(|t| t.time != u64::MAX).collect();
                    
                    println!("[COMPARE-TEST]   信号 {} (handle={}):", sig_idx, r_sig_header.signal_handle);
                    println!("    reader: {} transitions (过滤前: {})", r_trans_filtered.len(), r_trans.len());
                    println!("    api:    {} transitions (过滤前: {})", a_trans_filtered.len(), a_trans.len());
                    
                    // 显示前几个 transition
                    let min_len = r_trans_filtered.len().min(a_trans_filtered.len()).min(3);
                    for j in 0..min_len {
                        println!("      transition[{}]: reader(time={}, value={:?}) vs api(time={}, value={:?})",
                            j, r_trans_filtered[j].time, r_trans_filtered[j].value,
                            a_trans_filtered[j].time, a_trans_filtered[j].value);
                    }
                    
                    // 显示数量不匹配
                    if r_trans_filtered.len() != a_trans_filtered.len() {
                        println!("      ⚠️  transition 数量不匹配: reader={}, api={}", 
                            r_trans_filtered.len(), a_trans_filtered.len());
                    }
                }
            }
        }
        _ => {
            println!("[COMPARE-TEST] 无法解析数据包进行详细对比");
        }
    }
    
    println!("[COMPARE-TEST] ========== 详细对比结束 ==========\n");
}

/// 比较两个 SignalWaveData 向量（用于比较 lod_low 和 lod_high 方法）
fn compare_signal_wave_data(lod_low_data: &[crate::services::SignalWaveData], lod_high_data: &[crate::services::SignalWaveData], lod: u32) -> bool {
    use crate::services::wave_data::SignalWaveData;
    
    if lod_low_data.len() != lod_high_data.len() {
        println!("[COMPARE-TEST] LoD={}: lod_low 和 lod_high 信号数量不匹配 (low={}, high={})", 
            lod, lod_low_data.len(), lod_high_data.len());
        return false;
    }
    
    let mut total_diff = 0usize;
    
    for (idx, (low_signal, high_signal)) in lod_low_data.iter().zip(lod_high_data.iter()).enumerate() {
        // 过滤掉 pre-start value
        let low_trans: Vec<_> = low_signal.transitions.iter()
            .filter(|t| t.time != u64::MAX)
            .collect();
        let high_trans: Vec<_> = high_signal.transitions.iter()
            .filter(|t| t.time != u64::MAX)
            .collect();
        
        // 比较 transition 数量
        if low_trans.len() != high_trans.len() {
            let diff = if low_trans.len() > high_trans.len() { 
                low_trans.len() - high_trans.len() 
            } else { 
                high_trans.len() - low_trans.len() 
            };
            total_diff += diff;
            
            println!("[COMPARE-TEST] LoD={}: 信号 {} transition 数量不匹配 (low={}, high={}, diff={})", 
                lod, idx, low_trans.len(), high_trans.len(), diff);
            
            // 显示前几个 transition
            let min_len = low_trans.len().min(high_trans.len()).min(3);
            for j in 0..min_len {
                println!("      transition[{}]: low(time={}, value={:?}) vs high(time={}, value={:?})",
                    j, low_trans[j].time, low_trans[j].value,
                    high_trans[j].time, high_trans[j].value);
            }
        } else {
            // 数量相同，比较每个 transition
            for (j, (low_t, high_t)) in low_trans.iter().zip(high_trans.iter()).enumerate() {
                if low_t.time != high_t.time || low_t.value != high_t.value {
                    println!("[COMPARE-TEST] LoD={}: 信号 {} transition[{}] 不匹配", lod, idx, j);
                    println!("      low:  time={}, value={:?}", low_t.time, low_t.value);
                    println!("      high: time={}, value={:?}", high_t.time, high_t.value);
                    total_diff += 1;
                }
            }
        }
    }
    
    if total_diff == 0 {
        println!("[COMPARE-TEST] LoD={}: lod_low vs lod_high ✓ 完全匹配", lod);
        true
    } else {
        println!("[COMPARE-TEST] LoD={}: lod_low vs lod_high ✗ 有 {} 处差异", lod, total_diff);
        false
    }
}

/// 测试指定信号的详细对比，打印 fstapi 获取的所有 transactions
/// 
/// 信号: testbench.top.uut.picorv32_core.clk
/// 起点: 0
/// LoD: 10
/// tile_span: 256 个 bucket
/// tiles: 2 个
pub async fn run_detailed_signal_test(config: &ServerConfig) {
    println!("\n========================================");
    println!("[DETAILED-TEST] 指定信号详细对比测试");
    println!("========================================\n");
    
    // 测试参数
    let wave_name = "picorv32";
    let signal_name = "testbench.top.uut.picorv32_core.clk";
    let test_signals = vec![signal_name.to_string()];
    let lod: u32 = 10;
    let start_time: u64 = 0;
    let num_buckets = 256usize;
    let num_tiles = 2usize;
    
    let bucket_size = 2u64.pow(lod);
    let tile_span = bucket_size * num_buckets as u64;
    
    println!("[DETAILED-TEST] 波形文件: {}", wave_name);
    println!("[DETAILED-TEST] 测试信号: {}", signal_name);
    println!("[DETAILED-TEST] LoD: {} (bucket_size={})", lod, bucket_size);
    println!("[DETAILED-TEST] 起始时间: {}", start_time);
    println!("[DETAILED-TEST] tile_span: {} ({} 个 bucket)", tile_span, num_buckets);
    println!("[DETAILED-TEST] tiles 数量: {}", num_tiles);
    println!();
    
    // 创建服务
    let state = ServerState::new(config.clone());
    let api_service = WaveService::with_backend(state.clone(), FstBackend::FstApi);
    let reader_service = WaveService::with_backend(state.clone(), FstBackend::FstReader);
    
    // ===== 1. 使用 fstapi 读取 =====
    println!("[DETAILED-TEST] ===== 1. FSTAPI 读取 =====");
    let api_tiles = match api_service.get_wave_data_tiles(
        &wave_name,
        &test_signals,
        lod,
        start_time,
        tile_span,
        num_tiles,
        CompressionAlgorithm::None,
    ).await {
        Ok(d) => d.0,
        Err(e) => {
            println!("[DETAILED-TEST] FSTAPI 读取失败: {:?}", e);
            return;
        }
    };
    
    // 解析并打印 fstapi 的所有 transactions
    let api_multi = MultiTileChunkSerializer::deserialize(&api_tiles);
    
    // 创建输出文件
    let output_file = format!("detailed_test_{}_{}_lod{}.txt", wave_name, signal_name.replace(".", "_"), lod);
    let mut file_content = String::new();
    
    file_content.push_str(&format!("详细测试报告\n"));
    file_content.push_str(&format!("================\n\n"));
    file_content.push_str(&format!("波形文件: {}\n", wave_name));
    file_content.push_str(&format!("测试信号: {}\n", signal_name));
    file_content.push_str(&format!("LoD: {} (bucket_size={})\n", lod, bucket_size));
    file_content.push_str(&format!("起始时间: {}\n", start_time));
    file_content.push_str(&format!("tile_span: {} ({} 个 bucket)\n", tile_span, num_buckets));
    file_content.push_str(&format!("tiles 数量: {}\n\n", num_tiles));
    
    match &api_multi {
        Ok((header, tiles)) => {
            file_content.push_str(&format!("MultiTile Header Info:\n"));
            file_content.push_str(&format!("  LoD: {}\n", header.lod));
            file_content.push_str(&format!("  Num Tiles: {}\n", header.num_tiles));
            file_content.push_str(&format!("  Start Time: {}\n", header.start_time));
            file_content.push_str(&format!("  Tile Span: {}\n", header.tile_span));
            file_content.push_str(&format!("  Signal Count: {}\n\n", header.signal_count));
            
            for (tile_idx, (_, signals)) in tiles.iter().enumerate() {
                println!("\n[DETAILED-TEST] --- Tile {} ---", tile_idx);
                file_content.push_str(&format!("=== Tile {} ===\n", tile_idx));
                
                for (sig_idx, (sig_header, transitions)) in signals.iter().enumerate() {
                    println!("[DETAILED-TEST] 信号 {} (handle={}): {} transitions",
                        sig_idx, sig_header.signal_handle, transitions.len());
                    
                    file_content.push_str(&format!("\n信号 {} (handle={}):\n", sig_idx, sig_header.signal_handle));
                    file_content.push_str(&format!("  time_array_offset: {}\n", sig_header.time_array_offset));
                    file_content.push_str(&format!("  value_array_offset: {}\n", sig_header.value_array_offset));
                    file_content.push_str(&format!("  transition_time_array_offset: {}\n", sig_header.transition_time_array_offset));
                    file_content.push_str(&format!("  transition_count: {}\n", sig_header.transition_count));
                    file_content.push_str(&format!("  compression: {}\n", sig_header.compression));
                    file_content.push_str(&format!("  总 transitions: {}\n\n", transitions.len()));
                    
                    file_content.push_str(&format!("  详细 transactions:\n"));
                    file_content.push_str(&format!("  {:<6} {:<20} {:<20} {:<30}\n", "Index", "Bucket Index", "Transition Time", "Value"));
                    file_content.push_str(&format!("  {:-<6} {:-<20} {:-<20} {:-<30}\n", "", "", "", ""));
                    
                    println!("[DETAILED-TEST] 详细 transactions:");
                    for (trans_idx, trans) in transitions.iter().enumerate() {
                        let (bucket_idx, time_str) = if trans.time == u64::MAX {
                            ("N/A (Start Value)".to_string(), "MAX (u64::MAX)".to_string())
                        } else {
                            // 计算 bucket index
                            let bucket = trans.time / bucket_size;
                            (bucket.to_string(), trans.time.to_string())
                        };
                        
                        let value_str = format!("{:?}", trans.value);
                        
                        println!("[DETAILED-TEST]   [{}] bucket_idx={}, time={}, value={}",
                            trans_idx, bucket_idx, time_str, value_str);
                        
                        file_content.push_str(&format!("  {:<6} {:<20} {:<20} {:<30}\n", 
                            trans_idx, bucket_idx, time_str, value_str));
                    }
                }
            }
            
            // 写入文件
            match std::fs::write(&output_file, file_content) {
                Ok(_) => println!("\n[DETAILED-TEST] 结果已写入文件: {}", output_file),
                Err(e) => println!("\n[DETAILED-TEST] 写入文件失败: {:?}", e),
            }
        }
        Err(e) => {
            println!("[DETAILED-TEST] 解析 FSTAPI 数据失败: {:?}", e);
        }
    }
    
    // ===== 2. 使用 lod_low 读取 =====
    println!("\n[DETAILED-TEST] ===== 2. LOD_LOW 读取 =====");
    let wave_path = PathBuf::from(&config.wave_dir).join(format!("{}.fst", wave_name));
    let cache = crate::services::fst_reader_cache::get_fst_reader_cache();
    
    let lod_low_result = match read_signals_data_fst_reader_batch_lod_low(
        &cache,
        &wave_path,
        &test_signals,
        crate::services::LodLevel(lod),
        start_time,
        start_time + tile_span * num_tiles as u64,
        num_buckets,
    ).await {
        Ok(d) => d,
        Err(e) => {
            println!("[DETAILED-TEST] LOD_LOW 读取失败: {:?}", e);
            Vec::new()
        }
    };
    
    println!("[DETAILED-TEST] LOD_LOW 读取了 {} 个信号", lod_low_result.len());
    for (sig_idx, signal) in lod_low_result.iter().enumerate() {
        println!("[DETAILED-TEST]   信号 {}: {} transitions",
            sig_idx, signal.transitions.len());
    }
    
    // ===== 3. 使用 lod_high 读取 =====
    println!("\n[DETAILED-TEST] ===== 3. LOD_HIGH 读取 =====");
    let lod_high_result = match read_signals_data_fst_reader_batch_lod_high(
        &cache,
        &wave_path,
        &test_signals,
        crate::services::LodLevel(lod),
        start_time,
        start_time + tile_span * num_tiles as u64,
        num_buckets,
    ).await {
        Ok(d) => d,
        Err(e) => {
            println!("[DETAILED-TEST] LOD_HIGH 读取失败: {:?}", e);
            Vec::new()
        }
    };
    
    println!("[DETAILED-TEST] LOD_HIGH 读取了 {} 个信号", lod_high_result.len());
    for (sig_idx, signal) in lod_high_result.iter().enumerate() {
        println!("[DETAILED-TEST]   信号 {}: {} transitions",
            sig_idx, signal.transitions.len());
    }
    
    // ===== 4. 对比三个实现 =====
    println!("\n[DETAILED-TEST] ===== 4. 对比结果 =====");
    
    // 对比 fstapi vs lod_low
    let reader_tiles = match reader_service.get_wave_data_tiles(
        &wave_name,
        &test_signals,
        lod,
        start_time,
        tile_span,
        num_tiles,
        CompressionAlgorithm::None,
    ).await {
        Ok(d) => d.0,
        Err(e) => {
            println!("[DETAILED-TEST] Reader 读取失败: {:?}", e);
            return;
        }
    };
    
    let passed = compare_tile_data(&reader_tiles, &api_tiles, lod);
    if passed {
        println!("[DETAILED-TEST] ✓ FSTAPI vs READER: 匹配");
    } else {
        println!("[DETAILED-TEST] ✗ FSTAPI vs READER: 不匹配");
    }
    
    // 对比 lod_low vs lod_high
    let low_high_match = compare_lod_low_high_detailed(&lod_low_result, &lod_high_result);
    if low_high_match {
        println!("[DETAILED-TEST] ✓ LOD_LOW vs LOD_HIGH: 匹配");
    } else {
        println!("[DETAILED-TEST] ✗ LOD_LOW vs LOD_HIGH: 不匹配");
    }
    
    println!("\n[DETAILED-TEST] ===== 测试结束 =====");
}

/// 详细对比 lod_low 和 lod_high 的结果
fn compare_lod_low_high_detailed(
    low_result: &[crate::services::wave_data::SignalWaveData],
    high_result: &[crate::services::wave_data::SignalWaveData],
) -> bool {
    if low_result.len() != high_result.len() {
        println!("[DETAILED-TEST] 信号数量不匹配: low={}, high={}", low_result.len(), high_result.len());
        return false;
    }
    
    let mut total_diff = 0usize;
    
    for (sig_idx, (low_sig, high_sig)) in low_result.iter().zip(high_result.iter()).enumerate() {
        let low_trans = &low_sig.transitions;
        let high_trans = &high_sig.transitions;
        
        if low_trans.len() != high_trans.len() {
            let diff = if low_trans.len() > high_trans.len() {
                low_trans.len() - high_trans.len()
            } else {
                high_trans.len() - low_trans.len()
            };
            total_diff += diff;
            
            println!("[DETAILED-TEST] 信号 {}: transition 数量不匹配 (low={}, high={}, diff={})",
                sig_idx, low_trans.len(), high_trans.len(), diff);
            
            // 显示前几个 transition
            let min_len = low_trans.len().min(high_trans.len()).min(5);
            for j in 0..min_len {
                println!("      [{}]: low(time={}, value={:?}) vs high(time={}, value={:?})",
                    j, low_trans[j].time, low_trans[j].value,
                    high_trans[j].time, high_trans[j].value);
            }
        } else {
            // 数量相同，比较每个 transition
            for (j, (low_t, high_t)) in low_trans.iter().zip(high_trans.iter()).enumerate() {
                if low_t.time != high_t.time || low_t.value != high_t.value {
                    println!("[DETAILED-TEST] 信号 {} transition[{}] 不匹配",
                        sig_idx, j);
                    println!("      low:  time={}, value={:?}", low_t.time, low_t.value);
                    println!("      high: time={}, value={:?}", high_t.time, high_t.value);
                    total_diff += 1;
                }
            }
        }
    }
    
    if total_diff == 0 {
        true
    } else {
        println!("[DETAILED-TEST] 共发现 {} 处差异", total_diff);
        false
    }
}
