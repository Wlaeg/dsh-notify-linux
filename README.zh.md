# dsh-notify-linux

[English](README.md) | **中文**

为 Linux + GNOME 上的 DSH（DeepSeek Harness）提供桌面通知与提示音。DSH 完成任务、
需要你做出选择、有工具调用等待批准，或者执行出错时，主动提醒你。

通知由 **DSH 主进程**发出，而不是浏览器页面 —— 因此页面切到后台标签、窗口最小化，
甚至页面完全关闭时，提醒一样能送到。

- 无 npm 运行时依赖（Host 半身只用 Node 内置模块）
- 通知走 `notify-send`，声音走 `paplay`，并以 `canberra-gtk-play` 兜底
- 浏览器侧兜底（页内浮层、Web Notification、Web Audio 合成音），
  用于系统通道不可用的环境
- 可选「优先用浏览器通知」：页面开着时改走浏览器自己的通知，点一下就把浏览器
  切回对应的 DSH 标签页
- 所有开关都能在 DSH 设置页调整，也可以直接改一个 JSON 文件

---

## 会提醒哪些情况

共四类事件。每一类都有独立开关、独立的紧迫度与图标，以及各自的音效
（`turnEnd` 除外，它用你选择的提示音主题）。

| 类型 | 触发时机 | 通知标题 | 紧迫度 | 图标 | 声音 |
|---|---|---|---|---|---|
| `turnEnd` | 整个 agent 回合即将结束，模型不再有待回答的输出 | `DSH 已完成任务` | normal | `dialog-information` | 所选主题 |
| `question` | 模型请求你作答（单选 / 多选 / 自由文本） | `DSH 正在等待你的选择` | normal | `dialog-information` | `message-new-instant` |
| `approval` | 某个工具调用在等待人类放行 | `DSH 需要你的批准` | normal | `dialog-information` | `dialog-information` |
| `error` | 某一步或整个回合失败 | `DSH 执行出错` | critical | `dialog-error` | `dialog-error` |

通知正文会带上会话标识，方便你认出是哪一摊活。格式为
`<工作区名> · <会话 id 前 8 位>`，后接事件细节，例如：

```
DSH 已完成任务
default-workspace · 44b6a957 的回合已结束
```

`turnEnd` 挂在 `agent/turn-stopping` 上 —— 那是回合真正结束的时点。工具调用的往返
不会触发它，只有整个回合收尾才会。

> 通知文案目前是中文（由 Host 半身发出）。设置页本身是完整双语的（中文与英文）。

---

## 为什么在 Host 侧发通知

纯浏览器通知方案有一个硬限制：只有页面开着、浏览器还活着的时候才有效。切到别的
窗口、把浏览器最小化、或者关掉标签页，通知就根本送不到。

而 DSH 主进程的存活时间比页面长得多。`notify-send` 走 GNOME 通知中心，所以即使页面
没聚焦、浏览器不在前台，甚至页面根本没打开，通知与声音一样会到。

因此浏览器半身不做重复投递，而是负责另外三件事：

| 半身 | 文件 | 职责 |
|---|---|---|
| Host | `index.js`（601 行） | 监听四类事件、发出真实的系统通知与声音、持久化配置、提供 HTTP API |
| 浏览器 | `client.js`（766 行） | 设置页、页内浮层，以及在 Host 侧没能送出时用 Web Notification / Web Audio 兜底 |

是否兜底由 Host 随每个事件返回的两个布尔值 `desktop` 与 `sound` 决定，它们的含义是
「这次真的发出去了没有」。系统通知既然已经送出，浏览器就保持安静，绝不会提醒两遍。

打开「优先用浏览器通知」（`browserFirst`）后，规则变成：只要还有页面连着，Host 就把
这次事件定向发给其中一个标签页（优先刚聚焦的那个），并跳过系统通知；页面全关时再退回
系统通知。定向投递靠每个 SSE 连接自带的 `clientId`，`notify` 帧里的 `channel` 字段告诉
浏览器这次是不是由它负责弹出。

