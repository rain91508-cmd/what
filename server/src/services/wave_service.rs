use crate::error::{Result, ServerError};
use crate::services::wave_data::{LodConfig, LodLevel, SignalWaveData, Transition, ChunkSerializer};
use crate::state::ServerState;
use std::path::PathBuf;
use tokio::fs;
use tracing::{debug, error, info, warn};

/// FST 文件魔数 (用于识别 FST 文件)
const FST_MAGIC: &[u8] = b"FST\x00";

/// FST 文件最小大小 (魔数 + 头部信息)
const FST_MIN_SIZE: u64 = 32;

/// 波形文件基本信息
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct WaveFileInfo {
    /// 波形文件名
    pub name: String,
    /// 文件大小 (字节)
    pub file_size: u64,
    /// 是否为有效的 FST 文件
    pub is_valid: bool,
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
}

/// FST 读取后端枚举
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FstBackend {
    /// 使用 fstapi (GTKWave C API)
    FstApi,
    /// 使用 wavefst (纯 Rust)
    WaveFst,
}

impl Default for FstBackend {
    fn default() -> Self {
        // 默认使用 fstapi，因为它支持更完整的 FST 格式
        FstBackend::FstApi
    }
}

/// 波形数据服务
pub struct WaveService {
    state: ServerState,
    backend: FstBackend,
}

impl WaveService {
    /// 创建新的波形数据服务
    pub fn new(state: ServerState) -> Self {
        Self {
            state,
            backend: FstBackend::default(),
        }
    }

