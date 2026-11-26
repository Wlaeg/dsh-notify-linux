# dsh-notify-linux

**English** | [中文文档](README.zh.md)

Desktop notifications and a chime for DSH (DeepSeek Harness) on
Linux + GNOME. DSH tells you when it has finished a turn, when it is waiting for you to
choose something, when a tool call needs your approval, and when something failed.

The notifications are sent **by the DSH host process**, not by the browser page — so they
still arrive when the page is in a background tab, when the window is minimized, or when
the page is closed entirely.

- No npm runtime dependencies (the host half uses only Node built-ins)
- Notifications via `notify-send`, sounds via `paplay` with a `canberra-gtk-play` fallback
- Browser-side fallback (in-page toast, Web Notification, synthesized Web Audio chime)
  for environments where the system paths are unavailable
- Optional **Prefer browser notifications**: while the page is open the browser delivers the
  notification, and clicking it brings the browser back to that DSH tab
- All switches configurable in the DSH Settings page or by editing a single JSON file

---

## What it notifies you about

Four event kinds. Each one has its own toggle, its own urgency and icon, and its own
sound (except `turnEnd`, which uses the theme you select).

| Kind | Trigger | Notification title | Urgency | Icon | Sound |
|---|---|---|---|---|---|
| `turnEnd` | The whole agent turn is stopping — the model no longer owes a response | `DSH 已完成任务` | normal | `dialog-information` | selected theme |
| `question` | The model requests an answer from you (single choice / multi choice / free text) | `DSH 正在等待你的选择` | normal | `dialog-information` | `message-new-instant` |
| `approval` | A tool call is waiting for a human to allow it | `DSH 需要你的批准` | normal | `dialog-information` | `dialog-information` |
| `error` | A step or a whole turn failed | `DSH 执行出错` | critical | `dialog-error` | `dialog-error` |

The notification body identifies the session, so you can tell which piece of work it
refers to. Format: `<workspace> · <8-char session id>` plus the event detail, e.g.

```
DSH 已完成任务
default-workspace · 44b6a957 的回合已结束
```

`turnEnd` fires on `agent/turn-stopping` — the point where the turn is genuinely over.
Tool-call round trips do not trigger it; only the end of the whole turn does.

> The notification strings are currently Chinese (they are emitted from the host half).
> The Settings page itself is fully localized (Chinese and English).

---

## Why the host half sends the notifications

A browser-only notification scheme has a hard limitation: it only works while the page is
open and the browser is alive. Switch to another window, minimize the browser, or close
the tab, and the notification is simply never delivered.

The DSH host process lives longer than the page. `notify-send` goes through the GNOME
notification center, so the notification — and the sound — still reach you when the page
is unfocused, when the browser is in the background, or when the page is not open at all.

The browser half therefore does three different things instead of duplicating delivery:

| Half | File | Responsibility |
|---|---|---|
| Host | `index.js` (601 lines) | Listens to the four events, sends the real system notification and sound, persists config, serves the HTTP API |
| Browser | `client.js` (766 lines) | Settings page, in-page toast overlay, and fallback via Web Notification / Web Audio when the host could not deliver |

Whether the browser falls back is decided by two booleans the host returns with each
event — `desktop` and `sound`, meaning "this was actually dispatched". If the system
notification did go out, the browser stays quiet, so you are never notified twice.

With **Prefer browser notifications** (`browserFirst`) on, the rule becomes: as long as a
page is connected, the host targets that one tab (preferring the one focused most recently)
and skips the system notification; when every page is closed it falls back to the system
notification. Targeting uses the `clientId` each SSE connection carries, and the `channel`
field on a `notify` frame says whether the browser is the one that should surface it.

Getting back to the session that raised the notification is not something the browser does: every
DSH Web session shares one URL, so the browser can at best raise the tab. The `notify` frame
therefore carries the full `sessionId`; the browser half calls `uiWorkspace.openSession(sessionId)`
from the click handler and posts `POST /click` as a receipt.

---

## Requirements

