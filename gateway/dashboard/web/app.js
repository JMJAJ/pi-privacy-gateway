/* Pi Privacy Gateway - live dashboard (no external dependencies). */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const num = (v, d = 1) => (v == null || isNaN(v) ? '—' : Number(v).toFixed(d));

function fmtBps(b) {
  if (b == null) return '—';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' Gbps';
  if (b >= 1e6) return (b / 1e6).toFixed(b >= 1e8 ? 0 : 1) + ' Mbps';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' kbps';
  return Math.round(b) + ' bps';
}
function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; i++; }
  return (i ? b.toFixed(b >= 100 ? 0 : 1) : b) + ' ' + u[i];
}
function ago(s) {
  if (s == null) return 'never';
  if (s < 60) return s + ' s ago';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  return Math.floor(s / 86400) + ' d ago';
}
function dur(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}
// status chip: always icon + label (colour is never the only cue)
const ICON = { good: '✓', warn: '!', serious: '!', crit: '✕', off: '–', tor: '◆', prov: '◆' };
const chip = (level, label) => `<span class="chip ${level}"><i>${ICON[level] || ''}</i>${esc(label)}</span>`;
const row = (k, v) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;

/* ------------------------------------------------------------------ state */
let S = null;                 // latest snapshot
const H = { t: [] };          // 5-minute history, 1 point per second
const HIST_MAX = 300;
let trusted = false;
let switching = false;


const histKeys = (s) => {
  const pr = Object.values(s.peer_rates || {});
  const vals = {
    cpu: (s.cpu || {}).cpu ?? 0, temp: s.temp_c, power: (s.power || {}).total_w ?? null,
    vpn_down: pr.reduce((a, r) => a + (r.down_bps || 0), 0), vpn_up: pr.reduce((a, r) => a + (r.up_bps || 0), 0),
  };
  for (const [ifc, r] of Object.entries(s.rates || {})) { vals[ifc + '_rx'] = r.rx_bps; vals[ifc + '_tx'] = r.tx_bps; }
  return vals;
};
function histPush(s) {
  if (!s.rates || !s.ts) return;
  const t = Math.round(s.ts);
  if (H.t.length && H.t[H.t.length - 1] >= t) return;
  const vals = histKeys(s);
  H.t.push(t);
  for (const k of Object.keys(vals)) (H[k] = H[k] || Array(H.t.length - 1).fill(null)).push(vals[k]);
  for (const k of Object.keys(H)) {               // keep every series aligned with H.t
    if (k !== 't' && !(k in vals)) H[k].push(null);
    while (H[k].length > HIST_MAX) H[k].shift();
  }
  while (H.t.length > HIST_MAX) H.t.shift();
}
const series = (key) => H[key] || [];

/* ----------------------------------------------------------------- charts */
const tooltip = $('tooltip');
// clean axis: step is 1/2/5 x 10^k, 2-5 gridlines, top = whole number of steps
function niceScale(v) {
  if (!v || v <= 0) v = 1;
  const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw);
  const ticks = Math.max(2, Math.ceil(v / step - 1e-9));
  return { step, ticks, max: step * ticks };
}
// time labels that never collide: fewer when the plot is narrow
const xMarks = (pw) => (pw < 220 ? [5, 0] : pw < 420 ? [5, 3, 1, 0] : [5, 4, 3, 2, 1, 0]);
// '-12h' style label for a point `sec` seconds before now, unit picked from the chart's span
const agoLabel = (sec, span) => span <= 3600 ? `\u2212${Math.round(sec / 60)}m` : span <= 172800 ? `\u2212${Math.round(sec / 3600)}h` : `\u2212${Math.round(sec / 86400)}d`;

