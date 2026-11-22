//! Crib - thin file access for the web UI. All toolbook logic is in ui/lib (JS),
//! so it can be tested with node. Also serves the machine-side cache to the viewer page.

mod announce;

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::http::{header, Response};
use tauri::ipc::{self, InvokeBody};
use tauri::{AppHandle, Manager};

type R<T> = Result<T, String>;

fn e(err: std::io::Error) -> String {
    err.to_string()
}

#[derive(Serialize)]
struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
}

#[derive(Serialize)]
struct Stat {
    is_dir: bool,
    size: u64,
}

#[tauri::command]
fn read_file(path: String) -> R<ipc::Response> {
    fs::read(path).map(ipc::Response::new).map_err(e)
}

/// Body = file bytes; path in the "path" header (URL-encoded); header "create-new"
/// makes it fail if the file exists (used for the lock).
#[tauri::command]
fn write_file(request: ipc::Request) -> R<()> {
    let path = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing path header")?;
    let path = percent_decode(path);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw bytes".into());
    };
    let mut o = fs::OpenOptions::new();
    o.write(true);
    if request.headers().contains_key("create-new") {
        o.create_new(true);
    } else {
        o.create(true).truncate(true);
    }
    let mut f = o.open(&path).map_err(e)?;
    f.write_all(bytes).map_err(e)?;
    f.sync_all().map_err(e)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn list_dir(path: String) -> R<Vec<Entry>> {
    let mut v = vec![];
    for ent in fs::read_dir(path).map_err(e)? {
        let ent = ent.map_err(e)?;
        let m = ent.metadata().map_err(e)?;
        v.push(Entry { name: ent.file_name().to_string_lossy().into_owned(), is_dir: m.is_dir(), size: m.len() });
    }
    Ok(v)
}

#[tauri::command]
fn stat(path: String) -> Option<Stat> {
    fs::metadata(path).ok().map(|m| Stat { is_dir: m.is_dir(), size: m.len() })
}

#[tauri::command]
fn mkdirs(path: String) -> R<()> {
    fs::create_dir_all(path).map_err(e)
}

/// Replaces an existing target (MoveFileEx REPLACE_EXISTING on Windows).
#[tauri::command]
fn rename(from: String, to: String) -> R<()> {
    fs::rename(from, to).map_err(e)
}

#[tauri::command]
fn remove(path: String) -> R<()> {
    match fs::metadata(&path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path).map_err(e),
        Ok(_) => fs::remove_file(path).map_err(e),
        Err(_) => Ok(()),
    }
}

#[tauri::command]
fn copy_file(from: String, to: String) -> R<()> {
    fs::copy(from, to).map(|_| ()).map_err(e)
}

/// "Open folder" after an offline copy is saved: the file's folder in Explorer, the file selected (0.2.13).
#[tauri::command]
fn show_in_folder(path: String) -> R<()> {
    #[cfg(windows)]
    let r = {
        use std::os::windows::process::CommandExt; // explorer wants /select,"path" (quotes round the path only)
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.replace('/', "\\"))).spawn()
    };
    #[cfg(not(windows))]
    let r = std::process::Command::new("xdg-open").arg(Path::new(&path).parent().unwrap_or(Path::new("."))).spawn();
    r.map(|_| ()).map_err(e)
}

#[tauri::command]
fn whoami() -> serde_json::Value {
    let var = |a: &str, b: &str| std::env::var(a).or_else(|_| std::env::var(b)).unwrap_or_else(|_| "unknown".into());
    serde_json::json!({ "user": var("USERNAME", "USER"), "host": var("COMPUTERNAME", "HOSTNAME") })
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("crib"))
}

/// The machine-side cache lives here: <dir>/cache/<toolbook>/
#[tauri::command]
fn cache_root(app: AppHandle) -> String {
    data_dir(&app).join("cache").to_string_lossy().into_owned()
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir().join("crib"));
    let _ = fs::create_dir_all(&dir);
    dir.join("settings.json")
}

#[tauri::command]
fn settings_read(app: AppHandle) -> String {
    fs::read_to_string(settings_path(&app)).unwrap_or_else(|_| "{}".into())
}

#[tauri::command]
fn settings_write(app: AppHandle, text: String) -> R<()> {
    fs::write(settings_path(&app), text).map_err(e)?;
    announce(&app);
    Ok(())
}