点通知要回到「发起它的那个会话」，这件事浏览器做不了：DSH Web 的所有会话共用同一个地址，
浏览器最多把标签页提到前台。所以 `notify` 帧里带着完整 `sessionId`，浏览器半身在点击回调里
调 `uiWorkspace.openSession(sessionId)` 显式切过去，并回一条 `POST /click` 作为回执。

---

## 环境要求

| 项目 | 说明 |
|---|---|
| 平台 | **Linux + GNOME**（已在 Manjaro GNOME、Wayland 下验证） |
| DSH | 任意带 Cordis 插件系统、提供 `webServer` 与 `settings.section` 插槽的 DSH 构建 |
| Node | **>= 22**（DSH 自身的要求） |
| 通知 | **libnotify** 提供的 `notify-send` |
| 声音 | **pulseaudio-utils** 提供的 `paplay`，或 **libcanberra** 提供的 `canberra-gtk-play` |
| 声音文件 | `/usr/share/sounds/freedesktop/stereo`（freedesktop 声音主题） |
| npm 依赖 | **无** —— `package.json` 里没有 `dependencies` |

这些外部工具在某种意义上都是可选的，因为插件会优雅降级：如果 `notify-send` 不存在，
插件会把这个能力标记为不可用，浏览器半身就可以用 Web Notification 接手。事件分发路径上
从不 await 任何东西 —— 命令缺失或执行失败都绝不会拖住 agent。

插件在运行时探测这些工具，并在设置页里报告结果（`notify-send`、`paplay`、
`canberra-gtk-play` 各显示为可用或不可用）。

---

## 安装

这是一个 DSH 的 Cordis 插件 **bundle**。请通过 DSH 的插件管理（`plugin_manager`，
动作 `install_bundle`）安装，指向以下任一来源：

- **本地目录** —— `/home/wlaeg/文档/deepseek-harness/default-workspace/dsh-notify`
- 或 **Git 仓库** —— `https://github.com/Wlaeg/dsh-notify-linux`

bundle 在 `package.json` 里声明了自己的 patch：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] }
  }
}
```

而 patch 只有一行 `insert`，用来挂载 Host 半身：

```yaml
- insert:
    - id: dsh-notify-linux
      name: 'dsh-notify-linux'
      config: {}
