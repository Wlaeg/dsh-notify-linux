/**
 * DSH Notify —— Host 半身。
 *
 * 目标：DSH 完成任务、需要用户做出选择、需要批准或出错时，发一条桌面通知，
 * 并播放一段提示音。三件事：
 *
 *   1. 监听四类事件（见 EVENTS），经 `notify-send` 发桌面通知、经 `paplay`
 *      播放系统提示音；
 *   2. 把开关与偏好持久化到 profile 目录下的 `dsh-notify-linux.json`，改完即生效；
 *   3. 注册同源 HTTP 路由 `/api/dsh-notify-linux/*`，供浏览器半身的设置面板读写、
 *      试听，以及订阅 SSE 实时事件流。
 *
 * 通知与声音全部 fire-and-forget：事件分发路径上绝不 await 外部进程，
 * 也绝不因为通知失败而影响 agent 的正常流程。
 *
 * 【为什么默认在 Host 侧发通知，而不是浏览器侧】
 * 浏览器通知只在页面开着时有效，用户切走窗口、最小化或关掉页面就收不到；
 * 而 DSH 主进程活着的时间更长，`notify-send` 走 GNOME 通知中心，
 * 即使页面没聚焦、甚至浏览器不在前台，通知和声音一样会到。
 * 浏览器半身负责「页面内看得见」和「浏览器通知兜底」。
 *
 * 唯一的例外是用户打开 `browserFirst`：页面开着（有 SSE 连接）时改由浏览器通知
 * 投递——系统通知没有动作（action），点击只会消失；浏览器通知被点击时，浏览器会
 * 把发通知的那个标签页切到前台，这正是「点通知回到 DSH」想要的效果。页面关掉后
 * 没有连接可投，自动退回系统通知。
 *
 * 【为什么 waterfall 事件里必须 return next()】
 * `user-questions/request` 与 `approval/request` 都是 waterfall（串行责任链）
 * 事件。本插件是纯观察者，不拥有决策，所以监听器只做副作用，然后把
 * `next()` 原样委托下去；一旦忘记委托，Host 侧的问询与批准流程会全部卡死。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const NS = 'dsh-notify-linux'
const SOUND_DIR = '/usr/share/sounds/freedesktop/stereo'

/** 四类通知：key 同时是配置字段名、声音映射键与 SSE 事件里的 kind。 */
const EVENTS = ['turnEnd', 'question', 'approval', 'error']

/** 每类事件的紧迫度与通知图标（图标名取自 freedesktop 主题）。 */
const URGENCY = { turnEnd: 'normal', question: 'normal', approval: 'normal', error: 'critical' }
const ICON = {
  turnEnd: 'dialog-information',
  question: 'dialog-information',
  approval: 'dialog-information',
  error: 'dialog-error',
}

/**
 * 声音映射。`turnEnd` 用用户选的「提示音主题」，其余事件固定。
 * 都是 freedesktop 声音主题里实际存在的文件（已在本机核实）。
 */
const SOUND_BY_KIND = {
  question: 'message-new-instant',
  approval: 'dialog-information',
  error: 'dialog-error',
}
const SOUND_THEMES = {
  complete: 'complete',
  message: 'message',
  bell: 'bell',
  none: null,
}

/** 默认配置。用户改过的字段与默认值深合并，缺项永远有值。 */
const DEFAULTS = {
  enabled: true,
  systemNotify: true,
  systemSound: true,
  browserToast: true,
  browserNotify: true,
  browserSound: false,
  // 优先用浏览器通知：页面开着时由浏览器投递（点击通知，浏览器会把该标签页切到前台），
  // 页面关着时没有任何 SSE 连接，自动退回系统通知。
  browserFirst: false,
  soundTheme: 'complete',
  events: { turnEnd: true, question: true, approval: true, error: true },
  includeSubagents: false,
  onlyWhenUnfocused: false,
  cooldownSeconds: 3,
}

