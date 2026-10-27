# CacheCapsule

Claude 桌面端（Windows）的缓存保活小胶囊。独立的 Tauri 程序，只要 Claude 主窗口在任一屏幕上未被其他应用遮挡就出现，与键盘焦点无关，
可以拖到任意位置，位置记在相对 Claude 窗口的右下角偏移里。

视觉和 `../cache-keepalive-mockup/index.html` 定稿一致：磨砂黑 + 小克菊，倒计时条白色，计数点橙色。

## 分工

保活必须在 Claude Code 进程里做——只有它够得到当前会话的缓存前缀——所以拆成两半：

| | 做什么 |
| --- | --- |
| `cache-keepalive` mod（`~/.claude/dev-mods/…/cache-keepalive`） | 切 5m / 1h 写入 TTL；到点 `$.model.fork` 发一条最短的读缓存请求；窗口关闭、缓存过期、次数用完就停 |
| CacheCapsule（本目录） | 显示状态、改设置、「立即保活」；按各屏 Claude 主窗口的遮挡情况决定显隐 |

两边只通过 `%USERPROFILE%\.claude\cache-keepalive\` 里的文件说话：

- `settings.json`：胶囊写、mod 每秒读。`{ttl, isOn, pingNonce, tiers:{'5m':{iv,max},'1h':{iv,max}}}`。`pingNonce` 加一即「立即保活」。
- `state/<会话>.json`：mod 写、胶囊读。含 `ttl sent nextAt warmAt status note last activeAt beat ended`。`beat` 是心跳，20 秒没更新就当会话没了；多个会话同时开着，胶囊显示 `activeAt` 最近的那个。
- `capsule.json`：胶囊自己的，`{offR, offB}`。

## 显隐规则

每 100ms 读取当前虚拟桌面的窗口 Z 序、可见边框和各显示器的物理边界，不读取键盘焦点。
Claude 主窗口必须不小于 480×360 逻辑像素（按它自身的 DPI），进程是 `Claude.exe` 且路径不含 `claude-code`。
对每个 Claude 窗口，分别检查它在各屏幕上的部分：只要某一屏的这部分没有被更高层的其他应用窗口遮住，就显示并跟随。

- 主屏 Claude、右屏 YouTube 获焦：显示。
- 主屏 Chrome 完全盖住 Claude，或小窗只盖住一角：隐藏。
- 同屏并排且不重叠：显示；边缘相接不算遮挡。
- 某屏被盖住，另一屏还有合格的 Claude：显示并跟随合格窗口。跨屏窗口同样逐屏判断。
- 胶囊自身、工具/被动浮层、穿透式浮层和任务栏不算遮挡；HoverNote/QuotaSidebar 的小折角/额度条也忽略，但展开的正常面板仍算遮挡。普通应用的对话框和置顶窗口仍算。
- 关闭、最小化、收进托盘或其他虚拟桌面的 Claude 不参与。

优先保留当前锚定窗口及屏幕，避免切换焦点时跳位置。自动约束到合格屏幕不覆盖保存的拖动偏移。
隐藏条件连续约 200ms 才收起，显示不额外延迟。显示用 `SW_SHOWNOACTIVATE`，不抢键盘焦点。

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

诊断：设环境变量 `CACHECAPSULE_TRACE=<文件>`，显隐和位置保存、被拦截的系统标题栏绘制消息、候选 Claude 各屏区域及其遮挡窗口句柄会逐行写进去（判断变化时才记录）。

## 已知限制

- 透明窗口里没有桌面可模糊，磨砂只剩颗粒和略透的深色，做不出定稿稿里的真实背景模糊。
- 胶囊只认「最近有动静」的会话，同时跑多个会话时看不到其余的。
- 显隐按窗口的矩形边界判断，不逐像素解析应用内容；普通应用透明内容/不规则窗口可能按完整矩形算遮挡。
- 只支持 Windows。