class LineChart {
  /** opts: { lines: [{label, color: '--s1', data: () => []}], fmt, minMax, fixedMax,
   *          src: () => ({t: [...], span: seconds})  (optional: history instead of the live 5 min) } */
  constructor(el, opts) {
    this.el = el; this.o = opts; this.hover = null;
    this.c = document.createElement('canvas');
    el.appendChild(this.c);
    this.c.setAttribute('role', 'img');
    this.c.setAttribute('aria-label', opts.lines.map((l) => l.label).join(' and ') + (opts.src ? ' over time' : ' over the last 5 minutes'));
    this.c.addEventListener('mousemove', (e) => { this.hover = e; this.draw(); });
    this.c.addEventListener('mouseleave', () => { this.hover = null; tooltip.hidden = true; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(el);
  }
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.el.clientWidth, Hh = this.el.clientHeight;
    if (!W || !Hh) return;
    if (this.c.width !== Math.round(W * dpr) || this.c.height !== Math.round(Hh * dpr)) {
      this.c.width = Math.round(W * dpr); this.c.height = Math.round(Hh * dpr);
    }
    const g = this.c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, Hh);
    const lines = this.o.lines.map((l) => ({ ...l, d: l.data() }));
    const src = this.o.src ? this.o.src() : null;
    const T = src ? (src.t || []) : H.t, span = src ? (src.span || 3600) : HIST_MAX;
    const n = T.length;
    let peak = this.o.fixedMax || 0;
    if (!this.o.fixedMax) for (const l of lines) for (const v of l.d) if (v != null && v > peak) peak = v;
    const sc = this.o.fixedMax ? { step: this.o.fixedMax / 4, ticks: 4, max: this.o.fixedMax } : niceScale(Math.max(peak, this.o.minMax || 0));
    const max = sc.max;
    const fmt = this.o.fmt || ((v) => v);
    g.font = '11px system-ui, sans-serif';
    g.textBaseline = 'middle';
    const labels = Array.from({ length: sc.ticks + 1 }, (_, i) => fmt(sc.step * i, true));
    const pad = { l: Math.ceil(Math.max(...labels.map((s) => g.measureText(s).width))) + 12, r: 8, t: 8, b: 20 };
    const pw = W - pad.l - pad.r, ph = Hh - pad.t - pad.b;
    // grid + y ticks (recessive)
    for (let i = 0; i <= sc.ticks; i++) {
      const y = pad.t + ph - (ph * i) / sc.ticks;
      g.strokeStyle = i === 0 ? css('--axis') : css('--grid');
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(pad.l, Math.round(y) + .5); g.lineTo(W - pad.r, Math.round(y) + .5); g.stroke();
      g.fillStyle = css('--muted'); g.textAlign = 'right';
      g.fillText(labels[i], pad.l - 6, y);
    }
    // x labels: -span ... now
    g.textAlign = 'center'; g.fillStyle = css('--muted');
    for (const m of xMarks(pw)) {
      const x = pad.l + pw * (1 - m / 5);
      g.fillText(m ? agoLabel((span * m) / 5, span) : 'now', Math.min(Math.max(x, pad.l + 12), W - pad.r - 12), Hh - 8);
    }
    if (n < 2) return;
    const tEnd = src ? Math.max(T[n - 1], Date.now() / 1000) : T[n - 1];
    const X = (i) => pad.l + pw * (1 - (tEnd - T[i]) / span);
    const Y = (v) => pad.t + ph - (ph * Math.min(v, max)) / max;
    for (const l of lines) {
      const col = css(l.color);
      // faint area under the line for depth
      g.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const v = l.d[i]; if (v == null) continue;
        if (!started) { g.moveTo(X(i), Y(v)); started = true; } else g.lineTo(X(i), Y(v));
      }
      g.strokeStyle = col; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
      if (lines.length === 1 && started) {
        g.lineTo(X(n - 1), pad.t + ph); g.lineTo(X(0), pad.t + ph); g.closePath();
        g.globalAlpha = 0.10; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
      }
    }
    // hover: crosshair + markers + tooltip
    if (this.hover) {
      const r = this.c.getBoundingClientRect();
      const mx = this.hover.clientX - r.left;
      let best = 0, bd = 1e9;
      for (let i = 0; i < n; i++) { const d = Math.abs(X(i) - mx); if (d < bd) { bd = d; best = i; } }
      const x = X(best);
      g.strokeStyle = css('--axis'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(Math.round(x) + .5, pad.t); g.lineTo(Math.round(x) + .5, pad.t + ph); g.stroke();
      const when = new Date(T[best] * 1000);
      let html = `<div class="tt-t">${src && span > 3600 ? when.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : when.toLocaleTimeString()}</div>`;
      for (const l of lines) {
        const v = l.d[best]; if (v == null) continue;
        g.beginPath(); g.arc(x, Y(v), 4, 0, Math.PI * 2);
        g.fillStyle = css(l.color); g.fill(); g.lineWidth = 2; g.strokeStyle = css('--surface'); g.stroke();
        html += `<div class="tt-r"><span><span class="sw" style="background:${css(l.color)}"></span>${esc(l.label)}</span><b>${esc(fmt(v))}</b></div>`;
      }
      tooltip.innerHTML = html; tooltip.hidden = false;
      const tx = Math.min(this.hover.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
      tooltip.style.left = tx + 'px'; tooltip.style.top = (this.hover.clientY - 10) + 'px';
    }
  }
}

class StackedBars {
  /** hourly stacked bars: parts [{label, color, data: () => []}] */
  constructor(el, opts) {
    this.el = el; this.o = opts; this.hover = null;
    this.c = document.createElement('canvas'); el.appendChild(this.c);
    this.c.setAttribute('role', 'img'); this.c.setAttribute('aria-label', 'DNS queries per hour, allowed and blocked');
    this.c.addEventListener('mousemove', (e) => { this.hover = e; this.draw(); });
    this.c.addEventListener('mouseleave', () => { this.hover = null; tooltip.hidden = true; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(el);
  }
  draw() {
    const dpr = window.devicePixelRatio || 1, W = this.el.clientWidth, Hh = this.el.clientHeight;
    if (!W || !Hh) return;
    this.c.width = Math.round(W * dpr); this.c.height = Math.round(Hh * dpr);
    const g = this.c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
    const parts = this.o.parts.map((p) => ({ ...p, d: p.data() }));
    const n = Math.max(0, ...parts.map((p) => p.d.length));
    const pad = { l: 42, r: 6, t: 8, b: 20 }, pw = W - pad.l - pad.r, ph = Hh - pad.t - pad.b;
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, parts.reduce((a, p) => a + (p.d[i] || 0), 0));
    const sc = niceScale(peak), max = sc.max;
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (let i = 0; i <= sc.ticks; i++) {
      const y = pad.t + ph - (ph * i) / sc.ticks;
      g.strokeStyle = i === 0 ? css('--axis') : css('--grid'); g.lineWidth = 1;
      g.beginPath(); g.moveTo(pad.l, Math.round(y) + .5); g.lineTo(W - pad.r, Math.round(y) + .5); g.stroke();
      g.fillStyle = css('--muted'); g.textAlign = 'right'; g.fillText((sc.step * i).toLocaleString(), pad.l - 6, y);
    }
    if (!n) return;
    const bw = pw / n, gap = 2, w = Math.max(2, bw - gap);
    g.textAlign = 'center'; g.fillStyle = css('--muted');
    g.fillText('−24h', pad.l + 14, Hh - 8); g.fillText('−12h', pad.l + pw / 2, Hh - 8); g.fillText('now', W - pad.r - 12, Hh - 8);
    let hi = -1;
    if (this.hover) { const r = this.c.getBoundingClientRect(); hi = Math.floor((this.hover.clientX - r.left - pad.l) / bw); }
    for (let i = 0; i < n; i++) {
      let base = pad.t + ph;
      const x = pad.l + i * bw + gap / 2;
      parts.forEach((p, pi) => {
        const v = p.d[i] || 0; if (!v) return;
        const h = (ph * v) / max;
        const top = pi === parts.length - 1 || !parts.slice(pi + 1).some((q) => q.d[i]);
        g.fillStyle = css(p.color); g.globalAlpha = hi >= 0 && hi !== i ? 0.55 : 1;
        g.beginPath();
        const y = base - h, r = top ? Math.min(4, w / 2, h) : 0;
        g.moveTo(x, base); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.lineTo(x + w - r, y);
        g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, base); g.closePath(); g.fill();
        g.globalAlpha = 1;
        base = y - (top ? 0 : 2);  // 2px surface gap between stacked segments
      });
    }
    if (hi >= 0 && hi < n) {
      let html = `<div class="tt-t">${n - hi} h ago</div>`;
      for (const p of parts) html += `<div class="tt-r"><span><span class="sw" style="background:${css(p.color)}"></span>${esc(p.label)}</span><b>${(p.d[hi] || 0).toLocaleString()}</b></div>`;
      tooltip.innerHTML = html; tooltip.hidden = false;
      tooltip.style.left = Math.min(this.hover.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8) + 'px';
      tooltip.style.top = (this.hover.clientY - 10) + 'px';
    }
  }
}


const legend = (items) => items.map((i) => `<span><span class="sw" style="background:var(${i.color})"></span>${esc(i.label)}</span>`).join('');
const bpsFmt = (v, axis) => (axis && v === 0 ? '0' : fmtBps(v).replace(' ', axis ? '' : ' '));
const modeName = (m) => ({ warp: 'WARP', provider: (S && S.provider_name) || 'Provider', tor: 'Tor' })[m] || m;

const charts = [];
let ifaceKeys = '';
function makeCharts() {
  $('lg-vpn').innerHTML = legend([{ label: 'Download', color: '--s1' }, { label: 'Upload', color: '--s2' }]);
  charts.push(new LineChart($('ch-vpn'), {
    lines: [{ label: 'Download', color: '--s1', data: () => series('vpn_down') }, { label: 'Upload', color: '--s2', data: () => series('vpn_up') }],
    fmt: bpsFmt, minMax: 1e6,
  }));
  charts.push(new LineChart($('ch-power'), { lines: [{ label: 'Power (est.)', color: '--s1', data: () => series('power') }], fmt: (v) => num(v, 1) + ' W', minMax: 5 }));
  charts.push(new LineChart($('ch-cpu'), { lines: [{ label: 'CPU', color: '--s1', data: () => series('cpu') }], fmt: (v) => Math.round(v) + '%', fixedMax: 100 }));
  charts.push(new LineChart($('ch-temp'), { lines: [{ label: 'CPU temperature', color: '--s2', data: () => series('temp') }], fmt: (v) => num(v, 0) + ' °C', minMax: 80 }));
  $('lg-dns').innerHTML = legend([{ label: 'Allowed', color: '--s1' }, { label: 'Blocked', color: '--s2' }]);
  charts.push(new StackedBars($('ch-dns'), {
    parts: [
      { label: 'Allowed', color: '--s1', data: () => { const d = (S && S.dns) || {}; return (d.queries_series || []).map((q, i) => Math.max(0, q - ((d.blocked_series || [])[i] || 0))); } },
      { label: 'Blocked', color: '--s2', data: () => ((S && S.dns) || {}).blocked_series || [] },
    ],
  }));
}
// one small chart per network interface the host actually has
function ensureIfaceCharts(ifaces) {
  const keys = ifaces.map((i) => i.key).join(',');
  if (keys === ifaceKeys) return;
  ifaceKeys = keys;
  for (let i = charts.length - 1; i >= 0; i--) if (charts[i].iface) charts.splice(i, 1);
  $('iface-charts').innerHTML = ifaces.map((i) =>
    `<div class="card"><div class="mini-head"><b>${esc(i.label)}</b><span class="mini-vals" id="mv-${esc(i.key)}"></span></div><div class="chart" id="ch-if-${esc(i.key)}"></div></div>`).join('');
  for (const i of ifaces) {
    const c = new LineChart($('ch-if-' + i.key), {
      lines: [{ label: 'Receive', color: '--s1', data: () => series(i.key + '_rx') }, { label: 'Transmit', color: '--s2', data: () => series(i.key + '_tx') }],
      fmt: bpsFmt, minMax: 1e5,
    });
    c.iface = true;
    charts.push(c);
  }
}

/* ---------------------------------------------------------------- renders */
const kpi = (k, v, s, cls = '') => `<div class="kpi"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${s}</div></div>`;
const isOnline = (p) => p.handshake_age != null && p.handshake_age < 180;

function render() {
  if (!S) return;
  trusted = !!S.trusted;
  const mode = S.mode, tor = mode === 'tor', prov = mode === 'provider';
  const ex = S.exits || {}, w = ex.warp || {}, pv = ex.provider || {}, T = S.tor || {}, ks = S.killswitch || {};
  const peers = (S.wg1 || {}).peers || [], online = peers.filter(isOnline);
  const pr = Object.values(S.peer_rates || {});
  const down = pr.reduce((a, r) => a + (r.down_bps || 0), 0), up = pr.reduce((a, r) => a + (r.up_bps || 0), 0);
  const dns = S.dns || {}, pw = S.power;
  const hasProv = (S.provider || {}).configured;

  $('host').textContent = location.host;
  $('mode-provider').hidden = !hasProv;
  $('mode-provider').textContent = S.provider_name || 'Provider';
  $('mode-ptor').hidden = !hasProv;
  $('mode-ptor').textContent = (S.provider_name || 'Provider') + '+Tor';
  // "Provider+Tor" = Tor mode with Tor itself running through the provider tunnel
  const cur = tor && S.tor_via === 'provider' ? 'ptor' : mode;
  for (const m of ['warp', 'provider', 'tor', 'ptor']) {
    const b = $('mode-' + m);
    b.classList.toggle('on', cur === m);
    b.setAttribute('aria-checked', cur === m);
    b.disabled = !trusted || switching;
    b.title = trusted ? (m === 'ptor' ? `Tor, with Tor itself connecting through ${S.provider_name || 'the provider'} (inside WARP)` : `Send all VPN devices out through ${modeName(m)}`) : 'Connect through the VPN to switch';
  }

  const alerts = [];
  if (!ks.armed) alerts.push('Kill switch is NOT armed');
  if ((S.system || {}).undervoltage) alerts.push('Under-voltage: use a stronger power supply');
  if (w.warp !== 'on' && !tor) alerts.push('WARP is not connected: VPN traffic is blocked by the kill switch');
  if (prov && !pv.ip) alerts.push(`${modeName('provider')} is not connected: VPN traffic is blocked until it is`);
  if (tor && !T.exit_ip) alerts.push('Tor is not connected: VPN traffic is blocked until it is');
  if (S.failover) alerts.push(`${modeName('provider')} is down: its devices are temporarily using WARP (failover)`);
  if (S.clock_offset_s != null && Math.abs(S.clock_offset_s) > 60) alerts.push(`System clock is off by ${Math.round(S.clock_offset_s)} s: Tor will not work`);
  const bn = $('banner');
  if (!switching) {
    bn.hidden = !alerts.length;
    if (alerts.length) { bn.className = 'banner crit'; bn.innerHTML = chip('crit', 'Attention') + ' ' + alerts.map(esc).join(' · '); }
  }

  const exitIp = tor ? T.exit_ip : prov ? pv.ip : w.ip;
  const exitCc = tor ? ((T.path || []).slice(-1)[0] || {}).country : prov ? pv.loc : w.loc;
  $('kpis').innerHTML = [
    kpi('Websites see', esc(exitIp || '—'), `${chip(tor ? 'tor' : prov ? 'prov' : (w.warp === 'on' ? 'good' : 'crit'), modeName(mode))} ${esc(exitCc || '')}${prov || tor ? ' · inside WARP' : ''}`, 'ip'),
    kpi('Kill switch', ks.armed ? 'Armed' : 'OFF', `${chip(ks.armed ? 'good' : 'crit', ks.armed ? 'Fail-closed' : 'Leaks possible')} ${(ks.rejected_pkts || 0).toLocaleString()} blocked`),
    kpi('VPN throughput', fmtBps(down), `↓ download · ↑ ${fmtBps(up)} upload`),
    kpi('Devices online', `${online.length}<small>/ ${peers.length}</small>`, online.map((p) => esc(p.name)).join(', ') || 'none connected'),
    kpi('Ads & trackers', dns.blocked_pct != null ? `${dns.blocked_pct}<small>%</small>` : '—', dns.ok ? `${(dns.blocked || 0).toLocaleString()} of ${(dns.queries || 0).toLocaleString()} blocked (24 h)` : 'AdGuard not connected'),
    pw ? kpi('Power (est.)', `${num(pw.total_w, 1)}<small>W</small>`, `≈ ${num(pw.amps_5v, 2)} A at 5 V · ${num(S.temp_c, 0)} °C CPU`)
       : kpi('CPU', `${num((S.cpu || {}).cpu, 0)}<small>%</small>`, `${num(S.temp_c, 0)} °C · load ${esc(((S.system || {}).load || [])[0] || '—')}`),
  ].join('');

  renderStack(mode, ex, w, pv, T, ks, peers, online, down, dns, hasProv);
  renderAnatomy(mode);
  ensureIfaceCharts(S.ifaces || []);
  renderTraffic();
  renderRoute(mode, ex, w, pv, T, hasProv);
  renderDns(dns);
  renderSystem(S.system || {}, pw);
  renderSecurity(ks, dns, w, pv, T, hasProv);
  for (const c of charts) c.draw();
}

function layer(idx, cls, title, proto, detail, metric, sub) {
  return `<li class="layer ${cls}"><span class="idx">${idx}</span><div class="t">${title}${proto ? `<span class="proto">${proto}</span>` : ''}</div>
    <div class="m"><b>${metric}</b><span>${sub || ''}</span></div><div class="d">${detail}</div></li>`;
}

function renderStack(mode, ex, w, pv, T, ks, peers, online, down, dns, hasProv) {
  const tor = mode === 'tor', prov = mode === 'provider', lat = S.latency || {};
  const wg0p = ((S.wg0 || {}).peers || [])[0] || {}, wg2p = ((S.wg2 || {}).peers || [])[0] || {};
  const up = (S.links || []).find((l) => l.iface === S.uplink) || {};
  const isp = ex.isp || {};
  const L = [];
  let n = 0;
  const add = (...a) => L.push(layer(++n, ...a));
  add('', 'Your devices', 'WireGuard clients', peers.map((p) =>
    `${chip(isOnline(p) ? 'good' : 'off', p.name)} <code>${esc(p.allowed.split('/')[0])}</code>${p.endpoint ? ` via <code>${esc(p.endpoint.split(':')[0])}</code>` : ''}`).join(' &nbsp; ') || 'No devices yet: <code>pgw add-peer phone</code>',
  fmtBps(down), `${online.length} online`);
  add('', 'DNS filter', `AdGuard Home · ${esc(S.vpn_ip)}:53`,
    dns.ok ? `Blocks ads/trackers, DNSSEC ${dns.dnssec ? 'on' : 'off'}. Upstream: ${tor ? 'Tor DNS' : (dns.upstreams || []).map((u) => `<code>${esc(u.replace('https://', '').replace('/dns-query', ''))}</code>`).join(', ')}`
           : 'Not connected: set ADGUARD_USER / ADGUARD_PASSWORD in .env',
    dns.ok ? `${num(dns.avg_ms, 0)} ms` : '—', dns.ok ? `${dns.blocked_pct}% blocked` : '');
  add('l-tun', 'Tunnel A · VPN server', 'WireGuard wg1',
    `Device ⇄ gateway, inner network <code>${esc(S.vpn_subnet)}</code>, ChaCha20-Poly1305 + Curve25519, MTU 1280. Encrypts everything on your local network.`,
    `${online.length}/${peers.length}`, 'devices up');
  add('', 'Kill switch', 'iptables PIX_FWD',
    `VPN traffic may only leave through ${modeName(mode)}; anything else is rejected, so a dropped tunnel means no internet, never a leak.`,
    ks.armed ? chip('good', 'Armed') : chip('crit', 'Off'), `${(ks.rejected_pkts || 0).toLocaleString()} rejected`);
  const relays = (T.path || []).map((h) => `<span class="relay"><b>${esc(h.role)}</b>${esc(h.nick)} <span class="muted">${esc(h.country || '??')}</span></span>`).join('');
  add('l-tor' + (tor ? '' : ' dim'), 'Tor', tor ? '3 relays · onion encryption' : 'not in path',
    tor ? `Your TCP connections end at the gateway and are re-sent through Tor (UDP is blocked).<div class="relays">${relays || 'building circuit…'}</div>` : 'Switch the exit to Tor to add three relays.',
    tor ? `${num(lat.via_tor_connect_ms, 0)} ms` : '—', tor ? 'connect time' : '');
  if (hasProv) add('l-prov' + (prov ? '' : ' dim'), esc(S.provider_name), prov ? `WireGuard wg2 · ${esc(pv.loc || '')}` : 'not in path',
    prov ? `Gateway → ${esc(S.provider_name)} <code>${esc(wg2p.endpoint || '')}</code>. It sees the sites you visit but only a Cloudflare IP, never your home IP.`
         : `Switch the exit to ${esc(S.provider_name)} for a double hop: no single company sees both who you are and where you go.`,
    prov ? `${num((lat.via_provider || {}).ms, 0)} ms` : '—', prov ? 'to 1.1.1.1' : '');
  add('l-tun', 'Tunnel B · Cloudflare WARP', 'WireGuard wg0',
    `Gateway → <code>${esc(wg0p.endpoint || '')}</code>, Cloudflare ${esc(w.colo || '?')}. ${tor ? 'Carries Tor, so your ISP can’t see you use Tor.' : prov ? `Carries ${esc(S.provider_name)}, so Cloudflare only sees encrypted traffic to it.` : 'Hides your destinations from your ISP.'}`,
    `${num((lat.warp_edge || {}).ms, 0)} ms`, `edge · handshake ${ago(wg0p.handshake_age)}`);
  add('', up.wireless ? 'Uplink · Wi-Fi' : 'Uplink · Ethernet', esc(S.uplink || '?'),
    up.wireless ? `<code>${esc((up.ip || '').split('/')[0])}</code> on ${esc(up.ssid || '?')}, ch ${esc(up.channel ?? '?')} / ${esc(up.width || '?')}, ${esc(up.signal_dbm ?? '?')} dBm, link ${esc(up.tx_mbit ?? '?')} Mbit/s`
                : `<code>${esc((up.ip || '').split('/')[0])}</code>, ${esc(up.speed || '?')} Mbit/s`,
    fmtBps(((S.rates || {})[S.uplink] || {}).rx_bps), 'receive now');
  add('', 'Home router', esc(S.gateway || ''), 'Sees only encrypted WireGuard packets to Cloudflare.', `${num((lat.router || {}).ms, 1)} ms`, 'round-trip');
  add('', 'Your ISP', trusted && isp.asn && isp.asn !== 'private' ? `${esc(isp.asn)} · ${esc(asLabel(isp.as_name))}` : '',
    trusted ? (isp.ip ? `Your real public IP <code>${esc(isp.ip)}</code>. The ISP sees traffic volume and timing to Cloudflare, not sites or DNS.` : 'checking…')
            : 'Real IP hidden on the LAN view. Open the dashboard through the VPN.',
    `${num((lat.isp_internet || {}).ms, 0)} ms`, 'direct to 1.1.1.1');
  add('', 'Internet', 'websites', `Websites see <code>${esc((tor ? T.exit_ip : prov ? pv.ip : w.ip) || '—')}</code>, shared by many users.`,
    chip(tor ? 'tor' : prov ? 'prov' : 'good', modeName(mode) + ' exit'), '');
  $('stack').innerHTML = L.join('');
}

function anatomyBar(title, sub, segs, note) {
  const total = segs.reduce((a, s) => a + s[1], 0);
  const hdr = segs.filter((s) => s[2] !== 'pay').reduce((a, s) => a + s[1], 0);
  const bar = segs.map(([name, bytes, cls]) =>
    `<div class="seg-b ${cls}" style="flex:${bytes} 0 0" title="${esc(name)}: ${bytes} bytes">${bytes >= 60 ? esc(name) : ''}</div>`).join('');
  return `<div class="anat"><div class="anat-title">${title}<span>${sub} · ${Math.round((100 * hdr) / total)}% headers</span></div>
    <div class="anat-bar">${bar}</div>${note ? `<div class="anat-note">${note}</div>` : ''}</div>`;
}
function renderAnatomy(mode) {
  const lan = ['LAN link (Wi-Fi/Ethernet)', 50, 'l2'];
  const wgPkt = (name, cls) => [['IP', 20, 'hdr'], ['UDP', 8, 'hdr'], [name, 32, cls]];
  const inner = [['inner IP', 20, 'hdr'], ['TCP', 20, 'hdr']];
  let html = anatomyBar('Hop 1 · your device → gateway', 'encrypted by WireGuard (wg1)', [lan, ...wgPkt('WireGuard', 'tun'), ...inner, ['your data', 1240, 'pay']]);
  if (mode === 'provider') {
    html += anatomyBar(`Hop 2 · gateway → ${esc(S.provider_name)}, inside WARP`, `WARP + ${esc(S.provider_name)}`,
      [lan, ...wgPkt('WARP', 'tun'), ...wgPkt(S.provider_name, 'prov'), ...inner, ['your data', 1180, 'pay']],
      `Two WireGuard layers: the outer one (WARP) hides from your ISP that you use ${esc(S.provider_name)}; the inner one hides your destinations from Cloudflare.`);
  } else if (mode === 'tor') {
    html += anatomyBar('Hop 2 · gateway → Tor guard, inside WARP', 'WARP + TLS + 3 onion layers',
      [lan, ...wgPkt('WARP', 'tun'), ...inner, ['TLS', 29, 'tor'], ['cell hdr', 16, 'tor'], ['data (3× onion-encrypted)', 498, 'pay']],
      'Tor packs data into fixed 514-byte cells, encrypts each three times (exit, middle, guard keys) and sends them over TLS to the guard relay, all inside WARP.');
  } else {
    html += anatomyBar('Hop 2 · gateway → Cloudflare WARP', 'encrypted by WireGuard (wg0)', [lan, ...wgPkt('WARP', 'tun'), ...inner, ['your data', 1240, 'pay']],
      'The gateway decrypts Tunnel A, swaps your device address for its WARP address (NAT) and re-encrypts into Tunnel B. Only Cloudflare sees where it goes next.');
  }
  html += `<div class="anat-legend"><span><span class="sw" style="background:var(--muted)"></span>LAN link</span><span><span class="sw" style="background:var(--s2)"></span>IP / UDP / TCP headers</span><span><span class="sw" style="background:var(--s1)"></span>WireGuard</span>${mode === 'tor' ? '<span><span class="sw" style="background:var(--tor)"></span>Tor</span>' : ''}${mode === 'provider' ? `<span><span class="sw" style="background:var(--prov)"></span>${esc(S.provider_name)}</span>` : ''}<span><span class="sw" style="background:var(--s3)"></span>your data</span></div>`;
  $('anatomy').innerHTML = html;
}

function renderTraffic() {
  for (const i of S.ifaces || []) {
    const r = (S.rates || {})[i.key] || {}, el = $('mv-' + i.key);
    if (el) el.innerHTML = `<span class="sw" style="background:var(--s1)"></span>${fmtBps(r.rx_bps)} &nbsp;<span class="sw" style="background:var(--s2)"></span>${fmtBps(r.tx_bps)}`;
  }
  renderDevices();
}

function renderRoute(mode, ex, w, pv, T, hasProv) {
  const tor = mode === 'tor', prov = mode === 'provider', isp = ex.isp || {}, lat = S.latency || {};
  $('exits').innerHTML = '<div class="rows">' +
    row('Websites see now', `<b class="mono">${esc((tor ? T.exit_ip : prov ? pv.ip : w.ip) || '—')}</b> ${chip(tor ? 'tor' : prov ? 'prov' : 'good', modeName(mode))}`) +
    row('WARP exit', `<span class="mono">${esc(w.ip || '—')}</span> · ${esc(w.colo || '')} ${esc(w.loc || '')}`) +
    (hasProv ? row(`${esc(S.provider_name)} exit`, `<span class="mono">${esc(pv.ip || '—')}</span> · ${esc(pv.loc || '')}`) : '') +
    row('Tor exit', `<span class="mono">${esc(T.exit_ip || '—')}</span>`) +
    row('Your real ISP IP', trusted ? `<span class="mono">${esc(isp.ip || '—')}</span> · ${esc(isp.loc || '')}` : '<span class="muted">hidden on LAN view</span>') +
    row('Your ISP can see', 'encrypted UDP to Cloudflare, amount + timing') +
    row('Cloudflare can see', tor ? 'your IP + that you use Tor; not the sites' : prov ? `your IP + that you use ${esc(S.provider_name)}; not the sites` : 'your IP + the sites you visit (not HTTPS content)') +
    (prov ? row(`${esc(S.provider_name)} can see`, 'the sites you visit, but not your IP') : '') + '</div>';
  const items = [['Home router', (lat.router || {}).ms], ['Cloudflare WARP edge', (lat.warp_edge || {}).ms], ['Internet via WARP', (lat.via_warp || {}).ms]];
  if (hasProv) items.push([`Internet via ${S.provider_name}`, (lat.via_provider || {}).ms]);
  items.push(['Internet direct (ISP)', (lat.isp_internet || {}).ms], ['Tor (connect to 1.1.1.1)', lat.via_tor_connect_ms]);
  const mx = Math.max(1, ...items.map((i) => i[1] || 0));
  $('latency').innerHTML = items.map(([k, v], i) =>
    `<div class="lat-row"><span>${esc(k)}</span><div class="hbar ${i === items.length - 1 ? 'tor' : ''}"><div style="width:${v ? Math.max(2, (100 * v) / mx) : 0}%"></div></div><span class="n">${v == null ? '—' : num(v, v < 10 ? 1 : 0) + ' ms'}</span></div>`).join('');
  for (const id of ['tor-restart', 'tor-newnym', 'tor-country']) if ($(id)) $(id).hidden = !S.trusted;
  $('tor-hint').textContent = tor ? 'Your VPN traffic currently flows through this circuit' : 'Not carrying your traffic right now';
  const path = T.path || [];
  $('tor-circuit').innerHTML = (path.length ? '<div class="flow">' + ['<div class="hopbox"><div class="r">You</div><div class="nm">Gateway</div><div class="mono muted">via WARP</div></div>']
    .concat(path.map((h) => `<div class="hopbox"><div class="r">${esc(h.role)}</div><div class="nm">${esc(h.nick)}</div><div class="mono muted">${esc(h.ip || '')} · ${esc(h.country || '??')}</div></div>`))
    .concat([`<div class="hopbox"><div class="r">Website</div><div class="nm">sees ${esc(T.exit_ip || '—')}</div><div class="muted">exit IP</div></div>`])
    .join('<span class="arrow">→</span>') + '</div>' : '<p class="muted">No circuit yet.</p>') +
    '<div class="rows">' + row('Bootstrap', T.bootstrap != null ? T.bootstrap + '%' : '—') + row('Circuits built', T.circuits ?? '—') +
    row('Tor data in / out', `${fmtBytes(T.read_bytes)} / ${fmtBytes(T.written_bytes)}`) + '</div>';
}

function renderDns(d) {
  if (!d.ok) {
    $('dns-kpis').innerHTML = kpi('AdGuard Home', 'Not connected', 'Set ADGUARD_USER and ADGUARD_PASSWORD in .env, then restart');
    $('top-blocked').innerHTML = '<p class="muted">No data.</p>';
    return;
  }
  $('dns-kpis').innerHTML = [
    kpi('Queries (24 h)', (d.queries || 0).toLocaleString(), 'all devices + the gateway'),
    kpi('Blocked', `${d.blocked_pct ?? '—'}<small>%</small>`, `${(d.blocked || 0).toLocaleString()} requests stopped`),
    kpi('Avg response', `${num(d.avg_ms, 0)}<small>ms</small>`, 'including upstream time'),
    kpi('Validation', d.dnssec ? 'DNSSEC' : 'off', d.dnssec ? chip('good', 'Signatures checked') : chip('warn', 'Not validating')),
    kpi('Upstream', S.mode === 'tor' ? 'Tor' : 'DoH', S.mode === 'tor' ? 'resolved by Tor exits' : 'encrypted DNS-over-HTTPS'),
  ].join('');
  const top = d.top_blocked || [], mx = Math.max(1, ...top.map((t) => t.count));
  $('top-blocked').innerHTML = top.length ? '<table class="tbl"><tbody>' + top.map((t) =>
    `<tr><td class="dom">${esc(t.domain)}</td><td class="bar-cell"><div class="hbar"><div style="width:${(100 * t.count) / mx}%;background:var(--s2)"></div></div></td><td class="n">${t.count.toLocaleString()}</td></tr>`).join('') + '</tbody></table>'
    : '<p class="muted">Nothing blocked yet.</p>';
}

// 5.1 V x 3 A: the official Raspberry Pi 4 supply. Shows how much of it the estimated draw uses.
const PSU_W = 15.3;
function headroomHtml(pw) {
  const vals = series('power').filter((v) => Number.isFinite(v));
  const peak = Math.max(pw.total_w, ...vals), pct = Math.min(100, peak / PSU_W * 100);
  const lvl = pct < 60 ? 'good' : pct < 85 ? 'warn' : 'crit';
  return `<div class="rows" style="margin-top:10px">` +
    row('Supply headroom', `${chip(lvl, Math.round(pct) + '% of the ' + PSU_W + ' W budget at the recent peak')}`) +
    `</div><div class="stackbar" title="peak ${num(peak, 1)} W of ${PSU_W} W"><div style="flex:${pct} 0 0;background:var(--s${lvl === 'good' ? 1 : 2})"></div><div style="flex:${100 - pct} 0 0;background:var(--line, #2a2a2a)"></div></div>` +
    `<p class="hint">Now ${num(pw.total_w, 1)} W, peak ${num(peak, 1)} W (estimated). A 5 V fan adds about 0.5-1.5 W, so there is room unless the bar is above ~85%.</p>`;
}

// Tor sometimes sits without a circuit (stale guard, network change): restart it on demand
if ($('tor-restart')) {
  $('tor-restart').addEventListener('click', async () => {
    const b = $('tor-restart'), label = 'Restart Tor';
    b.disabled = true; b.textContent = 'Restarting...';
    let msg = 'Failed';
    try {
      const r = await fetch('/api/tor/restart', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Control': '1' }, body: '{}' });
      const j = await r.json().catch(() => ({}));
      msg = r.ok ? 'Restarted - building circuits (up to a minute)' : (j.error || 'Failed');
    } catch (_) { /* network error: keep "Failed" */ }
    b.textContent = msg;
    setTimeout(() => { b.disabled = false; b.textContent = label; }, 15000);
  });
}

// New circuit (fresh paths for new connections) and an optional exit country
const torPost = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Control': '1' }, body: JSON.stringify(body || {}) });
  return { ok: r.ok, j: await r.json().catch(() => ({})) };
};
if ($('tor-newnym')) {
  $('tor-newnym').addEventListener('click', async () => {
    const b = $('tor-newnym'); b.disabled = true; b.textContent = 'Requesting...';
    let m = 'Failed';
    try { const { ok, j } = await torPost('/api/tor/newcircuit'); m = ok ? 'Done - new connections use new circuits' : (j.error || 'Failed'); } catch (_) { /* keep Failed */ }
    b.textContent = m;
    setTimeout(() => { b.disabled = false; b.textContent = 'New circuit'; }, 8000);
  });
}
async function loadTorExit() {
  const sel = $('tor-country');
  if (!sel) return;
  try {
    const r = await fetch('/api/tor/exit');
    if (!r.ok) return;
    const j = await r.json();
    sel.innerHTML = '<option value="">Exit: any country (recommended)</option>' +
      Object.entries(j.options).map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
    sel.value = j.country || '';
  } catch (_) { /* leave empty */ }
}
if ($('tor-country')) {
  $('tor-country').addEventListener('change', async () => {
    const sel = $('tor-country'); sel.disabled = true;
    try { await torPost('/api/tor/exit', { country: sel.value }); } catch (_) { /* reloaded below */ }
    sel.disabled = false; loadTorExit();
  });
  loadTorExit();
}

function renderSystem(sys, pw) {
  $('power-card').hidden = !pw;
  if (pw) {
    const parts = pw.parts || [];
    $('power').innerHTML = `<div class="power-hero"><span class="big">${num(pw.total_w, 2)}</span><span class="unit">W</span><span class="muted">≈ ${num(pw.amps_5v, 2)} A at 5.1 V · ${num(pw.total_w * 24 / 1000, 3)} kWh/day ≈ <b>${money(pw.total_w * 24 / 1000 * priceGet().per_kwh)}</b>/day · ${money(pw.total_w * 24 * 30 / 1000 * priceGet().per_kwh)}/month · ${money(pw.total_w * 24 * 365 / 1000 * priceGet().per_kwh)}/year</span></div>
      <div class="stackbar">${parts.map((p) => `<div style="flex:${p.w} 0 0" title="${esc(p.name)} ${p.w} W"></div>`).join('')}</div>
      <div class="legend">${parts.map((p, i) => `<span><span class="sw" style="background:var(--s${i + 1});height:10px;width:10px;border-radius:3px"></span>${esc(p.name)} ${num(p.w, 2)} W</span>`).join('')}</div>
      <p class="hint">Model for a Raspberry Pi 4: board + CPU share by load × clock + USB Wi-Fi by traffic. For exact numbers use a USB-C power meter.</p>`;
    $('power').insertAdjacentHTML('beforeend', headroomHtml(pw));
  }
  const uv = sys.undervoltage, sp = sys.supply || {};
  $('health').innerHTML = '<div class="rows">' +
    (uv == null ? '' : row('Power supply', uv ? chip('crit', 'Under-voltage now') : sp.events ? chip('warn', `${sp.events} dip${sp.events > 1 ? 's' : ''} since start, last ${dur(Math.max(0, S.server_time - sp.last_ts))} ago - weak supply or cable`) : chip('good', 'No under-voltage since the dashboard started'))) +
    row('CPU clock', sys.cpu_mhz ? `${sys.cpu_mhz} MHz` : '—') +
    row('Memory', `${(sys.mem_used_mb || 0).toLocaleString()} / ${(sys.mem_total_mb || 0).toLocaleString()} MB`) +
    row('Disk (config volume)', `${sys.disk_used_gb ?? '—'} / ${sys.disk_total_gb ?? '—'} GB`) +
    row('Load (1/5/15 min)', esc((sys.load || []).join(' / '))) +
    row('Uptime', sys.uptime_s ? dur(sys.uptime_s) : '—') +
    row('Clock', S.clock_offset_s == null ? '—' : Math.abs(S.clock_offset_s) < 60 ? chip('good', `OK (${S.clock_offset_s} s)`) : chip('crit', `off by ${Math.round(S.clock_offset_s)} s`)) +
    row('Tracked connections', `${(sys.conntrack || 0).toLocaleString()} / ${(sys.conntrack_max || 0).toLocaleString()}`) +
    row('Hardware', `${esc(sys.model || '')} · kernel ${esc(sys.kernel || '')}`) + '</div>';
  const cpu = S.cpu || {}, cores = Object.keys(cpu).filter((k) => k !== 'cpu').sort();
  $('cpu-hint').textContent = `${num(cpu.cpu, 0)}% total${sys.cpu_mhz ? ' · ' + sys.cpu_mhz + ' MHz' : ''}`;
  $('cores').innerHTML = cores.map((c) =>
    `<div class="core-row"><span class="muted">Core ${esc(c.slice(3))}</span><div class="hbar"><div style="width:${cpu[c] || 0}%"></div></div><span class="n">${num(cpu[c], 0)}%</span></div>`).join('');
  const sig = (d) => d == null ? chip('off', 'down') : d >= -60 ? chip('good', d + ' dBm') : d >= -70 ? chip('warn', d + ' dBm') : chip('serious', d + ' dBm');
  $('tbl-radios').innerHTML = '<thead><tr><th>Interface</th><th>Address</th><th>Network</th><th>Channel</th><th>Signal</th><th class="n">Link</th><th class="n">TX power</th><th class="n">Retries / failed</th><th>Power save</th></tr></thead><tbody>' +
    (S.links || []).map((r) => r.wireless
      ? `<tr><td><b>${esc(r.iface)}</b>${r.iface === S.uplink ? ' ' + chip('good', 'uplink') : ''}<div class="mono muted">${esc(r.mac || '')}</div></td><td class="mono">${esc(r.ip || '—')}</td><td>${esc(r.ssid || '—')}</td>
        <td>${r.channel ? `${r.channel} · ${esc(r.width || '')}` : '—'}${r.freq ? `<div class="muted">${r.freq} MHz</div>` : ''}</td><td>${sig(r.signal_dbm)}</td>
        <td class="n">${r.tx_mbit ?? '—'} / ${r.rx_mbit ?? '—'} Mbit${r.tx_mode ? `<div class="muted">${esc(r.tx_mode)}</div>` : ''}</td><td class="n">${r.txpower_dbm ?? '—'} dBm</td>
        <td class="n">${r.tx_retries ?? '—'} / ${r.tx_failed ?? '—'}</td><td>${r.power_save === 'off' ? chip('good', 'off') : chip('warn', r.power_save || '?')}</td></tr>`
      : `<tr><td><b>${esc(r.iface)}</b>${r.iface === S.uplink ? ' ' + chip('good', 'uplink') : ''}<div class="mono muted">${esc(r.mac || '')}</div></td><td class="mono">${esc(r.ip || '—')}</td><td colspan="7">${r.state === 'up' ? chip('good', 'link up ' + (r.speed ? r.speed + ' Mbit' : '')) : chip('off', 'no cable')}</td></tr>`).join('') + '</tbody>';
}

const PORT_NOTES = { 53: 'DNS · AdGuard', 80: 'This dashboard', 3000: 'AdGuard admin', 9040: 'Tor transparent proxy (VPN devices only)', 51820: 'WireGuard VPN server', 22: 'SSH' };
function renderSecurity(ks, dns, w, pv, T, hasProv) {
  const C = [];
  const add = (lvl, label, text, val) => C.push(`<li>${chip(lvl, label)}<span>${text}</span><span class="v">${val ?? ''}</span></li>`);
  add(ks.armed ? 'good' : 'crit', ks.armed ? 'Armed' : 'Off', 'Kill switch (fail-closed forwarding)', `${(ks.rejected_pkts || 0).toLocaleString()} rejected`);
  add(dns.dnssec ? 'good' : 'warn', dns.dnssec ? 'On' : 'Off', 'DNSSEC validation', '');
  add(w.warp === 'on' ? 'good' : 'crit', w.warp === 'on' ? 'Connected' : 'Down', 'Cloudflare WARP tunnel', esc(w.colo || ''));
  if (hasProv) add(pv.ip ? 'good' : 'warn', pv.ip ? 'Connected' : 'Down', `${esc(S.provider_name)} tunnel (inside WARP)`, esc(pv.loc || ''));
  add(T.bootstrap === 100 ? 'good' : 'warn', T.bootstrap === 100 ? 'Ready' : `${T.bootstrap ?? '—'}%`, 'Tor network', `${T.circuits ?? 0} circuits`);
  const off = S.clock_offset_s;
  add(off == null ? 'off' : Math.abs(off) < 60 ? 'good' : 'crit', off == null ? 'Unknown' : Math.abs(off) < 60 ? 'Correct' : 'Wrong', 'System clock (Tor needs it)', off == null ? '' : `${off} s`);
  const uv = (S.system || {}).undervoltage;
  if (uv != null) add(uv ? 'crit' : 'good', uv ? 'Low' : 'OK', 'Power supply voltage', '');
  $('checks').innerHTML = C.join('');
  $('services').innerHTML = Object.entries(S.components || {}).map(([k, v]) =>
    `<div class="svc"><span title="${esc(k)}">${esc(k)}</span>${chip(v ? 'good' : 'crit', v ? 'up' : 'down')}</div>`).join('');
  const ports = (S.listening || []).slice().sort((a, b) => (+a.addr.split(':').pop()) - (+b.addr.split(':').pop()));
  $('tbl-ports').innerHTML = '<thead><tr><th>Protocol</th><th>Listening on</th><th>What it is</th></tr></thead><tbody>' +
    ports.map((p) => `<tr><td>${esc(p.proto.toUpperCase())}</td><td class="mono">${esc(p.addr)}</td><td>${esc(PORT_NOTES[+p.addr.split(':').pop()] || '')}</td></tr>`).join('') + '</tbody>';
}



/* ---------------------------------------------------------------- devices */
// list + per-device exit + add (QR) + remove. Managing needs a VPN client (and ADMIN_IPS if set).
let DEV = { devices: [], can_manage: false, default: 'warp', provider: null };
let devSig = '';
const postJSON = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Control': '1' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || j.log || ('HTTP ' + r.status));
  return j;
};
async function refreshDevices() {
  if (!trusted) return;
  try { DEV = await (await fetch('/api/devices', { cache: 'no-store' })).json(); devSig = ''; renderDevices(); } catch (_) { /* next tick */ }
}
setInterval(refreshDevices, 10000);