// ── 配置读写 ──────────────────────────────────────────────────────────────────

/** profile 目录：优先环境变量，否则按 DSH 的惯例推算。 */
function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', process.env.DSH_PROFILE || 'web')
}

const CONFIG_FILE = path.join(profileDir(), 'dsh-notify-linux.json')

/** 只接受已知字段，其余丢弃；类型不对就退回默认值。 */
function sanitize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  const eventsSrc = src.events && typeof src.events === 'object' ? src.events : {}
  const events = {}
  for (const key of EVENTS) events[key] = bool(eventsSrc[key], DEFAULTS.events[key])
  const cooldown = Number(src.cooldownSeconds)
  return {
    enabled: bool(src.enabled, DEFAULTS.enabled),
    systemNotify: bool(src.systemNotify, DEFAULTS.systemNotify),
    systemSound: bool(src.systemSound, DEFAULTS.systemSound),
    browserToast: bool(src.browserToast, DEFAULTS.browserToast),
    browserNotify: bool(src.browserNotify, DEFAULTS.browserNotify),
    browserSound: bool(src.browserSound, DEFAULTS.browserSound),
    browserFirst: bool(src.browserFirst, DEFAULTS.browserFirst),
    soundTheme: Object.hasOwn(SOUND_THEMES, src.soundTheme) ? src.soundTheme : DEFAULTS.soundTheme,
    events,
    includeSubagents: bool(src.includeSubagents, DEFAULTS.includeSubagents),
    onlyWhenUnfocused: bool(src.onlyWhenUnfocused, DEFAULTS.onlyWhenUnfocused),
    cooldownSeconds: Number.isFinite(cooldown) ? Math.min(120, Math.max(0, cooldown)) : DEFAULTS.cooldownSeconds,
  }
}

function readConfig() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch {
    // 文件不存在或内容坏掉都退回默认值：通知配置永远不该让插件挂掉。
    return sanitize(DEFAULTS)
  }
}

function writeConfig(config) {
  const dir = path.dirname(CONFIG_FILE)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch { /* 目录已存在或不可写，下面写文件时会再失败一次 */ }
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE) // 原子替换：读侧永远看不到半截 JSON
}

// ── 系统通知与提示音 ──────────────────────────────────────────────────────────

/**
 * 子进程环境。DSH 主进程通常在用户会话里启动、环境变量齐全；但若它是从
 * systemd 用户单元或 ssh 里拉起，会话总线变量可能缺失，此时补上按 uid
 * 推算的默认值，否则 `notify-send` 会静默失败（连不上 session bus）。
 */
