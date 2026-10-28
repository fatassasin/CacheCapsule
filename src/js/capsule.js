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
  const FRESH_MS = 20000; // mod 隔几秒写一次心跳，超过这么久没动静就当那个会话没了
  const DEFAULT_TIERS = { '5m': { iv: 270, max: 6 }, '1h': { iv: 3300, max: 3 } };
  const STATUS = {
    live: '保活中', busy: '对话中', done: '已用完', off: '已关闭', closed: '窗口已关闭',
    empty: '等待首条回复', expired: '缓存已过期', error: '出错',
    nochat: '未打开对话', nomod: '未加载 · 在本对话运行 /reload-plugins',
  };

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
  const parse = v => { const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?$/); return m ? (+m[1]) * 60 + (+(m[2] ?? 0)) : null; };
  const human = s => { const m = Math.round(s / 60); return m >= 120 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`; };
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
  // 开关、档位、立即保活每个聊天各一份（chats/<会话>.json）；没开过的聊天是关的。
  function mergeChat(saved) {
    const c = saved || {};
    return { ttl: c.ttl === '1h' ? '1h' : '5m', isOn: c.isOn === true, pingNonce: Number(c.pingNonce) || 0 };
  }

  let settings = mergeTiers(null);
  let chat = mergeChat(null);
  let sid = null;        // 正在显示的聊天，认不出就是 null
  let run = null;        // 这个聊天的保活状态，mod 还没写过就是 null
  let now = Date.now();
  let holdTiers = 0;     // 刚改过设置，这段时间内不让旧快照盖回去
  let holdChat = { sid: null, until: 0 };
  let open = false;
  let misses = 0;

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
    if (run.status !== 'live') return run.status;
    if (run.nextAt == null) return 'empty';
    if (run.sent >= settings.tiers[run.ttl].max) return 'done';
    return 'live';
  }

  function draw() {
    const ttl = chat.ttl, t = settings.tiers[ttl];
    const status = statusOf(), ok = status === 'live';
    const runTtl = run ? run.ttl : ttl, rt = settings.tiers[runTtl];
    const sent = run ? run.sent : 0;
    const left = ok ? Math.max(0, Math.ceil((run.nextAt - now) / 1000)) : 0;
    // 对话中虽然还没开始数，也给一个时间：就是下一轮满格的间隔。
    const cd = ok ? fmt(left) : status === 'busy' ? fmt(rt.iv) : null;
    const pending = run && run.ttl !== ttl && run.nextAt != null;

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

    const label = STATUS[status] + (run && run.note && status !== 'live' ? ` · ${run.note}` : '');
    const cdEl = $('cd');
    cdEl.textContent = cd ?? label;
    cdEl.classList.toggle('mute', cd === null);
    $('bar').style.width = ok ? `${Math.min(100, (1 - left / rt.iv) * 100)}%` : '0%';
    $('cnt').textContent = `${sent} / ${rt.max}`;
    $('pips').innerHTML = Array.from({ length: rt.max }, (_, i) => `<i class="${i < sent ? 'done' : ''}"></i>`).join('');
    $('pill').textContent = label;
    $('pill').classList.toggle('off', !ok);

    $('cdot').classList.toggle('off', !ok);
    $('cttl').textContent = pending ? `${run.ttl} → ${ttl}` : ttl;
    $('ccount').textContent = `保活 ${sent}/${rt.max}`;
    $('ccd').textContent = cd ?? '—';
    $('ccd').classList.toggle('off', !ok);

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
      if (!(holdChat.sid === sid && Date.now() < holdChat.until)) chat = mergeChat(sid && (snap.chats || {})[sid]);
      const next = sid ? states.find(s => s.sid === sid && isFresh(s, now)) || null : null;
      // mod 正在改写文件时可能读到半截，一帧读不到不算它没了。
      if (next || ++misses >= 2) { run = next; misses = 0; }
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
  $('iv').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  // 立即保活：把计数加一，由 mod 看到变化后去发。
  $('now').onclick = () => saveChat(c => { c.pingNonce += 1; return c; });

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
  $('chip').addEventListener('click', () => {
    if (dragged) { dragged = false; return; }
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
    const mem = { settings: null, chats: { 'demo-a': { ttl: '5m', isOn: true, pingNonce: 0 } }, nonce: 0, sent: 2, nextAt: Date.now() + 8000, last: null };
    return async (cmd, args) => {
      if (cmd === 'save_settings') { mem.settings = JSON.parse(args.text); return; }
      if (cmd === 'save_chat') {
        mem.chats[args.sid] = JSON.parse(args.text);
        const a = mem.chats['demo-a'];
        if (args.sid === 'demo-a' && a.pingNonce !== mem.nonce) {
          mem.nonce = a.pingNonce;
          mem.sent++; mem.nextAt = Date.now() + 270000;
          mem.last = { at: Date.now(), read: 146900, write: 0, out: 1 };
        }
        return;
      }
      if (cmd !== 'snapshot') return;
      const t = Date.now();
      if (t >= mem.nextAt) { mem.sent++; mem.nextAt = t + 270000; mem.last = { at: t, read: 146900, write: 0, out: 1 }; }
      return {
        now: t, settings: mem.settings,
        focusKnown: true, focus: location.hash === '#b' ? 'demo-b' : 'demo-a', chats: mem.chats,
        states: [{ sid: 'demo-a', ttl: '5m', sent: mem.sent, nextAt: mem.nextAt, warmAt: t, status: 'live', note: '', last: mem.last, activeAt: t, beat: t }],
      };
    };
  }
})();
