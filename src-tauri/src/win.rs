//! Windows 平台层：前台窗口探测、窗口样式、不抢焦点的显示/隐藏、单实例。
//!
//! 和 HoverNote 一样手写 FFI，不引入 `windows` crate，免得被它的大版本牵着走。
//! 这个程序只服务 Windows 上的 Claude 桌面端，所以整个模块不做跨平台桩。
//!
//! 坐标一律是物理像素——Tauri 应用是 per-monitor DPI 感知的，GetWindowRect 给的
//! 就是物理值，和 Electron 版 Claude 窗口的矩形可以直接相减。

use core::ffi::c_void;

#[repr(C)]
#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn w(&self) -> i32 {
        self.right - self.left
    }
    pub fn h(&self) -> i32 {
        self.bottom - self.top
    }
}

mod ffi {
    use super::{c_void, Rect};

    pub const DWMWA_BORDER_COLOR: u32 = 34;
    pub const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    /// DWMWA_COLOR_NONE：让 DWM 干脆不画窗口边线。
    pub const DWM_COLOR_NONE: u32 = 0xFFFF_FFFE;
    pub const ERROR_ALREADY_EXISTS: u32 = 183;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    pub const GWL_STYLE: i32 = -16;
    pub const GWL_EXSTYLE: i32 = -20;
    pub const WS_CAPTION: i32 = 0x00C0_0000;
    pub const WS_SYSMENU: i32 = 0x0008_0000;
    pub const WS_MINIMIZEBOX: i32 = 0x0002_0000;
    pub const WS_MAXIMIZEBOX: i32 = 0x0001_0000;
    pub const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;
    pub const WS_EX_APPWINDOW: i32 = 0x0004_0000;

    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOZORDER: u32 = 0x0004;
    pub const SWP_NOACTIVATE: u32 = 0x0010;
    pub const SWP_FRAMECHANGED: u32 = 0x0020;
    pub const HWND_TOPMOST: isize = -1;

    pub const SW_HIDE: i32 = 0;
    pub const SW_SHOWNOACTIVATE: i32 = 4;
    pub const VK_LBUTTON: i32 = 0x01;