function exitOptions(cur) {
  const opts = [['default', `Default (${modeName(DEV.default)})`], ['warp', 'WARP']];
  if (DEV.provider) opts.push(['provider', DEV.provider]);
  opts.push(['tor', 'Tor']);
  return opts.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
}
function renderDevices() {
  const peers = (S && S.wg1 && S.wg1.peers) || [];
  const live = Object.fromEntries(peers.map((p) => [p.name, p]));
  const list = trusted && DEV.devices.length ? DEV.devices : peers.map((p) => ({ name: p.name, ip: p.allowed.split('/')[0], exit: ((S.device_modes || {})[p.allowed.split('/')[0]]) || 'default' }));
  $('dev-add').hidden = !(trusted && DEV.can_manage);
  const sig = JSON.stringify([list.map((d) => [d.name, d.ip, d.exit]), DEV.can_manage, DEV.default, DEV.provider, trusted]);
  if (sig !== devSig) {
    devSig = sig;
    const manage = trusted && DEV.can_manage;
    $('tbl-peers').innerHTML = '<thead><tr><th>Device</th><th>VPN IP</th><th>Exit</th><th>Connected from</th><th>Last handshake</th><th class="n">↓ now</th><th class="n">↑ now</th><th class="n">↓ total</th><th class="n">↑ total</th>' + (manage ? '<th></th>' : '') + '</tr></thead><tbody>' +
      (list.length ? list.map((d) => `<tr>
        <td id="st-${esc(d.name)}"></td><td class="mono">${esc(d.ip)}</td>
        <td><select class="sel" data-dev="${esc(d.name)}" ${manage ? '' : 'disabled'} aria-label="Exit for ${esc(d.name)}">${exitOptions(d.exit)}</select></td>
        <td class="mono" id="ep-${esc(d.name)}"></td><td id="hs-${esc(d.name)}"></td>
        <td class="n" id="dn-${esc(d.name)}"></td><td class="n" id="up-${esc(d.name)}"></td><td class="n" id="td-${esc(d.name)}"></td><td class="n" id="tu-${esc(d.name)}"></td>
        ${manage ? `<td class="actions"><button class="btn ghost small" data-qr="${esc(d.name)}">QR</button><button class="btn ghost small danger" data-rm="${esc(d.name)}">Remove</button></td>` : ''}</tr>`).join('')
        : `<tr><td colspan="10" class="muted">No devices yet.${manage ? ' Add one above.' : ''}</td></tr>`) + '</tbody>';
  }
  const pr = (S && S.peer_rates) || {};
  for (const d of list) {
    const p = live[d.name] || {}, r = pr[d.name] || {}, set = (id, v) => { const el = $(id + '-' + d.name); if (el) el.innerHTML = v; };
    set('st', chip(isOnline(p) ? 'good' : 'off', d.name));
    set('ep', esc(p.endpoint || (trusted ? '—' : 'hidden')));
    set('hs', ago(p.handshake_age));
    set('dn', fmtBps(r.down_bps)); set('up', fmtBps(r.up_bps)); set('td', fmtBytes(p.tx)); set('tu', fmtBytes(p.rx));
  }
}
$('tbl-peers').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-dev]'); if (!sel) return;
  sel.disabled = true;
  try { await postJSON('/api/devices/exit', { name: sel.dataset.dev, mode: sel.value }); toast(`${sel.dataset.dev} now exits via ${sel.value === 'default' ? 'the default' : modeName(sel.value)}`); }
  catch (err) { toast('Could not change exit: ' + err.message, true); }
  await refreshDevices();
});
$('tbl-peers').addEventListener('click', async (e) => {
  const qr = e.target.closest('[data-qr]'), rm = e.target.closest('[data-rm]');
  if (qr) { try { showDevice(await postJSON('/api/devices/qr', { name: qr.dataset.qr }), false); } catch (err) { toast(err.message, true); } }
  if (rm && confirm(`Remove "${rm.dataset.rm}"? Its key stops working immediately.`)) {
    try { await postJSON('/api/devices/remove', { name: rm.dataset.rm }); toast(`Removed ${rm.dataset.rm}`); } catch (err) { toast(err.message, true); }
    await refreshDevices();
  }
});
$('dev-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('dev-name').value.trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) { toast('Use 1-32 letters, digits, - or _', true); return; }
  $('dev-add-btn').disabled = true;
  try { showDevice(await postJSON('/api/devices/add', { name }), true); $('dev-name').value = ''; }
  catch (err) { toast('Could not add: ' + err.message, true); }
  $('dev-add-btn').disabled = false;
  await refreshDevices();
});
function showDevice(b, isNew) {
  $('modal-title').textContent = (isNew ? 'New device: ' : 'Device: ') + b.name;
  $('modal-qr').src = b.qr;
  const url = URL.createObjectURL(new Blob([b.conf + '\n'], { type: 'text/plain' }));
  $('modal-dl').href = url; $('modal-dl').download = b.name + '.conf';
  $('modal').hidden = false; $('modal-close').focus();
}
$('modal-close').onclick = () => { $('modal').hidden = true; $('modal-qr').src = ''; };
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal-close').click(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) $('modal-close').click(); });