function sessionEnv() {
  const env = { ...process.env }
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  if (!env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`
  if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = `/run/user/${uid}`
  return env
}

/** 已解析到的可执行文件路径；undefined 表示还没找过，null 表示本机没有。 */
const resolved = new Map()

/** 在 PATH 里找可执行文件（不 shell 展开，与 DSH subprocess 的语义一致）。 */
function which(command) {
  if (resolved.has(command)) return resolved.get(command)
  let found = null
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      const stat = fs.statSync(candidate)
      if (stat.isFile()) { found = candidate; break }
    } catch { /* 继续找下一个目录 */ }
  }
  resolved.set(command, found)
  return found
}

/**
 * 跑一个即发即忘的外部命令。
 *
 * 刻意不用 DSH 的 `subprocess` 服务：那个服务的契约是「调用方持有句柄并对
 * 生命周期负责」，而这里要的恰恰是反过来——进程自己跑完就消失，插件不追踪、
 * 不 await、不因它失败而改变任何行为。`unref()` 保证它不拖住 Host 退出。
 */
function fireAndForget(command, args) {
  const bin = which(command)
  if (bin === null) return null
  try {
    const child = spawn(bin, args, { stdio: 'ignore', env: sessionEnv(), detached: false })
    child.on('error', () => { /* 命令存在但执行失败：静默，绝不影响 agent */ })
    child.unref()
    return child
  } catch {
    return null
  }
}

/** 发一条桌面通知。返回是否真的发起了调用。 */
function sendDesktop(title, body, kind) {
  return fireAndForget('notify-send', [
    '-a', 'DSH',
    '-i', ICON[kind] || 'dialog-information',
    '-u', URGENCY[kind] || 'normal',
    '-t', '8000',
    // 同类通知顶替上一条，避免连续回合把通知中心刷满。
    '-h', `string:x-canonical-private-synchronous:dsh-notify-linux-${kind}`,
    title, body,
  ]) !== null
}

/** 播放提示音：优先系统声音主题文件，回退 canberra（事件名播放）。 */
function playSound(sound) {
  if (sound === null) return false
  const file = path.join(SOUND_DIR, `${sound}.oga`)
  try {
    if (fs.statSync(file).isFile()) return fireAndForget('paplay', [file]) !== null
  } catch { /* 文件不在：走 canberra 回退 */ }
  return fireAndForget('canberra-gtk-play', ['-i', sound]) !== null
}

// ── 插件主体 ──────────────────────────────────────────────────────────────────

export function apply(ctx) {
  let config = readConfig()
  /** 每类事件上次触发的时间戳，用于冷却。 */
  const lastFired = new Map()
  /**
   * 正在订阅 SSE 的响应对象 → 该连接的元信息。
   *
   * `clientId` 由浏览器半身生成，经 `?client=` 与 `/presence` 上报关联到具体连接。
   * 浏览器通知按「用户最近在用的那个标签页」定向投递：开三个 DSH 标签页时，
   * 一次提醒也只弹一条，而不是三条。
   */
  const streams = new Map()

  const logger = ctx?.logger ?? console

  /** 当前窗口是否聚焦。由浏览器半身经 /presence 上报，未知时按「聚焦」处理。 */
  let windowFocused = true

  function broadcast(event, data) {
    if (streams.size === 0) return
    let frame
    try {
      frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    } catch {
      return
    }
    for (const res of streams.keys()) {
      try { res.write(frame) } catch { /* 断开的连接由 close 事件清理 */ }
    }
  }

  /** 只给一条 SSE 连接发一帧（浏览器通知定向投递用）。 */
  function sendTo(res, event, data) {
    let frame
    try {
      frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    } catch {
      return
    }
    try { res.write(frame) } catch { /* 断开的连接由 close 事件清理 */ }
  }

  /**
   * 挑出浏览器通知的投递目标：优先「最近一次上报为聚焦」的连接，其次「最近上报过
   * presence」的连接，最后按建立顺序取第一个。指向的是具体标签页，因此点击通知后
   * 浏览器会把那个标签页切到前台，正是用户想回到的那个页面。
   *
   * 只在「确实能弹浏览器通知」的连接里挑：浏览器半身会经 /presence 上报 notify，
   * 没授权时为 false，此时返回 null，让调用方回退系统通知——否则两边都不响。
   * notify 为 null 表示还没上报过（旧半身或刚连上），按可用处理。
   */
  function pickStream() {
    let best = null
    for (const [res, meta] of streams) {
      if (meta.notify === false) continue
      if (best === null) { best = [res, meta]; continue }
      const [, cur] = best
      if (meta.focused !== cur.focused) {
        if (meta.focused) best = [res, meta]
        continue
      }
      if (meta.at > cur.at) best = [res, meta]
    }
    return best === null ? null : best[0]
  }

  /** 会话的展示信息：工作区名 + 会话 id 短号，够用户在通知里认出是哪一摊活。 */
  function describe(agent) {
    const header = agent?.session?.header
    const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : ''
    const workspace = cwd === '' ? 'DSH' : path.basename(cwd)
    const id = String(agent?.session?.id ?? '')
    return { workspace, shortId: id === '' ? '' : id.slice(0, 8) }
  }

  /** 子代理（subagent）的会话在 header 里带 origin 标记。 */
  function isSubagent(agent) {
    return agent?.session?.header?.origin === 'subagent'
  }

  /**
   * 触发一次通知。所有分支都在 try 里：通知功能任何异常都不该冒泡进
   * agent 的事件分发路径。
   */
  function fire(kind, title, body) {
    try {
      if (!config.enabled) return
      if (config.events[kind] === false) return

      const now = Date.now()
      const cooldown = Math.max(0, Number(config.cooldownSeconds) || 0) * 1000
      if (cooldown > 0 && now - (lastFired.get(kind) ?? 0) < cooldown) return
      lastFired.set(kind, now)

      const payload = { kind, title, body, at: now }

      // 窗口在前台时不必再弹系统通知和声音——用户就在看。
      const suppressSystem = config.onlyWhenUnfocused && windowFocused

      // 「优先浏览器通知」：页面开着才有 SSE 连接可投。目标连接由最近一次
      // /presence 挑出，多标签页下也只弹一条，且点击后回到那个标签页。
      const target = config.browserFirst === true && !suppressSystem ? pickStream() : null
      const channel = target === null ? 'none' : 'browser'

      let desktop = false
      let sound = false
      if (!suppressSystem) {
        // 浏览器通知已经接手时不再发系统通知，否则同一次提醒会响两遍。
        if (config.systemNotify && channel !== 'browser') desktop = sendDesktop(title, body, kind)
        if (config.systemSound) {
          const sound$ = kind === 'turnEnd' ? SOUND_THEMES[config.soundTheme] : SOUND_BY_KIND[kind]
          sound = playSound(sound$ ?? null)
        }
      }

      // 把实际发生了什么告诉浏览器半身：它据此决定是否用浏览器通知/声音兜底。
      const frame = { ...payload, desktop, sound, channel }
      if (target !== null) sendTo(target, 'notify', frame)
      else broadcast('notify', frame)
    } catch (error) {
      logger.warn?.(`[${NS}] 发送通知失败：${error?.message ?? error}`)
    }
  }

  // ── 事件挂点 ────────────────────────────────────────────────────────────────

  // 「完成任务」：一轮即将关闭、模型不再欠响应。这是最准的时点——
  // 工具调用往返不会触发它，只有整个回合真正结束才会。
  ctx.on('agent/turn-stopping', payload => {
    const agent = payload?.agent
    if (agent && isSubagent(agent) && !config.includeSubagents) return
    const { workspace, shortId } = describe(agent)
    const suffix = shortId === '' ? '' : ` · ${shortId}`
    fire('turnEnd', 'DSH 已完成任务', `${workspace}${suffix} 的回合已结束`)
  })

  // 「有选择」：模型请求用户作答（单选/多选/自由文本）。
  // waterfall —— 纯观察者，必须把 next() 原样委托下去。
  ctx.on('user-questions/request', function (request, next) {
    try {
      const agent = request?.agent ?? this
      if (!(agent && isSubagent(agent) && !config.includeSubagents)) {
        const first = request?.questions?.[0]
        const text = typeof first?.question === 'string' && first.question !== '' ? first.question : '需要你做出选择'
        const count = Array.isArray(request?.questions) ? request.questions.length : 0
        const more = count > 1 ? `（共 ${count} 个问题）` : ''
        const { workspace } = describe(agent)
        fire('question', 'DSH 正在等待你的选择', `${workspace}：${text}${more}`)
      }
    } catch (error) {
      logger.warn?.(`[${NS}] 处理 user-questions/request 失败：${error?.message ?? error}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  // 「需要批准」：某个工具调用在等人类放行。
  ctx.on('approval/request', function (request, next) {
    try {
      const agent = request?.agent ?? this
      if (!(agent && isSubagent(agent) && !config.includeSubagents)) {
        const tool = typeof request?.toolName === 'string' ? request.toolName : '某个工具'
        const reason = request?.displayReason?.zh || request?.displayReason?.en || request?.reason
        const detail = typeof reason === 'string' && reason !== '' ? `：${reason}` : ''
        const { workspace } = describe(agent)
        fire('approval', 'DSH 需要你的批准', `${workspace}：${tool}${detail}`)
      }
    } catch (error) {
      logger.warn?.(`[${NS}] 处理 approval/request 失败：${error?.message ?? error}`)
    }
    return typeof next === 'function' ? next() : undefined
  })

  // 出错：一步或一整轮失败。冷却会吸收重试造成的连续触发。
  ctx.on('agent/error', payload => {
    const agent = payload?.agent
    if (agent && isSubagent(agent) && !config.includeSubagents) return
    const { workspace, shortId } = describe(agent)
    const suffix = shortId === '' ? '' : ` · ${shortId}`
    const raw = payload?.error
    const message = typeof raw === 'string' ? raw : (raw?.message ?? '')
    const detail = message === '' ? '执行过程中出现错误' : String(message).split('\n')[0].slice(0, 120)
    fire('error', 'DSH 执行出错', `${workspace}${suffix}：${detail}`)
  })

  // ── 同源 HTTP 路由（浏览器半身的数据面）────────────────────────────────────

  /**
   * 只服务本机与私有网段。DSH 的 webServer 常绑 0.0.0.0，这些路由能改插件
   * 配置、能触发真实通知，不该对公网开口。
   */
  function allowed(req) {
    const address = req.socket?.remoteAddress ?? ''
    const bare = address.startsWith('::ffff:') ? address.slice(7) : address
    if (bare === '' || bare === '::1' || bare === '127.0.0.1' || bare === 'localhost') return true
    const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare)
    if (v4) {
      const [a, b] = [Number(v4[1]), Number(v4[2])]
      if (a === 10 || a === 127) return true
      if (a === 192 && b === 168) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      return false
    }
    // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
    const head = bare.toLowerCase()
    return head.startsWith('fc') || head.startsWith('fd') || head.startsWith('fe8')
  }

  function readJson(req) {
    return new Promise(resolve => {
      let text = ''
      req.on('data', chunk => {
        text += chunk
        if (text.length > 64 * 1024) { text = ''; req.destroy() } // 配置很小，超限直接丢弃
      })
      req.on('end', () => {
        try { resolve(text.trim() === '' ? {} : JSON.parse(text)) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  /** 本机可用的声音主题文件清单，交给设置页做下拉。 */
  function availableSounds() {
    return Object.entries(SOUND_THEMES)
      .filter(([, file]) => file === null || fs.existsSync(path.join(SOUND_DIR, `${file}.oga`)))
      .map(([theme, file]) => ({ theme, file, available: file === null || fs.existsSync(path.join(SOUND_DIR, `${file}.oga`)) }))
  }

  function capabilities() {
    return {
      notifySend: which('notify-send') !== null,
      paplay: which('paplay') !== null,
      canberra: which('canberra-gtk-play') !== null,
      soundDir: fs.existsSync(SOUND_DIR),
      platform: process.platform,
    }
  }

  /**
   * SSE：把 Host 侧真实发生的通知推给页面。
   *
   * 页面据此显示页内浮层，并在系统通知不可用（非 Linux、没装 libnotify）时
   * 用 Web Notification 兜底——两边都发会重复打扰，所以由 capabilities()
   * 的结果决定谁来发，而不是两边都发。
   */
  function openStream(req, res) {
    // 连接标识：浏览器半身生成并经 ?client= 带来，/presence 上报时用它回指本连接。
    const clientId = String(new URL(req.url ?? '/', 'http://localhost').searchParams.get('client') ?? '').slice(0, 64)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    streams.set(res, { clientId, focused: false, notify: null, at: Date.now() })
    // 心跳让中间的代理/浏览器不把空闲连接掐掉。
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n') } catch { /* 下面统一清理 */ }
    }, 25_000)
    const cleanup = () => {
      clearInterval(keepAlive)
      streams.delete(res)
    }
    req.on('close', cleanup)
    res.on('close', cleanup)

    try {
      res.write(`event: hello\ndata: ${JSON.stringify({ capabilities: capabilities() })}\n\n`)
    } catch { /* 连接立刻断开，无需处理 */ }
  }

  function createHandler() {
    return async function handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/dsh-notify-linux/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      }

      if (!allowed(req)) return send(403, { error: 'forbidden' })

      try {
        if (method === 'GET' && route === '/events') return openStream(req, res)

        if (method === 'GET' && route === '/config') {
          // clients 只读：排查「通知到底发给了哪个标签页」时不用再猜。
          const clients = [...streams.values()].map(meta => ({
            clientId: meta.clientId,
            focused: meta.focused === true,
            notify: meta.notify,
            at: meta.at,
          }))
          return send(200, { config, capabilities: capabilities(), sounds: availableSounds(), focused: windowFocused, clients })
        }

        if (method === 'POST' && route === '/config') {
          const body = await readJson(req)
          config = sanitize({ ...config, ...body, events: { ...config.events, ...(body?.events ?? {}) } })
          writeConfig(config)
          broadcast('config', config)
          return send(200, { config, capabilities: capabilities(), sounds: availableSounds() })
        }

        // 设置页的「试一下」：走与真实通知完全相同的路径，所见即所得。
        if (method === 'POST' && route === '/test') {
          const body = await readJson(req)
          const kind = EVENTS.includes(body?.kind) ? body.kind : 'turnEnd'
          const titles = {
            turnEnd: 'DSH 已完成任务',
            question: 'DSH 正在等待你的选择',
            approval: 'DSH 需要你的批准',
            error: 'DSH 执行出错',
          }
          fire(kind, titles[kind], '这是一条测试通知，说明通知链路正常。')
          return send(200, { ok: true, kind, config })
        }

        // 窗口聚焦状态：用于「只在窗口不在前台时通知」这一档，同时同步到具体连接，
        // 供「优先浏览器通知」挑选定向投递的标签页。
        if (method === 'POST' && route === '/presence') {
          const body = await readJson(req)
          const focused = body?.focused !== false
          windowFocused = focused
          const clientId = typeof body?.clientId === 'string' ? body.clientId.slice(0, 64) : ''
          // notify：这个标签页是否真的拿到了浏览器通知权限。未带该字段时保持原值。
          const canNotify = typeof body?.notify === 'boolean' ? body.notify : null
          for (const meta of streams.values()) {
            // 旧版浏览器半身不带 clientId：退回「更新全部连接」的旧语义。
            if (clientId === '' || meta.clientId === clientId) {
              meta.focused = focused
              if (canNotify !== null) meta.notify = canNotify
              meta.at = Date.now()
            }
          }
          return send(200, { focused: windowFocused })
        }

        return send(404, { error: `unknown route ${route}` })
      } catch (error) {
        logger.warn?.(`[${NS}] 处理 ${method} ${route} 失败：${error?.message ?? error}`)
        try { send(500, { error: String(error?.message ?? error) }) } catch { /* 响应已发出 */ }
      }
    }
  }

  // webServer 可能在 apply 时还没提供，所以用 ctx.inject 等它就绪；
  // 直接用 ctx.get('webServer') 拿到 undefined 会让路由永远注册不上。
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: '/api/dsh-notify-linux', handler: createHandler() }),
      'dsh-notify-linux: 同源 API 路由',
    )
  })

  logger.info?.(`[${NS}] 已启用；配置：${CONFIG_FILE}`)
}

export const name = NS
