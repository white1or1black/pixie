// 平台检测和日志增强模块
// 可以添加到 src-tauri/src/engine/builtin/mod.rs 中

use log::info;

/// 获取详细的平台信息并记录到日志
pub fn log_platform_info() {
    info!("[builtin] ========================================");
    info!("[builtin] Platform Information");
    info!("[builtin] ========================================");

    // 操作系统
    info!(
        "[builtin] OS: {}",
        std::env::consts::OS
    );
    info!(
        "[builtin] ARCH: {}",
        std::env::consts::ARCH
    );
    info!(
        "[builtin] FAMILY: {}",
        std::env::consts::FAMILY
    );

    // 编译目标
    if let Ok(target) = std::env::var("TARGET") {
        info!("[builtin] TARGET (compile): {}", target);
    } else {
        info!("[builtin] TARGET (compile): not set (running from source?)");
    }

    // 运行时检测的架构（与编译目标可能不同）
    #[cfg(target_arch = "x86_64")]
    info!("[builtin] Runtime arch: x86_64 (compiled)");

    #[cfg(target_arch = "aarch64")]
    info!("[builtin] Runtime arch: aarch64/ARM64 (compiled)");

    #[cfg(target_arch = "x86")]
    info!("[builtin] Runtime arch: x86 (32-bit, compiled)");

    // 平台特定信息
    if cfg!(target_os = "macos") {
        info!("[builtin] Platform: macOS");
        #[cfg(target_arch = "x86_64")]
        info!("[builtin] ⚠️  macOS x86_64 detected - this platform has reported issues");
        #[cfg(target_arch = "aarch64")]
        info!("[builtin] macOS ARM64 (Apple Silicon) - should work well");
    } else if cfg!(target_os = "linux") {
        info!("[builtin] Platform: Linux");
    } else if cfg!(target_os = "windows") {
        info!("[builtin] Platform: Windows");
    }

    // TLS 后端
    if cfg!(feature = "native-tls") {
        info!("[builtin] TLS backend: native-tls (system TLS)");
    } else if cfg!(feature = "rustls-tls") {
        info!("[builtin] TLS backend: rustls (pure Rust TLS)");
    } else {
        info!("[builtin] TLS backend: default/unknown");
    }

    // 环境变量
    if let Ok(http_proxy) = std::env::var("HTTP_PROXY") {
        info!("[builtin] HTTP_PROXY: {} (set)", if !http_proxy.is_empty() { "yes" } else { "no" });
    }
    if let Ok(https_proxy) = std::env::var("HTTPS_PROXY") {
        info!("[builtin] HTTPS_PROXY: {} (set)", if !https_proxy.is_empty() { "yes" } else { "no" });
    }
    if let Ok(no_proxy) = std::env::var("NO_PROXY") {
        info!("[builtin] NO_PROXY: {} (set)", if !no_proxy.is_empty() { "yes" } else { "no" });
    }

    info!("[builtin] ========================================");
}

/// 测试网络连接到 Anthropic API
pub async fn test_anthropic_connection(base_url: &str) -> anyhow::Result<()> {
    use reqwest::Client;

    let test_url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    info!("[builtin] Testing connection to: {}", test_url);

    let client = Client::new();
    let start = std::time::Instant::now();

    // 发送一个简单的请求（不带认证，只是为了测试连接）
    let result = client
        .get(&test_url)
        .header("User-Agent", "pixie-builtin-test/1.0")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;

    let elapsed = start.elapsed();

    match result {
        Ok(response) => {
            info!("[builtin] ✅ Connection successful");
            info!("[builtin] Status: {}", response.status());
            info!("[builtin] Response time: {}ms", elapsed.as_millis());
            info!("[builtin] Server headers:");
            if let Some(server) = response.headers().get("server") {
                info!("[builtin]   Server: {:?}", server);
            }
            if let Some(date) = response.headers().get("date") {
                info!("[builtin]   Date: {:?}", date);
            }
            Ok(())
        }
        Err(e) => {
            info!("[builtin] ❌ Connection failed");
            info!("[builtin] Error: {}", e);
            info!("[builtin] Error kind: {:?}", e.kind());

            // 提供诊断建议
            if e.is_timeout() {
                info!("[builtin] ⚠️  Request timed out - check network connectivity");
            } else if e.is_connect() {
                info!("[builtin] ⚠️  Connection failed - possible DNS or firewall issue");
            } else if reqwest::Error::is_tls(e) {
                info!("[builtin] ⚠️  TLS/SSL error - possible certificate issue");
            }

            anyhow::bail!("Connection test failed: {}", e);
        }
    }
}

/// 在内置引擎初始化时调用这些函数
/// 在 src-tauri/src/engine/builtin/mod.rs 的 BuiltinSession::new 中添加：

/*
pub fn new(
    session_id: &str,
    model: Option<&str>,
    system_prompt: Option<&str>,
    cwd: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> Self {
    // 添加平台信息日志
    log_platform_info();

    let model_pattern = model.map(str::to_string).unwrap_or_else(get_model);
    let resolved = resolve_builtin_model(Some(&model_pattern), base_url);

    // 添加连接测试（可选，仅在首次启动时）
    let base_for_test = resolved.base_url.clone();
    tokio::spawn(async move {
        if let Err(e) = test_anthropic_connection(&base_for_test).await {
            log::error!("[builtin] Anthropic API connection test failed: {}", e);
        }
    });

    // ... 其余现有代码 ...
}
*/