let toastTimer = null;
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

/* ---------------------------------------------------------------- history */
let HIST = { t: [], span: 86400 }, histRange = '24h';
const hs = (k) => () => HIST[k] || [];
function makeHistoryCharts() {
  $('lg-hist').innerHTML = legend([{ label: 'Download', color: '--s1' }, { label: 'Upload', color: '--s2' }]);
  const src = () => HIST;
  charts.push(new LineChart($('ch-hist-net'), { src, lines: [{ label: 'Download', color: '--s1', data: hs('down') }, { label: 'Upload', color: '--s2', data: hs('up') }], fmt: bpsFmt, minMax: 1e5 }));
  charts.push(new LineChart($('ch-hist-cpu'), { src, lines: [{ label: 'CPU', color: '--s1', data: hs('cpu') }], fmt: (v) => Math.round(v) + '%', fixedMax: 100 }));
  charts.push(new LineChart($('ch-hist-temp'), { src, lines: [{ label: 'Temperature', color: '--s2', data: hs('temp') }], fmt: (v) => num(v, 0) + ' °C', minMax: 80 }));
}
async function loadHistoryRange() {
  try {
    HIST = await (await fetch('/api/history?range=' + histRange, { cache: 'no-store' })).json();
    const pts = (HIST.t || []).length;
    $('hist-meta').textContent = pts ? `${pts} points · ${new Date(HIST.t[0] * 1000).toLocaleString()} → now` : 'No history yet: one point is saved per minute.';
    charts.forEach((c) => c.draw());
  } catch (_) { /* keep the last data */ }
}
document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
  histRange = b.dataset.range;
  document.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x === b));
  loadHistoryRange();
}));
setInterval(() => { if (!document.hidden) loadHistoryRange(); }, 60000);