```

浏览器半身由 `dsh.client` 声明，并绑定在 `name` 为裸包名的那一行上 —— 子路径形式的
条目不会携带浏览器半身。

安装完成后插件即生效。刷新一次 DSH Web 界面，浏览器半身就会注册它的设置分区。
没有额外的 CLI 安装步骤。

> **替换已安装的副本**（例如改完源码之后）需要重启 DSH 宿主进程。插件管理会立刻改写依赖
> 与 patch，但正在运行的进程仍持有启动时加载的那一代 JS 模块，旧路由与旧处理器会一直活着
> 直到 DSH 重启 —— 只刷新页面不够。宿主半身的 HTTP 路由让这一点很好判断：旧副本还在时，
> `GET /api/dsh-notify-linux/config` 会返回 `401`，因为旧的 `/api/dsh-notify` 前缀路由仍在
> 抢这条路径。

---

## 设置页

设置分区名为「任务通知」（`settings.section` 插槽，order 30）。其中包含：

- 总开关
- 四类事件的开关
- 桌面通知 / 提示音的开关，以及完成时的提示音主题
- 子代理、仅前台不打扰、冷却时间等选项
- 浏览器通知分组（含「优先用浏览器通知」开关），并显示当前浏览器通知权限
- **试一下** 一行：每个事件类型一个按钮，走与真实通知完全相同的投递路径
- 能力检测行：显示本机是否找到了 `notify-send`、`paplay`、`canberra-gtk-play`

> **截图占位** —— 本仓库目前还没有截图，因此这里不引用任何图片。本块是显式的占位，
> 不是坏链。

---

## 配置

所有选项都在一个文件里：

```
<DSH profile 目录>/dsh-notify-linux.json
```

profile 目录的解析顺序是 `$DSH_PROFILE_DIR`，否则为
`$DSH_HOME/profiles/$DSH_PROFILE`（默认 `~/.dsh/profiles/web`）。在本机上即
`~/.dsh/profiles/web/dsh-notify-linux.json`。

文件以**原子方式**写入（临时文件 + `rename`），权限为 **0600**，所以读侧永远看不到
写了一半的 JSON。你可以直接改它 —— 每次推送通知都会重新读取 —— 也可以用设置页，
它走的是同一套写入逻辑。

### 默认值

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关掉后所有事件都不再提醒。 |
| `systemNotify` | boolean | `true` | 经 `notify-send` 发桌面通知。 |
| `systemSound` | boolean | `true` | 播放系统声音主题里的提示音。 |
| `browserToast` | boolean | `true` | 显示页内浮层。 |
| `browserNotify` | boolean | `true` | 用 Web Notification 兜底。需要浏览器授权。 |
| `browserSound` | boolean | `false` | 用 Web Audio 合成音兜底。 |
| `browserFirst` | boolean | `false` | 优先用浏览器通知：页面开着时由浏览器投递，点击通知可切回该标签页；页面关掉后自动退回系统通知。 |
| `soundTheme` | string | `'complete'` | `turnEnd` 使用的提示音，取值为 `complete`、`message`、`bell`、`none`。 |
| `events.turnEnd` | boolean | `true` | 回合结束时提醒。 |
| `events.question` | boolean | `true` | 模型需要你选择时提醒。 |
| `events.approval` | boolean | `true` | 工具调用需要批准时提醒。 |
| `events.error` | boolean | `true` | 某一步或整个回合失败时提醒。 |
| `includeSubagents` | boolean | `false` | 子代理会话也提醒（默认关闭，避免并行任务刷屏）。 |
| `onlyWhenUnfocused` | boolean | `false` | DSH 窗口在前台时，不弹系统通知、不播声音。 |
| `cooldownSeconds` | number | `3` | 同一类提醒的最小间隔，取值限制在 `0`–`120`。`0` 表示关闭冷却。 |

未知字段会被丢弃，类型不对就退回默认值，文件缺失或损坏则静默恢复默认 ——
通知配置永远不该让插件挂掉。

示例：

```json
{
  "enabled": true,
  "systemNotify": true,
  "systemSound": true,
  "browserToast": true,
  "browserNotify": true,
  "browserSound": false,
  "soundTheme": "message",
  "events": { "turnEnd": true, "question": true, "approval": true, "error": true },
  "includeSubagents": false,
  "onlyWhenUnfocused": true,
  "cooldownSeconds": 5
}
```

### 提示音主题

`turnEnd` 用你选择的主题，其余三类事件音效固定。

| 主题 | `/usr/share/sounds/freedesktop/stereo` 下的文件 | 界面文案 |
|---|---|---|
| `complete` | `complete.oga` | 轻快完成音 |
| `message` | `message.oga` | 消息提示音 |
| `bell` | `bell.oga` | 铃声 |
| `none` | — | 静音 |

设置页只会列出本机确实存在对应 `.oga` 文件的主题。若播放时文件不在，则跳过 `paplay`，
回退到 `canberra-gtk-play -i <sound>`。

---

## 架构

### Host 半身（`index.js`）

| 行号 | 作用 |
|---|---|
| `:196` | `sendDesktop(title, body, kind)` —— 拉起 `notify-send`，带 `-a DSH`、图标、紧迫度、`-t 8000` |
| `:209` | `playSound(sound)` —— 先 `paplay` 播放主题文件，否则 `canberra-gtk-play` |
| `:244` | `broadcast(event, data)` —— 给所有 SSE 连接发一帧 |
| `:258` | `sendTo(res, event, data)` —— 只给指定连接发一帧 |
| `:277` | `pickStream()` —— 挑定向投递目标：聚焦的优先，其次最近活跃的 |
| `:293` | `describe(agent)` —— 取工作区名、会话短号，以及随通知下发的完整 `sessionId` |
| `:312` | `fire(kind, title, body, sessionId)` —— 依次应用总开关、单事件开关、冷却，然后按 `browserFirst` 决定投递通道 |
| `:356` | `agent/turn-stopping` 处理器 → `turnEnd` |
| `:366` | `user-questions/request` waterfall 处理器 → `question` |
| `:384` | `approval/request` waterfall 处理器 → `approval` |
| `:401` | `agent/error` 处理器 → `error` |
| `:473` | `openStream(req, res)` —— SSE 长连接，从 `?client=` 取标签页标识 |
| `:570` | `POST /click` —— 浏览器通知被点击后的回执；`GET /config` 里的 `lastClick` 即来自此处 |
| `:590` | `ctx.inject(['webServer'])` —— 等 `webServer` 就绪后注册 HTTP 路由 |

有三个值得了解的设计决定：

1. **即发即忘（fire-and-forget）。** 通知以 detached 子进程方式拉起并 `unref()`。
   事件分发路径绝不 await 外部进程，通知失败也绝不影响 agent。插件刻意不使用 DSH 的
   `subprocess` 服务，因为那个服务的契约是「调用方持有句柄并对生命周期负责」，
   与这里想要的恰好相反。
2. **waterfall 里必须 `return next()`。** `user-questions/request` 与
   `approval/request` 都是串行责任链。本插件是纯观察者：监听器只做副作用，然后把
   `next()` 原样委托下去。一旦忘记委托，Host 侧的问询与批准流程会全部卡死。
3. **会话总线环境修复。** 如果 DSH 是从 systemd 用户单元或 SSH 里拉起的，
   `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` 可能缺失，`notify-send` 会静默失败。
   插件在拉起子进程前补上 `unix:path=/run/user/<uid>/bus` 与 `/run/user/<uid>`。

通知使用了 `-h string:x-canonical-private-synchronous:dsh-notify-linux-<kind>`，
所以同类的新通知会顶替上一条，连续回合不会把通知中心刷满。

### 浏览器半身（`client.js`）

| 行号 | 作用 |
|---|---|
| `:272` | `requestPermission()` —— 在用户手势里请求 Web Notification 权限 |
| `:288` | `beep(kind)` —— 用振荡器现场合成提示音，每类事件一段音符序列 |
| `:313` | `webNotify(title, body, kind, activate)` —— Web Notification，带按类型的 `tag` 与 `silent: true`，点击时回调 `activate` |
| `:346` | `showToast(title, body, tone, onClick)` —— 原生 DOM 页内浮层，7 秒后自动消失 |
| `:642` | SSE effect —— 维护配置副本、订阅事件流；`:676` 的 `activate()` 负责点通知后切回会话并回执（会话选择器不是 URL 路由，只能靠 `ctx.uiWorkspace.openSession(id)`；该服务未 inject 时直接读会抛错，因此用 `ctx.reflect.get('uiWorkspace')` 兜底） |
| `:722` | `new EventSource('/api/dsh-notify-linux/events?client=<clientId>')` —— 订阅实时事件流 |
| `:755` | `ctx.slots.register({ name: 'settings.section', id: 'dsh-notify-linux', order: 30 })` |

浏览器半身是手写的 `ModuleLoader` 包：无构建步骤，除 shell 已提供的 `react` 外无依赖，
颜色全部走主题变量，因此跟随明暗模式切换。

合成提示音的音符序列（`[频率 Hz, 偏移 秒]`）：

```
turnEnd  880 → 1318
question 740 → 740
approval 988 → 988
error    300 → 220
```

播放结束后 800 ms 会关闭 `AudioContext`，避免它一直占着一条音频通道。

### HTTP 接口

Host 半身在 DSH 的 `webServer` 上注册了同源路由前缀：

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/dsh-notify-linux/config` | 当前配置、工具能力、可用提示音主题、窗口聚焦状态 |
| `POST` | `/api/dsh-notify-linux/config` | 局部更新配置（深合并，含 `events`），并落盘 |
| `POST` | `/api/dsh-notify-linux/test` | 用正常链路真实触发一次指定 `kind` 的通知 |
| `POST` | `/api/dsh-notify-linux/presence` | 上报窗口是否聚焦（供 `onlyWhenUnfocused` 使用），并带上 `clientId` 以便定向投递时认出标签页 |
| `POST` | `/api/dsh-notify-linux/click` | 浏览器通知被点击后的回执（`sessionId`、`kind`），用于排查「点了没跳」 |
| `GET` | `/api/dsh-notify-linux/events` | SSE 事件流：`hello`（能力）、`notify`（真实的一次投递，帧里带 `channel`）、`config`（配置变更）；可带 `?client=<id>` |

