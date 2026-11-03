//! Managed local adapters. Trae credentials stay on disk; CommandCode uses each provider's standard API key.
use serde::{Deserialize, Serialize};
use std::{process::Stdio, sync::LazyLock};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

struct Adapter {
    child: Child,
    key: String,
    models: Vec<String>,
}
static ADAPTER: LazyLock<Mutex<Option<Adapter>>> = LazyLock::new(|| Mutex::new(None));
static COMMANDCODE_ADAPTER: LazyLock<Mutex<Option<Adapter>>> = LazyLock::new(|| Mutex::new(None));

struct AdapterConfig {
    name: &'static str,
    port: u16,
    state: &'static Mutex<Option<Adapter>>,
}
fn adapter_config(kind: &str) -> Result<AdapterConfig, String> {
    match kind {
        "trae" => Ok(AdapterConfig {
            name: "Trae",
            port: 18788,
            state: &ADAPTER,
        }),
        "commandcode" => Ok(AdapterConfig {
            name: "CommandCode",
            port: 18789,
            state: &COMMANDCODE_ADAPTER,
        }),
        _ => Err("Unknown local adapter".into()),
    }
}

#[derive(Serialize)]
pub struct AdapterStatus {
    running: bool,
    models: Vec<String>,
}

#[tauri::command]
pub async fn local_adapter_status(kind: String) -> Result<AdapterStatus, String> {
    let mut guard = adapter_config(&kind)?.state.lock().await;
    if let Some(adapter) = guard.as_mut() {
        if adapter
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(AdapterStatus {
                running: true,
                models: adapter.models.clone(),
            });
        }
    }
    *guard = None;
    Ok(AdapterStatus {
        running: false,
        models: vec![],
    })
}