/* -------------------------------------------------------------- leak test */
// Runs on THIS device: exit IP, IPv6 bypass, which DNS resolver it really uses, WebRTC exposure.
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function traceVia(url) { const t = await withTimeout(fetch(url, { cache: 'no-store' }).then((r) => r.text()), 6000); return Object.fromEntries(t.trim().split('\n').map((l) => l.split('='))); }
function webrtcIps() {
  return new Promise((resolve) => {
    if (!window.RTCPeerConnection) { resolve(null); return; }
    const ips = new Set();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate) { const m = /(\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})/i.exec(e.candidate.candidate); if (m && / srflx /.test(e.candidate.candidate)) ips.add(m[1]); } };
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
    setTimeout(() => { pc.close(); resolve([...ips]); }, 4000);
  });
}
async function runLeakTest() {
  const out = $('leak-results'), btn = $('leak-run');
  const rows = [];
  const show = () => { out.innerHTML = '<ul class="checks">' + rows.map((r) => `<li>${r.pending ? chip('off', 'Testing') : chip(r.ok ? 'good' : r.warn ? 'warn' : 'crit', r.ok ? 'Pass' : r.warn ? 'Check' : 'Leak')}<span>${r.name}</span><span class="v">${r.detail || ''}</span></li>`).join('') + '</ul>'; };
  const step = async (name, fn) => { const r = { name, pending: true }; rows.push(r); show(); try { Object.assign(r, await fn()); } catch (e) { Object.assign(r, { ok: false, detail: esc(e.message) }); } r.pending = false; show(); };
  if (!trusted) { out.innerHTML = '<p class="muted">Open this page through the VPN (http://' + esc(S && S.vpn_ip || '10.13.13.1') + '/dashboard) to test this device.</p>'; return; }
  btn.disabled = true;
  const exp = await (await fetch('/api/leak/expect', { cache: 'no-store' })).json();
  const ispIp = ((S.exits || {}).isp || {}).ip;
  await step('Traffic leaves through the gateway', async () => {
    const t = await traceVia('https://1.1.1.1/cdn-cgi/trace');
    const ok = t.ip && t.ip !== ispIp && (exp.mode === 'tor' || !exp.ip || t.ip === exp.ip);
    return { ok, detail: `websites see <b class="mono">${esc(t.ip)}</b> (${esc(modeName(exp.mode))}${exp.mode === 'tor' ? ', varies per site' : ''})${t.ip === ispIp ? ' = your REAL IP' : ''}` };
  });
  await step('IPv6 can’t bypass the VPN', async () => {
    // ipv6.icanhazip.com has only an IPv6 address: if it answers, IPv6 got out (a literal IPv6 URL can't be allowed in CSP)
    try { const ip = (await withTimeout(fetch('https://ipv6.icanhazip.com/', { cache: 'no-store' }).then((r) => r.text()), 6000)).trim(); return { ok: false, detail: `reached the internet over IPv6 as <b class="mono">${esc(ip)}</b>` }; }
    catch (_) { return { ok: true, detail: 'IPv6 is blocked' }; }
  });
  await step('DNS goes through the gateway (no DNS leak)', async () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => (b % 36).toString(36)).join('') + Date.now().toString(36);
    await withTimeout(fetch(`https://pgwleak${token}.example.com/`, { mode: 'no-cors', cache: 'no-store' }).catch(() => {}), 4000).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const j = await postJSON('/api/leak/dns', { token: 'pgwleak' + token });
    if (j.seen === null) return { warn: true, ok: false, detail: 'AdGuard not reachable, can’t tell' };
    return j.seen ? { ok: true, detail: 'lookups reach AdGuard' } : { ok: false, detail: 'your browser/OS asked another DNS server (turn off "secure DNS" in the browser, Android "Private DNS")' };
  });
  await step('WebRTC doesn’t reveal your real IP', async () => {
    const ips = await webrtcIps();
    if (ips === null) return { ok: true, detail: 'WebRTC disabled in this browser' };
    const real = ispIp && ips.includes(ispIp);
    return { ok: !real, detail: ips.length ? `public address seen: <span class="mono">${ips.map(esc).join(', ')}</span>${real ? ' = your REAL IP' : ''}` : 'no public address exposed' };
  });
  btn.disabled = false;
}
$('leak-run').onclick = runLeakTest;

