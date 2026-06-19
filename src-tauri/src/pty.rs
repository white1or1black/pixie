use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    pub master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    #[allow(dead_code)]
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub type PtyMap = Arc<Mutex<HashMap<String, PtySession>>>;

pub fn init_pty_map() -> PtyMap {
    Arc::new(Mutex::new(HashMap::new()))
}

#[cfg(unix)]
fn make_writer(
    master: &mut Box<dyn portable_pty::MasterPty + Send>,
) -> Result<Box<dyn std::io::Write + Send>, String> {
    use std::os::unix::io::FromRawFd;
    let fd = master.as_raw_fd().ok_or("No fd")?;
    let dup_fd = unsafe { libc::dup(fd) };
    if dup_fd < 0 {
        return Err("Failed to dup fd".into());
    }
    let file = unsafe { std::fs::File::from_raw_fd(dup_fd) };
    Ok(Box::new(file))
}

#[cfg(not(unix))]
fn make_writer(
    master: &mut Box<dyn portable_pty::MasterPty + Send>,
) -> Result<Box<dyn std::io::Write + Send>, String> {
    master.take_writer().map_err(|e| format!("Failed: {}", e))
}

pub fn spawn_pty(
    pty_map: &PtyMap,
    id: &str,
    cwd: Option<&str>,
    rows: u16,
    cols: u16,
    app: AppHandle,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    let mut pair = pty_system
        .openpty(size)
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.args(["-i", "-l"]);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    let writer = make_writer(&mut pair.master)?;
    let writer = Arc::new(Mutex::new(writer));
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;
    let master = Arc::new(Mutex::new(pair.master));

    let app_clone = app.clone();
    let id_clone = id.to_string();

    // Reader thread
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(
                        "pty-output",
                        serde_json::json!({ "id": id_clone, "data": data }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    let mut map = pty_map.lock().unwrap();
    if let Some(old) = map.remove(id) {
        drop(old);
    }
    map.insert(
        id.to_string(),
        PtySession {
            master,
            writer,
            child: Some(child),
        },
    );

    Ok(())
}

pub fn pty_write(pty_map: &PtyMap, id: &str, data: &str) -> Result<(), String> {
    let map = pty_map.lock().unwrap();
    let session = map.get(id).ok_or_else(|| "No PTY session".to_string())?;
    let mut writer = session.writer.lock().unwrap();
    use std::io::Write;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write error: {}", e))?;
    writer.flush().map_err(|e| format!("Flush error: {}", e))?;
    Ok(())
}

pub fn pty_resize(pty_map: &PtyMap, id: &str, rows: u16, cols: u16) -> Result<(), String> {
    let map = pty_map.lock().unwrap();
    let session = map.get(id).ok_or_else(|| "No PTY session".to_string())?;
    let master = session.master.lock().unwrap();
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize error: {}", e))?;
    Ok(())
}

pub fn kill_pty(pty_map: &PtyMap, id: &str) {
    let mut map = pty_map.lock().unwrap();
    if let Some(session) = map.remove(id) {
        drop(session);
    }
}
