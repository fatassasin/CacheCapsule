//! 桌面版眼下显示的是哪个聊天。
//!
//! 桌面版每切到一个聊天，就把那个会话记录里的 `lastFocusedAt` 改成当时的时间；
//! 记录在 `%LOCALAPPDATA%\<Claude-3p 或 Claude>\claude-code-sessions\<账号>\<组织>\local_*.json`。
//! 其中的 `cliSessionId` 就是 Claude Code 自己的会话 id，mod 写 `state/<id>.json` 用的正是它。
//! 应用重启后重新打开上次的聊天时不一定再写一次，所以按「最后聚焦」取，而不是跟日志里的切换行。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Value;

struct Record {
    mtime: SystemTime,
    focused_at: u64,
    cli: Option<String>,
    is_archived: bool,
}

/// 记录有八九十个，每秒都读一遍不值当：只重读改动过的文件。
static CACHE: Mutex<Option<HashMap<PathBuf, Record>>> = Mutex::new(None);

fn roots() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return Vec::new() };
    ["Claude-3p", "Claude"].iter().map(|d| local.join(d).join("claude-code-sessions")).collect()
}

/// `<根>\<账号>\<组织>\local_*.json`，深度固定，不往别处翻。
fn record_files() -> Vec<(PathBuf, SystemTime)> {
    let mut out = Vec::new();
    let mut dirs: Vec<(PathBuf, u8)> = roots().into_iter().map(|r| (r, 0)).collect();
    while let Some((dir, depth)) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if depth < 2 {
                    dirs.push((path, depth + 1));
                }
            } else if is_record(&path) {
                out.push((path, meta.modified().unwrap_or(SystemTime::UNIX_EPOCH)));
            }
        }
    }
    out
}

fn is_record(path: &Path) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    name.starts_with("local_") && name.ends_with(".json")
}

fn parse(text: &str, mtime: SystemTime) -> Option<Record> {
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    Some(Record {
        mtime,
        focused_at: v.get("lastFocusedAt").and_then(Value::as_u64).unwrap_or(0),
        cli: v.get("cliSessionId").and_then(Value::as_str).filter(|s| is_session_id(s)).map(str::to_owned),
        is_archived: v.get("isArchived").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// 会话 id 会拼进文件名，只认 UUID 那样的字符。
pub fn is_session_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// 最后聚焦的那个聊天。
/// `None`：没找到桌面版的会话记录，调用方自己想办法；`Some(None)`：那个聊天还没起 Claude Code 会话。
pub fn current() -> Option<Option<String>> {
    let files = record_files();
    if files.is_empty() {
        return None;
    }
    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(HashMap::new);
    let present: HashSet<&PathBuf> = files.iter().map(|(p, _)| p).collect();
    cache.retain(|p, _| present.contains(p));
    for (path, mtime) in &files {
        if cache.get(path).is_some_and(|r| r.mtime == *mtime) {
            continue;
        }
        // 桌面版正写到一半读不出来就先沿用旧的，下一秒再试。
        if let Some(r) = fs::read_to_string(path).ok().and_then(|t| parse(&t, *mtime)) {
            cache.insert(path.clone(), r);
        }
    }
    pick(cache.values())
}

fn pick<'a>(records: impl Iterator<Item = &'a Record>) -> Option<Option<String>> {
    records
        .filter(|r| !r.is_archived && r.focused_at > 0)
        .max_by_key(|r| r.focused_at)
        .map(|r| r.cli.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(json: &str) -> Record {
        parse(json, SystemTime::UNIX_EPOCH).unwrap()
    }

    #[test]
    fn picks_the_chat_focused_last() {
        let a = rec(r#"{"cliSessionId":"aaa-1","lastFocusedAt":100}"#);
        let b = rec(r#"{"cliSessionId":"bbb-2","lastFocusedAt":200}"#);
        assert_eq!(pick([&a, &b].into_iter()), Some(Some("bbb-2".into())));
    }

    #[test]
    fn archived_and_never_focused_chats_do_not_count() {
        let a = rec(r#"{"cliSessionId":"aaa-1","lastFocusedAt":100}"#);
        let b = rec(r#"{"cliSessionId":"bbb-2","lastFocusedAt":300,"isArchived":true}"#);
        let c = rec(r#"{"cliSessionId":"ccc-3"}"#);
        assert_eq!(pick([&a, &b, &c].into_iter()), Some(Some("aaa-1".into())));
    }

    #[test]
    fn a_chat_without_a_session_yet_is_known_but_empty() {
        let a = rec(r#"{"lastFocusedAt":100}"#);
        assert_eq!(pick([&a].into_iter()), Some(None));
        assert_eq!(pick([].into_iter()), None);
    }

    #[test]
    fn ids_that_could_leave_the_folder_are_refused() {
        let a = rec(r#"{"cliSessionId":"..\\..\\evil","lastFocusedAt":100}"#);
        assert_eq!(a.cli, None);
        assert!(is_session_id("c48fb10c-fc56-4976-ac99-ebb95b38fd5a"));
    }
}