| Item | Detail |
|---|---|
| Platform | **Linux + GNOME** (verified on Manjaro GNOME, Wayland) |
| DSH | Any DSH build with the Cordis plugin system (`webServer`, `settings.section` slots) |
| Node | **>= 22** (DSH's own requirement) |
| Notifications | `notify-send` from **libnotify** |
| Sounds | `paplay` from **pulseaudio-utils**, or `canberra-gtk-play` from **libcanberra** |
| Sound files | `/usr/share/sounds/freedesktop/stereo` (the freedesktop sound theme) |
| npm dependencies | **none** — `package.json` has no `dependencies` |

Everything external is optional in the sense that the plugin degrades gracefully: if
`notify-send` is missing, the plugin reports that capability as unavailable and the
browser half can take over with Web Notifications. Nothing is ever awaited on the event
path — a missing or failing command can never stall the agent.

The plugin probes for its tools at runtime and reports the result in the Settings page
(`notify-send`, `paplay`, `canberra-gtk-play` — each shown as available or not).

---

## Installation

This is a DSH Cordis plugin **bundle**. Install it through DSH's plugin manager
(`plugin_manager`, action `install_bundle`), pointing it at either:

- the **local directory** — `/home/wlaeg/文档/deepseek-harness/default-workspace/dsh-notify`
- or the **Git repository** — `https://github.com/Wlaeg/dsh-notify-linux`

The bundle declares its own patch in `package.json`:

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] }
  }
}
```

and the patch is a single `insert` that mounts the host half:

```yaml
- insert:
    - id: dsh-notify-linux
      name: 'dsh-notify-linux'
      config: {}