/* ------------------------------------------------------- electricity cost */
const priceGet = () => { try { const p = JSON.parse(localStorage.getItem('pgw-price') || 'null'); if (p) return p; } catch (_) { /* default */ } return (S && S.price) || { per_kwh: 0.3, currency: '€' }; };
function initPrice() {
  const p = priceGet(); $('kwh-price').value = p.per_kwh; $('kwh-cur').value = p.currency;
  const save = () => { try { localStorage.setItem('pgw-price', JSON.stringify({ per_kwh: parseFloat(String($('kwh-price').value).replace(',', '.')) || 0, currency: $('kwh-cur').value.slice(0, 4) || '€' })); } catch (_) { /* ignore */ } if (S) render(); };
  $('kwh-price').addEventListener('input', save); $('kwh-cur').addEventListener('input', save);
}
const money = (v) => { const p = priceGet(); return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ' + p.currency; };

/* ------------------------------------------------------------ live stream */
let es = null, lastMsg = 0;
function connect() {
  if (es) es.close();
  es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    lastMsg = Date.now();
    S = JSON.parse(e.data);
    histPush(S);
    const lv = $('live'); lv.textContent = 'live'; lv.className = 'live on';
    render();
  };
  es.onerror = () => { const lv = $('live'); lv.textContent = 'reconnecting…'; lv.className = 'live off'; };
}
setInterval(() => { if (Date.now() - lastMsg > 8000) connect(); }, 4000);

