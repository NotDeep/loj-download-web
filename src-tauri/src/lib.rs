use std::fs::{create_dir_all, OpenOptions};
use std::io::{Error as IoError, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct BackendState(Mutex<Option<CommandChild>>);

fn other_error(message: impl Into<String>) -> IoError {
    IoError::new(ErrorKind::Other, message.into())
}

fn resolve_startup_log_path(app: &AppHandle) -> Option<PathBuf> {
    let data_dir = app.path().app_local_data_dir().ok()?;
    let log_dir = data_dir.join("logs");
    create_dir_all(&log_dir).ok()?;
    Some(log_dir.join("startup.log"))
}

fn append_startup_log(log_path: Option<&PathBuf>, message: impl AsRef<str>) {
    let Some(log_path) = log_path else {
        return;
    };

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{timestamp}] {}", message.as_ref());
    }
}

#[cfg(target_os = "windows")]
fn reveal_startup_log(log_path: &Path) {
    let _ = std::process::Command::new("notepad.exe").arg(log_path).spawn();
}

#[cfg(not(target_os = "windows"))]
fn reveal_startup_log(_: &Path) {}

fn select_open_port() -> Result<u16, IoError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn resolve_backend_entry(app: &AppHandle) -> Result<PathBuf, IoError> {
    if cfg!(debug_assertions) {
        return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist/desktop/server-entry.js"));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| other_error(format!("Failed to resolve bundled resource directory: {error}")))?;

    let candidates = [
        resource_dir.join("dist/desktop/server-entry.js"),
        resource_dir.join("_up_/dist/desktop/server-entry.js"),
    ];

    candidates
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
        .ok_or_else(|| {
            other_error(format!(
                "Desktop backend entry does not exist in any expected resource path under {}",
                resource_dir.display()
            ))
        })
}

fn resolve_storage_dir(app: &AppHandle) -> Result<PathBuf, IoError> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| other_error(format!("Failed to resolve desktop data directory: {error}")))?;
    let storage_dir = data_dir.join("storage");
    create_dir_all(&storage_dir)?;
    Ok(storage_dir)
}

fn spawn_backend(app: &AppHandle, port: u16, log_path: Option<PathBuf>) -> Result<CommandChild, IoError> {
    let entry_path = resolve_backend_entry(app)?;
    if !entry_path.exists() {
        return Err(other_error(format!(
            "Desktop backend entry does not exist: {}",
            entry_path.display()
        )));
    }

    let storage_dir = resolve_storage_dir(app)?;
    let args = vec![
        entry_path.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        "--storage-dir".into(),
        storage_dir.to_string_lossy().into_owned(),
        "--retention-hours".into(),
        "24".into(),
    ];

    append_startup_log(
        log_path.as_ref(),
        format!(
            "Launching sidecar with entry={}, storage_dir={}, port={}",
            entry_path.display(),
            storage_dir.display(),
            port
        ),
    );

    let (mut receiver, child) = app
        .shell()
        .sidecar("loj-download-node")
        .map_err(|error| other_error(format!("Failed to prepare Node sidecar: {error}")))?
        .args(args)
        .spawn()
        .map_err(|error| other_error(format!("Failed to spawn Node sidecar: {error}")))?;

    let event_log_path = log_path.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let message = String::from_utf8_lossy(&line).trim().to_string();
                    println!("[desktop-backend] {message}");
                    append_startup_log(event_log_path.as_ref(), format!("[stdout] {message}"));
                }
                CommandEvent::Stderr(line) => {
                    let message = String::from_utf8_lossy(&line).trim().to_string();
                    eprintln!("[desktop-backend] {message}");
                    append_startup_log(event_log_path.as_ref(), format!("[stderr] {message}"));
                }
                CommandEvent::Error(message) => {
                    eprintln!("[desktop-backend] {message}");
                    append_startup_log(event_log_path.as_ref(), format!("[error] {message}"));
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

fn wait_for_backend(port: u16, timeout: Duration) -> Result<(), IoError> {
    let started_at = Instant::now();
    let request = b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";

    while started_at.elapsed() < timeout {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = stream.write_all(request);
            let _ = stream.set_read_timeout(Some(Duration::from_millis(600)));

            let mut response = String::new();
            if stream.read_to_string(&mut response).is_ok() && response.contains("\"status\":\"ok\"") {
                return Ok(());
            }
        }

        thread::sleep(Duration::from_millis(150));
    }

    Err(other_error("Desktop backend did not become healthy within 30 seconds."))
}

fn kill_backend(app: &AppHandle) {
    let state = app.state::<BackendState>();
    let child = {
        let mut guard = state.0.lock().expect("backend state poisoned");
        guard.take()
    };
    if let Some(child) = child {
        let _ = child.kill();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(BackendState::default());
            let handle = app.handle();
            let log_path = resolve_startup_log_path(&handle);
            append_startup_log(log_path.as_ref(), "Desktop startup begin.");

            let startup_result = (|| -> Result<(), IoError> {
                let port = select_open_port()?;
                append_startup_log(log_path.as_ref(), format!("Selected localhost port {port}."));

                let child = spawn_backend(&handle, port, log_path.clone())?;
                *app
                    .state::<BackendState>()
                    .0
                    .lock()
                    .expect("backend state poisoned") = Some(child);

                append_startup_log(log_path.as_ref(), "Waiting for desktop backend health check.");
                wait_for_backend(port, Duration::from_secs(30))?;
                append_startup_log(log_path.as_ref(), "Desktop backend health check succeeded.");

                let url = format!("http://127.0.0.1:{port}/")
                    .parse()
                    .map_err(|error| other_error(format!("Failed to build desktop URL: {error}")))?;

                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                    .title("LibreOJ 题目包下载器")
                    .inner_size(1360.0, 920.0)
                    .min_inner_size(1100.0, 760.0)
                    .resizable(true)
                    .build()
                    .map_err(|error| other_error(format!("Failed to create main window: {error}")))?;

                append_startup_log(log_path.as_ref(), "Main window created successfully.");
                Ok(())
            })();

            if let Err(error) = startup_result {
                append_startup_log(log_path.as_ref(), format!("Desktop startup failed: {error}"));
                kill_backend(&handle);
                if let Some(path) = log_path.as_ref() {
                    reveal_startup_log(path);
                }
                return Err(error.into());
            }

            Ok(())
        })
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                kill_backend(app);
            }
        }),
        Err(error) => {
            #[cfg(target_os = "windows")]
            {
                let log_path = std::env::temp_dir().join("loj-download-desktop-fatal.log");
                let _ = std::fs::write(
                    &log_path,
                    format!("Failed to build Tauri application: {error}\n"),
                );
                reveal_startup_log(&log_path);
            }
            panic!("failed to build Tauri application: {error}");
        }
    }
}
