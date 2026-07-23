use clap::Parser;
use std::path::PathBuf;

/// Web-based HDL Analysis Toolkit data server configuration
#[derive(Parser, Debug, Clone)]
#[command(author, version, about, long_about = None)]
pub struct ServerConfig {
    /// Knowledge database (KDB) directory
    #[arg(long, default_value = "./kdb")]
    pub kdb_dir: PathBuf,

    /// Waveform file directory
    #[arg(long, default_value = "./waves")]
    pub wave_dir: PathBuf,

    /// Server port
    #[arg(long, default_value = "8080")]
    pub port: u16,

    /// Bind address
    #[arg(long, default_value = "0.0.0.0")]
    pub host: String,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    pub log_level: String,

    /// Enable CORS
    #[arg(long, default_value = "true")]
    pub enable_cors: bool,

    /// Allowed CORS origins (* for any)
    #[arg(long, default_value = "*")]
    pub cors_origin: String,

    /// Maximum number of concurrent connections
    #[arg(long, default_value = "1000")]
    pub max_connections: usize,

    /// LRU cache capacity (MB)
    #[arg(long, default_value = "512")]
    pub cache_capacity_mb: usize,

    /// Waveform data chunk size (KB)
    #[arg(long, default_value = "64")]
    pub chunk_size_kb: usize,

    /// Enable authentication
    #[arg(long, default_value = "false")]
    pub enable_auth: bool,

    /// Authentication token (required if authentication is enabled)
    #[arg(long)]
    pub auth_token: Option<String>,

    /// Rate limit (requests per second)
    #[arg(long, default_value = "100")]
    pub rate_limit: u64,

    /// FST read backend (fstapi, fst-reader)
    #[arg(long, default_value = "fstapi")]
    pub fst_backend: String,

    /// Web client static file directory (default: ./web; enables the built-in static web service)
    #[arg(long, default_value = "./web")]
    pub web_dir: PathBuf,

    /// Disable the built-in static web client service (served from --web-dir)
    #[arg(long, default_value = "false")]
    pub disable_web: bool,

    /// Clear all caches on startup
    #[arg(long, default_value = "false")]
    pub clear_cache_on_startup: bool,

    /// Enable verbose debug output (only effective when log_level=debug)
    #[arg(long, default_value = "false")]
    pub verbose: bool,

    /// Enable fst-reader vs fstapi comparison test mode
    #[arg(long, default_value = "false")]
    pub compare_test: bool,

    /// Enable LoD 20 dedicated test mode
    #[arg(long, default_value = "false")]
    pub lod20_test: bool,

    /// Enable detailed signal test mode
    #[arg(long, default_value = "false")]
    pub detailed_test: bool,

    /// Optional URL to a .tar.xz archive downloaded and extracted into --data-dir
    /// at startup. After extraction, --kdb-dir/--wave-dir default to
    /// <data-dir>/kdb and <data-dir>/waves (so a bare executable upload can be
    /// run with: --data-url <url> --data-dir <dir>).
    #[arg(long)]
    pub data_url: Option<String>,

    /// Directory the --data-url archive is extracted into (default: ./data)
    #[arg(long, default_value = "./data")]
    pub data_dir: PathBuf,
}

impl ServerConfig {
    /// Validate the configuration
    pub fn validate(&self) -> crate::error::Result<()> {
        use crate::error::{Result, ServerError};

        // Verify kdb_dir exists
        if !self.kdb_dir.exists() {
            return Err(ServerError::ConfigError(format!(
                "KDB directory does not exist: {:?}",
                self.kdb_dir
            )));
        }

        // Verify wave_dir exists
        if !self.wave_dir.exists() {
            return Err(ServerError::ConfigError(format!(
                "Waveform directory does not exist: {:?}",
                self.wave_dir
            )));
        }

        // Verify port
        if self.port == 0 {
            return Err(ServerError::ConfigError(
                "Port number cannot be 0".to_string(),
            ));
        }

        // Verify cache capacity
        if self.cache_capacity_mb == 0 {
            return Err(ServerError::ConfigError(
                "Cache capacity cannot be 0".to_string(),
            ));
        }

        // Verify chunk size
        if self.chunk_size_kb == 0 {
            return Err(ServerError::ConfigError(
                "Chunk size cannot be 0".to_string(),
            ));
        }

        // If authentication is enabled, a token must be provided
        if self.enable_auth && self.auth_token.is_none() {
            return Err(ServerError::ConfigError(
                "Authentication token must be provided when auth is enabled".to_string(),
            ));
        }

        Ok(())
    }

