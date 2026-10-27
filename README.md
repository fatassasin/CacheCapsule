# CacheCapsule

Claude 桌面端（Windows）的缓存保活小胶囊。独立的 Tauri 程序，只要屏幕上有 Claude 桌面端的主窗口就出现（哪怕它在后台），
可以拖到任意位置，位置记在相对 Claude 窗口的右下角偏移里。

视觉和 `../cache-keepalive-mockup/index.html` 定稿一致：磨砂黑 + 小克菊，倒计时条白色，计数点橙色。

## 分工

保活必须在 Claude Code 进程里做——只有它够得到当前会话的缓存前缀——所以拆成两半：

| | 做什么 |
| --- | --- |
| `cache-keepalive` mod（`~/.claude/dev-mods/…/cache-keepalive`） | 切 5m / 1h 写入 TTL；到点 `$.model.fork` 发一条最短的读缓存请求；窗口关闭、缓存过期、次数用完就停 |
| CacheCapsule（本目录） | 显示状态、改设置、「立即保活」；检查已显示的 Claude 主窗口决定显隐 |

两边只通过 `%USERPROFILE%\.claude\cache-keepalive\` 里的文件说话：

- `settings.json`：胶囊写、mod 每秒读。`{ttl, isOn, pingNonce, tiers:{'5m':{iv,max},'1h':{iv,max}}}`。`pingNonce` 加一即「立即保活」。
- `state/<会话>.json`：mod 写、胶囊读。含 `ttl sent nextAt warmAt status note last activeAt beat ended`。`beat` 是心跳，20 秒没更新就当会话没了；多个会话同时开着，胶囊显示 `activeAt` 最近的那个。
- `capsule.json`：胶囊自己的，`{offR, offB}`。

## 显隐规则

每 100ms 枚举一次当前虚拟桌面上已显示的顶层窗口（没最小化、不是工具窗口、没有属主），
找进程是 `Claude.exe`（路径不含 `claude-code`，那是桌面端自带的 CLI）、窗口不小于 480×360 的那个：
有就显示并跟随；没有（关了、收进托盘、最小化、在别的虚拟桌面）就藏起来。
Claude 在不在最前面不影响，被别的窗口盖住也照常显示——胶囊是置顶的，会浮在那些窗口上面。
显示用 `SW_SHOWNOACTIVATE`，不抢键盘焦点。

原生窗口绘制沿用 Localless 的药丸修复：删除标题栏/缩放边框样式、补 `WS_POPUP`，
关闭 DWM 非客户区绘制和过渡动画，并用窗口子类包住 `WM_NCACTIVATE / WM_SETTEXT / WM_SETICON`。
单改样式不够：`DefWindowProc` 处理这三条消息时仍可能直接画出蓝色标题条。
子类暂摘 `WS_VISIBLE` 后正常传递消息，再恢复该位，禁止绘制但保留焦点和输入；不实际隐藏窗口。
监视循环会修正 tao 写回的边框样式，避免后续激活、显隐后复发。

## 构建

Rust 在 `~/.cargo/bin`，Git Bash 的 PATH 里没有它。

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd src-tauri && cargo build --release      # target/release/cache-capsule.exe
cargo tauri build                          # NSIS 安装包
```

前端是纯静态页，直接在浏览器里打开 `src/index.html`（`python -m http.server --directory src`）会接一个假后端，用来看样子。

诊断：设环境变量 `CACHECAPSULE_TRACE=<文件>`，显隐和位置保存、被拦截的系统标题栏绘制消息会逐行写进去。

## 已知限制

- 透明窗口里没有桌面可模糊，磨砂只剩颗粒和略透的深色，做不出定稿稿里的真实背景模糊。
- 胶囊只认「最近有动静」的会话，同时跑多个会话时看不到其余的。
- 只支持 Windows。
