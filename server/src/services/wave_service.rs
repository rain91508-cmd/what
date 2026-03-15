use crate::error::{Result, ServerError};
use crate::services::wave_data::{LodConfig, LodLevel, SignalWaveData, Transition, ChunkSerializer, CompressionAlgorithm, SignalValueType, MultiTileChunkSerializer, SignalValue, FourStateValue};
use crate::services::compute_file_hash;
use crate::state::ServerState;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tracing::{debug, error, info, warn};
use moka::future::Cache;
use fstapi::Handle;

/// FST 文件魔数 (用于识别 FST 文件)
const FST_MAGIC: &[u8] = b"FST\x00";

/// FST 文件最小大小 (魔数 + 头部信息)
const FST_MIN_SIZE: u64 = 32;

/// 搜索方向
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchDirection {
    /// 向前搜索：查找 time 之前的最近一个值
    Forward,
    /// 向后搜索：查找 time 之后的最近一个值
    Backward,
}

/// 最小搜索区间
const MIN_SEARCH_SPAN: u64 = 1000;

/// 搜索区间信息
#[derive(Debug, Clone)]
struct SearchRegion {
    handle: Handle,
    start: u64,
    end: u64,
}

/// 使用二分法为单个信号查找最小有 transition 的区间
/// 
/// # Returns
/// * Some((start, end)) - 找到的最小有 transition 的区间
/// * None - 没有找到任何 transition
fn find_min_region_binary(
    signal_data: &SignalWaveData,
    search_start: u64,
    search_end: u64,
    direction: SearchDirection,
) -> Option<(u64, u64)> {
    if signal_data.transitions.is_empty() {
        return None;
    }

    let mut start = search_start;
    let mut end = search_end;
    let mut last_found_region: Option<(u64, u64)> = None;

    while end - start > MIN_SEARCH_SPAN {
        let mid = (start + end) / 2;

        // 检查区间内是否有 transition
        let has_transition = match direction {
            SearchDirection::Forward => {
                // 向前搜索：检查 [mid, search_end] 区间
                signal_data.transitions.iter().any(|t| t.time >= mid && t.time <= search_end)
            }
            SearchDirection::Backward => {
                // 向后搜索：检查 [search_start, mid] 区间
                signal_data.transitions.iter().any(|t| t.time >= search_start && t.time <= mid)
            }
        };

        if has_transition {
            last_found_region = Some((start, end));
            // 缩小范围
            match direction {
                SearchDirection::Forward => start = mid,
                SearchDirection::Backward => end = mid,
            }
        } else {
            // 扩大范围（如果之前找到过，使用之前的区间）
            match direction {
                SearchDirection::Forward => end = mid,
                SearchDirection::Backward => start = mid,
            }
        }
    }

    // 如果当前区间没有找到，使用上一个找到的区间
    if last_found_region.is_none() {
        // 检查当前区间是否有 transition
        let has_transition = match direction {
            SearchDirection::Forward => {
                signal_data.transitions.iter().any(|t| t.time >= start && t.time <= search_end)
            }
            SearchDirection::Backward => {
                signal_data.transitions.iter().any(|t| t.time >= search_start && t.time <= end)
            }
        };
        if has_transition {
            last_found_region = Some((start, end));
        }
    }

    last_found_region
}

/// 为多个信号搜索边界值（优化版本）
/// 
/// # Arguments
/// * `signal_data_map` - 信号数据映射
/// * `time` - 搜索时间点
/// * `direction` - 搜索方向
/// * `wave_end` - 波形结束时间
/// * `widths` - 信号宽度映射
/// 
/// # Returns
/// * 每个信号找到的边界值
pub fn search_boundary_values_optimized(
    signal_data_map: &std::collections::HashMap<Handle, &SignalWaveData>,
    time: u64,
    direction: SearchDirection,
    wave_end: u64,
    widths: &std::collections::HashMap<Handle, u16>,
) -> std::collections::HashMap<Handle, Option<SignalValue>> {
    let mut results: std::collections::HashMap<Handle, Option<SignalValue>> = std::collections::HashMap::new();

    // Step 1: 为每个信号找到最小有 transition 的区间
    let mut search_regions: Vec<SearchRegion> = Vec::new();
    
    for (handle, signal_data) in signal_data_map {
        let (search_start, search_end) = match direction {
            SearchDirection::Forward => (0, time),
            SearchDirection::Backward => (time, wave_end),
        };

        if let Some((start, end)) = find_min_region_binary(signal_data, search_start, search_end, direction) {
            search_regions.push(SearchRegion {
                handle: *handle,
                start,
                end,
            });
        } else {
            // 没有找到任何 transition，结果为 None
            results.insert(*handle, None);
        }
    }

    // 如果所有信号都没有找到区间，直接返回
    if search_regions.is_empty() {
        return results;
    }

    // Step 2: 合并排序区间边界
    // 收集所有边界点
    let mut boundaries: Vec<(u64, Handle, bool)> = Vec::new(); // (time, handle, is_start)
    for region in &search_regions {
        boundaries.push((region.start, region.handle, true));
        boundaries.push((region.end, region.handle, false));
    }
    
    // 按时间排序，从距离目标最远的开始
    boundaries.sort_by(|a, b| {
        match direction {
            SearchDirection::Forward => b.0.cmp(&a.0), // 降序，从最远的开始
            SearchDirection::Backward => a.0.cmp(&b.0), // 升序，从最远的开始
        }
    });

    // Step 3: 多信号一起搜索
    let mut found_values: std::collections::HashMap<Handle, SignalValue> = std::collections::HashMap::new();
    let mut pending_handles: std::collections::HashSet<Handle> = search_regions.iter()
        .map(|r| r.handle)
        .collect();

    // 按区间搜索
    for (boundary_time, _, is_start) in &boundaries {
        if pending_handles.is_empty() {
            break;
        }

        // 找到当前边界涉及的信号
        let current_handles: Vec<Handle> = pending_handles.iter()
            .filter(|h| {
                search_regions.iter()
                    .any(|r| &r.handle == *h && *boundary_time >= r.start && *boundary_time <= r.end)
            })
            .cloned()
            .collect();

        if current_handles.is_empty() {
            continue;
        }

        // 在信号数据中搜索
        for handle in &current_handles {
            if let Some(signal_data) = signal_data_map.get(handle) {
                let value = match direction {
                    SearchDirection::Forward => {
                        // 查找 <= time 的最后一个值
                        signal_data.value_at(time).map(|t| t.value.clone())
                    }
                    SearchDirection::Backward => {
                        // 查找 > time 的第一个值
                        signal_data.transitions.iter()
                            .find(|t| t.time > time)
                            .map(|t| t.value.clone())
                    }
                };

                if let Some(v) = value {
                    found_values.insert(*handle, v);
                    pending_handles.remove(handle);
                }
            }
        }
    }

    // Step 4: 组装结果
    for (handle, _) in signal_data_map {
        if let Some(value) = found_values.get(handle) {
            results.insert(*handle, Some(value.clone()));
        } else {
            // 没有找到，使用默认值
            let width = widths.get(handle).copied().unwrap_or(1);
            let default_value = if width == 1 {
                SignalValue::Numeric("X".to_string())
            } else {
                SignalValue::Numeric(format!("b{}", "X".repeat(width as usize)))
            };
            results.insert(*handle, Some(default_value));
        }
    }

    results
}

/// 使用 fstapi reader 搜索 bucket 内的 first 和 last 值（优化版本）
/// 
/// 用于 LoD > 15 的情况，减少 FST 读取次数
/// 直接使用 fstapi 的 set_time_range_limit 和 for_each_block，不需要预先读取全部数据
/// 
/// # 查找策略
/// 只遍历一次数据，同时记录 first 和 last 值
/// - first: 第一个遇到的值
/// - last: 持续更新，最终是最后一个值
/// 
/// # Arguments
/// * `reader` - fstapi Reader
/// * `handles` - 信号 handle 列表
/// * `bucket_start` - bucket 起始时间
/// * `bucket_end` - bucket 结束时间
/// 
/// # Returns
/// * 每个信号的 (first, last) 值，如果 bucket 内没有 transition 则为 None
pub fn search_bucket_first_last_from_fst(
    wave_path: &std::path::Path,
    handles: &[Handle],
    bucket_start: u64,
    bucket_end: u64,
) -> std::collections::HashMap<Handle, (Option<SignalValue>, Option<SignalValue>)> {
    let mut results: std::collections::HashMap<Handle, (Option<SignalValue>, Option<SignalValue>)> = 
        handles.iter().map(|h| (*h, (None, None))).collect();
    
    // 重新打开 reader（避免状态污染）
    info!("Opening FST file: {:?}", wave_path);
    let mut reader = match fstapi::Reader::open(wave_path) {
        Ok(r) => {
            info!("Successfully opened FST file");
            r
        }
        Err(e) => {
            error!("Failed to open FST file: {:?}", e);
            return results;
        }
    };
    
    // 启用所有 mask（必须调用，否则 for_each_block 不会读取数据）
    // 注意：set_mask_all 会启用所有信号的 mask，不需要单独调用 set_mask
    info!("Setting mask all");
    reader.set_mask_all();
    
    let mut first_values: std::collections::HashMap<Handle, SignalValue> = std::collections::HashMap::new();
    let mut last_values: std::collections::HashMap<Handle, SignalValue> = std::collections::HashMap::new();
    
    // 设置时间范围限制
    info!("Setting time range: [{}, {}]", bucket_start, bucket_end);
    reader.set_time_range_limit(bucket_start, bucket_end);
    
    // 检查 reader 状态
    info!("Reader state: mask_all set, time range set");
    
    let mut block_count = 0;
    
    // 只遍历一次数据，同时记录 first 和 last
    reader.for_each_block(|_time, handle, value, _var_len| {
        block_count += 1;
        if handles.contains(&handle) {
            let signal_value = SignalValue::Numeric(String::from_utf8_lossy(value).to_string());
            
            // 记录 first（第一个遇到的值）
            if !first_values.contains_key(&handle) {
                first_values.insert(handle, signal_value.clone());
            }
            
            // 更新 last（最后一个遇到的值）
            last_values.insert(handle, signal_value);
        }
    }).ok();
    
    info!("search_bucket_first_last_from_fst: bucket=[{}, {}], blocks={}, first_values={}, last_values={}", 
          bucket_start, bucket_end, block_count, first_values.len(), last_values.len());
    
    // 组装结果
    for handle in handles {
        let first = first_values.get(handle).cloned();
        let last = last_values.get(handle).cloned();
        results.insert(*handle, (first, last));
    }
    
    results
}