    /// Download and extract the `--data-url` archive (if provided) into
    /// `--data-dir`, then point `kdb_dir`/`wave_dir` at the extracted
    /// `kdb`/`waves` subfolders. No-op when `--data-url` is absent.
    pub async fn prepare_data(&mut self) -> anyhow::Result<()> {
        let url = match self.data_url.clone() {
            Some(u) => u,
            None => return Ok(()),
        };

        let dir = self.data_dir.clone();
        std::fs::create_dir_all(&dir)
            .map_err(|e| anyhow::anyhow!("failed to create data dir {:?}: {}", dir, e))?;

        tracing::info!("Downloading data archive from {} ...", url);
        let resp = reqwest::get(&url)
            .await
            .map_err(|e| anyhow::anyhow!("download request failed: {}", e))?
            .error_for_status()
            .map_err(|e| anyhow::anyhow!("download error: {}", e))?;

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| anyhow::anyhow!("failed to read response body: {}", e))?;

        tracing::info!("Downloaded {} bytes, decompressing .xz ...", bytes.len());
        let mut tar_data = Vec::with_capacity(bytes.len() / 2);
        let mut cursor = std::io::Cursor::new(&bytes[..]);
        lzma_rs::xz_decompress(&mut cursor, &mut tar_data)
            .map_err(|e| anyhow::anyhow!("failed to decompress .xz archive: {:?}", e))?;

        let mut archive = tar::Archive::new(&tar_data[..]);
        archive
            .unpack(&dir)
            .map_err(|e| anyhow::anyhow!("failed to extract tar archive into {:?}: {}", dir, e))?;

        tracing::info!("Extracted data archive into {:?}", dir);
        self.kdb_dir = dir.join("kdb");
        self.wave_dir = dir.join("waves");
        Ok(())
    }

    /// Get the bind address
    pub fn bind_address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// Get the cache capacity in bytes
    pub fn cache_capacity_bytes(&self) -> u64 {
        self.cache_capacity_mb as u64 * 1024 * 1024
    }

    /// Get the chunk size in bytes
    pub fn chunk_size_bytes(&self) -> u64 {
        self.chunk_size_kb as u64 * 1024
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            kdb_dir: PathBuf::from("./kdb"),
            wave_dir: PathBuf::from("./waves"),
            port: 8080,
            host: "0.0.0.0".to_string(),
            log_level: "info".to_string(),
            enable_cors: true,
            cors_origin: "*".to_string(),
            max_connections: 1000,
            cache_capacity_mb: 512,
            chunk_size_kb: 64,
            enable_auth: false,
            auth_token: None,
            rate_limit: 100,
            fst_backend: "fstapi".to_string(),
            web_dir: PathBuf::from("./web"),
            disable_web: false,
            clear_cache_on_startup: false,
            verbose: false,
            compare_test: false,
            lod20_test: false,
            detailed_test: false,
            data_url: None,
            data_dir: PathBuf::from("./data"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = ServerConfig::default();
        assert_eq!(config.port, 8080);
        assert_eq!(config.host, "0.0.0.0");
        assert!(config.enable_cors);
        assert!(!config.enable_auth);
    }

    #[test]
    fn test_bind_address() {
        let config = ServerConfig::default();
        assert_eq!(config.bind_address(), "0.0.0.0:8080");
    }

    #[test]
    fn test_cache_capacity_bytes() {
        let config = ServerConfig::default();
        assert_eq!(config.cache_capacity_bytes(), 512 * 1024 * 1024);
    }
}