SSE 流每 25 秒发一条 `: ping` 注释，避免空闲连接被中间的代理掐断。浏览器半身在连续
6 次连接失败后会主动退避（等 30 秒再试），而不是无限紧循环重连。

`notify` 帧里的 `channel` 取 `browser`（由这条连接负责弹出，浏览器会把它和标签页绑定，
点击通知即切回该标签页）或 `none`（走系统通知）。多个标签页同时开着时，只有被选中的
那条连接收到事件，不会每个标签页弹一次。

### 安全边界

DSH 的 `webServer` 常绑 `0.0.0.0`，但这些路由能改插件配置、能触发真实通知，
不该对公网开口。每个请求都要过 `allowed(req)`，只放行：

- `127.0.0.1`、`::1`、`localhost` 或空地址
- `10.0.0.0/8`、`127.0.0.0/8`
- `192.168.0.0/16`
- `172.16.0.0/12`
- IPv6 唯一本地地址 `fc00::/7` 与链路本地地址 `fe80::/10`

其余一律返回 `403 {"error":"forbidden"}`。请求体上限 64 KiB。

---

## 已验证行为

以下均为在真机（Manjaro GNOME、Wayland）上装好插件、跑着真实 DSH 会话时观测到的：

- **抓到了真实的 D-Bus 通知调用。** 触发事件时监控会话总线，看到了插件发出的真实
  `org.freedesktop.Notifications.Notify` 方法调用，也就是说通知确实经由 GNOME 通知
  中心，而不是任何模拟层。