async function loadHistory() {
  try {
    const h = await (await fetch('/api/history', { cache: 'no-store' })).json();
    for (const k of Object.keys(h)) H[k] = h[k];
  } catch (_) { /* live data will fill in */ }
}

/* ------------------------------------------------------------- exit mode */
async function setMode(mode) {
  const curMode = S && S.mode === 'tor' && S.tor_via === 'provider' ? 'ptor' : S && S.mode;
  if (!trusted || switching || curMode === mode) return;
  if (mode === 'tor' || mode === 'ptor') {   // first decide how Tor itself reaches the internet
    const want = mode === 'ptor' ? 'provider' : 'warp';
    if ((S.tor_via || 'warp') !== want) {
      switching = true; render();
      const bn = $('banner'); bn.hidden = false; bn.className = 'banner';
      bn.innerHTML = chip('tor', 'Switching') + (want === 'provider' ? ` Moving Tor inside ${esc(S.provider_name || 'the provider')} (up to 90 s, reverts automatically if it fails)…` : ' Moving Tor back to WARP…');
      try {
        const v = await postJSON('/api/tor/via', { via: want });
        S.tor_via = v.via;
      } catch (e) { bn.innerHTML = chip('crit', 'Failed') + ' ' + esc(e.message); switching = false; render(); return; }
      switching = false;
      if (S.mode === 'tor') { bn.innerHTML = chip('good', 'Done') + ` Exit is now ${mode === 'ptor' ? esc(S.provider_name || 'Provider') + '+Tor' : 'Tor'}.`; render(); setTimeout(() => { bn.hidden = true; }, 6000); return; }
    }
    mode = 'tor';
  }
  switching = true; render();
  const bn = $('banner');
  bn.hidden = false; bn.className = 'banner';
  bn.innerHTML = chip(mode === 'warp' ? 'good' : mode === 'provider' ? 'prov' : 'tor', 'Switching') + ` Moving all VPN devices to ${modeName(mode)}${mode === 'tor' ? ' (waits until Tor is connected)' : ''}…`;
  try {
    const r = await fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Control': '1' }, body: JSON.stringify({ mode }) });
    const j = await r.json();
    bn.innerHTML = j.ok ? chip('good', 'Done') + ` Exit is now ${modeName(mode)}. Reload open websites.` : chip('crit', 'Failed') + ' ' + esc(j.error || j.log || r.status);
  } catch (e) { bn.innerHTML = chip('crit', 'Failed') + ' ' + esc(e); }
  switching = false;
  setTimeout(() => { if (bn.innerHTML.includes('Done')) bn.hidden = true; }, 6000);
}
$('mode-warp').onclick = () => setMode('warp');
$('mode-tor').onclick = () => setMode('tor');
$('mode-provider').onclick = () => setMode('provider');
$('mode-ptor').onclick = () => setMode('ptor');

