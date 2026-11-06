// 胶囊前端：只负责画和改设置。保活本身是 cache-keepalive 这个 mod 在做，
// 两边用 %USERPROFILE%\.claude\cache-keepalive\ 里的文件说话（见 src-tauri/src/lib.rs）。
(() => {
  const $ = id => document.getElementById(id);
  const tauri = window.__TAURI__;
  // 在普通浏览器里打开（预览用）就接一个假的后端。
  const invoke = tauri ? tauri.core.invoke : demoBackend();

  const TTL = { '5m': 300, '1h': 3600 };
  const STEP = { '5m': 10, '1h': 60 };
  const MIN_IV = 30, MAX_COUNT = 48;
  const COMPACT_MIN = 200000, COMPACT_MAX = 1000000;
  const FRESH_MS = 20000; // mod 隔几秒写一次心跳，超过这么久没动静就当那个会话没了
  const DEFAULT_TIERS = { '5m': { iv: 270, max: 6 }, '1h': { iv: 3300, max: 3 } };
  const STATUS = {
    live: '保活中', busy: '对话中', done: '已用完', off: '已关闭', closed: '窗口已关闭',
    empty: '等待首条回复', expired: '缓存已过期', error: '出错', stopped: '已停止 · 下条消息后恢复', resuming: '恢复中',
    nochat: '未打开对话', nomod: '未加载 · 完全退出 Claude 再打开',
    oldmod: 'mod 太旧，停止需先完全退出 Claude 再打开',
  };

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
  const parse = v => { const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?$/); return m ? (+m[1]) * 60 + (+(m[2] ?? 0)) : null; };
  const human = s => { const m = Math.round(s / 60); return m >= 120 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`; };
  const compactOf = v => { const n = Number(v); return v != null && n > 0 ? Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, Math.round(n))) : null; };
  const kTokens = n => n >= 1000000 ? `${n / 1000000}M` : `${n / 1000}k`;
  const clampIv = (ttl, s) => Math.min(TTL[ttl] - 5, Math.max(MIN_IV, Math.round(s)));

  // 各档的间隔和次数所有聊天共用（settings.json）。
  function mergeTiers(saved) {
    const s = saved || {};
    const tier = ttl => {
      const t = { ...DEFAULT_TIERS[ttl], ...((s.tiers || {})[ttl] || {}) };
      return { iv: clampIv(ttl, t.iv), max: Math.min(MAX_COUNT, Math.max(1, Math.round(t.max))) };
    };
    return { tiers: { '5m': tier('5m'), '1h': tier('1h') } };
  }
  // 开关、档位、立即保活、停止/恢复每个聊天各一份（chats/<会话>.json）；没开过的聊天是关的。
  function mergeChat(saved) {
    const c = saved || {};
    return {
      ttl: c.ttl === '1h' ? '1h' : '5m', isOn: c.isOn === true,
      pingNonce: Number(c.pingNonce) || 0,
      stopNonce: Number(c.stopNonce) || 0, resumeNonce: Number(c.resumeNonce) || 0,
      // 自动压缩窗口也按档各一份；null 是没动过，交给 Claude Code 自己。
      compact: { '5m': compactOf((c.compact || {})['5m']), '1h': compactOf((c.compact || {})['1h']) },
    };
  }

  let settings = mergeTiers(null);
  let chat = mergeChat(null);
  let sid = null;        // 正在显示的聊天，认不出就是 null
  let run = null;        // 这个聊天的保活状态，mod 还没写过就是 null
  let now = Date.now();
  let holdTiers = 0;     // 刚改过设置，这段时间内不让旧快照盖回去
  let holdChat = { sid: null, until: 0 };
  let chatSeen = null;   // 读到过开关文件的聊天
  let open = false;
  let misses = 0;
  // 点了 ⏹/▶ 之后先按点的结果显示，等 mod 把状态改掉（或超时）再听它的。
  let want = null;       // { sid, from, status, until }
  let oldMod = { sid: null, until: 0 }; // 这个聊天的 mod 太旧，不认停止键

  const isFresh = (s, at) => !s.ended && at - (s.beat || 0) < FRESH_MS;

  // 认不出桌面版在看哪个聊天时，退回挑最近有动静的那个；心跳断了的不算。
  function latest(states, at) {
    const live = states.filter(s => isFresh(s, at));
    live.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
    return live[0] || null;
  }

  function statusOf() {
    if (!sid) return 'nochat';
    if (!chat.isOn) return 'off';
    if (!run) return 'nomod';
    if (oldMod.sid === sid && Date.now() < oldMod.until) return 'oldmod';
    if (want && want.sid === sid) return want.status;
    if (run.status !== 'live') return run.status;
    if (run.nextAt == null) return 'empty';
    if (run.sent >= settings.tiers[run.ttl].max) return 'done';
    return 'live';
  }

  // 自动压缩有没有真的生效，听 mod 回报的：Claude Code 自己量上下文用的窗口和它的来源
  // （就是桌面版 context window 弹窗里那个数）。第二项为真时标成警告色。
  function compactHintOf(compact) {
    if (compact === null) return ['没设过，用 Claude Code 默认', false];
    if (!chat.isOn) return ['保活开着才生效', false];
    const c = run && run.compactCheck;
    if (!run) return ['等这个对话的 mod 回报…', false];
    if (c === undefined) return ['mod 太旧，没回报 · 完全退出 Claude 再打开', true];
    if (!c || c.want !== compact) return ['正在应用…', false];
    if (c.deny) return [`没生效：${c.deny}`, true];
    if (c.window == null) return [`已设 ${kTokens(compact)} · 下条消息后确认`, false];
    if (c.source === 'env') return [`已生效 · 快满 ${kTokens(c.window)} 时压缩`, false];
    return [`没生效 · 仍按 ${kTokens(c.window)}（${c.source}）`, true];
  }

  function draw() {
    const ttl = chat.ttl, t = settings.tiers[ttl];
    const status = statusOf(), ok = status === 'live';
    // 正在数（或停着）的那一轮按它写缓存时的档；对话中或没在数时，下一轮按现在选的档，
    // 改这一档的次数和间隔要立刻反映出来。
    const isStopped = status === 'stopped' && !!run && run.warmAt != null;
    const isCounting = !!run && run.nextAt != null && status !== 'busy';
    const runTtl = isCounting || isStopped ? run.ttl : ttl, rt = settings.tiers[runTtl];
    const sent = run ? run.sent : 0;
    const left = ok ? Math.max(0, Math.ceil((run.nextAt - now) / 1000)) : 0;
    // 停着时 mod 不再数，但上一轮照样在走：▶ 是从上次写缓存接着数的，
    // 过了保活点还没过期就会立刻补一次。所以先数到保活点，过了再数到缓存过期。
    const roundLeft = isStopped ? Math.ceil((run.warmAt + rt.iv * 1000 - now) / 1000) : 0;
    const cacheLeft = isStopped ? Math.ceil((run.warmAt + TTL[runTtl] * 1000 - now) / 1000) : 0;
    const isLate = isStopped && roundLeft <= 0 && cacheLeft > 0;
    const stopCd = roundLeft > 0 ? fmt(roundLeft) : isLate ? fmt(cacheLeft) : null;
    // 对话中虽然还没开始数，也给一个时间：就是下一轮满格的间隔。
    const cd = ok ? fmt(left) : status === 'busy' ? fmt(rt.iv) : stopCd;
    const pending = (isCounting || isStopped) && run.ttl !== ttl;

    $('pop').hidden = !open;
    document.querySelectorAll('#seg button').forEach(b => b.classList.toggle('on', b.dataset.ttl === ttl));
    $('s5').textContent = `写入 1.25× · 每 ${fmt(settings.tiers['5m'].iv)}`;
    $('s1').textContent = `写入 2× · 每 ${fmt(settings.tiers['1h'].iv)}`;
    $('sw').classList.toggle('on', chat.isOn);
    // 认不出是哪个聊天，就没有地方记，这个聊天自己的东西不让改。
    $('sw').disabled = $('now').disabled = !sid;
    document.querySelectorAll('#seg button').forEach(b => { b.disabled = !sid; });
    $('scopeName').textContent = ttl === '5m' ? '5 分钟档' : '1 小时档';
    if (document.activeElement !== $('iv')) $('iv').value = fmt(t.iv);
    const margin = ttl === '5m' ? '30 秒' : '5 分钟';
    $('ivHint').textContent = `须小于 ${fmt(TTL[ttl])}，建议留 ${margin}余量`;
    $('ivHint').classList.toggle('warn', t.iv >= TTL[ttl] - STEP[ttl]);
    $('max').textContent = t.max;
    $('span').textContent = `最多保到 ≈ ${human(TTL[ttl] + t.max * t.iv)}`;
    const compact = chat.compact[ttl], slider = $('compact');
    slider.value = (compact ?? COMPACT_MAX) / 1000;
    slider.disabled = !sid;
    slider.classList.toggle('unset', compact === null);
    slider.style.setProperty('--fill', `${(slider.value - slider.min) / (slider.max - slider.min) * 100}%`);
    $('compactVal').textContent = compact === null ? '默认' : kTokens(compact);
    $('compactVal').classList.toggle('mute', compact === null);
    const [hint, isOff] = compactHintOf(compact);
    $('compactHint').textContent = hint;
    $('compactHint').title = hint;
    $('compactHint').classList.toggle('warn', isOff);

    const label = STATUS[status] + (run && run.note && status !== 'live' ? ` · ${run.note}` : '');
    const cdEl = $('cd');
    cdEl.textContent = cd ?? label;
    cdEl.classList.toggle('mute', cd === null);
    cdEl.classList.toggle('warn', isLate);
    $('cdLabel').textContent = !isStopped ? '下次保活'
      : roundLeft > 0 ? '本轮保活点还剩' : isLate ? '已过保活点 · 缓存还剩' : '缓存已过期';
    const barLeft = ok ? left : isStopped ? Math.max(0, roundLeft) : null;
    $('bar').style.width = barLeft === null ? '0%' : `${Math.min(100, (1 - barLeft / rt.iv) * 100)}%`;
    $('bar').classList.toggle('idle', isStopped);
    $('cnt').textContent = `${sent} / ${rt.max}`;
    $('pips').innerHTML = Array.from({ length: rt.max }, (_, i) => `<i class="${i < sent ? 'done' : ''}"></i>`).join('');
    $('pill').textContent = label;
    $('pill').classList.toggle('off', !ok);

    $('cdot').classList.toggle('on', !!sid && chat.isOn);
    $('cttl').textContent = pending ? `${run.ttl} → ${ttl}` : ttl;
    // 数到 0 就是 mod 正在发这次保活，等它回来改 nextAt 之前都显示「保活中」；
    // 字短一截，先占住原来的宽度，免得药丸左边缘跳一下。
    const cc = $('ccount');
    if (ok && left === 0) {
      if (!cc.style.minWidth) cc.style.minWidth = `${cc.offsetWidth}px`;
      cc.textContent = '保活中';
    } else {
      cc.style.minWidth = '';
      cc.textContent = `保活 ${sent}/${rt.max}`;
    }
    const short = { busy: '对话中', stopped: '停止', expired: '过期', resuming: '…', oldmod: '需重启' };
    // 对话中胶囊里不放那个还没开始数的时间，跟面板右上角一样写「对话中」。
    // 停着等到缓存都过期了，▶ 也救不回来，跟 mod 恢复后报的一样写「过期」。
    const isGone = isStopped && cacheLeft <= 0;
    $('ccd').textContent = (ok || isStopped ? cd : null) ?? (isGone ? short.expired : short[status]) ?? '—';
    $('ccd').classList.toggle('off', !ok);
    $('ccd').classList.toggle('warn', isLate);
    // 正在数才有东西可停，停了才有东西可续；过期了两样都没有。
    $('chip').classList.toggle('can-stop', ok);
    $('chip').classList.toggle('can-play', status === 'stopped');
    $('act').title = ok ? '停止保活，下条消息后自动恢复'
      : roundLeft > 0 ? `恢复保活 · ${stopCd} 后保活`
        : isLate ? `恢复保活 · 已过保活点，会立刻保活一次（缓存还剩 ${stopCd}）` : '恢复保活';

    const l = run && run.last;
    $('last').innerHTML = l
      ? `<span>${new Date(l.at).toTimeString().slice(0, 8)}</span><span>读 <b>${(l.read / 1000).toFixed(1)}k</b></span><span>写 <b>${l.write}</b></span><span>出 <b>${l.out}</b></span>`
      : '<span>上次 —</span>';
  }

  // ---------- 读写 ----------
  async function refresh() {
    try {
      const snap = await invoke('snapshot');
      const states = snap.states || [];
      now = snap.now;
      if (Date.now() >= holdTiers) settings = mergeTiers(snap.settings);
      const nextSid = snap.focusKnown ? snap.focus || null : (latest(states, now) || {}).sid || null;
      if (nextSid !== sid) { sid = nextSid; run = null; misses = 0; }
      // 胶囊从不删聊天文件：读到过又忽然不见，是正好赶上改写，沿用上一帧，免得一闪成关、再被一次点击存成关。
      const saved = sid ? (snap.chats || {})[sid] : undefined;
      if (saved) chatSeen = sid;
      const isHeld = holdChat.sid === sid && Date.now() < holdChat.until;
      if (!isHeld && (saved || chatSeen !== sid)) chat = mergeChat(saved);
      const next = sid ? states.find(s => s.sid === sid && isFresh(s, now)) || null : null;
      // mod 正在改写文件时可能读到半截，一帧读不到不算它没了。
      if (next || ++misses >= 2) { run = next; misses = 0; }
      if (want && (want.sid !== sid || Date.now() >= want.until || (run && run.status !== want.from))) want = null;
    } catch (_) { /* 读不到就沿用上一帧 */ }
    draw();
  }

  function save(fn) {
    settings = mergeTiers(fn(JSON.parse(JSON.stringify(settings))));
    holdTiers = Date.now() + 1500;
    invoke('save_settings', { text: JSON.stringify(settings) }).catch(() => {});
    draw();
  }
  function saveChat(fn) {
    if (!sid) return;
    chat = mergeChat(fn({ ...chat }));
    holdChat = { sid, until: Date.now() + 1500 };
    invoke('save_chat', { sid, text: JSON.stringify(chat) }).catch(() => {});
    draw();
  }
  const tierOf = (ttl, fn) => save(s => { s.tiers[ttl] = fn(s.tiers[ttl]); return s; });

  // ---------- 交互 ----------
  // 点过胶囊后键盘焦点会留在按钮上，回头按的空格、回车会被当成再点一次，悄悄拨动开关。
  // 只认鼠标点的（键盘触发的 click 里 detail 是 0）。
  document.addEventListener('click', e => {
    if (e.detail === 0 && e.target.closest('button')) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  $('seg').onclick = e => {
    const b = e.target.closest('button');
    if (b) saveChat(c => { c.ttl = b.dataset.ttl; return c; });
  };
  $('sw').onclick = () => saveChat(c => { c.isOn = !c.isOn; return c; });
  $('minus').onclick = () => tierOf(chat.ttl, t => ({ ...t, max: t.max - 1 }));
  $('plus').onclick = () => tierOf(chat.ttl, t => ({ ...t, max: t.max + 1 }));
  $('ivMinus').onclick = () => tierOf(chat.ttl, t => ({ ...t, iv: t.iv - STEP[chat.ttl] }));
  $('ivPlus').onclick = () => tierOf(chat.ttl, t => ({ ...t, iv: t.iv + STEP[chat.ttl] }));
  $('iv').onchange = e => {
    const s = parse(e.target.value);
    if (s == null) draw(); else tierOf(chat.ttl, t => ({ ...t, iv: s }));
    e.target.blur();
  };
  // 拖动时每跨一格就存一次，一次拖动最多三十来格。
  $('compact').oninput = e => saveChat(c => { c.compact = { ...c.compact, [c.ttl]: e.target.value * 1000 }; return c; });
  $('iv').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  // 立即保活：把计数加一，由 mod 看到变化后去发。
  $('now').onclick = () => saveChat(c => { c.pingNonce += 1; return c; });
  // ⏹：这段空闲不再保活，下条消息写入缓存后 mod 自己重新开始；▶：接着原来的倒计时。
  $('act').onclick = () => {
    const status = statusOf();
    if (status !== 'live' && status !== 'stopped') return;
    if (!run.canStop) { oldMod = { sid, until: Date.now() + 4000 }; draw(); return; }
    const isStop = status === 'live';
    want = { sid, from: run.status, status: isStop ? 'stopped' : 'resuming', until: Date.now() + 4000 };
    saveChat(c => { if (isStop) c.stopNonce += 1; else c.resumeNonce += 1; return c; });
  };

  // 点胶囊开合；按住拖动。拖动交给系统，Rust 一侧在松手后记下新位置。
  let press = null, dragged = false;
  const armDrag = el => el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    press = { x: e.screenX, y: e.screenY };
    dragged = false;
  });
  armDrag($('chip'));
  armDrag($('head'));
  window.addEventListener('pointermove', async e => {
    if (!press || dragged) return;
    if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < 4) return;
    dragged = true;
    press = null;
    await invoke('begin_drag');
    if (tauri) tauri.window.getCurrentWindow().startDragging();
  });
  window.addEventListener('pointerup', () => { press = null; });
  $('chip').addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    if (e.target.closest('#act')) return;
    open = !open;
    draw();
  });
  // 点到胶囊和面板以外（包括点回 Claude 窗口）就收起。
  document.addEventListener('pointerdown', e => {
    if (open && !e.target.closest('#pop, #chip')) { open = false; draw(); }
  });
  window.addEventListener('blur', () => { if (open) { open = false; draw(); } });

  // 窗口跟着内容走：Rust 一侧保持右下角不动。
  let fitting = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(() => {
      const r = $('wrap').getBoundingClientRect();
      invoke('fit', { w: Math.ceil(r.width) + 28, h: Math.ceil(r.height) + 28 }).catch(() => {});
    });
  }).observe($('wrap'));

  setInterval(refresh, 1000);
  refresh();

  // ---------- 浏览器里预览用的假后端 ----------
  function demoBackend() {
    // 两个聊天：demo-a 开着保活，demo-b 从没开过；URL 带 #b 时看 demo-b。
    const mem = { settings: null, chats: { 'demo-a': { ttl: '5m', isOn: true, pingNonce: 0, stopNonce: 0, resumeNonce: 0 } }, nonce: 0, stop: 0, resume: 0, status: 'live', sent: 2, nextAt: Date.now() + 8000, warmAt: Date.now() + 8000 - 270000, last: null };
    return async (cmd, args) => {
      if (cmd === 'save_settings') { mem.settings = JSON.parse(args.text); return; }
      if (cmd === 'save_chat') {
        mem.chats[args.sid] = JSON.parse(args.text);
        const a = mem.chats['demo-a'];
        if (args.sid === 'demo-a' && a.pingNonce !== mem.nonce) {
          mem.nonce = a.pingNonce;
          mem.sent++; mem.warmAt = Date.now(); mem.nextAt = mem.warmAt + 270000;
          mem.last = { at: Date.now(), read: 146900, write: 0, out: 1 };
        }
        if (args.sid === 'demo-a' && a.stopNonce !== mem.stop) { mem.stop = a.stopNonce; mem.status = 'stopped'; }
        if (args.sid === 'demo-a' && a.resumeNonce !== mem.resume) { mem.resume = a.resumeNonce; mem.status = 'live'; }
        return;
      }
      if (cmd !== 'snapshot') return;
      const t = Date.now();
      // 真的 mod 发一次保活要一两秒，这段时间倒计时停在 0。
      // URL 带 #busy 时当作正在对话。
      if (location.hash === '#busy') mem.status = 'busy';
      if (mem.status === 'live' && t >= mem.nextAt + 1500) { mem.sent++; mem.warmAt = t; mem.nextAt = t + 270000; mem.last = { at: t, read: 146900, write: 0, out: 1 }; }
      return {
        now: t, settings: mem.settings,
        focusKnown: true, focus: location.hash === '#b' ? 'demo-b' : 'demo-a', chats: mem.chats,
        states: [{ sid: 'demo-a', ttl: '5m', sent: mem.sent, warmAt: mem.warmAt, status: mem.status, nextAt: mem.status === 'live' ? mem.nextAt : null, note: '', last: mem.last, activeAt: t, beat: t, canStop: true, compactCheck: demoCheck(mem.chats['demo-a']) }],
      };
    };
    // 假装 Claude Code 照单全收：窗口就是设的值。
    function demoCheck(c) {
      const want = c && c.isOn && c.compact ? c.compact[c.ttl] ?? null : null;
      return { want, deny: null, env: want === null ? null : String(want), window: want ?? 1000000, source: want === null ? 'auto' : 'env' };
    }
  }
})();
