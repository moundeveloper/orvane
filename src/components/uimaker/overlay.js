// UI Maker drawing code, shared by the editor and the headless screenshot page
// (server/uimaker-shot.html loads this file too): annotation overlay, the
// reference board, iframe helpers. Plain JS so it runs unbundled in both.
const NS = 'http://www.w3.org/2000/svg';
const FONT = '"Inter Variable", Inter, system-ui, sans-serif';
// Light Orvane surfaces for labels, cards and the hub.
const INK = '#455968', MUTED = '#687d8a', FAINT = '#9aabb6', PAPER = 'rgba(247,249,250,.97)', CARD = '#ffffff';
export function sv(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const txt = (parent, s, attrs) => { const t = sv('text', { 'font-family': FONT, ...attrs }, parent); t.textContent = s; return t; };

// ---------- strokes (used on the component and on the board) ----------
function drawStroke(g, s, { pts = s.pts, dim = false, attr = 'data-sid' } = {}) {
  const base = { stroke: s.color, 'stroke-width': s.size, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', [attr]: s.id, opacity: dim ? 0.3 : 1 };
  const a = pts[0], b = pts[pts.length - 1];
  if (s.tool === 'rect') {
    sv('rect', { ...base, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), rx: 3, fill: s.color, 'fill-opacity': 0.08 }, g);
  } else if (s.tool === 'arrow') {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hd = 6 + s.size * 2;
    const p = d => [b[0] - hd * Math.cos(ang + d), b[1] - hd * Math.sin(ang + d)].join(' ');
    sv('path', { ...base, d: `M${a.join(' ')} L${b.join(' ')} M${p(0.45)} L${b.join(' ')} L${p(-0.45)}` }, g);
  } else {
    sv('path', { ...base, d: 'M' + pts.map(p => p.join(' ')).join(' L') }, g);
  }
}

// ---------- component overlay ----------
export const noteName = (n, i) => n.title || `Note ${i + 1}`;
function drawPin(g, n, num, selected, k) {
  const pg = sv('g', { 'data-nid': n.id, 'data-part': 'pin', style: 'cursor:pointer' }, g);
  if (selected) sv('circle', { cx: n.x, cy: n.y, r: 14 * k, fill: n.color, opacity: 0.22 }, pg);
  sv('circle', { cx: n.x, cy: n.y, r: 9 * k, fill: n.color, stroke: '#ffffff', 'stroke-width': 1.5 * k }, pg);
  txt(pg, num, { x: n.x, y: n.y + 3.7 * k, 'text-anchor': 'middle', fill: '#1d2a33', 'font-size': 10.5 * k, 'font-weight': 700, 'pointer-events': 'none' });
}
function drawLeader(g, n, k) {
  sv('path', { d: `M${n.x} ${n.y} L${n.x} ${n.ly} L${n.lx} ${n.ly}`, fill: 'none', stroke: n.color, 'stroke-width': 1.25 * k, opacity: 0.85, 'pointer-events': 'none' }, g);
}
function drawSvgLabel(g, n, i) {
  const name = noteName(n, i), w = name.length * 6.5 + 20, hgt = 22;
  const x = n.lx < n.x ? n.lx - w : n.lx, y = n.ly - hgt / 2;
  sv('rect', { x, y, width: w, height: hgt, rx: 11, fill: PAPER, stroke: n.color, 'stroke-width': 1.25 }, g);
  txt(g, name, { x: x + 10, y: y + 15, fill: INK, 'font-size': 11.5, 'font-weight': 500 });
}
// zoom > 0 keeps pins a constant size on screen; labels:true draws SVG labels (screenshots — the app uses HTML labels).
export function renderOverlay(svg, { notes = [], strokes = [], selected = null, hover = null, picked = null, draft = null, zoom = 1, labels = true }) {
  svg.querySelectorAll('.dyn').forEach(n => n.remove());
  const g = sv('g', { class: 'dyn' }, svg), k = 1 / zoom;
  for (const s of strokes) drawStroke(g, s, { dim: selected && s.note && s.note !== selected });
  if (draft) drawStroke(g, draft);
  const box = (r, a) => r && sv('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: `rgba(91,140,200,${a})`, stroke: '#5b8cc8', 'stroke-width': k, 'pointer-events': 'none' }, g);
  box(picked, 0.08); box(hover, 0.16);
  notes.forEach(n => drawLeader(g, n, k));
  notes.forEach((n, i) => { drawPin(g, n, i + 1, n.id === selected, k); if (labels) drawSvgLabel(g, n, i); });
}

// ---------- reference board ----------
// A board belongs to a note or to the component: { refs, bstrokes, bpins, hub, bview }.
// Strokes/pins that start on an image are stored relative to it (units of image width), so they travel with it.
export const CAP = 20;
export const refH = r => r.bw * (r.ar || 0.66);
export const hubW = t => Math.max(64, (t || '').length * 6.4 + 28);
export function ensureBoard(o) {
  o.refs ||= []; o.bstrokes ||= []; o.bpins ||= [];
  if (!o.hub) {
    const xs = o.refs.flatMap(r => [r.bx, r.bx + r.bw]);
    o.hub = o.refs.length ? { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: Math.min(...o.refs.map(r => r.by)) - 70 } : { x: 0, y: 0 };
  }
  return o;
}
export function toWorld(o, item, p) {
  const r = item.ref && o.refs.find(r => r.id === item.ref);
  return r ? [r.bx + p[0] * r.bw, r.by + p[1] * r.bw] : p;
}
export function edgeGeom(hub, title, r) {
  const hw = hubW(title), bh = refH(r) + CAP, rc = [r.bx + r.bw / 2, r.by + bh / 2];
  const dx = rc[0] - hub.x, dy = rc[1] - hub.y;
  let a, b, d;
  if (Math.abs(dx) > Math.abs(dy) * 1.4) {
    const s = dx > 0 ? 1 : -1;
    a = [hub.x + s * hw / 2, hub.y]; b = [dx > 0 ? r.bx : r.bx + r.bw, rc[1]];
    const c = Math.max(24, Math.abs(b[0] - a[0]) * 0.5);
    d = `M${a} C${a[0] + s * c},${a[1]} ${b[0] - s * c},${b[1]} ${b}`;
  } else {
    const s = dy > 0 ? 1 : -1;
    a = [hub.x, hub.y + s * 13]; b = [rc[0], dy > 0 ? r.by : r.by + bh];
    const c = Math.max(24, Math.abs(b[1] - a[1]) * 0.5);
    d = `M${a} C${a[0]},${a[1] + s * c} ${b[0]},${b[1] - s * c} ${b}`;
  }
  return { d, a, b };
}
export function drawEdge(g, o, title, r, color, strong) {
  g.replaceChildren();
  const { d, a, b } = edgeGeom(o.hub, title, r);
  sv('path', { d, fill: 'none', stroke: color, 'stroke-width': 4, opacity: strong ? 0.18 : 0.08 }, g);
  sv('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.25, opacity: strong ? 1 : 0.7 }, g);
  for (const p of [a, b]) sv('circle', { cx: p[0], cy: p[1], r: 2.6, fill: CARD, stroke: color, 'stroke-width': 1.25 }, g);
}
function drawBoardPin(g, x, y, pin, letter, selected, k) {
  const pg = sv('g', { 'data-bpin': pin.id, style: 'cursor:pointer', transform: `translate(${x},${y}) scale(${k})` }, g);
  x = 0; y = 0;
  if (pin.text) {
    const w = Math.min(46, pin.text.length) * 6.3 + 22;
    sv('rect', { x: x + 6, y: y - 11, width: w, height: 22, rx: 11, fill: PAPER, stroke: pin.color, 'stroke-width': selected ? 1.6 : 1 }, pg);
    txt(pg, pin.text.length > 46 ? pin.text.slice(0, 45) + '…' : pin.text, { x: x + 18, y: y + 4, fill: INK, 'font-size': 11.5, 'font-weight': 500 });
  }
  if (selected) sv('circle', { cx: x, cy: y, r: 13, fill: pin.color, opacity: 0.22 }, pg);
  sv('circle', { cx: x, cy: y, r: 9, fill: pin.color, stroke: '#ffffff', 'stroke-width': 1.5 }, pg);
  txt(pg, letter, { x, y: y + 3.7, 'text-anchor': 'middle', fill: '#1d2a33', 'font-size': 10.5, 'font-weight': 700, 'pointer-events': 'none' });
}
// Pins live on their own layer so they can be redrawn on every zoom/drag frame without touching the images.
export function renderBoardPins(g, o, { selPin = null, k = 1 } = {}) {
  g.replaceChildren();
  o.bpins.forEach((p, i) => { const [x, y] = toWorld(o, p, [p.u, p.v]); drawBoardPin(g, x, y, p, String.fromCharCode(65 + i % 26), p.id === selPin, k); });
}
// refUrl maps a stored reference file name to a URL the page can load.
export function renderBoardSvg(world, o, { title = '', color = '#8a9aa6', selRef = null, target = null, draft = null, refUrl = f => 'refs/' + f } = {}) {
  world.replaceChildren();
  const edges = sv('g', {}, world);
  for (const r of o.refs) drawEdge(sv('g', { 'data-edge': r.id }, edges), o, title, r, color, r.id === selRef);
  for (const r of o.refs) {
    const bh = refH(r), on = r.id === selRef;
    const g = sv('g', { 'data-rid': r.id, transform: `translate(${r.bx},${r.by})`, style: 'cursor:grab' }, world);
    const shape = { x: 0, y: 0, width: r.bw, height: bh + CAP, rx: 7 };
    const clipId = 'reference-card-' + r.id;
    const clip = sv('clipPath', { id: clipId }, g);
    sv('rect', shape, clip);
    const content = sv('g', { 'clip-path': 'url(#' + clipId + ')' }, g);
    sv('rect', { ...shape, fill: CARD }, content);
    sv('image', { href: refUrl(r.file), x: 0, y: 0, width: r.bw, height: bh, preserveAspectRatio: 'xMidYMid slice' }, content);
    const max = Math.max(4, Math.floor(r.bw / 6.2));
    const cap = r.caption || 'Add a caption…';
    txt(content, cap.length > max ? cap.slice(0, max - 1) + '…' : cap, { x: 7, y: bh + 14, fill: r.caption ? MUTED : FAINT, 'font-size': 10.5, 'pointer-events': 'none', 'data-caption': '' });
    if (target === r.file) {
      sv('rect', { x: 6, y: 6, width: 50, height: 16, rx: 8, fill: '#3fa66b' }, content);
      txt(content, 'overlay', { x: 31, y: 17.5, 'text-anchor': 'middle', fill: '#ffffff', 'font-size': 9.5, 'font-weight': 700 });
    }
    for (const s of o.bstrokes) if (s.ref === r.id) drawStroke(content, s, { pts: s.pts.map(p => [p[0] * r.bw, p[1] * r.bw]), attr: 'data-bsid' });
    sv('rect', { ...shape, fill: 'none', stroke: on ? '#6f8998' : 'rgba(69,89,104,.2)', 'stroke-width': on ? 1.75 : 1, 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' }, g);
    if (on) sv('rect', { 'data-grip': r.id, x: Math.max(0, r.bw - 10), y: 8, width: 10, height: Math.max(1, bh + CAP - 16), fill: 'transparent', style: 'cursor:ew-resize' }, g);
  }
  const loose = sv('g', {}, world);
  for (const s of o.bstrokes) if (!o.refs.some(r => r.id === s.ref)) drawStroke(loose, s, { attr: 'data-bsid' });
  if (draft) drawStroke(loose, draft);
  const hw = hubW(title);
  const hg = sv('g', { 'data-hub': 1, transform: `translate(${o.hub.x},${o.hub.y})`, style: 'cursor:grab' }, world);
  sv('rect', { x: -hw / 2, y: -13, width: hw, height: 26, rx: 13, fill: CARD, stroke: color, 'stroke-width': 1.25 }, hg);
  txt(hg, title, { x: 0, y: 4, 'text-anchor': 'middle', fill: INK, 'font-size': 11.5, 'font-weight': 500, 'pointer-events': 'none' });
}
export function boardBounds(o, title) {
  const hw = hubW(title), xs = [o.hub.x - hw / 2, o.hub.x + hw / 2], ys = [o.hub.y - 13, o.hub.y + 13];
  for (const r of o.refs) { xs.push(r.bx, r.bx + r.bw); ys.push(r.by, r.by + refH(r) + CAP); }
  for (const s of o.bstrokes) for (const p of s.pts) { const w = toWorld(o, s, p); xs.push(w[0]); ys.push(w[1]); }
  for (const p of o.bpins) { const w = toWorld(o, p, [p.u, p.v]); xs.push(w[0] - 12, w[0] + 30 + Math.min(46, (p.text || '').length) * 6.3); ys.push(w[1] - 14, w[1] + 14); }
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ---------- iframe helpers ----------
export function measureFrame(frame) {
  const d = frame.contentDocument;
  frame.style.height = '10px';
  return Math.max(40, d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
}
export function applyTweaks(doc, tweaks) {
  for (const t of tweaks) {
    try { doc.querySelectorAll(t.selector).forEach(e => e.style.setProperty(t.prop, t.value, 'important')); } catch {}
  }
}
export function cssPath(e) {
  const parts = [];
  let rooted = false;
  while (e && e.nodeType === 1 && e.tagName !== 'BODY' && e.tagName !== 'HTML') {
    if (e.id) { parts.unshift('#' + CSS.escape(e.id)); rooted = true; break; }
    let s = e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
    const p = e.parentElement;
    if (p) {
      const same = [...p.children].filter(x => x.tagName === e.tagName);
      if (same.length > 1) s += `:nth-of-type(${same.indexOf(e) + 1})`;
    }
    parts.unshift(s);
    e = p;
  }
  if (!parts.length) return 'body';
  return (rooted ? '' : 'body > ') + parts.join(' > ');
}
export function rectOf(e) {
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}
export function describe(e) {
  if (!e || e.tagName === 'HTML') return null;
  return { selector: cssPath(e), tag: e.tagName.toLowerCase(), text: (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60), rect: rectOf(e) };
}
