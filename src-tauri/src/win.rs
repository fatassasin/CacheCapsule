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

    pub const DWMWA_NCRENDERING_POLICY: u32 = 2;
    pub const DWMWA_TRANSITIONS_FORCEDISABLED: u32 = 3;
    pub const DWMNCRP_DISABLED: i32 = 1;
    pub const DWMWA_BORDER_COLOR: u32 = 34;
    pub const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    pub const DWMWA_CLOAKED: u32 = 14;
    pub const GW_OWNER: u32 = 4;
    /// DWMWA_COLOR_NONE：让 DWM 干脆不画窗口边线。
    pub const DWM_COLOR_NONE: u32 = 0xFFFF_FFFE;
    pub const ERROR_ALREADY_EXISTS: u32 = 183;
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

    pub const GWL_STYLE: i32 = -16;
    pub const GWL_EXSTYLE: i32 = -20;
    pub const WS_POPUP: u32 = 0x8000_0000;
    pub const WS_VISIBLE: i32 = 0x1000_0000;
    pub const WS_THICKFRAME: i32 = 0x0004_0000;
    pub const WM_NCACTIVATE: u32 = 0x0086;
    pub const WM_SETTEXT: u32 = 0x000C;
    pub const WM_SETICON: u32 = 0x0080;
    pub type SubclassProc = unsafe extern "system" fn(isize, u32, usize, isize, usize, usize) -> isize;
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

    #[link(name = "comctl32")]
    extern "system" {
        pub fn SetWindowSubclass(hwnd: isize, proc: SubclassProc, id: usize, data: usize) -> i32;
        pub fn DefSubclassProc(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize;
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
        pub fn EnumWindows(cb: unsafe extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
        pub fn GetWindow(hwnd: isize, cmd: u32) -> isize;
        pub fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
        pub fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
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

unsafe extern "system" fn collect(hwnd: isize, lparam: isize) -> i32 {
    let out = &mut *(lparam as *mut Vec<(isize, u32)>);
    if ffi::IsWindowVisible(hwnd) == 0 || ffi::IsIconic(hwnd) != 0 || ffi::GetWindow(hwnd, ffi::GW_OWNER) != 0 {
        return 1;
    }
    if ffi::GetWindowLongW(hwnd, ffi::GWL_EXSTYLE) & ffi::WS_EX_TOOLWINDOW != 0 {
        return 1;
    }
    // 在别的虚拟桌面上的窗口 IsWindowVisible 也是真，但 DWM 把它遮住了。
    let mut cloaked = 0u32;
    ffi::DwmGetWindowAttribute(hwnd, ffi::DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
    if cloaked != 0 {
        return 1;
    }
    let mut pid = 0u32;
    ffi::GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != 0 {
        out.push((hwnd, pid));
    }
    1
}

/// 屏幕上已显示的顶层窗口（没最小化、没被遮住、不是工具窗口）和各自的进程，
/// 按 Z 序从上到下。「在后台」的窗口也在里面，只是排在后面。
pub fn shown_windows() -> Vec<(isize, u32)> {
    let mut out: Vec<(isize, u32)> = Vec::new();
    unsafe {
        ffi::EnumWindows(collect, &mut out as *mut Vec<(isize, u32)> as isize);
    }
    out
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
    disable_nc_rendering(hwnd);
    keep_frameless(hwnd);
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

/// tao 可能按缓存的 WindowFlags 写回样式；只在被写回时修正，不反复刷新边框。
pub fn keep_frameless(hwnd: isize) {
    unsafe {
        let style = ffi::GetWindowLongW(hwnd, ffi::GWL_STYLE);
        let next = (style
            & !(ffi::WS_CAPTION | ffi::WS_SYSMENU | ffi::WS_MINIMIZEBOX | ffi::WS_MAXIMIZEBOX | ffi::WS_THICKFRAME))
            | ffi::WS_POPUP as i32;
        if next != style {
            ffi::SetWindowLongW(hwnd, ffi::GWL_STYLE, next);
            commit_frame(hwnd);
        }
    }
}

fn disable_nc_rendering(hwnd: isize) {
    unsafe {
        let off = ffi::DWMNCRP_DISABLED;
        ffi::DwmSetWindowAttribute(hwnd, ffi::DWMWA_NCRENDERING_POLICY,
            &off as *const i32 as *const c_void, 4);
        let yes = 1i32;
        ffi::DwmSetWindowAttribute(hwnd, ffi::DWMWA_TRANSITIONS_FORCEDISABLED,
            &yes as *const i32 as *const c_void, 4);
    }
}

/// 移植 Localless 的 no_caption_proc：DefWindowProc 在处理激活、标题和图标消息时
/// 会直接画标题条，即便 WS_CAPTION 已删。消息仍交给 tao（保留焦点状态和输入），
/// 只在调用期间暂摘 WS_VISIBLE，阻止系统绘制；不调用 ShowWindow，不真的藏窗。
unsafe extern "system" fn no_caption_proc(
    hwnd: isize, msg: u32, wp: usize, lp: isize, _id: usize, _data: usize,
) -> isize {
    if msg != ffi::WM_NCACTIVATE && msg != ffi::WM_SETTEXT && msg != ffi::WM_SETICON {
        return ffi::DefSubclassProc(hwnd, msg, wp, lp);
    }
    let lp = if msg == ffi::WM_NCACTIVATE { -1 } else { lp };
    let style = ffi::GetWindowLongW(hwnd, ffi::GWL_STYLE);
    if style & ffi::WS_VISIBLE == 0 {
        return ffi::DefSubclassProc(hwnd, msg, wp, lp);
    }
    ffi::SetWindowLongW(hwnd, ffi::GWL_STYLE, style & !ffi::WS_VISIBLE);
    let result = ffi::DefSubclassProc(hwnd, msg, wp, lp);
    let current = ffi::GetWindowLongW(hwnd, ffi::GWL_STYLE);
    ffi::SetWindowLongW(hwnd, ffi::GWL_STYLE, current | ffi::WS_VISIBLE);
    crate::trace(&format!("caption-paint blocked msg={msg:#06x}"));
    result
}

/// 必须从建窗口的线程调用（setup）：子类拦截、DWM 策略和样式三层一起处理。
pub fn prepare(hwnd: isize) -> Result<(), &'static str> {
    unsafe {
        if ffi::SetWindowSubclass(hwnd, no_caption_proc, 1, 0) == 0 {
            return Err("无法安装禁止标题栏绘制的窗口子类");
        }
        disable_nc_rendering(hwnd);
        keep_frameless(hwnd);
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[link(name = "user32")]
    extern "system" {
        fn CreateWindowExW(ex: u32, class: *const u16, title: *const u16, style: u32,
            x: i32, y: i32, w: i32, h: i32, parent: isize, menu: isize, instance: isize, param: *const c_void) -> isize;
        fn DestroyWindow(hwnd: isize) -> i32;
        fn SendMessageW(hwnd: isize, msg: u32, wp: usize, lp: isize) -> isize;
    }

    struct TestWindow(isize);
    impl Drop for TestWindow {
        fn drop(&mut self) { unsafe { DestroyWindow(self.0); } }
    }

    // 挂在修复的下游，直接量 Windows 消息处理时看到的样式，不靠截图或模拟鼠标。
    unsafe extern "system" fn probe(
        hwnd: isize, msg: u32, wp: usize, lp: isize, _id: usize, data: usize,
    ) -> isize {
        if msg == ffi::WM_NCACTIVATE || msg == ffi::WM_SETTEXT || msg == ffi::WM_SETICON {
            let seen = &mut *(data as *mut Vec<(u32, i32, isize)>);
            seen.push((msg, ffi::GetWindowLongW(hwnd, ffi::GWL_STYLE), lp));
        }
        ffi::DefSubclassProc(hwnd, msg, wp, lp)
    }

    #[test]
    fn caption_messages_cannot_paint_but_visibility_is_restored() {
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let title: Vec<u16> = "caption regression\0".encode_utf16().collect();
        unsafe {
            // 原生窗口放在屏幕外，测试不改变用户桌面的焦点或鼠标。
            let window = TestWindow(CreateWindowExW(ffi::WS_EX_TOOLWINDOW as u32, class.as_ptr(),
                title.as_ptr(), ffi::WS_POPUP, -32000, -32000, 100, 50, 0, 0, 0, std::ptr::null()));
            let h = window.0;
            assert_ne!(h, 0);
            let mut seen: Vec<(u32, i32, isize)> = Vec::new();
            assert_ne!(ffi::SetWindowSubclass(h, probe, 2, &mut seen as *mut _ as usize), 0);
            prepare(h).unwrap();
            show_topmost_noactivate(h);
            seen.clear();
            for _ in 0..20 {
                SendMessageW(h, ffi::WM_NCACTIVATE, 1, 0);
                SendMessageW(h, ffi::WM_NCACTIVATE, 0, 0);
                SendMessageW(h, ffi::WM_SETTEXT, 0, title.as_ptr() as isize);
                SendMessageW(h, ffi::WM_SETICON, 0, 0);
                assert_ne!(ffi::GetWindowLongW(h, ffi::GWL_STYLE) & ffi::WS_VISIBLE, 0);
            }
            assert_eq!(seen.len(), 80);
            assert!(seen.iter().all(|&(_, style, _)| style & ffi::WS_VISIBLE == 0));
            assert!(seen.iter().filter(|&&(msg, _, _)| msg == ffi::WM_NCACTIVATE).all(|&(_, _, lp)| lp == -1));
            let mut nc_enabled = 1i32;
            assert_eq!(ffi::DwmGetWindowAttribute(h, 1, // DWMWA_NCRENDERING_ENABLED（可读的 BOOL）
                &mut nc_enabled as *mut i32 as *mut c_void, 4), 0);
            assert_eq!(nc_enabled, 0);

            // 模拟 tao 写回边框位，巡逻应再次清掉。
            let style = ffi::GetWindowLongW(h, ffi::GWL_STYLE);
            ffi::SetWindowLongW(h, ffi::GWL_STYLE, style | ffi::WS_CAPTION | ffi::WS_THICKFRAME);
            keep_frameless(h);
            let repaired = ffi::GetWindowLongW(h, ffi::GWL_STYLE);
            assert_eq!(repaired & (ffi::WS_CAPTION | ffi::WS_THICKFRAME), 0);
            assert_ne!(repaired as u32 & ffi::WS_POPUP, 0);
            hide(h);
            seen.clear();
            SendMessageW(h, ffi::WM_SETTEXT, 0, title.as_ptr() as isize);
            assert_eq!(ffi::GetWindowLongW(h, ffi::GWL_STYLE) & ffi::WS_VISIBLE, 0);
            drop(window);
        }
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
