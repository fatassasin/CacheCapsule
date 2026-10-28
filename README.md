# CacheCapsule

Claude 桌面端（Windows）的缓存保活小胶囊。独立的 Tauri 程序，只要 Claude 主窗口在任一屏幕上还有部分露出就出现，与键盘焦点无关，
可以拖到任意位置，位置记在相对 Claude 窗口的右下角偏移里。

视觉和 `../cache-keepalive-mockup/index.html` 定稿一致：磨砂黑 + 小克菊，倒计时条白色，计数点橙色。

## 分工

保活必须在 Claude Code 进程里做——只有它够得到当前会话的缓存前缀——所以拆成两半：

| | 做什么 |
| --- | --- |
| `cache-keepalive` mod（`mod/`） | 切 5m / 1h 写入 TTL；到点 `$.model.fork` 发一条最短的读缓存请求；窗口关闭、缓存过期、次数用完就停 |
| CacheCapsule（本目录） | 显示状态、改设置、「立即保活」；按各屏 Claude 主窗口的遮挡情况决定显隐 |

两边只通过 `%USERPROFILE%\.claude\cache-keepalive\` 里的文件说话：

- `settings.json`：胶囊写、mod 每秒读。`{tiers:{'5m':{iv,max},'1h':{iv,max}}}`，各档的间隔和次数，所有聊天共用。
- `chats/<会话>.json`：胶囊写、mod 每秒读。`{ttl, isOn, pingNonce}`，每个聊天自己一份；没有文件就是关，只有在这个聊天里打开过开关才会写。`pingNonce` 加一即「立即保活」。
- `state/<会话>.json`：mod 写、胶囊读。含 `sid ttl sent nextAt warmAt status note last activeAt beat ended`。`beat` 是心跳，20 秒没更新就当会话没了。
- `capsule.json`：胶囊自己的，`{offR, offB}`。

`<会话>` 是 Claude Code 的会话 id。胶囊只显示桌面版眼下打开的那个聊天：桌面版切聊天时会改
`%LOCALAPPDATA%\Claude-3p\claude-code-sessions\<账号>\<组织>\local_*.json` 里的 `lastFocusedAt`，取最大的那条未归档记录的 `cliSessionId`。
开关、档位、状态标签、倒计时、已保活次数和上次用量都跟着它换；那个聊天还没起会话时显示「未打开对话」，开关不能点。
找不到这些记录（比如不是桌面版）时退回显示最近有动静的会话。

### 安装 mod

`mod/` 自带一个本地插件市场，装到用户级后每个聊天都会加载：

```bash
claude plugin marketplace add "<本目录>\mod"
claude plugin install cache-keepalive@cachecapsule --scope user
```

装好后已经开着的聊天要 `/reload-plugins` 或重开才会加载。改了 `mod/` 之后用 `claude plugin update cache-keepalive@cachecapsule` 更新缓存里的副本。
用 CC Switch 管 `~/.claude/settings.json` 的话，它切换配置时会用自己库里的副本覆盖，`enabledPlugins` 和 `extraKnownMarketplaces` 也要写进 CC Switch 当前供应商的配置里。
开关打开、但胶囊显示「本对话未接入保活」，就是这个聊天里 mod 没加载。

测试：`cd mod && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .`

## 显隐规则

每 100ms 读取当前虚拟桌面的窗口 Z 序、可见边框和各显示器的物理边界，不读取键盘焦点。
Claude 主窗口必须不小于 480×360 逻辑像素（按它自身的 DPI），进程是 `Claude.exe` 且路径不含 `claude-code`。
对每个 Claude 窗口，分别检查它在各屏幕上的部分：逐一扣除更高层其他应用窗口的覆盖区域；只要某一屏还有部分露出，就显示并跟随。

- 主屏 Claude、右屏 YouTube 获焦：显示。
- 主屏 Chrome 小窗遮住 Claude 一角：继续显示；完全盖住才隐藏。
- 多扇应用窗口联合盖满 Claude 也隐藏；重复重叠的遮挡区域不会重复计数。
- 同屏并排且不重叠：显示；边缘相接不算遮挡。
- 某屏被盖住，另一屏还有合格的 Claude：显示并跟随合格窗口。跨屏窗口同样逐屏判断。
- 胶囊自身、工具/被动浮层、穿透式浮层和任务栏不算遮挡；HoverNote/QuotaSidebar 的小折角/额度条也忽略，但展开的正常面板仍算遮挡。普通应用的对话框和置顶窗口仍算。
- 关闭、最小化、收进托盘或其他虚拟桌面的 Claude 不参与。

优先保留当前锚定窗口及屏幕，避免切换焦点时跳位置。自动约束到合格屏幕不覆盖保存的拖动偏移。
检测到隐藏条件就立即收起，不加防抖延迟；每 100ms 检测一次。显示用 `SW_SHOWNOACTIVATE`，不抢键盘焦点。

原生窗口绘制沿用 Localless 的药丸修复：删除标题栏/缩放边框样式、补 `WS_POPUP`，
关闭 DWM 非客户区绘制和过渡动画，并用窗口子类包住 `WM_NCACTIVATE / WM_SETTEXT / WM_SETICON`。
单改样式不够：`DefWindowProc` 处理这三条消息时仍可能直接画出蓝色标题条。
子类暂摘 `WS_VISIBLE` 后正常传递消息，再恢复该位，禁止绘制但保留焦点和输入；不实际隐藏窗口。
监视循环会修正 tao 写回的边框样式，避免后续激活、显隐后复发。

## 开机启动

每次运行都会在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写入 `CacheCapsule`（当前 exe 路径），
于是它出现在「Windows 设置 → 应用 → 启动」和任务管理器的启动列表里，开关就在那里管。
程序从不改开关状态：Windows 把它记在 `Explorer\StartupApproved\Run`，路径刷新不会覆盖。胶囊和托盘里没有重复的开关。

从 Claude 桌面版的会话里（终端、Claude Code）直接启动的进程处在 MSIX 包的注册表虚拟化里，写进 HKCU 的值只进包的私有副本，
系统设置看不到。要登记成功，至少有一次从资源管理器、开始菜单或 `explorer.exe <exe 路径>` 启动。

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
- 「眼下打开的聊天」靠桌面版私有的会话记录格式（`lastFocusedAt`、`cliSessionId`），桌面版改了格式就会退回按最近动静挑。
- 分屏同时看两个聊天时，只跟最后点过的那个。
- 显隐按窗口的矩形边界判断，不逐像素解析应用内容；普通应用透明内容/不规则窗口可能按完整矩形算遮挡。
- 只支持 Windows。