/// 为多个信号搜索 bucket 内的 first 和 last 值（优化版本）
/// 
/// 用于 LoD > 15 的情况，减少 FST 读取次数
/// 
/// # Arguments
/// * `signal_data_map` - 信号数据映射
/// * `bucket_start` - bucket 起始时间
/// * `bucket_end` - bucket 结束时间
/// * `widths` - 信号宽度映射
/// 
/// # Returns
/// * 每个信号的 (first, last) 值，如果 bucket 内没有 transition 则为 None
pub fn search_bucket_first_last_optimized(
    signal_data_map: &std::collections::HashMap<Handle, &SignalWaveData>,
    bucket_start: u64,
    bucket_end: u64,
    widths: &std::collections::HashMap<Handle, u16>,
) -> std::collections::HashMap<Handle, (Option<SignalValue>, Option<SignalValue>)> {
    let mut results: std::collections::HashMap<Handle, (Option<SignalValue>, Option<SignalValue>)> = std::collections::HashMap::new();

    // Step 1: 为每个信号找到 bucket 范围内的最小搜索区间
    let mut search_regions: Vec<SearchRegion> = Vec::new();
    
    for (handle, signal_data) in signal_data_map {
        // 检查 bucket 范围内是否有 transition
        let has_transition = signal_data.transitions.iter()
            .any(|t| t.time >= bucket_start && t.time < bucket_end);
        
        if has_transition {
            // 使用二分法找到最小搜索区间
            if let Some((start, end)) = find_min_region_binary(
                signal_data, 
                bucket_start, 
                bucket_end, 
                SearchDirection::Forward  // 方向不重要，只是为了找到区间
            ) {
                search_regions.push(SearchRegion {
                    handle: *handle,
                    start: start.max(bucket_start),
                    end: end.min(bucket_end),
                });
            }
        } else {
            // bucket 内没有 transition
            results.insert(*handle, (None, None));
        }
    }

    // 如果所有信号都没有找到区间，直接返回
    if search_regions.is_empty() {
        return results;
    }

    // Step 2: 合并排序区间边界
    let mut boundaries: Vec<(u64, Handle, bool)> = Vec::new();
    for region in &search_regions {
        boundaries.push((region.start, region.handle, true));
        boundaries.push((region.end, region.handle, false));
    }
    
    // 按时间排序
    boundaries.sort_by(|a, b| a.0.cmp(&b.0));

    // Step 3: 多信号一起搜索 first 和 last
    let mut found_first: std::collections::HashMap<Handle, SignalValue> = std::collections::HashMap::new();
    let mut found_last: std::collections::HashMap<Handle, SignalValue> = std::collections::HashMap::new();
    let mut pending_handles: std::collections::HashSet<Handle> = search_regions.iter()
        .map(|r| r.handle)
        .collect();

    // 在每个搜索区间内查找 first 和 last
    for region in &search_regions {
        if !pending_handles.contains(&region.handle) {
            continue;
        }

        if let Some(signal_data) = signal_data_map.get(&region.handle) {
            // 查找 first: 第一个 time >= bucket_start && time < bucket_end 的 transition
            let first = signal_data.transitions.iter()
                .find(|t| t.time >= bucket_start && t.time < bucket_end)
                .map(|t| t.value.clone());
            
            // 查找 last: 最后一个 time >= bucket_start && time < bucket_end 的 transition
            let last = signal_data.transitions.iter()
                .rev()
                .find(|t| t.time >= bucket_start && t.time < bucket_end)
                .map(|t| t.value.clone());

            if let Some(f) = first {
                found_first.insert(region.handle, f);
            }
            if let Some(l) = last {
                found_last.insert(region.handle, l);
            }
            
            pending_handles.remove(&region.handle);
        }
    }

    // Step 4: 组装结果
    for (handle, _) in signal_data_map {
        let first = found_first.get(handle).cloned();
        let last = found_last.get(handle).cloned();
        
        if first.is_some() || last.is_some() {
            results.insert(*handle, (first, last));
        } else {
            results.insert(*handle, (None, None));
        }
    }

    results
}

/// 波形文件基本信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct WaveFileInfo {
    /// 波形文件名
    pub name: String,
    /// 文件大小 (字节)
    pub file_size: u64,
    /// 是否为有效的 FST 文件
    pub is_valid: bool,
    /// 文件修改时间 (Unix timestamp)
    pub modified_time: u64,
    /// SHA256 校验和 (用于缓存验证)
    pub checksum: String,
}

/// 波形文件元数据信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct WaveInfo {
    /// 波形文件名
    pub name: String,
    /// 文件大小 (字节)
    pub file_size: u64,
    /// 时间单位
    pub time_unit: String,
    /// 时间精度
    pub time_precision: String,
    /// 开始时间
    pub start_time: u64,
    /// 结束时间 (时长)
    pub end_time: u64,
    /// 信号数量
    pub signal_count: usize,
    /// 版本信息
    pub version: String,
    /// 日期信息
    pub date: String,
}

/// 信号信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct SignalInfo {
    /// 信号句柄/ID
    pub handle: u32,
    /// 信号名称
    pub name: String,
    /// 信号类型
    pub signal_type: String,
    /// 位宽
    pub width: u32,
    /// 方向 (输入/输出/内部)
    pub direction: String,
    /// 是否是 alias 信号
    pub is_alias: bool,
}

/// FST 读取后端枚举
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FstBackend {
    /// 使用 fstapi (GTKWave C API)
    FstApi,
    /// 使用 fst-reader (纯 Rust，支持 read_range_boundary_values)
    FstReader,
}

impl Default for FstBackend {
    fn default() -> Self {
        // 默认使用 fstapi，因为它支持更完整的 FST 格式
        FstBackend::FstApi
    }
}

/// 信号句柄缓存
/// 
/// 缓存结构: (波形路径, 信号名) -> (handle, width)
/// 使用 LRU 策略自动淘汰不常用的信号
#[derive(Debug, Clone)]
pub struct SignalHandleCache {
    cache: Cache<(String, String), (Handle, u16)>,
}

impl SignalHandleCache {
    /// 创建新的信号句柄缓存
    pub fn new(max_capacity: u64) -> Self {
        Self {
            cache: Cache::builder()
                .max_capacity(max_capacity)
                .build(),
        }
    }

    /// 获取信号 handle
    pub async fn get(&self, wave_path: &str, signal_name: &str) -> Option<(Handle, u16)> {
        self.cache.get(&(wave_path.to_string(), signal_name.to_string())).await
    }

    /// 缓存信号 handle
    pub async fn put(&self, wave_path: &str, signal_name: String, handle: Handle, width: u16) {
        self.cache.insert((wave_path.to_string(), signal_name), (handle, width)).await;
    }

    /// 使指定波形文件的缓存失效
    pub async fn invalidate(&self, wave_path: &str) {
        // 遍历并删除匹配的 key
        let keys_to_remove: Vec<_> = self.cache
            .iter()
            .filter(|(key, _)| key.0 == wave_path)
            .map(|(key, _)| (*key).clone())
            .collect();
        
        for key in keys_to_remove {
            self.cache.invalidate(&key).await;
        }
    }
}

/// 波形数据服务
pub struct WaveService {
    state: ServerState,
    backend: FstBackend,
    signal_cache: Arc<SignalHandleCache>,
}

impl WaveService {
    /// 创建新的波形数据服务
    pub fn new(state: ServerState) -> Self {
        Self {
            state,
            backend: FstBackend::default(),
            signal_cache: Arc::new(SignalHandleCache::new(10000)), // 最多缓存 10000 个信号
        }
    }

    /// 创建指定后端的波形数据服务
    pub fn with_backend(state: ServerState, backend: FstBackend) -> Self {
        Self {
            state,
            backend,
            signal_cache: Arc::new(SignalHandleCache::new(10000)), // 最多缓存 10000 个信号
        }
    }

    /// 设置后端
    pub fn set_backend(&mut self, backend: FstBackend) {
        self.backend = backend;
    }

    /// 获取当前后端
    pub fn backend(&self) -> FstBackend {
        self.backend
    }

    /// 获取所有可用的波形文件列表
    /// 只返回有效的 FST 文件
    pub async fn list_waves(&self) -> Result<Vec<WaveFileInfo>> {
        let mut waves = Vec::new();

        info!("正在读取波形目录: {}", self.state.config.wave_dir.display());
        let mut entries = fs::read_dir(&self.state.config.wave_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();

            // 检查是否是 .fst 文件
            info!("检查文件: {:?}", path);
            if let Some(ext) = path.extension() {
                info!("  扩展名: {:?}", ext);
                if ext == "fst" {
                    if let Some(name) = path.file_stem() {
                        let name = name.to_string_lossy().to_string();
                        let metadata = fs::metadata(&path).await?;
                        let file_size = metadata.len();

                        // 验证 FST 文件有效性
                        let is_valid = self.validate_fst_file(&path).await?;

                        // 获取文件修改时间
                        let modified_time = metadata
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0);

                        // 计算校验和（只对有效文件）
                        let checksum = if is_valid {
                            compute_file_hash(&path).await.unwrap_or_default()
                        } else {
                            String::new()
                        };

                        info!("  发现 FST 文件: {} ({} bytes, valid={}, modified={}, checksum={})", 
                            name, file_size, is_valid, modified_time, &checksum[..8.min(checksum.len())]);

                        waves.push(WaveFileInfo {
                            name,
                            file_size,
                            is_valid,
                            modified_time,
                            checksum,
                        });
                    }
                }
            }
        }

