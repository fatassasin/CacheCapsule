//! Windows 登录启动和开始菜单入口；与缓存保活设置分开。
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use std::io;
use winreg::{enums::*, RegKey, RegValue};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const NAME: &str = "CacheCapsule";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn optional<T>(value: io::Result<T>) -> io::Result<Option<T>> {
    match value {
        Ok(v) => Ok(Some(v)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
fn approved(key: &RegKey) -> io::Result<bool> {
    let Some(value) = optional(key.get_raw_value(NAME))? else { return Ok(true) };
    if value.vtype != REG_BINARY || value.bytes.len() < 12 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "无法识别 Windows 启动项状态"));
    }
    // Windows 的 2/6 表示启用，3/7 表示禁用；后八字节是禁用时间。
    let flag = u32::from_le_bytes(value.bytes[..4].try_into().unwrap());
    match flag {
        2 | 6 => Ok(true),
        3 | 7 => Ok(false),
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "无法识别 Windows 启动项状态")),
    }
}

fn approval(key: &RegKey, on: bool) -> io::Result<()> {
    let mut bytes = vec![0; 12];
    bytes[0] = if on { 2 } else { 3 };
    key.set_raw_value(NAME, &RegValue { vtype: REG_BINARY, bytes: bytes.into() })
}

#[cfg(test)]
fn enabled_at(root: &RegKey, run_path: &str, approval_path: &str) -> io::Result<bool> {
    let Some(run) = optional(root.open_subkey(run_path))? else { return Ok(false) };
    if optional(run.get_value::<String, _>(NAME))?.is_none() { return Ok(false); }
    let Some(key) = optional(root.open_subkey(approval_path))? else { return Ok(true) };
    approved(&key)
}

// 保留 Run 项才能留在“设置 → 应用 → 启动”中。首次登记先禁用，不能短暂开启。
fn register_at(root: &RegKey, run_path: &str, approval_path: &str, exe: &Path) -> io::Result<()> {
    let (run, _) = root.create_subkey(run_path)?;
    let (key, _) = root.create_subkey(approval_path)?;
    if optional(run.get_value::<String, _>(NAME))?.is_none() { approval(&key, false)?; }
    run.set_value(NAME, &format!("\"{}\"", exe.display()))
}

#[cfg(test)]
fn set_at(root: &RegKey, run_path: &str, approval_path: &str, exe: &Path, on: bool) -> io::Result<bool> {
    register_at(root, run_path, approval_path, exe)?;
    let key = root.open_subkey_with_flags(approval_path, KEY_SET_VALUE)?;
    approval(&key, on)?;
    let actual = enabled_at(root, run_path, approval_path)?;
    if actual != on { return Err(io::Error::other("Windows 启动项状态未更新")); }
    Ok(actual)
}

pub fn ensure_registered() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    register_at(&RegKey::predef(HKEY_CURRENT_USER), RUN_KEY, APPROVED_KEY, &exe).map_err(|e| e.to_string())
}

fn shortcut(exe: &Path, directory: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", include_str!("start-menu.ps1")])
        .env("CACHECAPSULE_EXE", exe)
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(dir) = directory { command.env("CACHECAPSULE_PROGRAMS", dir); }
    else { command.env_remove("CACHECAPSULE_PROGRAMS"); }
    let result = command.output().map_err(|e| format!("无法创建开始菜单入口：{e}"))?;
    if !result.status.success() {
        return Err(format!("无法创建开始菜单入口：{}", String::from_utf8_lossy(&result.stderr).trim()));
    }
    Ok(())
}

pub fn ensure_shortcut() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    shortcut(&exe, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_startup_registration_and_toggle() {
        let user = RegKey::predef(HKEY_CURRENT_USER);
        let path = format!(r"Software\CacheCapsule\Tests\{}", std::process::id());
        let (root, _) = user.create_subkey(&path).unwrap();
        let exe = Path::new(r"C:\程序 测试\CacheCapsule.exe");
        let state = || enabled_at(&root, "Run", "Approved").unwrap();
        let register = |exe: &Path| register_at(&root, "Run", "Approved", exe).unwrap();
        assert!(!state());
        register(exe);
        assert!(!state(), "首次登记不得开启自启");
        let run = root.open_subkey("Run").unwrap();
        assert_eq!(run.get_value::<String, _>(NAME).unwrap(), format!("\"{}\"", exe.display()));
        assert!(set_at(&root, "Run", "Approved", exe, true).unwrap());
        assert!(state());
        register(exe);
        assert!(state(), "重启应用不得覆盖已开启状态");
        // 模拟用户在 Windows 设置中关闭，而不是从应用内关闭。
        let key = root.open_subkey_with_flags("Approved", KEY_ALL_ACCESS).unwrap();
        approval(&key, false).unwrap();
        assert!(!state());
        let moved = Path::new(r"D:\移动后\CacheCapsule.exe");
        register(moved);
        assert!(!state(), "更新路径不得重新开启系统里禁用的启动项");
        assert_eq!(run.get_value::<String, _>(NAME).unwrap(), format!("\"{}\"", moved.display()));
        assert!(!set_at(&root, "Run", "Approved", moved, false).unwrap());
        assert!(run.get_value::<String, _>(NAME).is_ok(), "关闭后仍须保留系统列表入口");
        // 兼容之前只有 Run 项、没有审批记录的已启用版本。
        key.delete_value(NAME).unwrap();
        assert!(state());
        register(moved);
        assert!(state());
        for (flag, expected) in [(2, true), (3, false), (6, true), (7, false)] {
            let mut bytes = vec![0; 12];
            bytes[0] = flag;
            key.set_raw_value(NAME, &RegValue { vtype: REG_BINARY, bytes: bytes.into() }).unwrap();
            assert_eq!(state(), expected);
        }
        key.set_raw_value(NAME, &RegValue { vtype: REG_BINARY, bytes: vec![3].into() }).unwrap();
        assert!(enabled_at(&root, "Run", "Approved").is_err());
        drop(key);
        drop(run);
        drop(root);
        user.delete_subkey_all(path).unwrap();
    }

    #[test]
    fn shortcut_uses_executable_icon_and_updates_moved_target() {
        let dir = std::env::temp_dir().join(format!("cachecapsule-shortcut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = std::env::current_exe().unwrap();
        shortcut(&exe, Some(&dir)).unwrap();
        shortcut(&exe, Some(&dir)).unwrap();
        let moved = dir.join("移动 ' 路径.exe");
        shortcut(&moved, Some(&dir)).unwrap();
        let result = Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference='Stop'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $env:CACHECAPSULE_PROGRAMS 'CacheCapsule.lnk')); if ($s.TargetPath -ne $env:CACHECAPSULE_EXE -or $s.IconLocation -ne ($env:CACHECAPSULE_EXE+',0') -or $s.WorkingDirectory -ne (Split-Path -Parent $env:CACHECAPSULE_EXE)) { exit 1 }"])
            .env("CACHECAPSULE_PROGRAMS", &dir).env("CACHECAPSULE_EXE", &moved)
            .creation_flags(CREATE_NO_WINDOW).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