```

The browser half is declared by `dsh.client` and bound to the row whose `name` is the
bare package name — subpath rows do not carry a browser half.

After installing, the plugin is active. Reload the DSH Web UI page so the browser half
registers its Settings section. There is no separate CLI install step.

> **Replacing an already-installed copy** (for example after editing the source) needs a
> restart of the DSH host process. The plugin manager rewrites the dependency and the
> patch immediately, but the running process keeps the JS module generation it loaded at
> startup, so the old routes and handlers stay live until DSH restarts. A page reload is
> not enough. The host half's HTTP routes make this easy to see: while a stale copy is
> still running, `GET /api/dsh-notify-linux/config` answers `401` because the old
> `/api/dsh-notify` prefix route is still claiming the path.

---

## Settings

The Settings page section is called **Task Notifications** (导航项「任务通知」,
registered on the `settings.section` slot at order 30). It contains:

- the master switch
- the four event toggles
- system notification / sound toggles and the completion-sound theme
- subagent, focus-only and cooldown options
- the browser notification group (including **Prefer browser notifications**), with the current browser notification permission
- a **Try it** row with one button per event kind, using the exact same delivery path as
  a real notification
- a capability row showing whether `notify-send`, `paplay` and `canberra-gtk-play` were
  found on this machine

> **Screenshot placeholder** — no screenshot is included in this repository yet, so no
> image is referenced here. This block is an explicit placeholder, not a broken link.

---

## Configuration

All options live in one file:

```
<DSH profile directory>/dsh-notify-linux.json
```

The profile directory is resolved as `$DSH_PROFILE_DIR`, or otherwise
`$DSH_HOME/profiles/$DSH_PROFILE` (defaults: `~/.dsh/profiles/web`). On this machine that
is `~/.dsh/profiles/web/dsh-notify-linux.json`.

The file is written **atomically** (temp file + `rename`) with mode **0600**, so a reader
never sees half-written JSON. You can edit it directly — it is re-read on every
notification — or use the Settings page, which writes through the same code path.

### Defaults

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. Off disables every notification. |
| `systemNotify` | boolean | `true` | Send a desktop notification via `notify-send`. |
| `systemSound` | boolean | `true` | Play a sound from the system sound theme. |
| `browserToast` | boolean | `true` | Show the in-page toast overlay. |
| `browserNotify` | boolean | `true` | Use Web Notification as a fallback. Requires browser permission. |
| `browserSound` | boolean | `false` | Use the synthesized Web Audio chime as a fallback. |
| `browserFirst` | boolean | `false` | Prefer browser notifications: while the page is open the browser delivers them and clicking one returns to that tab; falls back to the system notification once the page is closed. |
| `soundTheme` | string | `'complete'` | Sound used for `turnEnd`. One of `complete`, `message`, `bell`, `none`. |
| `events.turnEnd` | boolean | `true` | Notify when a turn finishes. |
| `events.question` | boolean | `true` | Notify when the model needs you to choose. |
| `events.approval` | boolean | `true` | Notify when a tool call needs approval. |
| `events.error` | boolean | `true` | Notify when a step or turn fails. |
| `includeSubagents` | boolean | `false` | Also notify for subagent sessions (off by default to avoid parallel-task spam). |
| `onlyWhenUnfocused` | boolean | `false` | Suppress system notification and sound while the DSH window is focused. |
| `cooldownSeconds` | number | `3` | Per-kind minimum interval, clamped to `0`–`120`. `0` disables the cooldown. |

Unknown keys are dropped, wrong types fall back to the default, and a missing or corrupt
file silently reverts to defaults — notification configuration can never break the
plugin.

Example:

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

### Sound themes

`turnEnd` uses the theme you pick; the other three kinds are fixed.

| Theme | File under `/usr/share/sounds/freedesktop/stereo` | Label in the UI |
|---|---|---|
| `complete` | `complete.oga` | 轻快完成音 |
| `message` | `message.oga` | 消息提示音 |
| `bell` | `bell.oga` | 铃声 |
| `none` | — | 静音 (silent) |

The Settings page only offers themes whose `.oga` file actually exists on this machine.
If a file is missing at play time, `paplay` is skipped and the plugin falls back to
`canberra-gtk-play -i <sound>`.

---

## Architecture

### Host half (`index.js`)

| Line | What it does |
|---|---|
| `:196` | `sendDesktop(title, body, kind)` — spawns `notify-send` with `-a DSH`, icon, urgency, `-t 8000` |
| `:209` | `playSound(sound)` — `paplay` on the theme file, else `canberra-gtk-play` |
| `:244` | `broadcast(event, data)` — writes a frame to every SSE connection |
| `:258` | `sendTo(res, event, data)` — writes a frame to one connection only |
| `:277` | `pickStream()` — picks the targeted tab: focused first, then most recently active |
| `:293` | `describe(agent)` — workspace name, short session id, and the full `sessionId` sent with the notification |
| `:312` | `fire(kind, title, body, sessionId)` — applies master switch, per-event toggle and cooldown, then picks the channel via `browserFirst` |
| `:356` | `agent/turn-stopping` handler → `turnEnd` |
| `:366` | `user-questions/request` waterfall handler → `question` |
| `:384` | `approval/request` waterfall handler → `approval` |
| `:401` | `agent/error` handler → `error` |
| `:473` | `openStream(req, res)` — the SSE connection, taking the tab id from `?client=` |
| `:570` | `POST /click` — receipt for a clicked browser notification; feeds `lastClick` in `GET /config` |
| `:590` | `ctx.inject(['webServer'])` — registers the HTTP routes once `webServer` is available |

Three design decisions worth knowing:

1. **Fire-and-forget.** Notifications are spawned as detached child processes that are
   `unref()`ed. The event dispatch path never awaits an external process, and a failing
   notification never affects the agent. The plugin deliberately does not use DSH's
   `subprocess` service, whose contract is "the caller owns the handle and its
   lifecycle" — the opposite of what is wanted here.
2. **`return next()` in waterfalls.** `user-questions/request` and `approval/request` are
   serial responsibility chains. This plugin is a pure observer: its listeners only
   perform side effects and then delegate `next()`. Forgetting the delegation would deadlock
   every question and approval flow in the host.
3. **Session-bus environment repair.** If DSH was started from a systemd user unit or over
   SSH, `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR` may be missing, and `notify-send`
   would then fail silently. The plugin fills in `unix:path=/run/user/<uid>/bus` and
   `/run/user/<uid>` before spawning.

Notifications use
`-h string:x-canonical-private-synchronous:dsh-notify-linux-<kind>`, so a new notification of
the same kind replaces the previous one instead of filling up the notification center
during consecutive turns.

### Browser half (`client.js`)

| Line | What it does |
|---|---|
| `:272` | `requestPermission()` — requests Web Notification permission inside a user gesture |
| `:288` | `beep(kind)` — synthesizes the chime with oscillators, one note sequence per kind |
| `:313` | `webNotify(title, body, kind, activate)` — Web Notification with a per-kind `tag`, `silent: true`, and an `activate` click callback |
| `:346` | `showToast(title, body, tone, onClick)` — plain-DOM in-page overlay, auto-dismisses after 7 s |
| `:642` | SSE effect — keeps a config copy and subscribes to the stream; `:676` `activate()` switches back to the session and posts the receipt (the session picker is not a URL route, so it goes through `ctx.uiWorkspace.openSession(id)`; reading that service without `inject` throws, hence the `ctx.reflect.get('uiWorkspace')` fallback) |
| `:722` | `new EventSource('/api/dsh-notify-linux/events?client=<clientId>')` — subscribes to the live event stream |
| `:755` | `ctx.slots.register({ name: 'settings.section', id: 'dsh-notify-linux', order: 30 })` |

The browser half is a hand-written `ModuleLoader` bundle: no build step, no dependency
other than the `react` the shell already provides, and all colors come from theme
variables so it follows light/dark mode.

Synthesized chime note sequences (`[frequency Hz, offset s]`):

```
turnEnd  880 → 1318
question 740 → 740
approval 988 → 988
error    300 → 220
```

The `AudioContext` is closed 800 ms after playback so it does not hold an audio channel.

### HTTP API

The host half registers a same-origin route prefix on the DSH `webServer`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/dsh-notify-linux/config` | Current config, tool capabilities, available sound themes, focus state |
| `POST` | `/api/dsh-notify-linux/config` | Partial config update (deep-merged, including `events`), persisted to disk |
| `POST` | `/api/dsh-notify-linux/test` | Fire a real notification of a given `kind` through the normal path |
| `POST` | `/api/dsh-notify-linux/presence` | Report whether the window is focused (feeds `onlyWhenUnfocused`) together with the `clientId`, so targeting can identify the tab |
| `POST` | `/api/dsh-notify-linux/click` | Receipt for a clicked browser notification (`sessionId`, `kind`); used to diagnose "clicked but did not jump" |
| `GET` | `/api/dsh-notify-linux/events` | SSE stream: `hello` (capabilities), `notify` (a real dispatch, carrying `channel`), `config` (config changed); accepts `?client=<id>` |