#[tauri::command]
pub async fn local_adapter_start(
    app: tauri::AppHandle,
    kind: String,
    node_path: String,
    product_path: String,
    proxy: String,
) -> Result<AdapterStatus, String> {
    let config = adapter_config(&kind)?;
    let mut guard = config.state.lock().await;
    if let Some(adapter) = guard.as_mut() {
        if adapter
            .child
            .try_wait()
            .map_err(|e| e.to_string())?
            .is_none()
        {
            return Ok(AdapterStatus {
                running: true,
                models: adapter.models.clone(),
            });
        }
    }
    *guard = None;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(&kind);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let key_path = data.join("local-api-key");
    let key = match std::fs::read_to_string(&key_path) {
        Ok(key) if key.trim().len() >= 32 => key.trim().to_string(),
        Ok(_) => return Err("Invalid local adapter API key file".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            std::fs::write(&key_path, &key).map_err(|e| e.to_string())?;
            key
        }
        Err(e) => return Err(e.to_string()),
    };
    let bundled_script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join(format!("{kind}-adapter/server.mjs"));
    let script = if bundled_script.is_file() {
        bundled_script
    } else if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../{kind}-adapter/server.mjs"))
    } else {
        return Err(format!("Missing bundled {kind}-adapter/server.mjs"));
    };
    // Tauri canonicalizes resources to \\?\ paths. Node 24's entry-point
    // resolver fails on those (EISDIR at the drive root); use a normal path.
    #[cfg(windows)]
    let script = {
        let raw = script.to_string_lossy();
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            std::path::PathBuf::from(format!(r"\\{unc}"))
        } else {
            std::path::PathBuf::from(raw.strip_prefix(r"\\?\").unwrap_or(&raw))
        }
    };
    let mut command = Command::new(if node_path.trim().is_empty() {
        "node"
    } else {
        node_path.trim()
    });
    command
        .arg(script)
        .env("CC_TRAE_KEY", &key)
        .env("CC_TRAE_MANAGED", "1")
        .env("CC_TRAE_PORT", config.port.to_string())
        .env("NODE_USE_ENV_PROXY", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if !product_path.trim().is_empty() {
        command.env("TRAE_PRODUCT_PATH", product_path.trim());
    }
    if !proxy.trim().is_empty() {
        command.env("HTTPS_PROXY", proxy.trim());
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot launch Node 24: {e}"))?;
    let stdout = child.stdout.take().ok_or("Missing adapter stdout")?;
    let stderr = child.stderr.take().ok_or("Missing adapter stderr")?;
    let diagnostic = tokio::spawn(async move {
        let mut text = String::new();
        let _ = stderr.take(8192).read_to_string(&mut text).await;
        text
    });
    let mut lines = BufReader::new(stdout).lines();
    let line = tokio::time::timeout(std::time::Duration::from_secs(55), lines.next_line())
        .await
        .map_err(|_| "Adapter startup timed out; check proxy and credentials")?
        .map_err(|e| e.to_string())?;
    let line = match line {
        Some(line) => line,
        None => {
            let details = tokio::time::timeout(std::time::Duration::from_secs(2), diagnostic)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
            return Err(format!(
                "{} startup failed (Node >=24, port {}): {details}",
                config.name, config.port
            ));
        }
    };
    let ready: serde_json::Value =
        serde_json::from_str(&line).map_err(|_| "Invalid adapter startup response")?;
    let models: Vec<String> =
        serde_json::from_value(ready["models"].clone()).map_err(|_| "Invalid model directory")?;
    *guard = Some(Adapter {
        child,
        key,
        models: models.clone(),
    });
    Ok(AdapterStatus {
        running: true,
        models,
    })
}

#[tauri::command]
pub async fn local_adapter_stop(kind: String) -> Result<(), String> {
    if let Some(mut adapter) = adapter_config(&kind)?.state.lock().await.take() {
        adapter.child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalAdapterSettings {
    pub node_path: String,
    pub product_path: String,
    pub proxy: String,
}
impl Default for LocalAdapterSettings {
    fn default() -> Self {
        Self {
            node_path: "node".into(),
            product_path: String::new(),
            proxy: String::new(),
        }
    }
}

#[tauri::command]
pub fn local_adapter_settings(
    app: tauri::AppHandle,
    kind: String,
) -> Result<LocalAdapterSettings, String> {
    adapter_config(&kind)?;
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(&kind)
        .join("runtime.json");
    if !file.exists() {
        return Ok(LocalAdapterSettings::default());
    }
    serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedAdapter {
    endpoint: String,
    local_key: Option<String>,
    models: Vec<String>,
}

#[tauri::command]
pub async fn local_adapter_prepare(
    app: tauri::AppHandle,
    kind: String,
    settings: LocalAdapterSettings,
) -> Result<PreparedAdapter, String> {
    let config = adapter_config(&kind)?;
    let old = local_adapter_settings(app.clone(), kind.clone())?;
    if old.node_path != settings.node_path
        || old.product_path != settings.product_path
        || old.proxy != settings.proxy
    {
        local_adapter_stop(kind.clone()).await?;
    }
    let status = local_adapter_start(
        app.clone(),
        kind.clone(),
        settings.node_path.clone(),
        settings.product_path.clone(),
        settings.proxy.clone(),
    )
    .await?;
    let file = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(&kind)
        .join("runtime.json");
    std::fs::write(
        file,
        serde_json::to_vec(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let guard = config.state.lock().await;
    let adapter = guard.as_ref().ok_or("Adapter stopped")?;
    Ok(PreparedAdapter {
        endpoint: format!("http://127.0.0.1:{}/v1", config.port),
        local_key: if kind == "trae" {
            Some(adapter.key.clone())
        } else {
            None
        },
        models: status.models,
    })
}

pub fn restore_local_adapters(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        for kind in ["trae", "commandcode"] {
            let Ok(root) = app.path().app_data_dir() else {
                return;
            };
            if !root.join(kind).join("runtime.json").exists() {
                continue;
            }
            if let Ok(settings) = local_adapter_settings(app.clone(), kind.into()) {
                if local_adapter_start(
                    app.clone(),
                    kind.into(),
                    settings.node_path,
                    settings.product_path,
                    settings.proxy,
                )
                .await
                .is_err()
                {
                    log::warn!(
                        "{} adapter could not start; open its provider form to reconnect",
                        kind
                    );
                }
            }
        }
    });
}
