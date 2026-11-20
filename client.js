/**
 * DSH Notify —— 浏览器半身。
 *
 * 与 Host 半身的分工：
 *   Host 半身负责「一定送得到」——页面关着、窗口最小化时也会发系统通知、
 *   播系统提示音；本半身负责三件事：
 *     1. 设置页（settings.section）：所有开关、事件类型、提示音主题、冷却时间；
 *     2. 页内浮层：任何页面都能看到「任务完成 / 等你选择 / 等批准」；
 *     3. 兜底：当 Host 侧的系统通知或声音实际没送出去（非 Linux、没装
 *        libnotify、声音文件缺失），用 Web Notification 与 Web Audio 补齐。
 *
 * 兜底与否由 Host 在事件里回的 `desktop` / `sound` / `channel` 决定——也就是「真的
 * 发出去了没有」，而不是两边都发一遍造成重复打扰。`channel: 'browser'` 表示用户打开了
 * 「优先用浏览器通知」：这时由本半身弹通知，点击它浏览器会把本标签页切到前台。
 *
 * 手写 ModuleLoader 包：无构建步骤，除 shell 已提供的 `react` 外无依赖。
 * 颜色全部走主题变量，跟随明暗切换。
 */
window.__ModuleLoader__.load({
  id: 'dsh-notify-linux',
  factory: require => {
    const React = require('react')
    const { createElement: h, useState, useEffect, useRef, useCallback } = React

    const NS = 'dsh-notify-linux'
    const API = '/api/dsh-notify-linux'

    // ── 文案 ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': '任务通知',
        'meta.description': 'DSH 完成任务、需要你选择或需要批准时，发送桌面通知并播放提示音。',
        nav: '任务通知',
        title: '任务通知',
        intro: 'DSH 完成任务、需要你做出选择或需要批准时，用桌面通知和提示音提醒你。通知由 DSH 主进程直接发出，因此页面切到后台、窗口最小化时同样有效。',
        loading: '正在读取配置…',
        loadFailed: '无法连接插件后端，设置暂不可用。',
        retry: '重试',
        saveFailed: '保存失败',
        master: '启用通知',
        masterHint: '总开关。关掉后所有事件都不再提醒。',
        systemNotify: '桌面通知',
        systemNotifyHint: '经系统通知中心弹出（notify-send）。',
        systemSound: '提示音',
        systemSoundHint: '播放系统声音主题里的提示音。',
        soundTheme: '完成时的提示音',
        soundThemeHint: '「任务完成」使用这一段声音，其余事件各有固定音效。',
        soundComplete: '轻快完成音',
        soundMessage: '消息提示音',
        soundBell: '铃声',
        soundNone: '静音',
        events: '提醒哪些情况',
        eventsHint: '按需勾选，互不影响。',
        evTurnEnd: '任务完成',
        evTurnEndHint: '一个回合结束、模型不再有待回答的输出。',
        evQuestion: '需要我选择',
        evQuestionHint: '模型请求你从选项里做选择或填写答案。',
        evApproval: '需要我批准',
        evApprovalHint: '某个工具调用在等你放行。',
        evError: '执行出错',
        evErrorHint: '某一步或整个回合失败。',
        extra: '其它',
        includeSubagents: '子代理也提醒',
        includeSubagentsHint: '默认只提醒主会话，避免并行子任务刷屏。',
        onlyWhenUnfocused: '仅当窗口不在前台',
        onlyWhenUnfocusedHint: '你正看着 DSH 时不打扰，切走后才提醒。',
        cooldown: '冷却时间',
        cooldownHint: '同一类提醒在这个间隔内只发一次，单位秒。',
        cooldownUnit: '秒',
        browser: '浏览器通知',
        browserHint: '页面开着时可以用浏览器自己的通知：点击通知，浏览器会切回弹通知的那个标签页。系统通道不可用时也会自动用它兜底。',
        browserFirst: '优先用浏览器通知',
        browserFirstHint: '开着这个页面时改用浏览器通知，不再弹系统通知。点通知浏览器会切回本标签页；页面关掉后自动退回系统通知。',
        browserToast: '页内浮层',
        browserNotify: '浏览器通知',
        browserNotifyHint: '需要授予浏览器通知权限。',
        browserSound: '浏览器合成音',
        test: '试一下',
        testHint: '用与真实提醒完全相同的链路各触发一次。',
        testTurnEnd: '完成任务',
        testQuestion: '需要选择',
        testApproval: '需要批准',
        testError: '执行出错',
        testSent: '已触发',
        capTitle: '本机能力',
        capNotifySend: 'notify-send',
        capPaplay: 'paplay',
        capCanberra: 'canberra',
        capYes: '可用',
        capNo: '不可用',
        permissionHint: '浏览器通知权限：',
        permGranted: '已授权',
        permDenied: '已拒绝',
        permDefault: '未授予（打开开关时会请求）',
        permUnsupported: '当前环境不支持',
        permissionRow: '浏览器通知权限',
        permAllow: '请求授权',
        toastTurnEnd: 'DSH 已完成任务',
        toastQuestion: 'DSH 正在等待你的选择',
        toastApproval: 'DSH 需要你的批准',
        toastError: 'DSH 执行出错',
      },
      en: {
        'meta.title': 'Task Notifications',
        'meta.description': 'Desktop notifications and a chime when DSH finishes a turn, needs your choice, or needs your approval.',
        nav: 'Task Notifications',
        title: 'Task Notifications',
        intro: 'Get a desktop notification and a chime when DSH finishes a turn, waits for your choice, or waits for your approval. Notifications come from the DSH host process, so they still arrive with the page in the background or the window minimised.',
        loading: 'Loading configuration…',
        loadFailed: 'Cannot reach the plugin backend; settings are unavailable.',
        retry: 'Retry',
        saveFailed: 'Save failed',
        master: 'Enable notifications',
        masterHint: 'Master switch. Turning it off silences every event.',
        systemNotify: 'Desktop notification',
        systemNotifyHint: 'Shown through the system notification centre (notify-send).',
        systemSound: 'Chime',
        systemSoundHint: 'Plays a sound from the system sound theme.',
        soundTheme: 'Turn-complete chime',
        soundThemeHint: 'Used for "task finished"; the other events have fixed sounds.',
        soundComplete: 'Complete',
        soundMessage: 'Message',
        soundBell: 'Bell',
        soundNone: 'Silent',
        events: 'Which events',
        eventsHint: 'Pick any combination.',
        evTurnEnd: 'Task finished',
        evTurnEndHint: 'A turn closed and the model owes no further output.',
        evQuestion: 'Needs my choice',
        evQuestionHint: 'The model asks you to pick an option or type an answer.',
        evApproval: 'Needs my approval',
        evApprovalHint: 'A tool call is waiting for you to allow it.',
        evError: 'Failed',
        evErrorHint: 'A step or a whole turn failed.',
        extra: 'Other',
        includeSubagents: 'Include subagents',
        includeSubagentsHint: 'Only the main session notifies by default, so parallel subagents cannot flood you.',
        onlyWhenUnfocused: 'Only when unfocused',
        onlyWhenUnfocusedHint: 'Stay quiet while you are watching DSH; notify once you switch away.',
        cooldown: 'Cooldown',
        cooldownHint: 'At most one notification of the same kind within this interval, in seconds.',
        cooldownUnit: 's',
        browser: 'Browser notifications',
        browserHint: 'When this page is open you can use the browser notification: clicking one switches the browser back to the tab that raised it. It also takes over when the system channel is unavailable.',
        browserFirst: 'Prefer browser notifications',
        browserFirstHint: 'While this page stays open, notifications come from the browser instead of the system. Clicking one returns the browser to this tab; with the page closed it falls back to the system notification.',
        browserToast: 'In-page toast',
        browserNotify: 'Browser notification',
        browserNotifyHint: 'Requires the browser notification permission.',
        browserSound: 'Synthesised chime',
        test: 'Try it',
        testHint: 'Fires each through exactly the same path as a real notification.',
        testTurnEnd: 'Task finished',
        testQuestion: 'Needs choice',
        testApproval: 'Needs approval',
        testError: 'Failed',
        testSent: 'Fired',
        capTitle: 'Host capabilities',
        capNotifySend: 'notify-send',
        capPaplay: 'paplay',
        capCanberra: 'canberra',
        capYes: 'available',
        capNo: 'unavailable',
        permissionHint: 'Browser notification permission: ',
        permGranted: 'granted',
        permDenied: 'denied',
        permDefault: 'not granted (requested when you flip the switch)',
        permUnsupported: 'not supported here',
        permissionRow: 'Notification permission',
        permAllow: 'Request permission',
        toastTurnEnd: 'DSH finished the task',
        toastQuestion: 'DSH is waiting for your choice',
        toastApproval: 'DSH needs your approval',
        toastError: 'DSH hit an error',
      },
    }

    const KIND_LABEL = {
      turnEnd: 'toastTurnEnd',
      question: 'toastQuestion',
      approval: 'toastApproval',
      error: 'toastError',
    }

    const CSS = `
.dsn_page{display:flex;flex-direction:column;gap:22px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dsn_h2{font-size:15px;font-weight:600;margin:0}
.dsn_p{margin:0;color:var(--dsw-alias-label-secondary)}
.dsn_group{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:4px 14px}
.dsn_head{padding:12px 0 4px;display:flex;flex-direction:column;gap:2px}
.dsn_headtitle{font-weight:600;font-size:13px}
.dsn_headhint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsn_row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:11px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.dsn_row:first-of-type{border-top:none}
.dsn_rowtext{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsn_rowlabel{font-weight:500}
.dsn_rowhint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsn_rowctl{flex:none;display:flex;align-items:center;gap:8px}
.dsn_check{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.dsn_select,.dsn_num{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 8px;font:inherit;font-size:12px}
.dsn_num{width:72px}
.dsn_btn{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer}
.dsn_btn:hover{background:var(--dsw-alias-bg-layer-3)}
.dsn_btn:disabled{opacity:.5;cursor:default}
.dsn_tests{display:flex;flex-wrap:wrap;gap:8px;padding:12px 0}
.dsn_caps{display:flex;flex-wrap:wrap;gap:6px 14px;padding:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsn_cap{display:flex;align-items:center;gap:6px}
.dsn_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-error-primary)}
.dsn_dot.ok{background:var(--dsw-alias-state-success-primary)}
.dsn_err{display:flex;align-items:center;gap:10px;color:var(--dsw-alias-state-error-primary)}
.dsn_toasts{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column-reverse;gap:10px;pointer-events:none}
.dsn_toast{pointer-events:auto;min-width:250px;max-width:340px;padding:12px 14px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-3);box-shadow:0 8px 28px var(--dsw-alias-bg-mask-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.45;cursor:pointer;transition:opacity .2s,transform .2s}
.dsn_toast.err{border-color:var(--dsw-alias-state-error-primary)}
.dsn_toast.out{opacity:0;transform:translateY(6px)}
.dsn_toasttitle{font-weight:600;margin-bottom:2px}
.dsn_toastbody{color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-word}
.dsn_new{font-size:11px;font-weight:600;color:var(--dsw-alias-label-on-accent);background:var(--dsw-alias-state-business-primary);border-radius:999px;padding:1px 7px}
`

    // ── 同源 HTTP ─────────────────────────────────────────────────────────────

    async function api(path, options) {
      const { timeout = 8000, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    /**
     * 本标签页的稳定标识。SSE 连接与 /presence 都带上它，Host 才能把「哪个页面在前台」
     * 对应到具体那条连接；开了多个 DSH 标签页时也只给最近在用的那个发通知。
     */
    const clientId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `dsn-${Math.random().toString(36).slice(2)}-${Date.now()}`

    /**
     * 上报前台状态，以及「这个标签页到底能不能弹出浏览器通知」。
     * 后者是硬约束：没有授权时 new Notification() 会被浏览器静默丢掉，
     * Host 据此决定是走浏览器通道还是回退系统通知，避免两边都不响。
     */
    function reportPresence() {
      api('/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          focused: document.hasFocus(),
          clientId,
          notify: permissionState() === 'granted',
        }),
      }).catch(() => { /* 后端不可达，忽略 */ })
    }

    // ── 浏览器兜底：通知与合成提示音 ──────────────────────────────────────────

    /** 浏览器通知权限的当前状态，用于设置页展示。 */
    function permissionState() {
      if (typeof Notification === 'undefined') return 'unsupported'
      return Notification.permission ?? 'default'
    }

    /** 在用户手势里请求通知权限——脱离手势调用会被浏览器直接拒绝。 */
    function requestPermission() {
      if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
      try { void Notification.requestPermission() } catch { /* 浏览器拒绝，静默 */ }
    }

    /**
     * 合成提示音。浏览器兜底路径不依赖任何音频文件：四种事件各配一段
     * 音符序列，用振荡器现场合成，避免为几个提示音额外打包资源。
     */
    const NOTES = {
      turnEnd: [[880, 0], [1318, 0.12]],
      question: [[740, 0], [740, 0.18]],
      approval: [[988, 0], [988, 0.16]],
      error: [[300, 0], [220, 0.18]],
    }

    function beep(kind) {
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (typeof Ctor !== 'function') return
      const notes = NOTES[kind] ?? NOTES.turnEnd
      let ac
      try { ac = new Ctor() } catch { return }
      const start = ac.currentTime + 0.01
      for (const [freq, offset] of notes) {
        const osc = ac.createOscillator()
        const gain = ac.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        const at = start + offset
        gain.gain.setValueAtTime(0.0001, at)
        gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015)
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
        osc.connect(gain)
        gain.connect(ac.destination)
        osc.start(at)
        osc.stop(at + 0.2)
      }
      // 播完释放音频上下文：常驻的 AudioContext 会一直占着一个音频通道。
      setTimeout(() => { try { void ac.close() } catch { /* 已关闭 */ } }, 800)
    }

    function webNotify(title, body, kind) {
      if (typeof Notification === 'undefined') return false
      if (Notification.permission !== 'granted') return false
      try {
        const note = new Notification(title, {
          body,
          tag: `dsh-notify-linux-${kind}`, // 同类顶替，不刷满通知中心
          silent: true,
        })
        // 浏览器会把发通知的那个标签页切到前台；页面内再补一次 focus 兜底。
        note.onclick = () => { try { window.focus(); note.close() } catch { /* 忽略 */ } }
        return true
      } catch { return false }
    }

    // ── 页内浮层（原生 DOM，任何页面都可见）──────────────────────────────────

    let toastHostNode = null

    function toastHost() {
      if (toastHostNode !== null && toastHostNode.isConnected) return toastHostNode
      toastHostNode = document.querySelector('.dsn_toasts')
      if (toastHostNode === null) {
        toastHostNode = document.createElement('div')
        toastHostNode.className = 'dsn_toasts'
        document.body.appendChild(toastHostNode)
      }
      return toastHostNode
    }

    function showToast(title, body, tone, onClick) {
      try {
        const card = document.createElement('div')
        card.className = `dsn_toast${tone === 'error' ? ' err' : ''}`
        const head = document.createElement('div')
        head.className = 'dsn_toasttitle'
        head.textContent = title
        card.appendChild(head)
        if (typeof body === 'string' && body !== '') {
          const text = document.createElement('div')
          text.className = 'dsn_toastbody'
          text.textContent = body
          card.appendChild(text)
        }
        if (typeof onClick === 'function') {
          card.addEventListener('click', () => { try { onClick() } catch { /* 忽略 */ } })
        }
        toastHost().appendChild(card)
        const remove = () => {
          card.classList.add('out')
          setTimeout(() => { try { card.remove() } catch { /* 已移除 */ } }, 220)
        }
        const timer = setTimeout(remove, 7000)
        card.addEventListener('click', () => { clearTimeout(timer); remove() })
      } catch { /* 浮层失败不影响任何功能 */ }
    }

    // ── 设置页 ────────────────────────────────────────────────────────────────

    function Toggle({ checked, onChange, disabled }) {
      return h('input', {
        type: 'checkbox',
        className: 'dsn_check',
        checked: checked === true,
        disabled: disabled === true,
        onChange: event => onChange(event.target.checked),
      })
    }

    function Row({ label, hint, children }) {
      return h('div', { className: 'dsn_row' },
        h('div', { className: 'dsn_rowtext' },
          h('div', { className: 'dsn_rowlabel' }, label),
          hint ? h('div', { className: 'dsn_rowhint' }, hint) : null),
        h('div', { className: 'dsn_rowctl' }, children))
    }

    function Group({ title, hint, children }) {
      return h('div', { className: 'dsn_group' },
        h('div', { className: 'dsn_head' },
          h('div', { className: 'dsn_headtitle' }, title),
          hint ? h('div', { className: 'dsn_headhint' }, hint) : null),
        children)
    }

    const SOUND_LABEL = {
      complete: 'soundComplete',
      message: 'soundMessage',
      bell: 'soundBell',
      none: 'soundNone',
    }

    function Settings(props) {
      const { t } = props
      const [state, setState] = useState(undefined)
      const [failure, setFailure] = useState('')
      const [caps, setCaps] = useState(undefined)
      const [permission, setPermission] = useState(permissionState)
      const [fired, setFired] = useState('')

      const load = useCallback(() => {
        api('/config')
          .then(payload => {
            setState(payload.config)
            setCaps(payload.capabilities)
            setFailure('')
          })
          .catch(error => setFailure(String(error?.message ?? error)))
      }, [])

      useEffect(() => { load() }, [load])

      // 设置页开着时权限可能被用户在浏览器侧改掉，回来重读一次；
      // 顺便把「能不能弹浏览器通知」的最新结论同步给 Host。
      useEffect(() => {
        const onFocus = () => { setPermission(permissionState()); reportPresence() }
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [])

      const patch = useCallback((partial) => {
        setState(previous => ({ ...previous, ...partial }))
        api('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(partial),
        })
          .then(payload => { setState(payload.config); setFailure('') })
          .catch(error => { setFailure(String(error?.message ?? error)); load() })
      }, [load])

      const patchEvent = useCallback((key, value) => {
        setState(previous => (previous ? { ...previous, events: { ...previous.events, [key]: value } } : previous))
        api('/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events: { [key]: value } }),
        })
          .then(payload => { setState(payload.config); setFailure('') })
          .catch(error => { setFailure(String(error?.message ?? error)); load() })
      }, [load])

      const test = useCallback((kind) => {
        api('/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        })
          .then(() => {
            setFired(kind)
            setTimeout(() => setFired(current => (current === kind ? '' : current)), 1600)
          })
          .catch(error => setFailure(String(error?.message ?? error)))
      }, [])

      if (state === undefined) {
        return h('div', { className: 'dsn_page' },
          failure === ''
            ? h('p', { className: 'dsn_p' }, t('loading'))
            : h('div', { className: 'dsn_err' },
                h('span', null, t('loadFailed')),
                h('button', { className: 'dsn_btn', onClick: load }, t('retry'))))
      }

      const permissionText = permission === 'granted' ? t('permGranted')
        : permission === 'denied' ? t('permDenied')
          : permission === 'unsupported' ? t('permUnsupported')
            : t('permDefault')

      const capRow = (label, available) => h('span', { className: 'dsn_cap' },
        h('span', { className: `dsn_dot${available ? ' ok' : ''}` }),
        `${label} ${available ? t('capYes') : t('capNo')}`)

      const soundOptions = (caps?.sounds ?? []).map(entry => h('option', { key: entry.theme, value: entry.theme }, t(SOUND_LABEL[entry.theme] ?? entry.theme)))

      const locked = state.enabled !== true

      const masterRows = [
        h(Row, { key: 'master', label: t('master'), hint: t('masterHint') },
          h(Toggle, { checked: state.enabled, onChange: value => patch({ enabled: value }) })),
      ]

      const eventRows = [
        ['turnEnd', 'evTurnEnd', 'evTurnEndHint'],
        ['question', 'evQuestion', 'evQuestionHint'],
        ['approval', 'evApproval', 'evApprovalHint'],
        ['error', 'evError', 'evErrorHint'],
      ].map(([key, label, hint]) => h(Row, { key, label: t(label), hint: t(hint) },
        h(Toggle, {
          checked: state.events[key] !== false,
          disabled: locked,
          onChange: value => patchEvent(key, value),
        })))

      const soundRows = [
        h(Row, { key: 'notify', label: t('systemNotify'), hint: t('systemNotifyHint') },
          h(Toggle, { checked: state.systemNotify, disabled: locked, onChange: value => patch({ systemNotify: value }) })),
        h(Row, { key: 'sound', label: t('systemSound'), hint: t('systemSoundHint') },
          h(Toggle, { checked: state.systemSound, disabled: locked, onChange: value => patch({ systemSound: value }) })),
        h(Row, { key: 'theme', label: t('soundTheme'), hint: t('soundThemeHint') },
          h('select', {
            className: 'dsn_select',
            value: state.soundTheme,
            disabled: locked || state.systemSound !== true,
            onChange: event => patch({ soundTheme: event.target.value }),
          }, soundOptions)),
      ]

      const extraRows = [
        h(Row, { key: 'sub', label: t('includeSubagents'), hint: t('includeSubagentsHint') },
          h(Toggle, { checked: state.includeSubagents, disabled: locked, onChange: value => patch({ includeSubagents: value }) })),
        h(Row, { key: 'focus', label: t('onlyWhenUnfocused'), hint: t('onlyWhenUnfocusedHint') },
          h(Toggle, { checked: state.onlyWhenUnfocused, disabled: locked, onChange: value => patch({ onlyWhenUnfocused: value }) })),
        h(Row, { key: 'cooldown', label: t('cooldown'), hint: t('cooldownHint') },
          h('input', {
            type: 'number',
            className: 'dsn_num',
            min: 0,
            max: 120,
            step: 1,
            value: state.cooldownSeconds,
            disabled: locked,
            onChange: event => patch({ cooldownSeconds: Number(event.target.value) }),
          }),
          h('span', { className: 'dsn_rowhint' }, t('cooldownUnit'))),
      ]

      const browserRows = [
        // 权限单独一行 + 显式按钮：开关状态由配置决定，权限却只能由用户手势触发，
        // 两者混在一起会让人以为「开了开关就会有通知」。
        h(Row, { key: 'perm', label: t('permissionRow'), hint: permissionText },
          permission === 'granted'
            ? h('span', { className: 'dsn_new' }, t('permGranted'))
            : h('button', {
                className: 'dsn_btn',
                disabled: permission === 'unsupported',
                onClick: () => {
                  requestPermission()
                  setTimeout(() => { setPermission(permissionState()); reportPresence() }, 600)
                },
              }, t('permAllow'))),
        h(Row, { key: 'first', label: t('browserFirst'), hint: t('browserFirstHint') },
          h(Toggle, {
            checked: state.browserFirst === true,
            disabled: locked,
            onChange: value => {
              if (value) requestPermission()
              patch({ browserFirst: value })
              setTimeout(() => setPermission(permissionState()), 300)
            },
          })),
        h(Row, { key: 'toast', label: t('browserToast'), hint: '' },
          h(Toggle, { checked: state.browserToast, disabled: locked, onChange: value => patch({ browserToast: value }) })),
        h(Row, { key: 'web', label: t('browserNotify'), hint: `${t('browserNotifyHint')} ${t('permissionHint')}${permissionText}` },
          h(Toggle, {
            checked: state.browserNotify,
            disabled: locked,
            onChange: value => {
              if (value) requestPermission()
              patch({ browserNotify: value })
              setTimeout(() => setPermission(permissionState()), 300)
            },
          })),
        h(Row, { key: 'beep', label: t('browserSound'), hint: '' },
          h(Toggle, { checked: state.browserSound, disabled: locked, onChange: value => patch({ browserSound: value }) })),
      ]

      const testButtons = [
        ['turnEnd', 'testTurnEnd'],
        ['question', 'testQuestion'],
        ['approval', 'testApproval'],
        ['error', 'testError'],
      ].map(([kind]) => h('button', {
        key: kind,
        className: 'dsn_btn',
        disabled: locked,
        onClick: () => test(kind),
      }, fired === kind ? t('testSent') : t(testLabelKey(kind))))

      const capRows = [
        capRow(t('capNotifySend'), caps?.notifySend === true),
        capRow(t('capPaplay'), caps?.paplay === true),
        capRow(t('capCanberra'), caps?.canberra === true),
      ]

      const header = h('div', null,
        h('h2', { className: 'dsn_h2' }, t('title')),
        h('p', { className: 'dsn_p' }, t('intro')))

      const failureBar = failure === '' ? null : h('div', { className: 'dsn_err' }, `${t('saveFailed')}：${failure}`)

      return h('div', { className: 'dsn_page' },
        header,
        failureBar,
        h(Group, { title: t('master'), hint: t('masterHint') }, masterRows),
        h(Group, { title: t('events'), hint: t('eventsHint') }, eventRows),
        h(Group, { title: t('systemNotify'), hint: t('systemNotifyHint') }, soundRows),
        h(Group, { title: t('extra'), hint: '' }, extraRows),
        h(Group, { title: t('browser'), hint: t('browserHint') }, browserRows),
        h(Group, { title: t('test'), hint: t('testHint') },
          h('div', { className: 'dsn_tests' }, testButtons)),
        h(Group, { title: t('capTitle'), hint: '' },
          h('div', { className: 'dsn_caps' }, capRows)))
    }

    function testLabelKey(kind) {
      return { turnEnd: 'testTurnEnd', question: 'testQuestion', approval: 'testApproval', error: 'testError' }[kind] ?? kind
    }

    // ── apply ─────────────────────────────────────────────────────────────────

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-notify-linux: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', NS)
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { try { style.remove() } catch { /* 已移除 */ } }
      }, 'dsh-notify-linux: styles')

      // ── 实时事件流与窗口聚焦上报 ────────────────────────────────────────────
      // 一条 EventSource 服务整个页面：Host 侧每次真实发出通知，这里都会收到
      // 一帧，据此显示页内浮层并按需补齐浏览器兜底。
      ctx.effect(() => {
        let source
        let retryTimer
        let failures = 0
        let closed = false
        let config = { enabled: true, browserToast: true, browserNotify: true, browserSound: false, browserFirst: false }

        // 本标签页的标识：随 SSE 连接与 /presence 一起上报，Host 据此把通知定向发给
        // 用户最近在用的那个页面，开了多个 DSH 标签页时也只弹一条通知。
        // clientId 与 reportPresence 定义在模块作用域（设置页也要用同一份）。

        const refreshConfig = () => {
          api('/config')
            .then(payload => {
              config = payload.config ?? config
              if (typeof payload.capabilities?.notifySend === 'boolean') capabilities = payload.capabilities
            })
            .catch(() => { /* 后端不可达时沿用上一次配置 */ })
        }
        let capabilities = {}
        refreshConfig()

        const onNotify = event => {
          let payload
          try { payload = JSON.parse(event.data) } catch { return }
          const kind = payload?.kind ?? 'turnEnd'
          const title = t(KIND_LABEL[kind] ?? 'toastTurnEnd')
          const body = typeof payload?.body === 'string' ? payload.body : ''

          if (config.enabled !== true) return

          // 点通知/浮层时把窗口提到前台（会话切换是后续提交的事）。
          const focus = () => { try { window.focus() } catch { /* 忽略 */ } }

          if (config.browserToast !== false) showToast(title, body, kind, focus)

          // channel==='browser'：Host 判定应由浏览器通知接手（页面开着，且用户选了
          // 「优先用浏览器通知」）。否则沿用兜底语义：只在 Host 侧确实没送出去时才发，
          // 两边都发会重复打扰。
          const systemNotifyBroken = capabilities?.notifySend !== true
          const byBrowser = payload?.channel === 'browser'
          if (config.browserNotify !== false && (byBrowser || (payload?.desktop !== true && systemNotifyBroken))) {
            webNotify(title, body, kind)
          }
          const systemSoundBroken = capabilities?.paplay !== true && capabilities?.canberra !== true
          if (payload?.sound !== true && systemSoundBroken && config.browserSound === true) beep(kind)
        }

        const onHello = event => {
          try {
            const payload = JSON.parse(event.data)
            if (payload?.capabilities) capabilities = payload.capabilities
          } catch { /* 忽略坏帧 */ }
        }

        const onConfig = event => {
          try { config = JSON.parse(event.data) ?? config } catch { /* 忽略坏帧 */ }
        }

        const connect = () => {
          if (closed) return
          if (typeof EventSource !== 'function') return
          try { source = new EventSource(`${API}/events?client=${encodeURIComponent(clientId)}`) } catch { return }
          source.addEventListener('notify', onNotify)
          source.addEventListener('hello', onHello)
          source.addEventListener('config', onConfig)
          source.addEventListener('open', () => { failures = 0 })
          source.addEventListener('error', () => {
            // 后端重启期间浏览器会自己重连；但若一直连不上，无限重连会持续
            // 占用同源连接，所以连续失败若干次后主动退避。
            failures += 1
            if (failures < 6) return
            try { source.close() } catch { /* 已关闭 */ }
            retryTimer = setTimeout(() => { failures = 0; connect() }, 30_000)
          })
        }
        connect()

        reportPresence()
        window.addEventListener('focus', reportPresence)
        window.addEventListener('blur', reportPresence)
        document.addEventListener('visibilitychange', reportPresence)

        return () => {
          closed = true
          clearTimeout(retryTimer)
          try { source?.close() } catch { /* 已关闭 */ }
          window.removeEventListener('focus', reportPresence)
          window.removeEventListener('blur', reportPresence)
          document.removeEventListener('visibilitychange', reportPresence)
          try { toastHostNode?.remove() } catch { /* 已移除 */ }
          toastHostNode = null
        }
      }, 'dsh-notify-linux: event stream')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 30,
        label: () => t('nav'),
        locale: NS,
      }, props => h(Settings, { ...props, t })))
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
