use clap::Parser;
use what_server::{
    create_router,
    ServerConfig, ServerState,
};
use tower_http::{
    cors::{Any, CorsLayer},
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
    services::ServeDir,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

/// Server entry point
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Parse command-line arguments
    let config = ServerConfig::parse();

    // Validate configuration
    config.validate()?;

    // Initialize logging
    init_logging(&config);

    // Create server state
    let state = ServerState::new(config.clone());

    // Clear caches on startup if requested
    if config.clear_cache_on_startup {
        tracing::info!("Clearing all caches on startup...");
        state.clear_all_caches();
        tracing::info!("All caches cleared");
    }

    // Print startup information (using println to ensure console visibility)
    println!("");
    println!("========================================");
    println!("  Web-based HDL Analysis Toolkit Data Server (WHAT Server)");
    println!("========================================");
    println!("");
    println!("[Server configuration]");
    println!("  Bind address: {}", config.bind_address());
    println!("  Log level: {}", config.log_level);
    println!("  Verbose debug: {}", if config.verbose { "enabled" } else { "disabled" });
    println!("  CORS enabled: {}", config.enable_cors);
    println!("  FST backend: {}", config.fst_backend);

    // Also record to tracing
    tracing::info!("========================================");
    tracing::info!("  Web-based HDL Analysis Toolkit Data Server (WHAT Server)");
    tracing::info!("========================================");
    tracing::info!("");
    tracing::info!("[Server configuration]");
    tracing::info!("  Bind address: {}", config.bind_address());
    tracing::info!("  Log level: {}", config.log_level);
    tracing::info!("  Verbose debug: {}", if config.verbose { "enabled" } else { "disabled" });
    tracing::info!("  CORS enabled: {}", config.enable_cors);
    tracing::info!("  FST backend: {}", config.fst_backend);
    println!("");
    println!("[Data directories]");
    println!("  KDB directory: {:?}", config.kdb_dir);
    println!("  Waveform directory: {:?}", config.wave_dir);

    // Check whether the directories exist
    if config.kdb_dir.exists() {
        let kdb_count = std::fs::read_dir(&config.kdb_dir)
            .map(|entries| entries.filter(|e| {
                e.as_ref().map(|entry| {
                    entry.path().extension().map(|ext| ext == "kdb").unwrap_or(false)
                }).unwrap_or(false)
            }).count())
            .unwrap_or(0);
        println!("    - Found {} KDB file(s)", kdb_count);
    } else {
        println!("    - KDB directory does not exist!");
    }

    if config.wave_dir.exists() {
        let wave_count = std::fs::read_dir(&config.wave_dir)
            .map(|entries| entries.filter(|e| {
                e.as_ref().map(|entry| {
                    entry.path().extension().map(|ext| ext == "fst").unwrap_or(false)
                }).unwrap_or(false)
            }).count())
            .unwrap_or(0);
        println!("    - Found {} FST file(s)", wave_count);
    } else {
        println!("    - Waveform directory does not exist!");
    }

    // If static web service is enabled, record the web directory info
    if !config.disable_web {
        println!("  Web client directory: {:?}", config.web_dir);
        if config.web_dir.exists() {
            println!("    - Directory exists (static web service enabled)");
        } else {
            println!("    - Directory does not exist (static web service will be inactive)");
        }
    } else {
        println!("  Static web service: disabled");
    }

    println!("");
    println!("[Cache configuration]");
    println!("  Cache capacity: {} MB", config.cache_capacity_mb);
    println!("  Data chunk size: {} KB", config.chunk_size_kb);
    println!("");
    println!("========================================");
    println!("  Starting server...");
    println!("========================================");
    println!("");

    // Create CORS layer
    let cors = if config.enable_cors {
        CorsLayer::new()
            .allow_origin(Any) // Production should restrict to specific domains
            .allow_methods(Any)
            .allow_headers(Any)
            .expose_headers([
                axum::http::header::CONTENT_LENGTH,
                axum::http::header::CONTENT_RANGE,
                axum::http::header::ACCEPT_RANGES,
            ])
    } else {
        CorsLayer::new() // Use default CORS configuration
    };

    // Build the API router
    let api_router = create_router(state.clone());

    // Build the full app (optionally including the static file service)
    let app = if !config.disable_web {
        // Static file service is enabled: API routes take priority, and any
        // unmatched path is served from the static web directory.
        api_router
            .fallback_service(ServeDir::new(&config.web_dir))
            .layer(cors)
            .layer(TraceLayer::new_for_http())
            .layer(RequestBodyLimitLayer::new(
                (config.cache_capacity_bytes() / 10) as usize,
            ))
            .with_state(state)
    } else {
        // Static web service disabled: API only
        api_router
            .layer(cors)
            .layer(TraceLayer::new_for_http())
            .layer(RequestBodyLimitLayer::new(
                (config.cache_capacity_bytes() / 10) as usize,
            ))
            .with_state(state)
    };

    // In comparison test mode, run the test and exit without starting the server
    if config.compare_test {
        println!("\n========================================");
        println!("  Comparison test mode: fst-reader vs fstapi");
        println!("========================================\n");

        // Run the comparison test, then exit immediately
        what_server::compare_test::run_compare_test(&config).await;
        println!("\n========================================");
        println!("  Comparison test finished, exiting");
        println!("========================================");
        return Ok(());
    }

    // In LoD 20 test mode
    if config.lod20_test {
        println!("\n========================================");
        println!("  LoD 20 dedicated test mode");
        println!("========================================\n");

        // Run the LoD 20 test, then exit immediately
        what_server::compare_test_lod20::run_lod20_test(&config).await;
        println!("\n========================================");
        println!("  LoD 20 test finished, exiting");
        println!("========================================");
        return Ok(());
    }

    // In detailed signal test mode
    if config.detailed_test {
        println!("\n========================================");
        println!("  Detailed signal test mode");
        println!("========================================\n");

        // Run the detailed signal test, then exit immediately
        what_server::compare_test::run_detailed_signal_test(&config).await;
        println!("\n========================================");
        println!("  Detailed signal test finished, exiting");
        println!("========================================");
        return Ok(());
    }

    // Start the server
    let listener = tokio::net::TcpListener::bind(&config.bind_address()).await?;
    tracing::info!("Server listening on {}", config.bind_address());

    axum::serve(listener, app).await?;

    Ok(())
}

/// Initialize the logging system
fn init_logging(config: &ServerConfig) {
    // Set the log filter based on log_level and verbose options
    let filter = if config.log_level == "debug" && config.verbose {
        // Verbose mode: show all debug information
        format!("{}=debug,tower_http=debug", env!("CARGO_PKG_NAME"))
    } else {
        // Normal mode: show info and above
        format!("{}=info,tower_http=info", env!("CARGO_PKG_NAME"))
    };

    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| filter.into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();
}