    #[link(name = "dwmapi")]
    extern "system" {
        pub fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const c_void, size: u32)
            -> i32;
        pub fn DwmGetWindowAttribute(hwnd: isize, attr: u32, value: *mut c_void, size: u32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn CreateMutexW(attrs: *const c_void, owner: i32, name: *const u16) -> isize;
        pub fn GetLastError() -> u32;
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        pub fn QueryFullProcessImageNameW(
            process: isize,
            flags: u32,
            name: *mut u16,
            size: *mut u32,
        ) -> i32;
        pub fn CloseHandle(handle: isize) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> isize;
        pub fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        pub fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        pub fn IsWindow(hwnd: isize) -> i32;
        pub fn IsWindowVisible(hwnd: isize) -> i32;
        pub fn IsIconic(hwnd: isize) -> i32;
        pub fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
        pub fn GetDpiForWindow(hwnd: isize) -> u32;
        pub fn GetAsyncKeyState(key: i32) -> i16;
        pub fn GetWindowLongW(hwnd: isize, index: i32) -> i32;
        pub fn SetWindowLongW(hwnd: isize, index: i32, value: i32) -> i32;
        pub fn SetWindowPos(
            hwnd: isize,
            after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
}

/// 前台窗口和它所属的进程。
pub fn foreground() -> Option<(isize, u32)> {
    unsafe {
        let hwnd = ffi::GetForegroundWindow();
        if hwnd == 0 {
            return None;
        }
        let mut pid = 0u32;
        ffi::GetWindowThreadProcessId(hwnd, &mut pid);
        (pid != 0).then_some((hwnd, pid))
    }
}

/// 进程的可执行文件完整路径。
fn image_path(pid: u32) -> Option<String> {
    unsafe {
        let process = ffi::OpenProcess(ffi::PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process == 0 {
            return None;
        }
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = ffi::QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len) != 0;
        ffi::CloseHandle(process);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// 是不是 Claude 桌面端的进程。
///
/// 和 mod 里「窗口还开着吗」的判法一致：进程叫 Claude.exe，并且路径里没有
/// claude-code——后者是桌面端自带的 CLI，它也叫 claude.exe，但不是那个窗口。
pub fn is_claude_desktop(pid: u32) -> bool {
    let Some(path) = image_path(pid) else { return false };
    let lower = path.to_lowercase();
    lower.rsplit(['\\', '/']).next() == Some("claude.exe") && !lower.contains("claude-code")
}

/// 窗口肉眼可见的边框矩形。
///
/// Win11 的 GetWindowRect 把 7px 左右不可见的缩放边框也算进去，贴着它摆东西会
/// 离视觉边缘差一截，所以优先用 DWM 的扩展边框。
pub fn frame_rect(hwnd: isize) -> Option<Rect> {
    unsafe {
        let mut r = Rect::default();
        let hr = ffi::DwmGetWindowAttribute(
            hwnd,
            ffi::DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut Rect as *mut c_void,
            std::mem::size_of::<Rect>() as u32,
        );
        if hr == 0 && r.w() > 0 {
            return Some(r);
        }
        window_rect(hwnd)
    }
}

pub fn window_rect(hwnd: isize) -> Option<Rect> {
    unsafe {
        let mut r = Rect::default();
        (ffi::GetWindowRect(hwnd, &mut r) != 0).then_some(r)
    }
}

/// 窗口还在、没最小化。
pub fn is_usable(hwnd: isize) -> bool {
    unsafe { ffi::IsWindow(hwnd) != 0 && ffi::IsIconic(hwnd) == 0 && ffi::IsWindowVisible(hwnd) != 0 }
}

pub fn dpi_scale(hwnd: isize) -> f64 {
    let dpi = unsafe { ffi::GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        dpi as f64 / 96.0
    }
}

pub fn left_button_down() -> bool {
    unsafe { ffi::GetAsyncKeyState(ffi::VK_LBUTTON) as u16 & 0x8000 != 0 }
}

/// 显示但不激活：Claude 正在输入时，胶囊冒出来绝不能把键盘焦点抢走。
pub fn show_topmost_noactivate(hwnd: isize) {
    unsafe {
        ffi::ShowWindow(hwnd, ffi::SW_SHOWNOACTIVATE);
        ffi::SetWindowPos(
            hwnd,
            ffi::HWND_TOPMOST,
            0,
            0,
            0,
            0,
            ffi::SWP_NOMOVE | ffi::SWP_NOSIZE | ffi::SWP_NOACTIVATE,
        );
    }
}

pub fn hide(hwnd: isize) {
    unsafe {
        ffi::ShowWindow(hwnd, ffi::SW_HIDE);
    }
}

/// 只挪位置，不动大小和层级。
pub fn move_to(hwnd: isize, x: i32, y: i32) {
    unsafe {
        ffi::SetWindowPos(
            hwnd,
            0,
            x,
            y,
            0,
            0,
            ffi::SWP_NOSIZE | ffi::SWP_NOZORDER | ffi::SWP_NOACTIVATE,
        );
    }
}

/// 位置和大小一次设完，省得先改大小再挪位置时闪一下。
pub fn set_bounds(hwnd: isize, x: i32, y: i32, w: i32, h: i32) {
    unsafe {
        ffi::SetWindowPos(hwnd, 0, x, y, w, h, ffi::SWP_NOZORDER | ffi::SWP_NOACTIVATE);
    }
}

fn commit_frame(hwnd: isize) {
    unsafe {
        ffi::SetWindowPos(
            hwnd,
            0,
            0,
            0,
            0,
            0,
            ffi::SWP_FRAMECHANGED
                | ffi::SWP_NOMOVE
                | ffi::SWP_NOSIZE
                | ffi::SWP_NOZORDER
                | ffi::SWP_NOACTIVATE,
        );
    }
}

/// 无边框透明小窗的善后：摘标题栏样式（否则系统会强制一个最小宽度）、
/// 从 Alt+Tab 里摘出去、关掉 Win11 默认的 1px DWM 描边。
pub fn prepare(hwnd: isize) {
    unsafe {
        let style = ffi::GetWindowLongW(hwnd, ffi::GWL_STYLE);
        let next = style
            & !(ffi::WS_CAPTION | ffi::WS_SYSMENU | ffi::WS_MINIMIZEBOX | ffi::WS_MAXIMIZEBOX);
        if next != style {
            ffi::SetWindowLongW(hwnd, ffi::GWL_STYLE, next);
        }
        let ex = ffi::GetWindowLongW(hwnd, ffi::GWL_EXSTYLE);
        let next_ex = (ex & !ffi::WS_EX_APPWINDOW) | ffi::WS_EX_TOOLWINDOW;
        if next_ex != ex {
            ffi::SetWindowLongW(hwnd, ffi::GWL_EXSTYLE, next_ex);
        }
        let none = ffi::DWM_COLOR_NONE;
        ffi::DwmSetWindowAttribute(
            hwnd,
            ffi::DWMWA_BORDER_COLOR,
            &none as *const u32 as *const c_void,
            std::mem::size_of::<u32>() as u32,
        );
        commit_frame(hwnd);
    }
}

/// 开两份会各画一个胶囊、轮流覆盖对方写的位置，所以只许一个。
/// 句柄故意不释放，进程活多久就持有多久。
pub fn claim_single_instance() -> bool {
    let name: Vec<u16> = "Local\\com.shawn.cachecapsule.instance"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let handle = ffi::CreateMutexW(std::ptr::null(), 1, name.as_ptr());
        handle != 0 && ffi::GetLastError() != ffi::ERROR_ALREADY_EXISTS
    }
}