/* ------------------------------------------------------------ traceroute */
// "EXAMPLE-NET - Example Telecom, US" -> "Example Telecom"
const asLabel = (n) => { n = (n || '').split(',')[0]; return n.includes(' - ') ? n.split(' - ').slice(1).join(' - ') : n; };
let tracePath = 'warp', tracing = false, traceTimer = null;
document.querySelectorAll('[data-path]').forEach((b) => b.addEventListener('click', () => {
  tracePath = b.dataset.path;
  document.querySelectorAll('[data-path]').forEach((x) => x.classList.toggle('on', x === b));
  runTrace();
}));
async function runTrace() {
  if (tracing) return;
  if (!trusted) { $('tbl-trace').innerHTML = '<tbody><tr><td class="muted">Traceroute is only available when you open the dashboard through the VPN.</td></tr></tbody>'; return; }
  const target = $('trace-target').value.trim();
  tracing = true; $('trace-run').disabled = true; $('trace-meta').textContent = `Tracing ${target}…`;
  try {
    const r = await (await fetch(`/api/trace?target=${encodeURIComponent(target)}&path=${tracePath}`, { cache: 'no-store' })).json();
    if (r.error) { $('trace-meta').textContent = r.error; return; }
    const hubs = r.hubs || [];
    const mx = Math.max(1, ...hubs.map((h) => h.worst || 0));
    $('tbl-trace').innerHTML = '<thead><tr><th>#</th><th>Host</th><th>Network</th><th class="n">Loss</th><th class="n">Last</th><th class="n">Avg</th><th class="n">Best</th><th class="n">Worst</th><th>Latency</th></tr></thead><tbody>' +
      hubs.map((h) => h.host ? `<tr><td>${h.hop}</td><td class="mono">${esc(h.host)}</td><td>${h.asn === 'private' ? '<span class="muted">private network</span>' : `${esc(h.asn || '')} <span class="muted">${esc(asLabel(h.as_name))}</span>`}</td>
        <td class="n">${h.loss ? chip(h.loss >= 50 ? 'serious' : 'warn', h.loss + '%') : '0%'}</td><td class="n">${num(h.last)}</td><td class="n"><b>${num(h.avg)}</b></td><td class="n">${num(h.best)}</td><td class="n">${num(h.worst)}</td>
        <td class="bar-cell"><div class="hbar"><div style="width:${(100 * h.avg) / mx}%"></div></div></td></tr>`
        : `<tr><td>${h.hop}</td><td class="muted" colspan="8">no reply (router hides itself)</td></tr>`).join('') + '</tbody>';
    $('trace-meta').textContent = `${r.reached ? 'Reached' : 'Did not reach'} ${r.target} (${r.ip}) in ${hubs.length} hops via ${r.path === 'isp' ? 'your real ISP route' : 'Cloudflare WARP'} · ${new Date(r.ts * 1000).toLocaleTimeString()} · ms values are round-trip`;
  } catch (e) { $('trace-meta').textContent = 'Trace failed: ' + e; }
  finally { tracing = false; $('trace-run').disabled = false; }
}
$('trace-form').addEventListener('submit', (e) => { e.preventDefault(); runTrace(); });
$('trace-live').addEventListener('change', (e) => {
  clearInterval(traceTimer);
  if (e.target.checked) { runTrace(); traceTimer = setInterval(runTrace, 5000); }
});

/* -------------------------------------------------------------- query log */
async function pollQlog() {
  if (!S) return;
  if (!trusted) {
    $('qlog-hint').textContent = 'Only visible through the VPN (keeps your browsing private from others on the Wi-Fi)';
    $('tbl-qlog').innerHTML = '<tbody><tr><td class="muted">Open this dashboard through the VPN to see the live DNS log.</td></tr></tbody>';
    return;
  }
  if (document.hidden) return;
  try {
    let rows = await (await fetch('/api/querylog', { cache: 'no-store' })).json();
    if ($('qlog-blocked-only').checked) rows = rows.filter((r) => r.blocked);
    $('tbl-qlog').innerHTML = '<thead><tr><th>Time</th><th>Device</th><th>Domain</th><th>Type</th><th>Result</th><th class="n">ms</th></tr></thead><tbody>' +
      rows.map((r) => `<tr class="${r.blocked ? 'blocked' : ''}"><td class="mono">${esc(new Date(r.time).toLocaleTimeString())}</td><td>${esc(r.client)}</td><td class="dom">${esc(r.domain)}</td><td class="mono muted">${esc(r.type)}</td>
        <td>${r.blocked ? chip('crit', 'Blocked') : r.cached ? chip('off', 'Cached') : chip('good', 'Allowed')}</td><td class="n">${num(r.ms, 0)}</td></tr>`).join('') + '</tbody>';
  } catch (_) { /* transient */ }
}
setInterval(pollQlog, 3000);
$('qlog-blocked-only').addEventListener('change', pollQlog);

/* ------------------------------------------------------------- tabs/theme */
const tabLinks = [...document.querySelectorAll('.tabs a')];
const io = new IntersectionObserver((ents) => {
  for (const e of ents) if (e.isIntersecting) tabLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + e.target.id));
}, { rootMargin: '-40% 0px -55% 0px' });
document.querySelectorAll('.section').forEach((s) => io.observe(s));

function applyTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; charts.forEach((c) => c.draw()); }
try { applyTheme(localStorage.getItem('pi-theme')); } catch (_) { /* storage unavailable */ }
$('theme-btn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('pi-theme', next); } catch (_) { /* ignore */ }
};

/* ------------------------------------------------------------------ boot */
makeCharts();
makeHistoryCharts();
initPrice();
loadHistory().then(connect).then(() => setTimeout(() => { refreshDevices(); loadHistoryRange(); }, 1500));