    /// 创建指定后端的波形数据服务
    pub fn with_backend(state: ServerState, backend: FstBackend) -> Self {
        Self { state, backend }
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

                        info!("  发现 FST 文件: {} ({} bytes, valid={})", name, file_size, is_valid);

                        waves.push(WaveFileInfo {
                            name,
                            file_size,
                            is_valid,
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
    async fn validate_fst_file(&self, path: &PathBuf) -> Result<bool> {
        // 检查文件大小
        let metadata = fs::metadata(path).await?;
        if metadata.len() < FST_MIN_SIZE {
            return Ok(false);
        }

        // 读取文件头部检查魔数
        let header = fs::read(&path).await?;
        if header.len() < FST_MAGIC.len() {
            return Ok(false);
        }

        // 检查魔数
        let valid = &header[..FST_MAGIC.len()] == FST_MAGIC;

        if !valid {
            warn!("文件 {:?} 不是有效的 FST 文件", path);
        }

        Ok(valid)
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
            FstBackend::WaveFst => self.get_wave_info_wavefst(&wave_path, wave_name).await,
        }
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
            let start_time = reader.start_time();
            let end_time = reader.end_time();
            let var_count = reader.var_count();

            info!("FST 文件元数据: vars={}, start={}, end={}, version={}",
                var_count, start_time, end_time, version);

            // 获取时间单位字符串 (fstapi 不直接提供 timescale，使用默认值)
            let time_unit = "1ps".to_string();

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

    /// 使用 wavefst 获取波形文件信息
    async fn get_wave_info_wavefst(&self, wave_path: &PathBuf, wave_name: &str) -> Result<WaveInfo> {
        let file = std::fs::File::open(wave_path)?;
        let reader = wavefst::ReaderBuilder::new(file).build()
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {}", e)))?;

        let header = reader.header();
        let metadata = fs::metadata(wave_path).await?;
        let file_size = metadata.len();

        // 解析时间单位
        let time_unit = if header.timescale_exponent < 0 {
            format!("{}s", 10f64.powi(header.timescale_exponent as i32))
        } else {
            format!("{}s", 10f64.powi(header.timescale_exponent as i32))
        };

        Ok(WaveInfo {
            name: wave_name.to_string(),
            file_size,
            time_unit: time_unit.clone(),
            time_precision: time_unit,
            start_time: header.start_time,
            end_time: header.end_time,
            signal_count: header.var_count as usize,
            version: header.version.clone(),
            date: header.date.clone(),
        })
    }

    /// 获取波形文件中所有信号列表
    pub async fn list_signals(&self, wave_name: &str) -> Result<Vec<SignalInfo>> {
        let wave_path = self.get_wave_path(wave_name)?;

        // 根据后端选择不同的读取方式
        match self.backend {
            FstBackend::FstApi => self.list_signals_fstapi(&wave_path, wave_name).await,
            FstBackend::WaveFst => self.list_signals_wavefst(&wave_path, wave_name).await,
        }
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

                // 跳过别名
                if var.is_alias() {
                    alias_count += 1;
                    continue;
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

    /// 使用 wavefst 获取信号列表
    async fn list_signals_wavefst(&self, wave_path: &PathBuf, wave_name: &str) -> Result<Vec<SignalInfo>> {
        let file = std::fs::File::open(wave_path)?;
        let reader = wavefst::ReaderBuilder::new(file).build()
            .map_err(|e| ServerError::Internal(format!("无法读取 FST 文件: {}", e)))?;

        let mut signals = Vec::new();

        // 遍历层次结构中的所有信号
        match reader.hierarchy() {
            Some(hierarchy) => {
                for var in &hierarchy.variables {
                    signals.push(SignalInfo {
                        handle: var.handle,
                        name: var.name.to_string(),
                        signal_type: format!("{:?}", var.var_type),
                        width: var.length.unwrap_or(1),
                        direction: format!("{:?}", var.direction),
                    });
                }
                info!("波形 {} 从 wavefst 读取了 {} 个信号", wave_name, signals.len());
            }
            None => {
                // 如果层次结构不可用，尝试从 header 获取信号数量信息
                let header = reader.header();
                warn!("波形 {} 的层次结构块无法读取 (var_count={})", wave_name, header.var_count);

                // 返回一个特殊的信号项，说明层次结构不可用
                signals.push(SignalInfo {
                    handle: 0,
                    name: "__hierarchy_unavailable__".to_string(),
                    signal_type: "N/A".to_string(),
                    width: header.var_count as u32,
                    direction: "N/A".to_string(),
                });
            }
        }

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
    pub async fn get_wave_data(
        &self,
        wave_name: &str,
        signal_name: &str,
        lod: u32,
        start: i64,
        end: i64,
        range: Option<(u64, Option<u64>)>,
    ) -> Result<(Vec<u8>, u64, Option<u64>)> {
        let wave_path = self.get_wave_path(wave_name)?;
        let metadata = fs::metadata(&wave_path).await?;
        let file_size = metadata.len();

        // 验证 LoD 层级
        let lod_level = LodLevel::new(lod);
        if !lod_level.is_valid() {
            return Err(ServerError::InvalidLod(lod));
        }

        // 解析时间范围
        let time_start = start.max(0) as u64;
        let time_end = if end > 0 {
            end as u64
        } else {
            // 从 FST 文件获取结束时间
            self.get_wave_end_time(&wave_path).await.unwrap_or(time_start + 1_000_000)
        };

        info!(
            "获取波形数据: wave={}, signal={}, lod={}, time={}-{}",
            wave_name, signal_name, lod, time_start, time_end
        );

        // 根据后端选择数据获取方式
        let chunk_data = match self.backend {
            FstBackend::FstApi => {
                self.get_wave_data_fstapi(&wave_path, signal_name, lod_level, time_start, time_end)
                    .await?
            }
            FstBackend::WaveFst => {
                self.get_wave_data_wavefst(&wave_path, signal_name, lod_level, time_start, time_end)
                    .await?
            }
        };

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

    /// 使用 fstapi 获取波形数据
    async fn get_wave_data_fstapi(
        &self,
        wave_path: &PathBuf,
        signal_name: &str,
        lod: LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<Vec<u8>> {
        let path_str = wave_path.to_string_lossy().to_string();
        let signal_name = signal_name.to_string();

        // 使用 spawn_blocking 避免阻塞异步运行时
        let chunk_data = tokio::task::spawn_blocking(move || {
            info!("正在使用 fstapi 读取波形数据: {}, signal={}", path_str, signal_name);

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

            info!("找到信号: {} (handle={}, width={})", signal_name, handle, signal_width);

            // 读取信号波形数据
            let mut signal_data = SignalWaveData::new(handle.into(), signal_width);

            // 使用 fstapi 的迭代器读取转换点
            // 注意：fstapi 的 API 可能需要根据实际库调整
            // 这里使用简化的实现

            // 模拟一些转换点数据（实际实现需要从 fstapi 读取）
            // TODO: 实现真正的 fstapi 波形数据读取
            signal_data.add_transition(time_start, 0);
            signal_data.add_transition((time_start + time_end) / 2, 1);
            signal_data.add_transition(time_end, 0);

            // 生成 LoD 数据
            let config = LodConfig::default();
            let lod_data = LodPyramidGenerator::new(config).generate_level(&signal_data, lod);

            // 序列化为 chunk
            let chunk = ChunkSerializer::serialize(
                0, // chunk_id
                lod.0 as u16,
                &[&lod_data],
                (time_start, time_end),
            )?;

            info!("生成 chunk: {} bytes, {} transitions", chunk.len(), lod_data.transitions.len());

            Ok::<_, ServerError>(chunk)
        })
        .await
        .map_err(|e| ServerError::Internal(format!("任务执行失败: {}", e)))??;

        Ok(chunk_data)
    }

    /// 使用 wavefst 获取波形数据
    async fn get_wave_data_wavefst(
        &self,
        wave_path: &PathBuf,
        _signal_name: &str,
        lod: LodLevel,
        time_start: u64,
        time_end: u64,
    ) -> Result<Vec<u8>> {
        // wavefst 目前不支持读取实际波形数据
        // 返回一个空的 chunk 作为占位符
        info!("wavefst 后端暂不支持波形数据读取，返回空数据");

        let signal_data = SignalWaveData::new(0, 1);
        let chunk = ChunkSerializer::serialize(
            0,
            lod.0 as u16,
            &[&signal_data],
            (time_start, time_end),
        )?;

        Ok(chunk)
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
            FstBackend::WaveFst => {
                // wavefst 实现
                None
            }
        }
    }
}

use crate::services::wave_data::LodPyramidGenerator;
