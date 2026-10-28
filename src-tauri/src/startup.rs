//! Windows 登录启动和开始菜单入口；与缓存保活设置分开。
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn registered(key: &str) -> bool {
    Command::new("reg.exe").args(["query", key, "/v", "CacheCapsule"])
        .creation_flags(CREATE_NO_WINDOW).output()
        .map(|o| o.status.success()).unwrap_or(false)
}

pub fn enabled() -> bool {
    registered(RUN_KEY)
}

fn set_at(key: &str, exe: &Path, on: bool) -> Result<bool, String> {
    if !on && !registered(key) { return Ok(false); }
    let target = format!("\"{}\"", exe.display());
    let args = if on {
        vec!["add", key, "/v", "CacheCapsule", "/t", "REG_SZ", "/d", &target, "/f"]
    } else {
        vec!["delete", key, "/v", "CacheCapsule", "/f"]
    };
    let result = Command::new("reg.exe").args(args).creation_flags(CREATE_NO_WINDOW)
        .output().map_err(|e| format!("无法更改开机启动：{e}"))?;
    if !result.status.success() || registered(key) != on {
        return Err("无法更改开机启动，请检查 Windows 启动项权限".into());
    }
    Ok(on)
}

pub fn set(on: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    set_at(RUN_KEY, &exe, on)
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
    fn autostart_round_trip_in_isolated_key() {
        let key = format!(r"HKCU\Software\CacheCapsule\Tests\{}", std::process::id());
        let exe = Path::new(r"C:\程序 测试\CacheCapsule.exe");
        assert!(!registered(&key));
        assert_eq!(set_at(&key, exe, false), Ok(false));
        assert_eq!(set_at(&key, exe, true), Ok(true));
        let output = Command::new("reg.exe").args(["query", &key, "/v", "CacheCapsule"])
            .creation_flags(CREATE_NO_WINDOW).output().unwrap();
        // 注册表内容必须保留双引号，含空格的路径不能被拆成参数。
        assert!(String::from_utf8_lossy(&output.stdout).contains("\"C:\\"));
        assert_eq!(set_at(&key, exe, false), Ok(false));
        assert!(!registered(&key));
        let _ = Command::new("reg.exe").args(["delete", &key, "/f"])
            .creation_flags(CREATE_NO_WINDOW).output();
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
