//! FST Reader 对比测试模块
//! 
//! 提供 fst-reader 和 fstapi 的对比测试功能

use crate::config::ServerConfig;
use crate::state::ServerState;
use crate::services::{WaveService, FstBackend, CompressionAlgorithm, wave_data::MultiTileChunkSerializer};
use crate::services::fst_reader_backend::{read_signals_data_fst_reader_batch_lod_low, read_signals_data_fst_reader_batch_lod_high};
use std::time::{SystemTime, UNIX_EPOCH};
use std::path::PathBuf;

/// 运行 fst-reader 与 fstapi 对比测试（100次随机测试）
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
    
    // 测试的 LoD 值（包含 LoD > 10 的情况）
    let test_lods = vec![0u32, 8u32, 12u32, 20u32];
    
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
    println!("[COMPARE-TEST] ===== 100次随机测试 =====");
    println!("[COMPARE-TEST] 时间范围: [{}, {}]", min_start_time, max_start_time);
    println!("[COMPARE-TEST] 随机种子: {}", seed);
    println!("========================================\n");
    
    // 伪随机数生成器
    let mut rng_state: u64 = seed;
    let mut next_rand = || {
        rng_state = rng_state.wrapping_mul(1103515245).wrapping_add(12345);
        (rng_state >> 16) as u64
    };
    
    // 运行 100 次测试
    let mut total_tests = 0usize;
    let mut passed_tests = 0usize;
    
    for test_idx in 0..100 {
        // 随机选择 LoD
        let lod_idx = (next_rand() % test_lods.len() as u64) as usize;
        let lod = test_lods[lod_idx];
        let bucket_size = 2u64.pow(lod);
        
        // 随机选择 tile_span（1-5 个 bucket）
        let num_buckets = ((next_rand() % 5) + 1) as usize;
        let tile_span = bucket_size * num_buckets as u64;
        
        // 随机选择起始时间（在有效范围内平均分布）
        let start_time = min_start_time + (next_rand() % test_duration);
        let num_tiles = 1usize;
        
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
                println!("[COMPARE-TEST] 测试 {}/100: fst-reader 读取失败 (LoD={}, start={}): {:?}", 
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
                println!("[COMPARE-TEST] 测试 {}/100: fstapi 读取失败 (LoD={}, start={}): {:?}", 
                    test_idx + 1, lod, start_time, e);
                continue;
            }
        };
        
        // 对比数据包
        let passed = compare_tile_data(&reader_tiles, &api_tiles, lod);
        
        // 如果 LoD > 10，额外比较 lod_low 和 lod_high 方法
        if lod > 10 && passed {
            let wave_path = PathBuf::from(&config.wave_dir).join(format!("{}.fst", wave_name));
            let time_end = start_time + tile_span;
            
            // 获取全局缓存
            let cache = crate::services::fst_reader_cache::get_fst_reader_cache();
            
            // 调用 lod_low 方法
            let lod_low_result = match read_signals_data_fst_reader_batch_lod_low(
                cache,
                &wave_path,
                &test_signals,
                crate::services::LodLevel(lod),
                start_time,
                time_end,
                num_buckets,
            ).await {
                Ok(d) => d,
                Err(e) => {
                    println!("[COMPARE-TEST] 测试 {}/100: lod_low 读取失败 (LoD={}, start={}): {:?}", 
                        test_idx + 1, lod, start_time, e);
                    Vec::new()
                }
            };
            
            // 调用 lod_high 方法
            let lod_high_result = match read_signals_data_fst_reader_batch_lod_high(
                cache,
                &wave_path,
                &test_signals,
                crate::services::LodLevel(lod),
                start_time,
                time_end,
                num_buckets,
            ).await {
                Ok(d) => d,
                Err(e) => {
                    println!("[COMPARE-TEST] 测试 {}/100: lod_high 读取失败 (LoD={}, start={}): {:?}", 
                        test_idx + 1, lod, start_time, e);
                    Vec::new()
                }
            };
            
            // 比较 lod_low 和 lod_high 的结果
            if !lod_low_result.is_empty() && !lod_high_result.is_empty() {
                let lod_low_passed = compare_signal_wave_data(&lod_low_result, &lod_high_result, lod);
                if !lod_low_passed {
                    println!("[COMPARE-TEST] 测试 {}/100: lod_low vs lod_high 不匹配 (LoD={}, start={}, span={})", 
                        test_idx + 1, lod, start_time, tile_span);
                }
            }
        }
        
        if passed {
            passed_tests += 1;
            if (test_idx + 1) % 10 == 0 {
                println!("[COMPARE-TEST] 测试 {}/100: ✓ 通过 (LoD={}, start={}, span={})", 
                    test_idx + 1, lod, start_time, tile_span);
            }
        } else {
            println!("[COMPARE-TEST] 测试 {}/100: ✗ 失败 (LoD={}, start={}, span={})", 
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