        // 按名称排序
        waves.sort_by(|a, b| a.name.cmp(&b.name));

        info!("发现 {} 个波形文件", waves.len());
        Ok(waves)
    }

    /// 验证 FST 文件的有效性
    /// 简化验证：仅通过文件扩展名 .fst 判断
    /// 实际格式验证在读取时由 fstapi 处理
    async fn validate_fst_file(&self, path: &PathBuf) -> Result<bool> {
        // 检查文件大小（至少要有一些内容）
        let metadata = fs::metadata(path).await?;
        if metadata.len() < 1 {
            return Ok(false);
        }

        // 仅通过扩展名判断
        let is_valid = path.extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("fst"))
            .unwrap_or(false);

        if is_valid {
            debug!("FST 文件验证成功（通过扩展名）：{:?}", path);
        }

        Ok(is_valid)
    }

    /// 获取波形文件的完整路径
    fn get_wave_path(&self, wave_name: &str) -> Result<PathBuf> {
        let wave_dir = &self.state.config.wave_dir;
        let wave_path = wave_dir.join(format!("{}.fst", wave_name));

        if !wave_path.exists() {
            return Err(ServerError::WaveformNotFound(wave_name.to_string()));
        }

        Ok(wave_path)
    }

    /// 获取波形文件的元数据信息
    pub async fn get_wave_info(&self, wave_name: &str) -> Result<WaveInfo> {
        let wave_path = self.get_wave_path(wave_name)?;

        // 根据后端选择不同的读取方式
        match self.backend {
            FstBackend::FstApi => self.get_wave_info_fstapi(&wave_path, wave_name).await,
            FstBackend::FstReader => self.get_wave_info_fst_reader(&wave_path, wave_name).await,
        }
    }

    /// 使用 fst-reader 获取波形文件信息
    async fn get_wave_info_fst_reader(&self, wave_path: &PathBuf, wave_name: &str) -> Result<WaveInfo> {
        use crate::services::fst_backend::{FstReader, create_reader_backend};
        
        let backend = create_reader_backend("fst-reader");
        let file_info = backend.get_file_info(wave_path).await?;
        
        // 获取文件大小
        let file_size = tokio::fs::metadata(wave_path).await.map(|m| m.len()).unwrap_or(0);
        
        Ok(WaveInfo {
            name: wave_name.to_string(),
            file_size,
            time_unit: "ps".to_string(),  // fst-reader 默认使用 ps
            time_precision: "1ps".to_string(),
            start_time: file_info.start_time,
            end_time: file_info.end_time,
            signal_count: file_info.signal_count,
            version: "FST".to_string(),
            date: String::new(),
        })
    }

    /// 使用 fstapi 获取波形文件信息
    async fn get_wave_info_fstapi(&self, wave_path: &PathBuf, wave_name: &str) -> Result<WaveInfo> {
        let path_str = wave_path.to_string_lossy().to_string();
        let wave_name = wave_name.to_string();

        // 使用 spawn_blocking 避免阻塞异步运行时
        let info = tokio::task::spawn_blocking(move || {
            info!("正在使用 fstapi 打开 FST 文件: {}", path_str);
            let reader = fstapi::Reader::open(&path_str)
                .map_err(|e| {
                    error!("无法打开 FST 文件 {}: {}", path_str, e);
                    ServerError::Internal(format!("无法打开 FST 文件: {}", e))
                })?;

            let file_size = std::fs::metadata(&path_str)
                .map(|m| m.len())
                .unwrap_or(0);

            // 获取各个字段
            let date = reader.date().unwrap_or("Unknown");
            let version = reader.version().unwrap_or("Unknown");
            let start_time_fst = reader.start_time();
            let end_time_fst = reader.end_time();
            let var_count = reader.var_count();

            info!("FST 文件元数据: vars={}, start={}, end={}, version={}",
                var_count, start_time_fst, end_time_fst, version);

            // 使用 fstapi 的 timescale_str() 获取时间单位
            let time_unit = reader.timescale_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| {
                    // 如果 timescale_str 返回 None，使用 exponent 转换
                    let exp = reader.timescale();
                    warn!("fstapi 返回未知 timescale (exponent: {})，使用默认值 1ps", exp);
                    "1ps".to_string()
                });
            info!("FST 文件时间单位 (from fstapi): {}", time_unit);

            // 使用 FST 原始时间单位（不转换为 fs）
            let start_time = start_time_fst;
            let end_time = end_time_fst;
            info!("时间范围: {} - {} (单位: {})", start_time, end_time, time_unit);

            Ok::<_, ServerError>(WaveInfo {
                name: wave_name,
                file_size,
                time_unit: time_unit.clone(),
                time_precision: time_unit,
                start_time,
                end_time,
                signal_count: var_count as usize,
                version: version.to_string(),
                date: date.to_string(),
            })
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(info)
    }

    /// 从 FST 文件 header 读取时间单位
    /// FST 文件格式：offset 73 处存储 1-byte signed integer 表示 timescale exponent
    /// 0=1s, -3=1ms, -6=1us, -9=1ns, -12=1ps, -15=1fs
    fn read_fst_timescale(path: &str) -> Result<String> {
        use std::io::{Read, Seek, SeekFrom};

        let mut file = std::fs::File::open(path)
            .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;

        // 读取 header 前几个字节来验证文件类型
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|e| ServerError::Internal(format!("无法读取 FST header: {}", e)))?;

        // FST 文件以特定 header 开始，检查是否是有效的 FST 文件
        // FST header: 0x00 block type, followed by gzipped content
        // 我们需要读取解压后的 header block

        // 由于 FST 文件是压缩的，我们需要使用 fstapi 或其他方式获取 timescale
        // 目前 fstapi 没有直接暴露 timescale，我们尝试从文件直接读取

        // 尝试读取 offset 73 处的时间单位（这在解压后的 header 中）
        // 由于文件是压缩的，这种方法可能不准确
        // 更好的方法是使用 wavefst 后端或等待 fstapi 支持

        // 作为备选，我们尝试解析文件
        file.seek(SeekFrom::Start(73))
            .map_err(|e| ServerError::Internal(format!("无法定位到 timescale: {}", e)))?;

        let mut timescale_byte = [0u8; 1];
        match file.read_exact(&mut timescale_byte) {
            Ok(_) => {
                let exponent = timescale_byte[0] as i8;
                // 转换 exponent 为时间单位字符串
                let time_unit = Self::exponent_to_time_unit(exponent);
                info!("从 FST 文件读取到 timescale exponent: {}, 时间单位: {}", exponent, time_unit);
                Ok(time_unit)
            }
            Err(_) => {
                // 如果读取失败，返回默认值
                warn!("无法从 FST 文件读取 timescale，使用默认值 1ps");
                Ok("1ps".to_string())
            }
        }
    }

    /// 将 timescale exponent 转换为时间单位字符串
    /// exponent: 0=1s, -3=1ms, -6=1us, -9=1ns, -12=1ps, -15=1fs
    fn exponent_to_time_unit(exponent: i8) -> String {
        match exponent {
            0 => "1s".to_string(),
            -1 => "100ms".to_string(),
            -2 => "10ms".to_string(),
            -3 => "1ms".to_string(),
            -4 => "100us".to_string(),
            -5 => "10us".to_string(),
            -6 => "1us".to_string(),
            -7 => "100ns".to_string(),
            -8 => "10ns".to_string(),
            -9 => "1ns".to_string(),
            -10 => "100ps".to_string(),
            -11 => "10ps".to_string(),
            -12 => "1ps".to_string(),
            -13 => "100fs".to_string(),
            -14 => "10fs".to_string(),
            -15 => "1fs".to_string(),
            _ => {
                // 对于其他值，使用科学计数法表示
                if exponent < 0 {
                    format!("1e{}s", exponent)
                } else {
                    format!("1e+{}s", exponent)
                }
            }
        }
    }

    /// 获取波形文件中所有信号列表
    pub async fn list_signals(&self, wave_name: &str) -> Result<Vec<SignalInfo>> {
        let wave_path = self.get_wave_path(wave_name)?;

        // 根据后端选择不同的读取方式
        match self.backend {
            FstBackend::FstApi => self.list_signals_fstapi(&wave_path, wave_name).await,
            FstBackend::FstReader => self.list_signals_fst_reader(&wave_path, wave_name).await,
        }
    }

    /// 使用 fst-reader 获取信号列表
    async fn list_signals_fst_reader(&self, wave_path: &PathBuf, _wave_name: &str) -> Result<Vec<SignalInfo>> {
        use fst_reader::{FstReader, FstHierarchyEntry};
        use std::fs::File;
        use std::io::BufReader;

        let path = wave_path.clone();

        let signals = tokio::task::spawn_blocking(move || {
            let file = File::open(&path)
                .map_err(|e| ServerError::Internal(format!("无法打开 FST 文件: {}", e)))?;
            let buf_reader = BufReader::new(file);
            let mut reader = FstReader::open(buf_reader)
                .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {:?}", e)))?;

            let mut signals = Vec::new();
            let mut scope_stack: Vec<String> = Vec::new();

            reader.read_hierarchy(|entry| {
                match entry {
                    FstHierarchyEntry::Scope { name, .. } => {
                        scope_stack.push(name.to_string());
                    }
                    FstHierarchyEntry::UpScope => {
                        scope_stack.pop();
                    }
                    FstHierarchyEntry::Var { name, handle, length, .. } => {
                        let full_path = if scope_stack.is_empty() {
                            name.to_string()
                        } else {
                            format!("{}.{}", scope_stack.join("."), name)
                        };

                        signals.push(SignalInfo {
                            handle: handle.get_index() as u32,
                            name: full_path,
                            signal_type: "logic".to_string(),  // fst-reader 不提供类型信息
                            width: length.to_owned(),
                            direction: "internal".to_string(),
                            is_alias: false,  // fst-reader 不提供 alias 信息
                        });
                    }
                    _ => {}
                }
            }).ok();

            Ok::<_, ServerError>(signals)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(signals)
    }

    /// 使用 fstapi 获取信号列表
    async fn list_signals_fstapi(&self, wave_path: &PathBuf, _wave_name: &str) -> Result<Vec<SignalInfo>> {
        let path_str = wave_path.to_string_lossy().to_string();

        // 使用 spawn_blocking 避免阻塞异步运行时
        let signals = tokio::task::spawn_blocking(move || {
            info!("正在使用 fstapi 打开 FST 文件: {}", path_str);
            let mut reader = fstapi::Reader::open(&path_str)
                .map_err(|e| {
                    error!("无法打开 FST 文件 {}: {}", path_str, e);
                    ServerError::Internal(format!("无法打开 FST 文件: {}", e))
                })?;

            let mut signals = Vec::new();
            let mut var_count = 0;
            let mut alias_count = 0;

            // 遍历所有变量
            info!("开始遍历 FST 文件的变量...");
            for var_result in reader.vars() {
                var_count += 1;
                let (name, var) = var_result
                    .map_err(|e| {
                        error!("读取变量失败: {}", e);
                        ServerError::Internal(format!("读取变量失败: {}", e))
                    })?;

                // 记录别名，但不跳过（alias 信号也应该在列表中显示）
                let is_alias = var.is_alias();
                if is_alias {
                    alias_count += 1;
                }

                // 转换信号类型
                let signal_type = match var.ty() {
                    fstapi::var_type::VCD_EVENT => "VcdEvent",
                    fstapi::var_type::VCD_INTEGER => "VcdInteger",
                    fstapi::var_type::VCD_PARAMETER => "VcdParameter",
                    fstapi::var_type::VCD_REAL => "VcdReal",
                    fstapi::var_type::VCD_REAL_PARAMETER => "VcdRealParameter",
                    fstapi::var_type::VCD_REG => "VcdReg",
                    fstapi::var_type::VCD_SUPPLY0 => "VcdSupply0",
                    fstapi::var_type::VCD_SUPPLY1 => "VcdSupply1",
                    fstapi::var_type::VCD_TIME => "VcdTime",
                    fstapi::var_type::VCD_TRI => "VcdTri",
                    fstapi::var_type::VCD_TRIAND => "VcdTriand",
                    fstapi::var_type::VCD_TRIOR => "VcdTrior",
                    fstapi::var_type::VCD_TRIREG => "VcdTrireg",
                    fstapi::var_type::VCD_TRI0 => "VcdTri0",
                    fstapi::var_type::VCD_TRI1 => "VcdTri1",
                    fstapi::var_type::VCD_WAND => "VcdWand",
                    fstapi::var_type::VCD_WIRE => "VcdWire",
                    fstapi::var_type::VCD_WOR => "VcdWor",
                    fstapi::var_type::VCD_PORT => "VcdPort",
                    fstapi::var_type::VCD_SPARRAY => "VcdSparray",
                    fstapi::var_type::VCD_REALTIME => "VcdRealtime",
                    fstapi::var_type::GEN_STRING => "GenString",
                    fstapi::var_type::SV_BIT => "SvBit",
                    fstapi::var_type::SV_LOGIC => "SvLogic",
                    fstapi::var_type::SV_INT => "SvInt",
                    fstapi::var_type::SV_SHORTINT => "SvShortint",
                    fstapi::var_type::SV_LONGINT => "SvLongint",
                    fstapi::var_type::SV_BYTE => "SvByte",
                    fstapi::var_type::SV_ENUM => "SvEnum",
                    fstapi::var_type::SV_SHORTREAL => "SvShortreal",
                    _ => "Unknown",
                };

                // 转换方向
                let direction = match var.direction() {
                    fstapi::var_dir::IMPLICIT => "Implicit",
                    fstapi::var_dir::INPUT => "Input",
                    fstapi::var_dir::OUTPUT => "Output",
                    fstapi::var_dir::INOUT => "Inout",
                    fstapi::var_dir::BUFFER => "Buffer",
                    fstapi::var_dir::LINKAGE => "Linkage",
                    _ => "Unknown",
                };

                signals.push(SignalInfo {
                    handle: var.handle().into(),
                    name: name.to_string(),
                    signal_type: signal_type.to_string(),
                    width: var.length(),
                    direction: direction.to_string(),
                    is_alias,
                });
            }

            info!("FST 文件从 fstapi 读取完成: 总变量={}, 别名={}, 有效信号={}",
                var_count, alias_count, signals.len());
            Ok::<_, ServerError>(signals)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(signals)
    }

    /// 获取单个信号的详细信息
    pub async fn get_signal_info(&self, wave_name: &str, signal_name: &str) -> Result<SignalInfo> {
        let signals = self.list_signals(wave_name).await?;

        for signal in signals {
            if signal.name == signal_name {
                return Ok(signal);
            }
        }

        Err(ServerError::SignalNotFound(signal_name.to_string()))
    }

    /// 获取波形数据 (支持 HTTP Range 和 LoD)
    ///
    /// 根据请求的 LoD 层级和时间范围，返回对应的 chunk 数据
    /// 
    /// 注意：API 传入的时间参数单位与波形文件的 time_unit 一致
    pub async fn get_wave_data(
        &self,
        wave_name: &str,
        signal_name: &str,
        lod: u32,
        start: i64,
        end: i64,
        range: Option<(u64, Option<u64>)>,
        compression: CompressionAlgorithm,
    ) -> Result<(Vec<u8>, u64, Option<u64>)> {
        let wave_path = self.get_wave_path(wave_name)?;
        let metadata = fs::metadata(&wave_path).await?;
        let file_size = metadata.len();

        // 验证 LoD 层级
        let lod_level = LodLevel::new(lod);
        if !lod_level.is_valid() {
            return Err(ServerError::InvalidLod(lod));
        }

        // 获取 FST 文件的时间单位
        let fst_time_unit = self.read_fst_timescale_str(&wave_path).await?;
        
        // API 传入的时间已经是 time_unit 单位，直接使用
        let time_start = start.max(0) as u64;
        let time_end = if end > 0 {
            end as u64
        } else {
            // 从 FST 文件获取结束时间
            self.get_wave_end_time(&wave_path).await.unwrap_or(1_000_000)
        };

        info!(
            "获取波形数据: wave={}, signal={}, lod={}, time={}-{} (unit={}), compression={}",
            wave_name, signal_name, lod, time_start, time_end, fst_time_unit, compression.name()
        );

        // 根据后端选择数据获取方式
        let signal_data = match self.backend {
            FstBackend::FstApi => {
                self.read_signal_data_fstapi(&wave_path, signal_name, lod_level, time_start, time_end)
                    .await?
            }
            FstBackend::FstReader => {
                self.read_signal_data_fst_reader(&wave_path, signal_name, lod_level, time_start, time_end)
                    .await?
            }
        };
        
        // 序列化为 chunk
        // 这里的数据已经是 LoD 数据，时间已经是 bucket 索引，不需要过滤
        let chunk_data = ChunkSerializer::serialize(
            0,
            lod as u16,
            &[&signal_data],
            (time_start, time_end),
            compression,
            true, // skip_time_filter = true for LoD data
        )?;

        // 处理 Range 请求
        let (data, content_length) = if let Some((start, end)) = range {
            let end = end.unwrap_or(chunk_data.len() as u64);
            let start = start as usize;
            let end = end.min(chunk_data.len() as u64) as usize;

            if start >= chunk_data.len() {
                return Err(ServerError::InvalidRange);
            }

            let ranged_data = chunk_data[start..end].to_vec();
            let content_length = ranged_data.len() as u64;
            (ranged_data, Some(content_length))
        } else {
            (chunk_data, None)
        };

        Ok((data, file_size, content_length))
    }

    /// 获取多个信号的波形数据
    ///
    /// # Arguments
    /// * `wave_name` - 波形文件名
    /// * `signal_names` - 信号名列表
    /// * `lod` - LoD 层级
    /// * `start` - 起始时间
    /// * `end` - 结束时间
    /// * `range` - HTTP Range 请求范围
    /// * `compression` - 压缩算法
    pub async fn get_wave_data_multi(
        &self,
        wave_name: &str,
        signal_names: &[String],
        lod: u32,
        start: i64,
        end: i64,
        range: Option<(u64, Option<u64>)>,
        compression: CompressionAlgorithm,
    ) -> Result<(Vec<u8>, u64, Option<u64>)> {
        let wave_path = self.get_wave_path(wave_name)?;
        let metadata = fs::metadata(&wave_path).await?;
        let file_size = metadata.len();

        // 验证 LoD 层级
        let lod_level = LodLevel::new(lod);
        if !lod_level.is_valid() {
            return Err(ServerError::InvalidLod(lod));
        }

        // 获取 FST 文件的时间单位
        let fst_time_unit = self.read_fst_timescale_str(&wave_path).await?;

        // API 传入的时间已经是 time_unit 单位，直接使用
        let time_start = start.max(0) as u64;
        let time_end = if end > 0 {
            end as u64
        } else {
            // 从 FST 文件获取结束时间
            self.get_wave_end_time(&wave_path).await.unwrap_or(1_000_000)
        };

        info!(
            "获取多信号波形数据: wave={}, signals={:?}, lod={}, time={}-{} (unit={}), compression={}",
            wave_name, signal_names, lod, time_start, time_end, fst_time_unit, compression.name()
        );

        // 读取所有信号数据
        if signal_names.is_empty() {
            return Err(ServerError::SignalNotFound("No signals specified".to_string()));
        }
        
        // 使用优化的批量读取函数（支持 SignalHandleCache）
        let signal_data_list = match self.backend {
            FstBackend::FstApi => {
                self.read_signals_data_fstapi(&wave_path, signal_names, lod_level, time_start, time_end).await?
            }
            FstBackend::FstReader => {
                // fst-reader 后端使用逐个读取
                let mut list = Vec::new();
                for signal_name in signal_names {
                    let signal_data = self.read_signal_data_fst_reader(&wave_path, signal_name, lod_level, time_start, time_end).await?;
                    list.push(signal_data);
                }
                list
            }
        };
        
        // 序列化为多信号 chunk
        // 这里的数据已经是 LoD 数据，时间已经是 bucket 索引，不需要过滤
        let signal_refs: Vec<&SignalWaveData> = signal_data_list.iter().collect();
        let chunk_data = ChunkSerializer::serialize(
            0, // chunk_id
            lod as u16,
            &signal_refs,
            (time_start, time_end),
            compression,
            true, // skip_time_filter = true for LoD data
        )?;

        // 处理 Range 请求
        let (data, content_length) = if let Some((start, end)) = range {
            let end = end.unwrap_or(chunk_data.len() as u64);
            let start = start as usize;
            let end = end.min(chunk_data.len() as u64) as usize;

            if start >= chunk_data.len() {
                return Err(ServerError::InvalidRange);
            }

            let ranged_data = chunk_data[start..end].to_vec();
            let content_length = ranged_data.len() as u64;
            (ranged_data, Some(content_length))
        } else {
            (chunk_data, None)
        };

        info!(
            "返回多信号波形数据: wave={}, {} 个信号, {} bytes",
            wave_name,
            signal_names.len(),
            data.len()
        );

        Ok((data, file_size, content_length))
    }

    /// 获取多个信号的波形数据（Tile-based 模式）
    ///
    /// # Arguments
    /// * `wave_name` - 波形文件名
    /// * `signal_names` - 信号名列表
    /// * `lod` - LoD 层级
    /// * `start_time` - 第一个 tile 的起始时间
    /// * `tile_span` - 每个 tile 的时间跨度
    /// * `num_tiles` - tile 数量
    /// * `compression` - 压缩算法
    pub async fn get_wave_data_tiles(
        &self,
        wave_name: &str,
        signal_names: &[String],
        lod: u32,
        start_time: u64,
        tile_span: u64,
        num_tiles: usize,
        compression: CompressionAlgorithm,
    ) -> Result<(Vec<u8>, u64)> {
        let wave_path = self.get_wave_path(wave_name)?;
        let metadata = fs::metadata(&wave_path).await?;
        let file_size = metadata.len();

        // 验证 LoD 层级
        let lod_level = LodLevel::new(lod);
        if !lod_level.is_valid() {
            return Err(ServerError::InvalidLod(lod));
        }

        // 限制 tile 数量（防止请求过大）
        const MAX_TILES: usize = 100;
        if num_tiles == 0 || num_tiles > MAX_TILES {
            return Err(ServerError::InvalidParameter(format!(
                "num_tiles must be between 1 and {}, got {}",
                MAX_TILES, num_tiles
            )));
        }

        // 验证 tile_span
        if tile_span == 0 {
            return Err(ServerError::InvalidParameter(
                "tile_span must be greater than 0".to_string()
            ));
        }

        info!(
            "获取多信号 Tile 数据: wave={}, signals={:?}, lod={}, tiles={}×{} ({}-{})",
            wave_name, signal_names, lod, num_tiles, tile_span,
            start_time, start_time + tile_span * num_tiles as u64
        );

        // 读取所有信号数据
        if signal_names.is_empty() {
            return Err(ServerError::SignalNotFound("No signals specified".to_string()));
        }

        // 使用优化的批量读取函数
        debug!("backend={:?}, wave_name={}", self.backend, wave_name);
        let tiles_data = match self.backend {
            FstBackend::FstApi => {
                self.read_signals_data_tiles_fstapi(
                    &wave_path, signal_names, lod_level, start_time, tile_span, num_tiles
                ).await?
            }
            FstBackend::FstReader => {
                // fst-reader 后端：使用新的多 tile 版本
                let reader_tiles = self.read_signals_data_fst_reader_tiles(
                    &wave_path, signal_names, lod_level, start_time, tile_span, num_tiles
                ).await?;
                
                // ===== 对比测试：同时使用 fstapi 读取相同数据（仅在开启 compare_test 时执行）=====
                if self.state.config.compare_test {
                    println!("[COMPARE] 开始对比测试 num_tiles={}", num_tiles);
                    match self.read_signals_data_tiles_fstapi(
                        &wave_path, signal_names, lod_level, start_time, tile_span, num_tiles
                    ).await {
                        Ok(fstapi_tiles) => {
                            println!("[COMPARE] fstapi_tiles.len()={}, reader_tiles.len()={}", 
                                fstapi_tiles.len(), reader_tiles.len());
                            
                            // 对比每个 tile 的结果
                            for tile_idx in 0..num_tiles.min(fstapi_tiles.len()).min(reader_tiles.len()) {
                                let reader_signals = &reader_tiles[tile_idx];
                                let fstapi_signals = &fstapi_tiles[tile_idx];
                                
                                if !reader_signals.is_empty() && !fstapi_signals.is_empty() {
                                    self.compare_signal_data(&signal_names, reader_signals, fstapi_signals, tile_idx);
                                }
                            }
                        }
                        Err(e) => {
                            println!("[COMPARE] fstapi 读取失败: {:?}", e);
                        }
                    }
                }
                // ===== 对比测试结束 =====
                
                reader_tiles
            }
        };

        // 序列化为 MultiTileChunk 格式
        let multi_tile_data = MultiTileChunkSerializer::serialize(
            lod as u16,
            start_time,
            tile_span,
            &tiles_data,
            compression,
        )?;

        info!(
            "返回多信号 Tile 数据: wave={}, {} 个信号, {} tiles, {} bytes",
            wave_name,
            signal_names.len(),
            num_tiles,
            multi_tile_data.len()
        );

        Ok((multi_tile_data, file_size))
    }

    /// 读取 FST 文件的时间单位字符串
    async fn read_fst_timescale_str(&self, wave_path: &PathBuf) -> Result<String> {
        let path_str = wave_path.to_string_lossy().to_string();
        
        tokio::task::spawn_blocking(move || {
            Self::read_fst_timescale(&path_str)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("读取时间单位失败: {}", e)))?
    }

    /// 将飞秒 (fs) 转换为 FST 内部时间单位（取整）
    /// 
    /// 例如：
    /// - 1000 fs, timescale="1fs" -> 1000
    /// - 1000 fs, timescale="1ps" -> 1
    /// - 1500 fs, timescale="1ps" -> 2 (四舍五入)
    fn fs_to_fst_time(fs: u64, timescale: &str) -> u64 {
        let scale_factor = Self::timescale_to_factor(timescale);
        // 使用四舍五入： (fs + scale_factor/2) / scale_factor
        (fs + scale_factor / 2) / scale_factor
    }

    /// 将 FST 内部时间单位转换为飞秒 (fs)
    ///
    /// 例如：
    /// - 1000, timescale="1fs" -> 1000 fs
    /// - 1, timescale="1ps" -> 1000 fs
    fn fst_time_to_fs(fst_time: u64, timescale: &str) -> u64 {
        let scale_factor = Self::timescale_to_factor(timescale);
        fst_time * scale_factor
    }

    /// 将时间单位字符串转换为飞秒倍数
    ///
    /// "1fs" -> 1
    /// "1ps" -> 1000
    /// "1ns" -> 1_000_000
    /// "1us" -> 1_000_000_000
    /// "1ms" -> 1_000_000_000_000
    /// "1s" -> 1_000_000_000_000_000
    fn timescale_to_factor(timescale: &str) -> u64 {
        match timescale {
            "1fs" => 1,
            "10fs" => 10,
            "100fs" => 100,
            "1ps" => 1_000,
            "10ps" => 10_000,
            "100ps" => 100_000,
            "1ns" => 1_000_000,
            "10ns" => 10_000_000,
            "100ns" => 100_000_000,
            "1us" => 1_000_000_000,
            "10us" => 10_000_000_000,
            "100us" => 100_000_000_000,
            "1ms" => 1_000_000_000_000,
            "10ms" => 10_000_000_000_000,
            "100ms" => 100_000_000_000_000,
            "1s" => 1_000_000_000_000_000,
            _ => {
                // 尝试解析科学计数法格式，如 "1e-15s"
                if let Some(exp) = timescale.strip_prefix("1e") {
                    if let Some(exp) = exp.strip_suffix('s') {
                        if let Ok(exp) = exp.parse::<i32>() {
                            // 1e-15 s = 1 fs
                            let fs_exp = exp + 15; // 转换为以 fs 为单位的指数
                            if fs_exp >= 0 {
                                return 10_u64.pow(fs_exp as u32);
                            }
                        }
                    }
                }
                // 默认返回 1000 (1ps)
                warn!("未知的时间单位格式: {}, 默认使用 1ps", timescale);
                1_000
            }
        }
    }

    /// 使用 fstapi 批量读取多个信号数据（优化版本）
    ///
    /// 使用 SignalHandleCache 缓存信号 handle，避免重复遍历 vars
    /// 一次 FST 文件遍历读取所有信号数据
    async fn read_signals_data_fstapi(
        &self,
        wave_path: &PathBuf,
        signal_names: &[String],
        lod: LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<Vec<SignalWaveData>> {
        let path_str = wave_path.to_string_lossy().to_string();
        let signal_names: Vec<String> = signal_names.to_vec();
        let cache = self.signal_cache.clone();

        // 使用 spawn_blocking 避免阻塞异步运行时
        let signal_data_list = tokio::task::spawn_blocking(move || {
            info!("正在使用 fstapi 批量读取信号数据: {}, signals={:?}", path_str, signal_names);

            let mut reader = fstapi::Reader::open(&path_str)
                .map_err(|e| {
                    error!("无法打开 FST 文件 {}: {}", path_str, e);
                    ServerError::Internal(format!("无法打开 FST 文件: {}", e))
                })?;

            // 检查缓存中已有的信号 handle
            let mut cached_signals: Vec<(String, Handle, u16)> = Vec::new();
            let mut uncached_signal_names: Vec<String> = Vec::new();

            for signal_name in &signal_names {
                // 尝试从缓存获取
                if let Some((handle, width)) = futures::executor::block_on(cache.get(&path_str, signal_name)) {
                    info!("从缓存找到信号: {} (handle={:?}, width={})", signal_name, handle, width);
                    cached_signals.push((signal_name.clone(), handle, width));
                } else {
                    uncached_signal_names.push(signal_name.clone());
                }
            }

            // 如果有未缓存的信号，遍历 vars 查找
            let mut found_signals: Vec<(String, Handle, u16)> = Vec::new();
            if !uncached_signal_names.is_empty() {
                info!("需要查找 {} 个未缓存的信号", uncached_signal_names.len());
                
                for var_result in reader.vars() {
                    let (name, var) = var_result
                        .map_err(|e| ServerError::Internal(format!("读取变量失败: {}", e)))?;

                    if uncached_signal_names.contains(&name) {
                        let handle = var.handle();
                        let width = var.length() as u16;
                        info!("找到信号: {} (handle={:?}, width={}), 加入缓存", name, handle, width);
                        
                        // 加入缓存
                        futures::executor::block_on(cache.put(&path_str, name.clone(), handle, width));
                        
                        found_signals.push((name, handle, width));
                        
                        // 如果所有信号都找到了，提前退出
                        if found_signals.len() == uncached_signal_names.len() {
                            break;
                        }
                    }
                }
            }

            // 合并缓存和找到的信号
            let all_signals: Vec<(String, Handle, u16)> = cached_signals.into_iter()
                .chain(found_signals.into_iter())
                .collect();

            if all_signals.len() != signal_names.len() {
                let found_names: std::collections::HashSet<_> = all_signals.iter()
                    .map(|(name, _, _)| name.clone())
                    .collect();
                let missing: Vec<_> = signal_names.iter()
                    .filter(|name| !found_names.contains(*name))
                    .collect();
                return Err(ServerError::SignalNotFound(format!("未找到信号: {:?}", missing)));
            }

            // 设置 mask 读取所有信号
            for (_, handle, _) in &all_signals {
                reader.set_mask(*handle);
            }

            // 初始化所有信号的数据结构
            let mut signals_data: std::collections::HashMap<Handle, SignalWaveData> = std::collections::HashMap::new();
            for (name, handle, width) in &all_signals {
                let signal_data = SignalWaveData::new((*handle).into(), *width, SignalValueType::Numeric);
                signals_data.insert(*handle, signal_data);
                info!("初始化信号数据结构: {} (handle={:?}, width={})", name, handle, width);
            }

            // 读取完整数据
            let mut full_signals_data: std::collections::HashMap<Handle, SignalWaveData> = std::collections::HashMap::new();
            for (name, handle, width) in &all_signals {
                let signal_data = SignalWaveData::new((*handle).into(), *width, SignalValueType::Numeric);
                full_signals_data.insert(*handle, signal_data);
            }
            
            reader.for_each_block(|time, h, value, _var_len| {
                if let Some(signal_data) = full_signals_data.get_mut(&h) {
                    // 调试：打印前几个值的原始数据
                    if signal_data.transitions.len() < 5 {
                        info!("FST原始数据: handle={:?}, time={}, value={:?}, len={}", 
                            h, time, value, value.len());
                    }
                    let transition = Transition::from_fst(time, value, SignalValueType::Numeric);
                    if signal_data.transitions.len() < 5 {
                        info!("解析后: time={}, value={:?}", transition.time, transition.value);
                    }
                    signal_data.add_transition(transition);
                }
            }).map_err(|e| ServerError::Internal(format!("读取完整波形数据失败: {:?}", e)))?;

            info!("读取到完整数据: {:?}", full_signals_data.iter()
                .map(|(h, d)| format!("handle={:?}, transitions={}", h, d.transitions.len()))
                .collect::<Vec<_>>());

            // 使用优化方法批量搜索边界值
            let config = LodConfig::default();
            let mut result: Vec<SignalWaveData> = Vec::new();
            
            // 准备信号数据映射和宽度映射
            let signal_data_map: std::collections::HashMap<Handle, &SignalWaveData> = all_signals.iter()
                .map(|(_, handle, _)| (*handle, full_signals_data.get(handle).unwrap()))
                .collect();
            
            let widths: std::collections::HashMap<Handle, u16> = all_signals.iter()
                .map(|(_, handle, width)| (*handle, *width))
                .collect();
            
            // 获取波形结束时间
            let wave_end = full_signals_data.values()
                .filter_map(|d| d.transitions.last())
                .map(|t| t.time)
                .max()
                .unwrap_or(time_end);

            // 计算对齐后的起始地址（按 LoD bucket size 对齐）
            let bucket_size = lod.bucket_size() as u64;
            let aligned_start = (time_start / bucket_size) * bucket_size;
            info!("原始起始={}, 对齐后起始={}, bucket_size={}", time_start, aligned_start, bucket_size);
            
            // 批量搜索 Start Value
            let start_values = search_boundary_values_optimized(
                &signal_data_map,
                time_start,
                SearchDirection::Forward,
                wave_end,
                &widths,
            );
            
            for (name, handle, _) in all_signals {
                let full_data = full_signals_data.get(&handle).unwrap();
                let mut signal_data = SignalWaveData::new(handle.into(), full_data.width, full_data.value_type);

                // 过滤时间范围内的 transitions（从对齐后的起始地址开始）
                // 统一规则：bucket 范围是 [aligned_start + bucket_idx * bucket_size, aligned_start + (bucket_idx + 1) * bucket_size - 1]
                // 所以 time_end 不包含在内
                for trans in &full_data.transitions {
                    if trans.time >= aligned_start && trans.time < time_end {
                        signal_data.add_transition(trans.clone());
                    }
                }

                // 获取 Start Value
                let start_value = start_values.get(&handle)
                    .and_then(|v| v.clone())
                    .unwrap_or_else(|| {
                        let width = widths.get(&handle).copied().unwrap_or(1);
                        if width == 1 {
                            SignalValue::Numeric("X".to_string())
                        } else {
                            SignalValue::Numeric(format!("b{}", "X".repeat(width as usize)))
                        }
                    });
                
                info!("信号 {} 时间范围内数据: {} transitions, start={:?}", 
                    name, signal_data.transitions.len(), start_value);

                // 生成 LoD 数据（使用对齐后的时间范围）
                // 注意：start_value 不放入 bucket 计算，只作为 BOUNDARY_TIME_START 输出
                let mut lod_data = LodPyramidGenerator::new(config.clone())
                    .generate_level_with_range(&signal_data, lod, aligned_start, time_end);
                info!("信号 {} 生成 LoD {} 数据: {} transitions", name, lod.0, lod_data.transitions.len());
                
                // 在 LoD 数据开头添加 Start Value（始终添加）
                lod_data.transitions.insert(0, Transition {
                    time: ChunkSerializer::BOUNDARY_TIME_START,
                    value: start_value,
                });
                info!("信号 {} 添加 Start Value 到 LoD 数据", name);
                
                result.push(lod_data);
            }

            Ok::<_, ServerError>(result)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(signal_data_list)
    }

    /// 使用 fstapi 批量读取多个 tile 的信号数据
    ///
    /// 优化点：
    /// 1. 只打开一次 FST 文件
    /// 2. 按时间顺序处理 tiles，利用连续性
    /// 3. Tile N+1 的起始边界值可以从 Tile N 的结束值获取
    async fn read_signals_data_tiles_fstapi(
        &self,
        wave_path: &PathBuf,
        signal_names: &[String],
        lod: LodLevel,
        start_time: u64,
        tile_span: u64,
        num_tiles: usize,
    ) -> Result<Vec<Vec<SignalWaveData>>> {
        let path_str = wave_path.to_string_lossy().to_string();
        let wave_path_clone = wave_path.clone();
        let signal_names: Vec<String> = signal_names.to_vec();
        let cache = self.signal_cache.clone();

        // 使用 spawn_blocking 避免阻塞异步运行时
        let tiles_data = tokio::task::spawn_blocking(move || {
            info!("正在使用 fstapi 批量读取 {} 个 tiles: {}, signals={:?}", num_tiles, path_str, signal_names);

            let mut reader = fstapi::Reader::open(&path_str)
                .map_err(|e| {
                    error!("无法打开 FST 文件 {}: {}", path_str, e);
                    ServerError::Internal(format!("无法打开 FST 文件: {}", e))
                })?;

            // 步骤 1: 获取所有信号的 handles（使用缓存）
            let mut signal_handles: Vec<(String, Handle, u16)> = Vec::new();
            
            for signal_name in &signal_names {
                // 尝试从缓存获取
                if let Some((handle, width)) = futures::executor::block_on(cache.get(&path_str, signal_name)) {
                    info!("从缓存找到信号: {} (handle={:?}, width={})", signal_name, handle, width);
                    signal_handles.push((signal_name.clone(), handle, width));
                }
            }

            // 查找未缓存的信号
            let cached_names: std::collections::HashSet<_> = signal_handles.iter()
                .map(|(name, _, _)| name.clone())
                .collect();
            let uncached_names: Vec<_> = signal_names.iter()
                .filter(|name| !cached_names.contains(*name))
                .cloned()
                .collect();

            if !uncached_names.is_empty() {
                info!("需要查找 {} 个未缓存的信号", uncached_names.len());
                for var_result in reader.vars() {
                    let (name, var) = var_result
                        .map_err(|e| ServerError::Internal(format!("读取变量失败: {}", e)))?;

                    if uncached_names.contains(&name) {
                        let handle = var.handle();
                        let width = var.length() as u16;
                        info!("找到信号: {} (handle={:?}, width={}), 加入缓存", name, handle, width);
                        
                        futures::executor::block_on(cache.put(&path_str, name.clone(), handle, width));
                        signal_handles.push((name, handle, width));

                        if signal_handles.len() == signal_names.len() {
                            break;
                        }
                    }
                }
            }

            if signal_handles.len() != signal_names.len() {
                let found_names: std::collections::HashSet<_> = signal_handles.iter()
                    .map(|(name, _, _)| name.clone())
                    .collect();
                let missing: Vec<_> = signal_names.iter()
                    .filter(|name| !found_names.contains(*name))
                    .collect();
                return Err(ServerError::SignalNotFound(format!("未找到信号: {:?}", missing)));
            }

            // 按原始请求顺序重新排序 signal_handles
            let signal_handles_map: std::collections::HashMap<String, (Handle, u16)> = signal_handles
                .into_iter()
                .map(|(name, handle, width)| (name, (handle, width)))
                .collect();
            
            signal_handles = signal_names
                .iter()
                .filter_map(|name| {
                    signal_handles_map.get(name).map(|(handle, width)| {
                        (name.clone(), *handle, *width)
                    })
                })
                .collect();

            // 步骤 2: 设置所有信号的 mask
            for (_, handle, _) in &signal_handles {
                reader.set_mask(*handle);
            }

            // 步骤 3: 读取完整数据（用于边界值）
            let mut full_signals_data: std::collections::HashMap<Handle, SignalWaveData> = 
                std::collections::HashMap::new();
            for (name, handle, width) in &signal_handles {
                let signal_data = SignalWaveData::new((*handle).into(), *width, SignalValueType::Numeric);
                full_signals_data.insert(*handle, signal_data);
            }

            reader.for_each_block(|time, h, value, _var_len| {
                if let Some(signal_data) = full_signals_data.get_mut(&h) {
                    let transition = Transition::from_fst(time, value, SignalValueType::Numeric);
                    signal_data.add_transition(transition);
                }
            }).map_err(|e| ServerError::Internal(format!("读取完整波形数据失败: {:?}", e)))?;

            info!("读取到完整数据: {} signals, {} total transitions", 
                full_signals_data.len(),
                full_signals_data.values().map(|d| d.transitions.len()).sum::<usize>()
            );

            // 准备信号数据映射和宽度映射
            let signal_data_map: std::collections::HashMap<Handle, &SignalWaveData> = signal_handles.iter()
                .map(|(_, handle, _)| (*handle, full_signals_data.get(handle).unwrap()))
                .collect();
            
            let widths: std::collections::HashMap<Handle, u16> = signal_handles.iter()
                .map(|(_, handle, width)| (*handle, *width))
                .collect();
            
            // 获取波形结束时间
            let wave_end = full_signals_data.values()
                .filter_map(|d| d.transitions.last())
                .map(|t| t.time)
                .max()
                .unwrap_or(start_time + tile_span * num_tiles as u64);

            // 步骤 4: 按 tile 分割数据
            let config = LodConfig::default();
            let mut tiles_result: Vec<Vec<SignalWaveData>> = Vec::with_capacity(num_tiles);
            
            // 判断是否使用优化算法（LoD > 15）
            // 暂时禁用优化算法，直接使用常规算法
            let use_optimized = false; // lod.0 > 15;
            info!("LoD={}, lod.0={}, use_optimized={}", lod.0, lod.0, use_optimized);
            
            if use_optimized {
                // 优化模式：使用 search_bucket_first_last_from_fst
                info!("使用优化算法：LoD {} > 15", lod.0);
                
                // 获取 bucket 大小
                let bucket_size = lod.bucket_size() as u64;
                
                for tile_idx in 0..num_tiles {
                    let tile_start = start_time + tile_span * tile_idx as u64;
                    let tile_end = tile_start + tile_span;
                    
                    info!("处理 Tile {}: time={}-{}", tile_idx, tile_start, tile_end);
                    
                    // 计算该 tile 内的 bucket 数量
                    let num_buckets = (tile_span / bucket_size) as usize;
                    
                    // 获取 handles 列表
                    let handles: Vec<Handle> = signal_handles.iter().map(|(_, h, _)| *h).collect();
                    
                    // 搜索 Start Value（tile_start 之前的最后一个值）
                    let start_values = search_boundary_values_optimized(
                        &signal_data_map,
                        tile_start,
                        SearchDirection::Forward,
                        wave_end,
                        &widths,
                    );
                    
                    let mut tile_signals: Vec<SignalWaveData> = Vec::with_capacity(signal_handles.len());
                    
                    for (name, handle, width) in &signal_handles {
                        // 获取 Start Value
                        let start_value = start_values.get(handle)
                            .and_then(|v| v.clone())
                            .unwrap_or_else(|| {
                                if *width == 1 {
                                    SignalValue::Numeric("X".to_string())
                                } else {
                                    SignalValue::Numeric(format!("b{}", "X".repeat(*width as usize)))
                                }
                            });
                        
                        // 创建 LoD 数据结构
                        let mut lod_data = SignalWaveData::new((*handle).into(), *width, SignalValueType::Numeric);
                        
                        // 添加 Start Value
                        lod_data.add_transition(Transition {
                            time: ChunkSerializer::BOUNDARY_TIME_START,
                            value: start_value.clone(),
                        });
                        
                        // 对每个 bucket 搜索 first 和 last
                        for bucket_idx in 0..num_buckets {
                            let bucket_start = tile_start + bucket_idx as u64 * bucket_size;
                            let bucket_end = bucket_start + bucket_size;
                            
                            // 使用 search_bucket_first_last_from_fst 搜索
                            // 传递 wave_path_clone，函数内部会重新打开 reader
                            let bucket_results = search_bucket_first_last_from_fst(
                                &wave_path_clone,
                                &[*handle],
                                bucket_start,
                                bucket_end,
                            );
                            
                            if let Some((first, last)) = bucket_results.get(handle) {
                                // 添加 first
                                if let Some(f) = first {
                                    info!("Bucket {}: first={:?}, last={:?}, equal={}", bucket_idx, f, last, last.as_ref().map(|l| f == l).unwrap_or(false));
                                    lod_data.add_transition(Transition {
                                        time: bucket_idx as u64,
                                        value: f.clone(),
                                    });
                                    
                                    // 如果有 last 且不同于 first，添加 last（与普通算法一致）
                                    if let Some(l) = last {
                                        if f != l {
                                            info!("Bucket {}: adding last because f != l", bucket_idx);
                                            lod_data.add_transition(Transition {
                                                time: bucket_idx as u64,
                                                value: l.clone(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                        
                        info!("Tile {} 信号 {}: 生成 LoD {} 数据: {} transitions", tile_idx, name, lod.0, lod_data.transitions.len());
                        
                        tile_signals.push(lod_data);
                    }
                    
                    tiles_result.push(tile_signals);
                }
            } else {
                // 常规模式：读取完整数据后处理
                info!("使用常规算法：LoD {} <= 15", lod.0);
                
                for tile_idx in 0..num_tiles {
                    let tile_start = start_time + tile_span * tile_idx as u64;
                    let tile_end = tile_start + tile_span;
                    
                    info!("处理 Tile {}: time={}-{}", tile_idx, tile_start, tile_end);

                    // 计算对齐后的起始地址（按 LoD bucket size 对齐）
                    let bucket_size = lod.bucket_size() as u64;
                    let aligned_start = (tile_start / bucket_size) * bucket_size;
                    info!("Tile {}: 原始起始={}, 对齐后起始={}, bucket_size={}", tile_idx, tile_start, aligned_start, bucket_size);

                    // 批量搜索 Start Value
                    let start_values = search_boundary_values_optimized(
                        &signal_data_map,
                        tile_start,
                        SearchDirection::Forward,
                        wave_end,
                        &widths,
                    );

                    let mut tile_signals: Vec<SignalWaveData> = Vec::with_capacity(signal_handles.len());

                    for (name, handle, width) in &signal_handles {
                        let full_data = full_signals_data.get(handle).unwrap();
                        
                        // 提取时间范围内的 transitions（从对齐后的起始地址开始）
                        let mut tile_signal = SignalWaveData::new((*handle).into(), *width, SignalValueType::Numeric);
                        
                        let mut count = 0;
                        for trans in &full_data.transitions {
                            if trans.time >= aligned_start && trans.time <= tile_end {
                                tile_signal.add_transition(trans.clone());
                                count += 1;
                            }
                        }
                        
                        info!("Tile {} 信号 {}: 从完整数据中提取了 {} 个 transitions", tile_idx, name, count);

                        // 获取 Start Value
                        let start_value = start_values.get(handle)
                            .and_then(|v| v.clone())
                            .unwrap_or_else(|| {
                                if *width == 1 {
                                    SignalValue::Numeric("X".to_string())
                                } else {
                                    SignalValue::Numeric(format!("b{}", "X".repeat(*width as usize)))
                                }
                            });

                        // 生成 LoD 数据（使用对齐后的时间范围）
                        // 注意：start_value 不参与 bucket 计算，只在最后作为 BOUNDARY_TIME_START 输出
                        let mut lod_data = LodPyramidGenerator::new(config.clone())
                            .generate_level_with_range(&tile_signal, lod, aligned_start, tile_end);
                        info!("Tile {} 信号 {}: 生成 LoD {} 数据: {} transitions", tile_idx, name, lod.0, lod_data.transitions.len());
                        
                        // 在 LoD 数据开头添加 Start Value（始终添加，时间为 BOUNDARY_TIME_START）
                        // Start Value 不参与 bucket 计算，只是作为 tile 起始点的参考值
                        lod_data.transitions.insert(0, Transition {
                            time: ChunkSerializer::BOUNDARY_TIME_START,
                            value: start_value,
                        });
                        info!("Tile {} 信号 {}: 添加 Start Value 到 LoD 数据", tile_idx, name);
                        
                        tile_signals.push(lod_data);
                    }

                    tiles_result.push(tile_signals);
                }
            }

            Ok::<_, ServerError>(tiles_result)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(tiles_data)
    }

    /// 使用 fstapi 读取信号数据（返回 SignalWaveData）
    async fn read_signal_data_fstapi(
        &self,
        wave_path: &PathBuf,
        signal_name: &str,
        lod: LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<SignalWaveData> {
        let path_str = wave_path.to_string_lossy().to_string();
        let signal_name = signal_name.to_string();

        // 使用 spawn_blocking 避免阻塞异步运行时
        let signal_data = tokio::task::spawn_blocking(move || {
            info!("正在使用 fstapi 读取信号数据: {}, signal={}", path_str, signal_name);

            let mut reader = fstapi::Reader::open(&path_str)
                .map_err(|e| {
                    error!("无法打开 FST 文件 {}: {}", path_str, e);
                    ServerError::Internal(format!("无法打开 FST 文件: {}", e))
                })?;

            // 查找信号
            let mut signal_handle = None;
            let mut signal_width = 1u16;

            for var_result in reader.vars() {
                let (name, var) = var_result
                    .map_err(|e| ServerError::Internal(format!("读取变量失败: {}", e)))?;

                if name == signal_name {
                    signal_handle = Some(var.handle());
                    signal_width = var.length() as u16;
                    break;
                }
            }

            let handle = signal_handle.ok_or_else(|| {
                ServerError::SignalNotFound(signal_name.clone())
            })?;

            info!("找到信号: {} (handle={:?}, width={})", signal_name, handle, signal_width);

            // 读取信号波形数据（使用 Numeric 类型）
            let mut signal_data = SignalWaveData::new(handle.into(), signal_width, SignalValueType::Numeric);

            // 设置 mask 只读取目标信号
            reader.set_mask(handle);

            // 首先读取完整数据以获取边界值（用于 LoD 0 或空数据情况）
            let mut full_signal_data = SignalWaveData::new(handle.into(), signal_width, SignalValueType::Numeric);
            reader.for_each_block(|time, h, value, _var_len| {
                if h == handle {
                    let transition = Transition::from_fst(time, value, SignalValueType::Numeric);
                    full_signal_data.add_transition(transition);
                }
            }).map_err(|e| ServerError::Internal(format!("读取完整波形数据失败: {:?}", e)))?;

            info!("读取到 {} 个完整转换点", full_signal_data.transitions.len());

            // 然后读取时间范围内的数据
            reader.set_time_range_limit(time_start, time_end);
            let mut transition_count = 0u64;
            reader.for_each_block(|time, h, value, _var_len| {
                if h == handle {
                    let transition = Transition::from_fst(time, value, SignalValueType::Numeric);
                    signal_data.add_transition(transition);
                    transition_count += 1;
                }
            }).map_err(|e| ServerError::Internal(format!("读取波形数据失败: {:?}", e)))?;

            info!("读取到 {} 个时间范围内转换点", transition_count);

            // 如果时间范围内没有数据，使用完整数据的边界值
            if signal_data.transitions.is_empty() {
                if let Some(boundary_trans) = full_signal_data.value_at(time_start) {
                    signal_data.add_transition(Transition {
                        time: time_start,
                        value: boundary_trans.value.clone(),
                    });
                    info!("添加边界值: time={}, value={:?}", time_start, boundary_trans.value);
                }
            }

            // 生成 LoD 数据
            let config = LodConfig::default();
            let lod_data = LodPyramidGenerator::new(config).generate_level(&signal_data, lod);

            info!("生成 LoD {} 数据: {} transitions", lod.0, lod_data.transitions.len());

            Ok::<_, ServerError>(lod_data)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(signal_data)
    }

    /// 使用 fst-reader 读取信号数据（返回 SignalWaveData）
    async fn read_signal_data_fst_reader(
        &self,
        wave_path: &PathBuf,
        signal_name: &str,
        lod: LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<SignalWaveData> {
        use crate::services::fst_backend::{FstReader, create_reader_backend};
        
        let backend = create_reader_backend("fst-reader");
        let signal_data = backend.read_signal_data(
            wave_path,
            signal_name,
            lod,
            time_start,
            time_end,
        ).await?;
        
        Ok(signal_data)
    }

    /// 使用 fst-reader 批量读取多个信号数据（优化版本）
    /// 
    /// 根据 LoD 选择不同的实现策略：
    /// - LoD = 0: 使用 read_signals 读取所有 transitions
    /// - LoD <= 10: 使用流式处理，边读取边计算 bucket first/last
    /// - LoD > 10: 对每个 bucket 单独调用 read_range_boundary_values
    async fn read_signals_data_fst_reader_batch(
        &self,
        wave_path: &PathBuf,
        signal_names: &[String],
        lod: LodLevel,
        time_start: u64,
        num_buckets: usize,
    ) -> Result<Vec<SignalWaveData>> {
        use crate::services::fst_reader_backend::read_signals_data_fst_reader_batch;
        use crate::services::fst_reader_cache::get_fst_reader_cache;
        
        let cache = get_fst_reader_cache();
        read_signals_data_fst_reader_batch(cache, wave_path, signal_names, lod, time_start, num_buckets).await
    }

    /// 使用 fst-reader 批量读取多个 tiles
    async fn read_signals_data_fst_reader_tiles(
        &self,
        wave_path: &PathBuf,
        signal_names: &[String],
        lod: LodLevel,
        start_time: u64,
        tile_span: u64,
        num_tiles: usize,
    ) -> Result<Vec<Vec<SignalWaveData>>> {
        use crate::services::fst_reader_backend::read_signals_data_fst_reader_tiles;
        
        read_signals_data_fst_reader_tiles(wave_path, signal_names, lod, start_time, tile_span, num_tiles).await
    }

    /// 对比 fst-reader 和 fstapi 两个后端返回的数据
    fn compare_signal_data(
        &self,
        signal_names: &[String],
        reader_signals: &[SignalWaveData],
        fstapi_tile: &[SignalWaveData],
        tile_idx: usize,
    ) {
        println!("[COMPARE] ========== 对比测试 tile_idx={} ==========", tile_idx);
        
        for (idx, (sig_name, reader_data)) in signal_names.iter().zip(reader_signals.iter()).enumerate() {
            let fstapi_data = fstapi_tile.get(idx);
            
            println!("[COMPARE] 信号 {}: reader_transitions={}, fstapi_transitions={}",
                sig_name,
                reader_data.transitions.len(),
                fstapi_data.map(|d| d.transitions.len()).unwrap_or(0)
            );
            
            if let Some(fstapi) = fstapi_data {
                // 对比 transition 数量
                if reader_data.transitions.len() != fstapi.transitions.len() {
                    println!("[COMPARE]   ⚠️  transition 数量不匹配: reader={}, fstapi={}",
                        reader_data.transitions.len(),
                        fstapi.transitions.len()
                    );
                }
                
                // 对比每个 transition
                let min_len = reader_data.transitions.len().min(fstapi.transitions.len());
                for i in 0..min_len {
                    let r = &reader_data.transitions[i];
                    let f = &fstapi.transitions[i];
                    
                    let time_match = r.time == f.time;
                    let value_match = match (&r.value, &f.value) {
                        (SignalValue::Numeric(rv), SignalValue::Numeric(fv)) => rv == fv,
                        (SignalValue::Real(rv), SignalValue::Real(fv)) => (rv - fv).abs() < 0.0001,
                        _ => false,
                    };
                    
                    if !time_match || !value_match {
                        println!("[COMPARE]   ⚠️  transition[{}] 不匹配: reader(time={}, value={:?}) vs fstapi(time={}, value={:?})",
                            i, r.time, r.value, f.time, f.value
                        );
                    } else {
                        println!("[COMPARE]   ✓  transition[{}]: time={}, value={:?}",
                            i, r.time, r.value
                        );
                    }
                }
                
                // 显示多余的 transitions
                if reader_data.transitions.len() > min_len {
                    for i in min_len..reader_data.transitions.len() {
                        println!("[COMPARE]   ⚠️  reader 多余 transition[{}]: time={}, value={:?}",
                            i, reader_data.transitions[i].time, reader_data.transitions[i].value
                        );
                    }
                }
                if fstapi.transitions.len() > min_len {
                    for i in min_len..fstapi.transitions.len() {
                        println!("[COMPARE]   ⚠️  fstapi 多余 transition[{}]: time={}, value={:?}",
                            i, fstapi.transitions[i].time, fstapi.transitions[i].value
                        );
                    }
                }
            } else {
                println!("[COMPARE]   ⚠️  fstapi 中没有找到信号 {}", sig_name);
            }
        }
        
        println!("[COMPARE] ========== 对比测试结束 ==========\n");
    }

    /// 获取波形文件的结束时间
    async fn get_wave_end_time(&self, wave_path: &PathBuf) -> Option<u64> {
        match self.backend {
            FstBackend::FstApi => {
                let path_str = wave_path.to_string_lossy().to_string();
                tokio::task::spawn_blocking(move || {
                    fstapi::Reader::open(&path_str)
                        .ok()
                        .map(|reader| reader.end_time())
                })
                .await
                .ok()
                .flatten()
            }
            FstBackend::FstReader => {
                use crate::services::fst_backend::{FstReader, create_reader_backend};
                
                let backend = create_reader_backend("fst-reader");
                backend.get_file_info(wave_path).await.ok().map(|info| info.end_time)
            }
        }
    }
}

use crate::services::wave_data::LodPyramidGenerator;