/// The announce file for Apphub (announce.rs).
fn announce(app: &AppHandle) {
    let name = app.config().product_name.clone().unwrap_or_else(|| "Crib".into());
    announce::write(app.path().config_dir().ok(), &name, &app.package_info().version.to_string());
}

fn mime(p: &Path) -> &'static str {
    match p.extension().and_then(|x| x.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "png" => "image/png",
        "glb" => "model/gltf-binary",
        _ => "application/octet-stream",
    }
}

/// tb://localhost/<toolbook>/<file> -> <cache>/<toolbook>/<file>
fn serve_cache(app: &AppHandle, uri_path: &str) -> Response<Vec<u8>> {
    let rel = PathBuf::from(percent_decode(uri_path.trim_start_matches('/')));
    let clean = rel.components().all(|c| matches!(c, Component::Normal(_)));
    let mut full = data_dir(app).join("cache").join(&rel);
    if full.is_dir() {
        full.push("index.html");
    }
    let body = if clean { fs::read(&full).ok() } else { None };
    let (status, body) = match body {
        Some(b) => (200, b),
        None => (404, b"not found".to_vec()),
    };
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime(&full))
        .header(header::CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap()
}

// ---- the hub folder as a web page (hub PC, opt-in): phones, tablets and PCs without Crib open http://<hub>:8480/
// Read-only: GET of files inside the hub folder and a list of its toolbooks. Nothing is ever written or run.
const WEB_PORT: u16 = 8480;
static WEB_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// A request path -> the file inside root. None unless every segment is a plain name: no "..", drive, root, \ or :.
fn web_file(root: &Path, url_path: &str) -> Option<PathBuf> {
    let path = percent_decode(url_path.split(['?', '#']).next().unwrap_or("").trim_start_matches('/'));
    let rel = PathBuf::from(&path);
    let plain = !path.contains(['\\', ':', '\0']) && rel.components().all(|c| matches!(c, Component::Normal(_)));
    plain.then(|| root.join(rel))
}

/// The toolbooks in the hub folder (folders holding a current.json), as a page of links.
fn web_index(root: &Path) -> Vec<u8> {
    let mut names: Vec<String> = fs::read_dir(root).into_iter().flatten().flatten()
        .filter(|d| d.path().join("current.json").is_file())
        .map(|d| d.file_name().to_string_lossy().into_owned())
        // the hub's own rule for a toolbook name (hub.js), so a name never needs escaping
        .filter(|n| n.chars().all(|c| c.is_ascii_alphanumeric() || " ._-".contains(c)))
        .collect();
    names.sort();
    let links: String = names.iter().map(|n| format!("<p><a href=\"{}/\">{}</a></p>", n.replace(' ', "%20"), n)).collect();
    format!("<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{0}</title>\
<body style=\"font:20px system-ui;background:#0f1320;color:#e6e9f2;padding:1em\"><h1>{0} toolbooks</h1>{1}<style>a{{color:#7fd4ff}}</style>",
        "Crib",
        if links.is_empty() { "<p>None yet.</p>".into() } else { links }).into_bytes()
}

/// -> (status, content type, body, redirect)
fn web_answer(root: Option<&Path>, method: &str, url_path: &str) -> (u16, &'static str, Vec<u8>, Option<String>) {
    let miss = |code| (code, "text/plain", b"not found".to_vec(), None);
    let Some(root) = root else { return miss(404) };
    if method != "GET" && method != "HEAD" {
        return miss(405);
    }
    let bare = url_path.split(['?', '#']).next().unwrap_or("");
    if bare == "/" {
        return (200, "text/html; charset=utf-8", web_index(root), None);
    }
    let Some(mut full) = web_file(root, bare) else { return miss(404) };
    if full.is_dir() {
        if !bare.ends_with('/') {
            return (301, "text/plain", vec![], Some(format!("{bare}/"))); // so the page's own files resolve inside it
        }
        full.push("index.html");
    }
    // is_file: a Windows device name (CON, COM1) is not a file, so it is never opened
    match full.is_file().then(|| fs::read(&full).ok()).flatten() {
        Some(b) => (200, mime(&full), b, None),
        None => miss(404),
    }
}