- **真实回合结束触发了真实通知。** 在活动会话中，通知正文为：

  ```
  default-workspace · 44b6a957 的回合已结束
  ```

  —— 工作区名取自会话的 `cwd`，后接会话 id 的前 8 个字符。
- **真实播放了声音。** 通知触发时 `pactl list sink-inputs` 抓到了 `paplay` 的
  sink-input，说明音频链路（而不只是文件查找）是通的。

设置页的「试一下」按钮调用 `/test`，走的是与真实事件完全相同的 `fire()` 路径，
所见即所得。

---

## 故障排查

| 现象 | 排查方向 |
|---|---|
| 没有桌面通知 | `notify-send` 是否已安装且在 `PATH` 里？设置页的能力行会显示。 |
| 没有声音 | `paplay`（或 `canberra-gtk-play`）是否存在，`.oga` 文件是否在 `/usr/share/sounds/freedesktop/stereo` 下？ |
| 只是偶尔没提醒 | `cooldownSeconds` 会压制同类重复提醒 —— 调小或设为 `0`。 |
| 完全没有提醒 | `enabled` 必须为 `true`，且对应 `events.<kind>` 开关要打开。 |
| 盯着 DSH 时不提醒 | `onlyWhenUnfocused` 开着 —— 窗口在前台时按设计不弹系统通知、不播声音。 |
| 设置页打不开 | Host 半身需要 `webServer` 服务；后端不可达时页面会显示重试按钮。 |
| 子代理任务没有提醒 | `includeSubagents` 默认就是 `false`。打开后才会包含。 |

---

## 卸载

通过 DSH 的插件管理（`plugin_manager`，动作 `remove_bundle`）移除 `dsh-notify-linux`，
然后删掉遗留的配置文件：

```bash
rm -f ~/.dsh/profiles/web/dsh-notify-linux.json
```

系统上没有安装任何其它东西 —— 没有 systemd 单元，也没有 DSH profile 与插件目录之外的
文件。插件播放的声音文件属于 freedesktop 声音主题，保持不动。

---

## 许可

MIT © Wlaeg (wlaeg@users.noreply.github.com)