The SSE stream sends a `: ping` comment every 25 s to keep idle connections alive through
proxies. The browser half backs off after 6 consecutive connection failures (30 s before
retrying) rather than reconnecting in a tight loop.

### Security boundary

DSH's `webServer` often binds `0.0.0.0`, but these routes can change plugin configuration
and trigger real notifications — they must not be open to the public internet. Every
request passes through `allowed(req)`, which permits only:

- `127.0.0.1`, `::1`, `localhost`, or an empty address
- `10.0.0.0/8`, `127.0.0.0/8`
- `192.168.0.0/16`
- `172.16.0.0/12`
- IPv6 unique-local `fc00::/7` and link-local `fe80::/10`

Anything else gets `403 {"error":"forbidden"}`. Request bodies are capped at 64 KiB.

---

## Verified behavior

The following were observed on real hardware (Manjaro GNOME, Wayland) with the plugin
installed and a real DSH session running:

- **A real D-Bus notification call was captured.** Monitoring the session bus during a
  triggered event showed an actual `org.freedesktop.Notifications.Notify` method call
  from the plugin, i.e. the notification went through the GNOME notification center and
  not through any simulation layer.
- **A real turn end produced a real notification.** With the live agent session running,
  the notification body was:

  ```
  default-workspace · 44b6a957 的回合已结束
  ```

  — the workspace name derived from the session's `cwd`, followed by the first 8
  characters of the session id.
- **A real sound was played.** `pactl list sink-inputs` captured a `paplay` sink-input
  while the notification fired, confirming the audio path (rather than only the file
  lookup) works.

The Settings page "Try it" buttons call `/test`, which runs through the exact same
`fire()` path as a real event, so what you see there is what you get in practice.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| No desktop notification | Is `notify-send` installed and on `PATH`? The capability row in Settings shows this. |
| No sound | Is `paplay` (or `canberra-gtk-play`) present, and does the `.oga` file exist under `/usr/share/sounds/freedesktop/stereo`? |
| Notifications only sometimes | `cooldownSeconds` suppresses repeats of the same kind — lower it or set it to `0`. |
| Nothing at all | `enabled` must be `true`, and the specific `events.<kind>` toggle must be on. |
| No notifications while watching DSH | `onlyWhenUnfocused` is on — the window is focused, so system notification and sound are suppressed by design. |
| Settings page unreachable | The host half needs the `webServer` service; the page shows a retry button when the backend cannot be reached. |
| Subagent tasks silent | `includeSubagents` defaults to `false` on purpose. Turn it on to include them. |

---

## Uninstalling

Remove the bundle through DSH's plugin manager (`plugin_manager`, action
`remove_bundle`), targeting `dsh-notify-linux`. Then delete the leftover config file:

```bash
rm -f ~/.dsh/profiles/web/dsh-notify-linux.json
```

Nothing else is installed on the system — no systemd units, no files outside the DSH
profile and the plugin directory. The sound files the plugin plays belong to the
freedesktop sound theme and are left untouched.

---

## License

MIT © Wlaeg (wlaeg@users.noreply.github.com)