fn web_serve(stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
    let mut head = BufReader::new((&stream).take(16384));
    let mut first = String::new();
    if head.read_line(&mut first).is_err() {
        return;
    }
    let mut line = String::new(); // the rest of the request's header: read so the answer is not cut off by a reset
    while matches!(head.read_line(&mut line), Ok(n) if n > 2) {
        line.clear();
    }
    let mut it = first.split_whitespace();
    let (method, path) = (it.next().unwrap_or(""), it.next().unwrap_or(""));
    let root = WEB_ROOT.get().and_then(|m| m.lock().ok().and_then(|g| g.clone()));
    let (status, ctype, body, to) = web_answer(root.as_deref(), method, path);
    let mut out = format!("HTTP/1.1 {status} -\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n", body.len());
    if let Some(to) = to {
        out += &format!("Location: {to}\r\n");
    }
    let mut w = &stream;
    let _ = w.write_all((out + "\r\n").as_bytes());
    if method != "HEAD" {
        let _ = w.write_all(&body);
    }
}

/// Show the hub folder as a web page; an empty root stops answering (everything is "not found"). -> the port.
/// shortcut: one thread per request and every network card, fine for a shop's handful of screens; bind one address
/// and cap the threads if IT wants it kept off the office side.
#[tauri::command]
fn hub_web(root: String) -> R<u16> {
    if WEB_ROOT.get().is_none() {
        let l = TcpListener::bind(("0.0.0.0", WEB_PORT)).map_err(|err| format!("port {WEB_PORT}: {err}"))?;
        if WEB_ROOT.set(Mutex::new(None)).is_ok() {
            std::thread::spawn(move || {
                for s in l.incoming().flatten() {
                    std::thread::spawn(move || web_serve(s));
                }
            });
        }
    }
    *WEB_ROOT.get().unwrap().lock().map_err(|_| "web page lock")? = (!root.is_empty()).then(|| PathBuf::from(root));
    Ok(WEB_PORT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_page_serves_only_files_inside_the_hub_folder() {
        let root = std::env::temp_dir().join(format!("mbtb-web-{}", std::process::id()));
        fs::create_dir_all(root.join("shop-a/assets")).unwrap();
        fs::write(root.join("shop-a/current.json"), "{}").unwrap();
        fs::write(root.join("shop-a/index.html"), "page").unwrap();
        fs::write(root.parent().unwrap().join("crib-secret.txt"), "secret").unwrap();
        let get = |p: &str| web_answer(Some(&root), "GET", p);
        assert_eq!(get("/shop-a/").2, b"page");
        assert_eq!(get("/shop-a/current.json?x=1").0, 200);
        assert_eq!(get("/shop-a").3.as_deref(), Some("/shop-a/"));
        assert!(String::from_utf8(get("/").2).unwrap().contains("<a href=\"shop-a/\">shop-a</a>"));
        for bad in ["/../crib-secret.txt", "/shop-a/../../crib-secret.txt", "/%2e%2e/crib-secret.txt", "/..%5Ccrib-secret.txt", "//etc/passwd", "/C:/Windows/win.ini", "/shop-a/nope"] {
            assert_eq!(get(bad).0, 404, "{bad}");
        }
        assert_eq!(web_answer(Some(&root), "POST", "/shop-a/").0, 405);
        assert_eq!(web_answer(None, "GET", "/").0, 404);
        // a real request through the listener
        hub_web(root.to_string_lossy().into_owned()).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", WEB_PORT)).unwrap();
        c.write_all(b"GET /shop-a/ HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut got = String::new();
        c.read_to_string(&mut got).unwrap();
        assert!(got.starts_with("HTTP/1.1 200") && got.ends_with("\r\n\r\npage"), "{got}");
        hub_web(String::new()).unwrap();
        fs::remove_dir_all(&root).unwrap();
        fs::remove_file(root.parent().unwrap().join("crib-secret.txt")).unwrap();
    }
}

/// The toolbook folder given on the command line (a launcher such as Apphub can pass one), if any.
#[tauri::command]
fn start_arg() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.is_empty())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol("tb", |ctx, req| serve_cache(ctx.app_handle(), req.uri().path()))
        .invoke_handler(tauri::generate_handler![
            read_file, write_file, list_dir, stat, mkdirs, rename, remove, copy_file, whoami, cache_root,
            settings_read, settings_write, hub_web, show_in_folder, start_arg
        ])
        .setup(|app| {
            announce(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Crib");
}
