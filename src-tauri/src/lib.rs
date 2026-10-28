//! CacheCapsule：Claude 桌面端缓存保活的小胶囊。
//!
//! 保活本身由 cache-keepalive 这个 mod 在 Claude Code 进程里做（只有它够得到
//! 当前会话的缓存前缀）。这里只管两件事：
//!
//! 1. 读写 mod 约定的文件，让人能看见状态、改设置；
//! 2. Claude 主窗口在任一屏幕上还有部分露出就显示，并跟着它的窗口走。
//!
//! 约定的目录是 `%USERPROFILE%\.claude\cache-keepalive\`：
//! - `settings.json`    胶囊写、mod 读：档位、开关、各档的间隔和次数、立即保活的计数；
//! - `state/<会话>.json` mod 写、胶囊读：这个会话的保活进度和上一次的用量；
//! - `capsule.json`     胶囊自己的，记着相对 Claude 窗口的位置。

mod win;
mod visibility;

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, State, WebviewWindow};

/// 第一次出现时离 Claude 窗口右、下边的距离（逻辑像素），大致落在输入框上方。
const DEFAULT_OFF_R: f64 = 40.0;
const DEFAULT_OFF_B: f64 = 130.0;
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 胶囊窗口右、下边相对 Claude 窗口右、下边的距离，逻辑像素（换显示器缩放也不变）。
struct Anchor {
    off_r: f64,
    off_b: f64,
}

struct Shared {
    /// 拖动由系统接管，进了它的模态循环；松手只能靠轮询鼠标左键发现。
    dragging: AtomicBool,
    /// 当前合格的 Claude 主窗口，与键盘焦点无关。
    claude: AtomicIsize,
    anchor: Mutex<Anchor>,
    target: Mutex<Option<visibility::Target>>,
}

impl Shared {
    fn load() -> Self {
        let saved = read_json(&capsule_path());
        let get = |k: &str, d: f64| {
            saved.as_ref().and_then(|v| v.get(k)).and_then(Value::as_f64).unwrap_or(d)
        };
        Shared {
            dragging: AtomicBool::new(false),
            claude: AtomicIsize::new(0),
            target: Mutex::new(None),
            anchor: Mutex::new(Anchor {
                off_r: get("offR", DEFAULT_OFF_R),
                off_b: get("offB", DEFAULT_OFF_B),
            }),
        }
    }
}

fn data_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default();
    home.join(".claude").join("cache-keepalive")
}

fn capsule_path() -> PathBuf {
    data_dir().join("capsule.json")
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// 设 CACHECAPSULE_TRACE=<文件> 打开显隐诊断。release 是 windows 子系统，
/// 没有控制台，这类置顶小窗从外面又观察不到，只能让程序自己报。
fn trace(msg: &str) {
    let Some(path) = std::env::var_os("CACHECAPSULE_TRACE") else { return };
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {}", now_ms(), msg);
    }
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// 先写临时文件再改名：mod 同时在读，不能让它读到写了一半的 JSON。
/// 它恰好打开着目标文件时改名会被拒绝，隔一小会儿再试。
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    let mut last = Ok(());
    for _ in 0..5 {
        last = fs::rename(&tmp, path);
        if last.is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    last
}

fn hwnd_of(window: &WebviewWindow) -> Option<isize> {
    window.hwnd().ok().map(|h| h.0 as isize)
}

/// 设置 + 全部会话的状态。挑哪个会话、过期不过期都交给前端——判定只放一处。
#[tauri::command]
fn snapshot() -> Value {
    let dir = data_dir();
    let mut states = Vec::new();
    if let Ok(entries) = fs::read_dir(dir.join("state")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(v) = read_json(&path) {
                    states.push(v);
                }
            }
        }
    }
    json!({
        "settings": read_json(&dir.join("settings.json")),
        "states": states,
        "now": now_ms(),
    })
}

#[tauri::command]
fn save_settings(text: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&text).map_err(|e| e.to_string())?;
    write_atomic(&data_dir().join("settings.json"), &text).map_err(|e| e.to_string())
}

/// 内容变高变宽时调整窗口，右下角不动：胶囊在右下，面板向上长。
#[tauri::command]
fn fit(window: WebviewWindow, w: f64, h: f64) {
    let Some(hwnd) = hwnd_of(&window) else { return };
    let Some(r) = win::window_rect(hwnd) else { return };
    let s = win::dpi_scale(hwnd);
    let (nw, nh) = ((w * s).ceil() as i32, (h * s).ceil() as i32);
    if nw == r.w() && nh == r.h() {
        return;
    }
    win::set_bounds(hwnd, r.right - nw, r.bottom - nh, nw, nh);
}

#[tauri::command]
fn begin_drag(shared: State<Shared>) {
    shared.dragging.store(true, Ordering::Relaxed);
}

