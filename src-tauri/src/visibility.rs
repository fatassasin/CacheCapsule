//! 纯几何显隐判定：窗口按 Z 序从上到下，坐标全部是物理像素。
use crate::win::Rect;

#[derive(Clone, Debug)]
pub struct Window {
    pub hwnd: isize,
    pub pid: u32,
    pub frame: Rect,
    pub scale: f64,
    pub main_candidate: bool,
    pub ignored: bool,
    pub is_claude: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Target {
    pub hwnd: isize,
    pub monitor: Rect,
    pub clip: Rect,
    pub frame: Rect,
    pub scale: f64,
}

#[derive(Debug)]
pub struct Assessment {
    pub target: Target,
    pub blocker: Option<isize>,
}

pub fn intersection(a: Rect, b: Rect) -> Option<Rect> {
    let r = Rect {
        left: a.left.max(b.left), top: a.top.max(b.top),
        right: a.right.min(b.right), bottom: a.bottom.min(b.bottom),
    };
    (r.w() > 0 && r.h() > 0).then_some(r)
}

/// 从可见区域扣掉一扇上层窗口；四条不重叠的矩形保留精确的剩余区域。
fn subtract(region: Rect, cover: Rect, out: &mut Vec<Rect>) {
    let Some(hit) = intersection(region, cover) else { out.push(region); return };
    for piece in [
        Rect { bottom: hit.top, ..region },
        Rect { top: hit.bottom, ..region },
        Rect { top: hit.top, bottom: hit.bottom, right: hit.left, ..region },
        Rect { top: hit.top, bottom: hit.bottom, left: hit.right, ..region },
    ] {
        if piece.w() > 0 && piece.h() > 0 { out.push(piece); }
    }
}

pub fn assess(windows: &[Window], monitors: &[Rect]) -> Vec<Assessment> {
    let mut out = Vec::new();
    for (i, w) in windows.iter().enumerate() {
        if w.ignored || !w.main_candidate || !w.is_claude
            || (w.frame.w() as f64) < 480.0 * w.scale
            || (w.frame.h() as f64) < 360.0 * w.scale {
            continue;
        }
        for &monitor in monitors {
            let Some(clip) = intersection(w.frame, monitor) else { continue };
            let mut visible = vec![clip];
            let mut blocker = None;
            for above in windows[..i].iter().filter(|above| !above.ignored) {
                let mut remaining = Vec::new();
                for region in visible { subtract(region, above.frame, &mut remaining); }
                visible = remaining;
                if visible.is_empty() {
                    // 可能是多扇窗口联合盖满，记录最后盖住剩余区域的句柄。
                    blocker = Some(above.hwnd);
                    break;
                }
            }
            out.push(Assessment {
                target: Target { hwnd: w.hwnd, monitor, clip, frame: w.frame, scale: w.scale },
                blocker,
            });
        }
    }
    out
}

/// 优先保留当前窗口和屏幕，其次最高层窗口，再取其最大的未遮挡屏幕部分。
pub fn choose(assessments: &[Assessment], current: Option<Target>) -> Option<Target> {
    let clear: Vec<_> = assessments.iter().filter(|a| a.blocker.is_none()).map(|a| a.target).collect();
    if let Some(old) = current {
        if let Some(t) = clear.iter().find(|t| t.hwnd == old.hwnd && t.monitor == old.monitor) {
            return Some(*t);
        }
    }
    let hwnd = current.and_then(|old| clear.iter().find(|t| t.hwnd == old.hwnd).map(|t| t.hwnd))
        .or_else(|| clear.first().map(|t| t.hwnd))?;
    clear.into_iter().filter(|t| t.hwnd == hwnd)
        .max_by_key(|t| i64::from(t.clip.w()) * i64::from(t.clip.h()))
}

/// 自动挪回合格屏幕不改变保存的拖动偏移；跨屏时也不落在被 Chrome 盖住的那半边。
pub fn position(target: Target, size: (i32, i32), offset: (f64, f64)) -> (i32, i32) {
    let x = target.frame.right - (offset.0 * target.scale).round() as i32 - size.0;
    let y = target.frame.bottom - (offset.1 * target.scale).round() as i32 - size.1;
    (x.clamp(target.clip.left, (target.clip.right - size.0).max(target.clip.left)),
     y.clamp(target.clip.top, (target.clip.bottom - size.1).max(target.clip.top)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn r(l: i32, t: i32, right: i32, b: i32) -> Rect { Rect { left: l, top: t, right, bottom: b } }
    fn app(hwnd: isize, frame: Rect, claude: bool) -> Window {
        Window { hwnd, pid: hwnd as u32, frame, scale: 1.0, main_candidate: true, ignored: false, is_claude: claude }
    }
    fn pick(ws: &[Window], ms: &[Rect]) -> Option<Target> { choose(&assess(ws, ms), None) }
    const LEFT: Rect = Rect { left: 0, top: 0, right: 1920, bottom: 1080 };
    const RIGHT: Rect = Rect { left: 1920, top: 0, right: 3840, bottom: 1080 };

    #[test]
    fn other_monitor_focus_does_not_hide() {
        let ws = [app(2, RIGHT, false), app(1, LEFT, true)];
        assert_eq!(pick(&ws, &[LEFT, RIGHT]).unwrap().hwnd, 1);
    }
    #[test]
    fn partial_cover_shows_and_full_cover_hides() {
        for cover in [r(0, 0, 20, 20), r(0, 0, 1919, 1080)] {
            assert!(pick(&[app(2, cover, false), app(1, LEFT, true)], &[LEFT]).is_some());
        }
        assert!(pick(&[app(2, LEFT, false), app(1, LEFT, true)], &[LEFT]).is_none());
        assert!(pick(&[app(1, LEFT, true), app(2, LEFT, false)], &[LEFT]).is_some());
    }
    #[test]
    fn multiple_covering_windows_are_combined_without_double_counting() {
        let claude = app(1, LEFT, true);
        let left_half = app(2, r(0, 0, 960, 1080), false);
        let right_half = app(3, r(960, 0, 1920, 1080), false);
        assert!(pick(&[left_half.clone(), right_half, claude.clone()], &[LEFT]).is_none());
        // 两扇重复覆盖左半，面积相加虽等于整屏，右半仍然露出。
        assert!(pick(&[left_half.clone(), left_half, claude.clone()], &[LEFT]).is_some());
        // 中央只留 1px 的缝隙仍算露出。
        assert!(pick(&[app(2, r(0, 0, 960, 1080), false),
            app(3, r(961, 0, 1920, 1080), false), claude], &[LEFT]).is_some());
    }
    #[test]
    fn edge_touch_and_snapped_neighbours_do_not_cover() {
        let ws = [app(2, r(960, 0, 1920, 1080), false), app(1, r(0, 0, 960, 1080), true)];
        assert!(pick(&ws, &[LEFT]).is_some());
    }
    #[test]
    fn overlays_are_ignored_but_normal_topmost_apps_and_owned_dialogs_block() {
        let mut overlay = app(2, LEFT, false);
        overlay.ignored = true;
        assert!(pick(&[overlay.clone(), app(1, LEFT, true)], &[LEFT]).is_some());
        // main_candidate=false 只是不作为 Claude 主窗，仍然可以是普通应用的对话框。
        overlay.ignored = false;
        overlay.main_candidate = false;
        assert!(pick(&[overlay, app(1, LEFT, true)], &[LEFT]).is_none());
    }
    #[test]
    fn spanning_window_qualifies_on_clear_monitor_only() {
        let ws = [app(2, LEFT, false), app(1, r(0, 0, 3840, 1080), true)];
        let t = pick(&ws, &[LEFT, RIGHT]).unwrap();
        assert_eq!(t.monitor, RIGHT);
        assert_eq!(position(t, (220, 60), (3000.0, 130.0)).0, RIGHT.left);
        let ws = [app(3, RIGHT, false), ws[0].clone(), ws[1].clone()];
        assert!(pick(&ws, &[LEFT, RIGHT]).is_none());
    }
    #[test]
    fn negative_coordinates_and_monitor_gaps() {
        let neg = r(-1920, -200, 0, 880);
        assert!(pick(&[app(2, LEFT, false), app(1, neg, true)], &[neg, LEFT]).is_some());
        assert!(pick(&[app(1, r(0, 1200, 800, 1800), true)], &[LEFT, RIGHT]).is_none());
        assert!(intersection(r(2, 0, 1, 4), LEFT).is_none());
    }
    #[test]
    fn candidate_uses_its_own_dpi() {
        let mut w = app(1, r(0, 0, 720, 540), true);
        w.scale = 1.5;
        assert!(pick(&[w.clone()], &[LEFT]).is_some());
        w.frame.right -= 1;
        assert!(pick(&[w], &[LEFT]).is_none());
    }
    #[test]
    fn current_anchor_is_sticky_until_covered() {
        let first = [app(1, LEFT, true), app(2, RIGHT, true)];
        let old = pick(&first, &[LEFT, RIGHT]);
        let reordered = [first[1].clone(), first[0].clone()];
        assert_eq!(choose(&assess(&reordered, &[LEFT, RIGHT]), old).unwrap().hwnd, 1);
        let covered = [app(3, LEFT, false), first[1].clone(), first[0].clone()];
        assert_eq!(choose(&assess(&covered, &[LEFT, RIGHT]), old).unwrap().hwnd, 2);
    }
    #[test]
    fn current_monitor_is_sticky_until_covered() {
        let spanning = app(1, r(0, 0, 3840, 1080), true);
        let a = assess(&[spanning.clone()], &[LEFT, RIGHT]);
        let old = Some(a[0].target);
        assert_eq!(choose(&a, old).unwrap().monitor, LEFT);
        let b = assess(&[app(2, LEFT, false), spanning], &[LEFT, RIGHT]);
        assert_eq!(choose(&b, old).unwrap().monitor, RIGHT);
    }
}
