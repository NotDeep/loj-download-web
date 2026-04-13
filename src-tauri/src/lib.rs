use std::fs::create_dir_all;
use std::io::{Error as IoError, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct BackendState(Mutex<Option<CommandChild>>);

fn other_error(message: impl Into<String>) -> IoError {
    IoError::new(ErrorKind::Other, message.into())
}

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

fn spawn_backend(app: &AppHandle, port: u16) -> Result<CommandChild, IoError> {
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

    let (mut receiver, child) = app
        .shell()
        .sidecar("loj-download-node")
        .map_err(|error| other_error(format!("Failed to prepare Node sidecar: {error}")))?
        .args(args)
        .spawn()
        .map_err(|error| other_error(format!("Failed to spawn Node sidecar: {error}")))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[desktop-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[desktop-backend] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(message) => {
                    eprintln!("[desktop-backend] {message}");
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

    Err(other_error("Desktop backend did not become healthy within 10 seconds."))
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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            app.manage(BackendState::default());

            let port = select_open_port()?;
            let child = spawn_backend(&app.handle(), port)?;
            *app
                .state::<BackendState>()
                .0
                .lock()
                .expect("backend state poisoned") = Some(child);

            wait_for_backend(port, Duration::from_secs(10))?;

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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                kill_backend(app);
            }
        });
}
