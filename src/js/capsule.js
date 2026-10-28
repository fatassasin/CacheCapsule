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
  const DEFAULTS = {
    ttl: '5m', isOn: true, pingNonce: 0,
    tiers: { '5m': { iv: 270, max: 6 }, '1h': { iv: 3300, max: 3 } },
  };
  const STATUS = {
    live: '保活中', busy: '对话中', done: '已用完', off: '已关闭', closed: '窗口已关闭',
    empty: '等待首条回复', expired: '缓存已过期', error: '出错',
  };

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;
  const parse = v => { const m = String(v).trim().match(/^(\d+)(?::(\d{1,2}))?$/); return m ? (+m[1]) * 60 + (+(m[2] ?? 0)) : null; };
  const human = s => { const m = Math.round(s / 60); return m >= 120 ? `${(m / 60).toFixed(1)} 小时` : `${m} 分钟`; };
  const clampIv = (ttl, s) => Math.min(TTL[ttl] - 5, Math.max(MIN_IV, Math.round(s)));

  function merge(saved) {
    const s = saved || {};
    const tier = ttl => {
      const t = { ...DEFAULTS.tiers[ttl], ...((s.tiers || {})[ttl] || {}) };
      return { iv: clampIv(ttl, t.iv), max: Math.min(MAX_COUNT, Math.max(1, Math.round(t.max))) };
    };
    return {
      ttl: s.ttl === '1h' ? '1h' : '5m',
      isOn: s.isOn ?? true,
      pingNonce: Number(s.pingNonce) || 0,
      tiers: { '5m': tier('5m'), '1h': tier('1h') },
    };
  }

  let settings = merge(null);
  let run = null;        // 正在显示的那个会话的状态，没有就是 null
  let now = Date.now();
  let holdUntil = 0;     // 刚改过设置，这段时间内不让旧快照盖回去
  let open = false;
  let misses = 0;
  let autostart = null, startupBusy = false, startupReading = false;
  let startupVersion = 0, startupError = '';

  // 多个会话同时开着时，挑最近有动静的那个；心跳断了的不算。
  function pick(states, at) {
    const live = states.filter(s => !s.ended && at - (s.beat || 0) < FRESH_MS);
    live.sort((a, b) => (b.activeAt || 0) - (a.activeAt || 0));
    return live[0] || null;
  }

  function statusOf() {
    if (!settings.isOn) return 'off';
    if (!run) return 'empty';
    if (run.status !== 'live') return run.status;
    if (run.nextAt == null) return 'empty';
    if (run.sent >= settings.tiers[run.ttl].max) return 'done';
    return 'live';
  }

  function draw() {
    const ttl = settings.ttl, t = settings.tiers[ttl];
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
    $('sw').classList.toggle('on', settings.isOn);
    $('autostart').classList.toggle('on', autostart === true);
    $('autostart').setAttribute('aria-checked', String(autostart === true));
    $('autostart').disabled = startupBusy || autostart === null;
    $('autostartHint').textContent = startupError || (startupBusy ? '正在更新启动项…' : autostart === null ? '正在读取启动项…' : '登录 Windows 后自动运行胶囊');
    $('autostartHint').classList.toggle('warn', !!startupError);
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
  async function refreshStartup() {
    if (startupBusy || startupReading) return;
    startupReading = true;
    const version = startupVersion;
    try {
      const actual = await invoke('get_autostart');
      if (version === startupVersion) autostart = actual;
    } catch (e) {
      if (version === startupVersion) startupError = `读取启动项失败：${e}`;
    } finally {
      startupReading = false;
    }
  }

  async function refresh() {
    try {
      const snap = await invoke('snapshot');
      now = snap.now;
      if (Date.now() >= holdUntil) settings = merge(snap.settings);
      const next = pick(snap.states || [], snap.now);
      // mod 正在改写文件时可能读到半截，一帧读不到不算它没了。
      if (next || ++misses >= 2) { run = next; misses = 0; }
    } catch (_) { /* 读不到就沿用上一帧 */ }
    if (open || autostart === null) await refreshStartup();
    draw();
  }

  function save(fn) {
    settings = merge(fn(JSON.parse(JSON.stringify(settings))));
    holdUntil = Date.now() + 1500;
    invoke('save_settings', { text: JSON.stringify(settings) }).catch(() => {});
    draw();
  }
  const tierOf = (ttl, fn) => save(s => { s.tiers[ttl] = fn(s.tiers[ttl]); return s; });

  // ---------- 交互 ----------
  $('seg').onclick = e => {
    const b = e.target.closest('button');
    if (b) save(s => { s.ttl = b.dataset.ttl; return s; });
  };
  $('sw').onclick = () => save(s => { s.isOn = !s.isOn; return s; });
  $('autostart').onclick = async () => {
    if (startupBusy || autostart === null) return;
    startupBusy = true;
    startupVersion++;
    startupError = '';
    draw();
    try {
      autostart = await invoke('set_autostart', { on: !autostart });
    } catch (e) {
      startupError = `更新启动项失败：${e}`;
      try { autostart = await invoke('get_autostart'); } catch (_) { /* 保留上次确认的状态 */ }
    } finally {
      startupBusy = false;
      draw();
    }
  };
  $('minus').onclick = () => tierOf(settings.ttl, t => ({ ...t, max: t.max - 1 }));
  $('plus').onclick = () => tierOf(settings.ttl, t => ({ ...t, max: t.max + 1 }));
  $('ivMinus').onclick = () => tierOf(settings.ttl, t => ({ ...t, iv: t.iv - STEP[settings.ttl] }));
  $('ivPlus').onclick = () => tierOf(settings.ttl, t => ({ ...t, iv: t.iv + STEP[settings.ttl] }));
  $('iv').onchange = e => {
    const s = parse(e.target.value);
    if (s == null) draw(); else tierOf(settings.ttl, t => ({ ...t, iv: s }));
    e.target.blur();
  };
  $('iv').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  // 立即保活：把计数加一，由 mod 看到变化后去发。
  $('now').onclick = () => save(s => { s.pingNonce += 1; return s; });

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
    if (open) refreshStartup().then(draw);
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
    const mem = { settings: null, autostart: false, nonce: 0, sent: 2, nextAt: Date.now() + 8000, last: null };
    return async (cmd, args) => {
      if (cmd === 'get_autostart') return mem.autostart;
      if (cmd === 'set_autostart') return (mem.autostart = args.on);
      if (cmd === 'save_settings') {
        mem.settings = JSON.parse(args.text);
        if (mem.settings.pingNonce !== mem.nonce) {
          mem.nonce = mem.settings.pingNonce;
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
        states: [{ sid: 'demo', ttl: '5m', sent: mem.sent, nextAt: mem.nextAt, warmAt: t, status: 'live', note: '', last: mem.last, activeAt: t, beat: t }],
      };
    };
  }
})();