/// 把窗口按记着的相对位置摆到 Claude 窗口上。
fn follow(hwnd: isize, shared: &Shared) {
    let Some(target) = *shared.target.lock().unwrap() else { return };
    let Some(w) = win::window_rect(hwnd) else { return };
    let (off_r, off_b) = {
        let a = shared.anchor.lock().unwrap();
        (a.off_r, a.off_b)
    };
    let (x, y) = visibility::position(target, (w.w(), w.h()), (off_r, off_b));
    if x != w.left || y != w.top {
        win::move_to(hwnd, x, y);
    }
}

/// 拖完之后，把现在的位置记成相对 Claude 窗口的距离。
fn capture(hwnd: isize, shared: &Shared) {
    let claude = shared.claude.load(Ordering::Relaxed);
    let (Some(c), Some(w)) = (win::frame_rect(claude), win::window_rect(hwnd)) else { return };
    let s = win::dpi_scale(claude);
    let (off_r, off_b) = ((c.right - w.right) as f64 / s, (c.bottom - w.bottom) as f64 / s);
    {
        let mut a = shared.anchor.lock().unwrap();
        a.off_r = off_r;
        a.off_b = off_b;
    }
    let _ = write_atomic(&capsule_path(), &json!({ "offR": off_r, "offB": off_b }).to_string());
    trace(&format!("saved offset r={off_r:.1} b={off_b:.1}"));
}

/// 按每屏 Z 序和遮挡判断，而不是焦点。右屏操作和局部遮挡不会隐藏左屏仍露出的 Claude。
fn watch(handle: tauri::AppHandle, hwnd: isize) {
    let shared = handle.state::<Shared>();
    let mut is_claude: HashMap<u32, bool> = HashMap::new();
    let mut shown = false;
    let mut last_diagnostic = String::new();

    loop {
        std::thread::sleep(Duration::from_millis(100));
        win::keep_frameless(hwnd);
        let mut windows = win::shown_windows();
        let monitors = win::monitors();
        // 只缓存当前快照内的 PID，避免退出后的 PID 复用沿用旧结论。
        is_claude.retain(|pid, _| windows.iter().any(|w| w.pid == *pid));
        for w in &mut windows {
            if !w.ignored {
                w.is_claude = *is_claude.entry(w.pid).or_insert_with(|| win::is_claude_desktop(w.pid));
            }
        }
        let current = *shared.target.lock().unwrap();
        let assessments = visibility::assess(&windows, &monitors);
        let dragging = shared.dragging.load(Ordering::Relaxed);
        let mut target = visibility::choose(&assessments, current);
        if dragging {
            // 拖动时只认原目标，不能把松手位置记到另一扇 Claude 上。
            target = target.filter(|t| current.is_some_and(|old| t.hwnd == old.hwnd));
        }
        if std::env::var_os("CACHECAPSULE_TRACE").is_some() {
            let diagnosis = format!("visibility target={target:?} monitors={monitors:?} candidates={assessments:?}");
            if diagnosis != last_diagnostic {
                trace(&diagnosis);
                last_diagnostic = diagnosis;
            }
        }
        if let Some(t) = target {
            *shared.target.lock().unwrap() = Some(t);
            shared.claude.store(t.hwnd, Ordering::Relaxed);
            if !shown {
                follow(hwnd, &shared);
                win::show_topmost_noactivate(hwnd);
                shown = true;
                trace("show");
            }
        } else {
            if shown {
                win::hide(hwnd);
                shown = false;
                shared.dragging.store(false, Ordering::Relaxed);
                trace("hide");
            }
            continue;
        }

        if dragging {
            if !win::left_button_down() {
                shared.dragging.store(false, Ordering::Relaxed);
                capture(hwnd, &shared);
            }
        } else {
            follow(hwnd, &shared);
        }
    }
}

/// 登记进「设置 → 应用 → 启动」。开关由 Windows 自己记在 `StartupApproved\Run`，
/// 这里只写 Run 项（每次启动刷新 exe 路径，程序挪了位置也跟得上），从不碰开关状态。
fn register_startup() {
    let Ok(exe) = std::env::current_exe() else { return };
    let ok = Command::new("reg")
        .args(["add", RUN_KEY, "/v", "CacheCapsule", "/t", "REG_SZ", "/d", &format!("\"{}\"", exe.display()), "/f"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|s| s.success());
    if !ok {
        trace("startup registration failed");
    }
}

pub fn run() {
    if !win::claim_single_instance() {
        return;
    }
    tauri::Builder::default()
        .manage(Shared::load())
        .invoke_handler(tauri::generate_handler![snapshot, save_settings, fit, begin_drag])
        .setup(|app| {
            let window = app.get_webview_window("main").ok_or("没有主窗口")?;
            let hwnd = hwnd_of(&window).ok_or("拿不到窗口句柄")?;
            win::prepare(hwnd)?;

            std::thread::spawn(register_startup);

            let quit = MenuItem::with_id(app, "quit", "退出 CacheCapsule", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("CacheCapsule")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id().as_ref() == "quit" {
                        app.exit(0);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let handle = app.handle().clone();
            std::thread::spawn(move || watch(handle, hwnd));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("CacheCapsule 启动失败");
}
