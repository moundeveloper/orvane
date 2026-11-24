// UI Maker editor engine: the artboard (iframe + annotation overlay), pinned
// notes, the reference board, undo and the live link to new iterations.
// Ported from the standalone UI Maker. Differences in Orvane:
// - everything is scoped to one app root (several UI Makers can be open);
// - pointer maths divides by the canvas zoom around the app;
// - keys and paste act only while the pointer is over the app or focus is in it,
//   and Space stays with the canvas (Space-drag pans the workspace);
// - the open component/version is kept in the block value.
import { reactive } from 'vue';
import { ICONS } from './icons.js';
import { renderOverlay, applyTweaks, measureFrame, forwardCanvasZoom, describe, rectOf, cssPath, noteName,
  ensureBoard, renderBoardSvg, renderBoardPins, boardBounds, drawEdge, toWorld, refH, CAP, sv } from './overlay.js';

export const API = '/__orvane/uimaker/';
export const compUrl = (c, v, t) => `${API}files/c/${encodeURIComponent(c)}/v${v}/index.html${t ? '?t=' + Math.round(t) : ''}`;
export const refUrl = file => API + 'files/refs/' + encodeURIComponent(file);
export const labUrl = (c, round, variant, t) => `${API}files/c/${encodeURIComponent(c)}/lab/${round}/${variant}.html${t ? '?t=' + Math.round(t) : ''}`;

// ---------- tiny helpers ----------
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
  return e;
}
const icon = name => {
  const i = h('i', { 'data-i': name, 'aria-hidden': 'true' });
  i.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name] || ''}"/></svg>`;
  return i;
};
export const ago = t => { const s = (Date.now() - t) / 1000; return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };

// ---------- state ----------
// White strokes vanish on Orvane's light surfaces, so free sketches are slate.
export const COLORS = [['#ff5a5f', 'Red — wrong / remove'], ['#4ade80', 'Green — add / want'], ['#f5b942', 'Amber — attention'], ['#78b4ff', 'Blue — layout sketch'], ['#455968', 'Slate — free sketch']];
export const KINDS = [['#ff5a5f', 'Fix'], ['#4ade80', 'Add'], ['#f5b942', 'Question'], ['#78b4ff', 'Layout']];
export const TOOLS = [['select', 'move', 'Move & select (V)'], ['pen', 'pen', 'Pen (P)'], ['rect', 'rect', 'Box (R)'], ['arrow', 'arrow', 'Arrow (A)'], ['eraser', 'eraser', 'Eraser (E)'], ['pin', 'pin', 'Pin a note (N)'], ['element', 'target', 'Pin an HTML element (T)'], ['interact', 'hand', 'Use the component live (I)']];
export const BTOOLS = [['move', 'move', 'Move, select, pan (V)'], ['pen', 'pen', 'Draw on references (P)'], ['pin', 'pin', 'Pin a comment on a reference (N)'], ['eraser', 'eraser', 'Erase marks (E)']];
export const PROPS = ['width', 'height', 'padding', 'margin', 'gap', 'border-radius', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'background-color', 'border', 'box-shadow', 'opacity'];
export function createEditorModel() {
  const ui = reactive({ c: null, v: null, h: 300, mode: 'review', tool: 'select', color: COLORS[0][0], size: 3, note: null, el: null, zoom: 1, px: 80, py: 60, tab: 'notes',
  board: 'global', btool: 'move', bcolor: COLORS[0][0], ref: null, bpin: null, cmp: { against: 'prev', val: 50 }, compareHeight: 0,
  labRound: null, labVariant: null });
  return reactive({
    ui, state: null, versions: {}, feed: [], lab: {},
    library: false, toast: '', help: false, newOpen: false, error: '', elementPreview: '',
  });
}

/** root: the app element. options.view: saved {c, v}; options.onView(view) saves it. */
export function mountEditor(model, root, { view = null, onView = () => {} } = {}) {
  const { ui } = model;
  const $ = name => root.querySelector(`[data-el="${name}"]`);
  const lifetime = new AbortController();
  const on = (target, type, handler, options) =>
    target.addEventListener(type, handler, { ...options, signal: lifetime.signal });
  // The canvas scales the whole app; screen pixels / scale = app pixels.
  const S = () => (root.offsetWidth ? root.getBoundingClientRect().width / root.offsetWidth : 1) || 1;
  let hovering = false;
  on(root, 'pointerenter', () => { hovering = true; });
  on(root, 'pointerleave', () => { hovering = false; });
  const inside = () => hovering || root.contains(document.activeElement);
  let events;
  let resizeObserver;
  let toastT;
  function toast(msg, ms = 3200) { model.toast = msg; clearTimeout(toastT); toastT = setTimeout(() => { model.toast = ''; }, ms); }
  const comp = () => model.state?.components.find(c => c.id === ui.c);
  const vers = () => model.versions[ui.c] || [];
  const ver = (n = ui.v) => vers().find(x => x.n === n);
  const cur = a => a.filter(x => x.c === ui.c && x.v === ui.v);
  const selNote = () => model.state?.notes.find(n => n.id === ui.note);
  const rememberView = () => onView({ c: ui.c, v: ui.v });

  const post = async (op, data = {}) => {
    const r = await fetch(API + op, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: lifetime.signal });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  };
  let saveT;
  let pendingWrite = Promise.resolve();
  // Artboard sizes as last saved by this editor, to tell a size set from
  // outside (uimaker_size) apart from this editor's own unsaved changes.
  const savedSizes = new Map();
  const sizeKey = c => `${c.width}x${c.height ?? 'auto'}`;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => flush().catch(error => toast('Could not save: ' + error.message)), 350);
  };
  function flush() {
    clearTimeout(saveT);
    saveT = null;
    const body = JSON.stringify({ state: model.state });
    const sizes = model.state.components.map(c => [c.id, sizeKey(c)]);
    const write = pendingWrite.then(async () => {
      const response = await fetch(API + 'save', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: document.visibilityState === 'hidden' && body.length < 60000 });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
      for (const [id, key] of sizes) savedSizes.set(id, key);
    });
    pendingWrite = write.catch(() => {});
    return write;
  }

  // undo: snapshot before every structural change
  const undoStack = [], redoStack = [];
  function snap(state = JSON.stringify(model.state)) {
    if (undoStack.at(-1) !== state) undoStack.push(state);
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
  }
  function stepHistory(redo = false) {
    commitLabel?.();
    commitBEdit();
    const from = redo ? redoStack : undoStack;
    const to = redo ? undoStack : redoStack;
    const current = JSON.stringify(model.state);
    while (from.at(-1) === current) from.pop();
    const previous = from.pop();
    if (!previous) return toast(redo ? 'Nothing to redo' : 'Nothing to undo');
    to.push(current);
    const old = comp();
    const tweaks = JSON.stringify(cur(model.state.tweaks));
    model.state = JSON.parse(previous);
    if (!comp()) showLibrary();
    if (!selNote()) { ui.note = null; if (ui.board === 'local') ui.board = 'global'; }
    ui.ref = ui.bpin = null;
    save(); refreshCanvases();
    if (comp() && (old?.width !== comp().width || old?.height !== comp().height || JSON.stringify(cur(model.state.tweaks)) !== tweaks)) loadFrame();
  }

  // ---------- dom refs ----------
  const vp = $('viewport'), stage = $('stage'), art = $('artboard'), frame = $('frame'), ov = $('overlay'), labels = $('labels');
  const board = $('board'), bsvg = $('bsvg'), bedit = $('bedit');
  const bcam = $('bworld');                       // camera group
  const bworld = sv('g', {}, bcam), bdraftG = sv('g', {}, bcam), bpinsG = sv('g', {}, bcam);

  // ---------- view ----------
  function applyView() {
    stage.style.transform = `translate(${ui.px}px,${ui.py}px) scale(${ui.zoom})`;
    positionLabels(); draw();
  }
  function fit() {
    const c = comp(); if (!c) return;
    const w = vp.clientWidth, hh = vp.clientHeight;
    if (!w || !hh) return;
    const left = 54;
    const right = ui.mode === 'compare' ? left : Math.min(250, Math.max(24, w * 0.27));
    const height = ui.mode === 'compare' ? Math.max(ui.h, ui.compareHeight || 0) : ui.h;
    ui.zoom = clamp(Math.min((w - left - right) / c.width, (hh - 92) / height), 0.1, 1);
    ui.px = left + (w - left - right - c.width * ui.zoom) / 2;
    ui.py = (hh - height * ui.zoom) / 2 - 8;
    applyView();
  }
  function zoomAt(mx, my, z) {
    z = clamp(z, 0.1, 8);
    ui.px = mx - (mx - ui.px) * z / ui.zoom; ui.py = my - (my - ui.py) * z / ui.zoom; ui.zoom = z; applyView();
  }
  // Plain wheel zooms the artboard; Ctrl+wheel is left to the canvas.
  on(vp, 'wheel', e => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const r = vp.getBoundingClientRect(), s = S();
    zoomAt((e.clientX - r.left) / s, (e.clientY - r.top) / s, ui.zoom * Math.exp(-e.deltaY * 0.0016));
  }, { passive: false });
  $('zIn').onclick = () => zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, ui.zoom * 1.25);
  $('zOut').onclick = () => zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, ui.zoom / 1.25);
  $('zFit').onclick = fit;

  // ---------- frame ----------
  let needFit = true;
  function sizeArt() {
    const c = comp();
    frame.style.width = c.width + 'px'; frame.style.height = ui.h + 'px';
    ov.setAttribute('width', c.width); ov.setAttribute('height', ui.h);
  }
  function loadFrame() {
    const c = comp(), vv = ver();
    if (!c || !vv) return;
    frame.style.width = c.width + 'px';
    frame.onload = () => {
      const d = frame.contentDocument;
      if (!d) return;
      // Live mode (I) lets the pointer reach the component, so its Ctrl+wheel
      // lands inside the iframe; replay it on the frame so the canvas zooms.
      forwardCanvasZoom(frame);
      const settle = final => {
        applyTweaks(d, cur(model.state.tweaks));
        ui.h = c.height || measureFrame(frame);
        sizeArt(); syncCompareTarget(); draw();
        if (needFit) { fit(); if (final) needFit = false; }
      };
      settle(!d.fonts);
      d.fonts?.ready.then(() => settle(true));
    };
    ui.el = null;
    frame.src = compUrl(c.id, ui.v, vv.mtime);
  }
  const elementAt = (x, y) => { try { return frame.contentDocument.elementFromPoint(x, y); } catch { return null; } };

  const pickingElement = () => ui.mode === 'inspect' || (ui.mode === 'review' && ui.tool === 'element');
  let hoverElement = null, elementDepth = 0;
  function pickedElementAt(x, y) {
    return ancestorOf(elementAt(x, y), elementDepth);
  }
  function ancestorOf(element, depth) {
    while (depth-- > 0 && element?.parentElement?.tagName !== 'HTML') element = element?.parentElement;
    return element?.tagName === 'HTML' ? null : element;
  }
  function updateHover(x, y) {
    const element = elementAt(x, y);
    if (hoverElement !== element) elementDepth = 0;
    hoverElement = element;
    const target = ancestorOf(element, elementDepth);
    hover = target ? rectOf(target) : null;
    model.elementPreview = target && ui.mode === 'review' && ui.tool === 'element' ? cssPath(target) : '';
    draw();
  }
  function clearHover() {
    hover = hoverElement = null;
    elementDepth = 0;
    model.elementPreview = '';
  }
  function resolveTarget(note) {
    try { return frame.contentDocument?.querySelector(note.target.selector); } catch { return null; }
  }

  // ---------- overlay + pin labels ----------
  let hover = null, draft = null, raf = 0, editing = null;
  function draw() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const show = ui.mode !== 'compare';
      if (!comp()) return;
      const visibleNotes = renderLabels();
      const note = selNote();
      const target = note?.elementPin ? resolveTarget(note) : null;
      renderOverlay(ov, {
        notes: show ? visibleNotes : [], strokes: show ? cur(model.state.strokes) : [], selected: ui.note, draft, zoom: ui.zoom, labels: false,
        hover: pickingElement() ? hover : null,
        picked: ui.mode === 'inspect' && ui.el?.isConnected ? rectOf(ui.el) : note?.elementPin ? (target ? rectOf(target) : note.target.rect) : null,
      });
    });
  }
  function renderLabels() {
    if (editing) return positionLabels();
    labels.replaceChildren();
    if (ui.mode === 'compare') return [];
    cur(model.state.notes).forEach((n, i) => {
      const el = h('div', { class: 'plabel' + (n.id === ui.note ? ' on' : ''), 'data-id': n.id, style: `--c:${n.color}`, 'aria-label': 'Drag to move · double-click to edit' },
        h('b', {}, i + 1), h('span', { class: n.title ? '' : 'ph' }, n.title || 'Describe this…'),
        n.refs?.length ? h('em', {}, icon('image'), n.refs.length) : null);
      el.addEventListener('pointerdown', e => labelDown(e, n));
      el.addEventListener('dblclick', () => editLabel(n));
      labels.append(el);
    });
    return positionLabels();
  }
  function positionLabels() {
    const visibleNotes = [];
    for (const el of labels.children) {
      const n = model.state?.notes.find(n => n.id === el.dataset.id); if (!n) continue;
      const width = labels.clientWidth;
      const target = n.elementPin ? resolveTarget(n) : null;
      const bounds = target ? rectOf(target) : null;
      const x = bounds ? bounds.x + bounds.w / 2 : n.x;
      const y = bounds ? bounds.y + bounds.h / 2 : n.y;
      const pinX = ui.px + x * ui.zoom;
      // A dragged label keeps the side it was dropped on (see labelDown).
      let left = n.labelMoved && typeof n.labelLeft === 'boolean' ? n.labelLeft : n.lx < x;
      let anchor = ui.px + n.lx * ui.zoom;
      // A label that would run past the view's edge flips to the pin's other
      // side or slides back inside, at any view width. A label the user has
      // dragged stays exactly where it was put, like it does vertically.
      if (!n.labelMoved && pinX >= 0 && pinX <= width) {
        const labelWidth = el.offsetWidth;
        const margin = 8;
        if (!left && anchor + labelWidth > width - margin) {
          left = true;
          anchor = Math.min(pinX - 12, width - margin);
        } else if (left && anchor - labelWidth < margin) {
          left = false;
          anchor = Math.max(pinX + 12, margin);
        }
        anchor = left ? clamp(anchor, labelWidth + margin, width - margin) : clamp(anchor, margin, width - labelWidth - margin);
      }
      const lx = (anchor - ui.px) / ui.zoom;
      el.style.left = anchor + 'px'; el.style.top = ui.py + n.ly * ui.zoom + 'px';
      el.classList.toggle('left', left);
      visibleNotes.push({ ...n, x, y, lx });
    }
    return visibleNotes;
  }
  function labelDown(e, n) {
    if (editing || e.button) return;
    e.preventDefault();
    // The box follows the cursor; which end hangs on the leader line (the
    // side of the pin) follows from where the box is, so it never jumps.
    const el = e.currentTarget, w = el.offsetWidth;
    const boxLeft = parseFloat(el.style.left) - (el.classList.contains('left') ? w : 0);
    if (ui.note !== n.id) selectNote(n.id);
    const sx = e.clientX, sy = e.clientY, oy = n.ly, s = S(), k = ui.zoom * s; let moved = false;
    const mv = m => {
      if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 3) return;
      if (!moved) { snap(); moved = true; n.labelMoved = true; }
      const target = n.elementPin ? resolveTarget(n) : null, bounds = target ? rectOf(target) : null;
      const pinX = ui.px + (bounds ? bounds.x + bounds.w / 2 : n.x) * ui.zoom;
      const left = boxLeft + (m.clientX - sx) / s;
      n.labelLeft = left + w / 2 < pinX;
      n.lx = ((n.labelLeft ? left + w : left) - ui.px) / ui.zoom;
      n.ly = oy + (m.clientY - sy) / k;
      draw();
    };
    const up = () => { window.removeEventListener('pointermove', mv); if (moved) save(); };
    on(window, 'pointermove', mv); on(window, 'pointerup', up, { once: true });
  }
  function editLabel(n) {
    editing = null; renderLabels();
    const el = labels.querySelector(`[data-id="${CSS.escape(n.id)}"] span`); if (!el) return;
    editing = n.id;
    el.classList.remove('ph'); el.textContent = n.title; el.contentEditable = 'plaintext-only'; el.focus();
    getSelection().selectAllChildren(el);
    el.oninput = () => { n.title = el.textContent.replace(/\s+/g, ' ').slice(0, 80); };
    // commit explicitly on Enter / click-away as well as blur: blur alone is not reliable when the window is unfocused
    commitLabel = () => { if (editing !== n.id) return; editing = null; commitLabel = null; n.title = n.title.trim(); save(); renderLabels(); draw(); renderBoard(); };
    el.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); commitLabel?.(); } };
    el.onpointerdown = e => e.stopPropagation();
    el.onblur = () => commitLabel?.();
  }
  let commitLabel = null;
  on(window, 'pointerdown', e => { if (commitLabel && !e.target.closest?.('.plabel span[contenteditable]')) commitLabel(); }, { capture: true });
  const pt = e => { const r = art.getBoundingClientRect(), k = ui.zoom * S(); return [Math.round((e.clientX - r.left) / k * 10) / 10, Math.round((e.clientY - r.top) / k * 10) / 10]; };

  let drag = null;
  const startPan = e => ({ k: 'pan', sx: e.clientX, sy: e.clientY, px: ui.px, py: ui.py, s: S() });
  on(ov, 'pointerdown', e => {
    if (e.button !== 0) return;
    // stop the browser's mousedown focus change, or it steals focus from the label editor we open below
    e.preventDefault();
    if (!comp()) return;
    if (document.activeElement?.matches('input,textarea')) document.activeElement.blur();
    const t = e.target, [x, y] = pt(e);
    // Middle-drag stays the canvas pan, as everywhere in Orvane.
    if (e.button !== 0) return;
    try { ov.setPointerCapture(e.pointerId); } catch {}
    if (ui.mode === 'compare') { drag = startPan(e); return; }
    if (ui.mode === 'inspect') {
      const el = elementAt(x, y);
      if (el && el.tagName !== 'HTML') { ui.el = el; ui.tab = 'inspect'; draw(); } else drag = startPan(e);
      return;
    }
    if (ui.tool === 'element') {
      if (hoverElement !== elementAt(x, y)) elementDepth = 0;
      const el = pickedElementAt(x, y);
      if (el) {
        const box = rectOf(el);
        addNote(box.x + box.w / 2, box.y + box.h / 2, el);
      }
      return;
    }
    const ng = t.closest('[data-nid]');
    if (ng && ui.tool !== 'eraser') {
      const n = model.state?.notes.find(n => n.id === ng.dataset.nid);
      if (ui.note !== n.id) selectNote(n.id);
      if (n.elementPin) return;
      drag = { k: 'pin', n, ox: x - n.x, oy: y - n.y, dx: n.lx - n.x, dy: n.ly - n.y, moved: false };
      return;
    }
    const stroke = (tool, pts) => ({ id: uid(), c: ui.c, v: ui.v, tool, color: ui.color, size: ui.size, pts, note: ui.note, target: null });
    if (ui.tool === 'select') { drag = startPan(e); if (ui.note) selectNote(null); }
    else if (ui.tool === 'pen') { draft = stroke('pen', [[x, y]]); drag = { k: 'draw' }; }
    else if (ui.tool === 'rect' || ui.tool === 'arrow') { draft = stroke(ui.tool, [[x, y], [x, y]]); drag = { k: 'draw' }; }
    else if (ui.tool === 'eraser') { snap(); drag = { k: 'erase' }; erase(t); }
    else if (ui.tool === 'pin') addNote(x, y);
  });
  on(ov, 'pointermove', e => {
    const [x, y] = pt(e);
    if (!drag) {
      if (pickingElement()) updateHover(x, y);
      return;
    }
    if (drag.k === 'pan') { ui.px = drag.px + (e.clientX - drag.sx) / drag.s; ui.py = drag.py + (e.clientY - drag.sy) / drag.s; applyView(); }
    else if (drag.k === 'draw') {
      if (draft.tool === 'pen') { const l = draft.pts[draft.pts.length - 1]; if (Math.hypot(x - l[0], y - l[1]) > 1.5 / ui.zoom) draft.pts.push([x, y]); }
      else draft.pts[1] = [x, y];
      draw();
    }
    else if (drag.k === 'erase') erase(document.elementFromPoint(e.clientX, e.clientY));
    else if (drag.k === 'pin') {
      if (!drag.moved) { snap(); drag.moved = true; }
      const n = drag.n; n.x = x - drag.ox; n.y = y - drag.oy;
      if (e.shiftKey) { n.lx = n.x + drag.dx; n.ly = n.y + drag.dy; }
      draw();
    }
  });
  const endDrag = () => {
    if (!drag) return;
    if (drag.k === 'draw' && draft) {
      const [a, b] = [draft.pts[0], draft.pts[draft.pts.length - 1]];
      const big = draft.tool === 'pen' ? draft.pts.length > 2 : Math.hypot(b[0] - a[0], b[1] - a[1]) > 4;
      if (big) {
        const xs = draft.pts.map(p => p[0]), ys = draft.pts.map(p => p[1]);
        const at = draft.tool === 'arrow' ? b : [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
        draft.target = describe(elementAt(at[0], at[1]));
        snap(); model.state.strokes.push(draft); save();
      }
      draft = null; draw();
    }
    if (drag.k === 'pin' && drag.moved) { drag.n.target = describe(elementAt(drag.n.x, drag.n.y)); save(); }
    drag = null;
  };
  on(ov, 'pointerup', endDrag);
  on(ov, 'pointercancel', endDrag);
  on(ov, 'pointerleave', () => { if (!drag && hover) { clearHover(); draw(); } });
  function erase(t) {
    const id = t?.dataset?.sid; if (!id) return;
    model.state.strokes = model.state.strokes.filter(s => s.id !== id); save(); draw();
  }

  // ---------- notes ----------
  function addNote(x, y, element) {
    const c = comp(); snap();
    let ly = y; const lx = c.width + 40;
    while (cur(model.state.notes).some(o => o.lx === lx && Math.abs(o.ly - ly) < 30 / ui.zoom)) ly += 32 / ui.zoom;
    const n = { id: uid(), c: ui.c, v: ui.v, title: '', text: '', color: KINDS.some(k => k[0] === ui.color) ? ui.color : KINDS[2][0], x, y, lx, ly, target: describe(element || elementAt(x, y)), ...(element && { elementPin: true }), refs: [], bstrokes: [], bpins: [] };
    model.state.notes.push(n); save();
    ui.tab = 'notes'; setTool('select'); selectNote(n.id);
    editLabel(selNote());
  }
  function selectNote(id) {
    commitBEdit();
    ui.note = id; ui.ref = ui.bpin = null;
    ui.board = id ? 'local' : 'global';
    if (id) ui.tab = 'notes';
    renderBoard(); draw();
  }
  function deleteNote(n) {
    snap();
    model.state.notes = model.state.notes.filter(x => x !== n);
    model.state.strokes.forEach(s => { if (s.note === n.id) s.note = null; });
    save(); selectNote(null); toast('Note deleted — Ctrl+Z brings it back');
  }

  // ---------- library / header ----------
  async function newComponent(name) {
    model.newOpen = false;
    try {
      const { id } = await post('component', { name });
      snap();
      model.state.components.push({ id, name, width: 480, height: 360, intent: '', refs: [], bstrokes: [], bpins: [], target: null, match: null });
      await flush(); await pullVersions(); openComp(id);
      toast('Blank artboard ready — sketch what you want, pin notes, add references, then hand the brief to your agent.', 5000);
    } catch (error) {
      toast('Could not create component: ' + error.message);
    }
  }
  function openComp(id, v) {
    commitLabel?.();
    commitBEdit();
    model.library = false;
    clearHover();
    ui.c = id; ui.v = v ?? vers().at(-1)?.n ?? 1; ui.note = null; ui.ref = ui.bpin = null; ui.el = null; ui.board = 'global'; needFit = true;
    rememberView();
    refreshCanvases(); loadFrame();
  }
  function showLibrary() {
    commitLabel?.();
    commitBEdit();
    clearHover();
    model.library = true;
    ui.c = ui.v = ui.note = ui.ref = ui.bpin = ui.el = null;
    rememberView();
    ui.board = 'global';
    frame.onload = null;
    frame.removeAttribute('src');
    labels.replaceChildren();
    ov.querySelectorAll('.dyn').forEach(node => node.remove());
    renderBoard();
  }
  function renameComponent(item, value) {
    const name = value.trim();
    if (!name || item.name === name) return;
    snap();
    item.name = name;
    save();
    renderBoard();
  }
  function deleteComponent(item) {
    snap();
    model.state.components = model.state.components.filter(c => c.id !== item.id);
    for (const key of ['notes', 'strokes', 'tweaks']) {
      model.state[key] = model.state[key].filter(entry => entry.c !== item.id);
    }
    if (ui.c === item.id) showLibrary();
    save();
    toast('Component removed from the list. Ctrl+Z restores it; its iteration files stay on disk.');
  }
  function resize(axis, value) {
    snap();
    if (axis === 'width') comp().width = clamp(Math.round(value) || 320, 40, 3000);
    else comp().height = value > 0 ? clamp(Math.round(value), 20, 6000) : null;
    save(); needFit = true; loadFrame();
  }
  function setMode(m) {
    ui.mode = m; clearHover();
    if (m === 'inspect') ui.tab = 'inspect';
    else if (ui.tab === 'inspect') ui.tab = 'notes';
    syncCompareTarget(); draw();
  }

  // ---------- toolbar ----------
  function setTool(t) { ui.tool = t; clearHover(); draw(); }
  function setColor(col) {
    ui.color = col;
    if (['select', 'eraser', 'interact'].includes(ui.tool)) setTool('pen');
  }
  function setBoardColor(col) {
    ui.bcolor = col;
    if (['move', 'eraser'].includes(ui.btool)) ui.btool = 'pen';
  }

  // ---------- compare ----------
  function syncCompareTarget() {
    if (!comp() || ui.mode !== 'compare') return;
    const others = vers().filter(x => x.n !== ui.v);
    const options = [...others.map(x => 'v' + x.n), ...(comp().target ? ['ref'] : [])];
    if (!options.includes(ui.cmp.against)) {
      const previous = others.filter(x => x.n < ui.v).at(-1);
      ui.cmp.against = previous ? 'v' + previous.n : options[0];
    }
  }
  async function measure() {
    const c = comp();
    toast('Rendering in a real browser and measuring…');
    try {
      const [a, b] = await Promise.all([`${API}shot?c=${encodeURIComponent(c.id)}&v=${ui.v}`, refUrl(c.target)].map(async u => {
        const r = await fetch(u);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        return createImageBitmap(await r.blob());
      }));
      const W = 240, H = Math.round(Math.min(a.height / a.width, b.height / b.width) * W);
      const px = img => { const cv = new OffscreenCanvas(W, H), g = cv.getContext('2d'); g.drawImage(img, 0, 0, W, img.height / img.width * W); return g.getImageData(0, 0, W, H).data; };
      const A = px(a), B = px(b); let sum = 0;
      for (let i = 0; i < A.length; i += 4) sum += Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
      c.match = { v: ui.v, pct: Math.round((1 - sum / (A.length / 4 * 3 * 255)) * 1000) / 10 };
      save(); syncCompareTarget(); toast(`v${ui.v} is a ${c.match.pct}% pixel match to the reference.`);
    } catch (e) { toast('Could not measure: ' + e.message); }
  }

  // ---------- timeline ----------
  function openVersion(n) {
    ui.v = n; ui.note = null; ui.ref = ui.bpin = null; ui.board = 'global';
    rememberView();
    refreshCanvases(); loadFrame();
  }

  // The agent pulls the brief through the orvane MCP server (uimaker_brief).
  async function copyPrompt() {
    await flush().catch(error => toast('Could not save: ' + error.message));
    const c = comp();
    const line = `Process the UI Maker brief for component "${c.id}" v${ui.v}: use the orvane MCP tool uimaker_brief, then deliver the next iteration with uimaker_deliver.`;
    try {
      await navigator.clipboard.writeText(line);
      toast('Prompt copied. Paste it into your agent — it reads the brief through the Orvane MCP server.', 6000);
    } catch {
      toast(line, 12000);
    }
  }
  async function exportBrief() {
    try {
      await flush();
      toast('Exporting the brief with real-browser screenshots…', 9000);
      const r = await post('brief', { c: ui.c, v: ui.v });
      const warning = r.warnings?.length ? ' Some screenshots are missing. See Export warnings in the brief.' : '';
      toast(`Brief written to ${r.brief}.` + warning, 9000);
      await pullFeed();
      ui.tab = 'feed';
    } catch (e) { toast('Could not export: ' + e.message, 6000); }
  }

  function updateNoteTitle(n, value) {
    n.title = value;
    save(); draw(); renderBoardSvgNow();
  }
  function updateNoteColor(n, color) {
    n.color = color;
    save(); renderBoard(); draw();
  }
  function removeTweak(tweak) {
    snap(); model.state.tweaks = model.state.tweaks.filter(x => x !== tweak);
    save(); loadFrame();
  }
  function setTweak(selector, prop, value, from) {
    if (!value) return;
    snap();
    let t = model.state.tweaks.find(t => t.c === ui.c && t.v === ui.v && t.selector === selector && t.prop === prop);
    if (t) t.value = value; else model.state.tweaks.push(t = { id: uid(), c: ui.c, v: ui.v, selector, prop, value, from });
    applyTweaks(frame.contentDocument, [t]);
    if (!comp().height) { ui.h = measureFrame(frame); sizeArt(); }
    save(); draw();
  }
  // ---------- reference canvas ----------
  const bowner = () => { const o = ui.board === 'local' ? selNote() : comp(); return o ? ensureBoard(o) : null; };
  const btitle = () => ui.board === 'local' ? noteName(selNote(), cur(model.state.notes).indexOf(selNote())) : comp().name;
  const bcolor = () => ui.board === 'local' ? selNote().color : '#8a9aa6';
  const bhas = o => o.refs.length || o.bstrokes.length || o.bpins.length;
  const pinK = o => clamp(1 / o.bview.z, 0.25, 12);
  function drawBPins() { const o = bowner(); if (!o?.bview || !bhas(o)) return bpinsG.replaceChildren(); renderBoardPins(bpinsG, o, { selPin: ui.bpin, k: pinK(o) }); }
  function applyBView() { const v = bowner()?.bview; if (v) { bcam.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.z})`); drawBPins(); } }
  function fitBoard(o = bowner(), box) {
    const W = board.clientWidth, H = board.clientHeight;
    if (!o || !W || !H) return;
    if (!bhas(o)) { o.bview = { x: W / 2, y: 46, z: 1 }; return applyBView(); }
    const b = box || boardBounds(o, btitle());
    const z = clamp(Math.min((W - 76) / Math.max(b.w, 1), (H - 36) / Math.max(b.h, 1)), 0.03, box ? 4 : 1);
    o.bview = { x: (W - b.w * z) / 2 - b.x * z + 14, y: (H - b.h * z) / 2 - b.y * z, z };
    applyBView();
  }
  function renderBoardSvgNow() {
    const o = bowner();
    if (!o || !bhas(o)) { bpinsG.replaceChildren(); return bworld.replaceChildren(); }
    renderBoardSvg(bworld, o, { title: btitle(), color: bcolor(), selRef: ui.ref, target: comp().target, refUrl });
    drawBPins();
  }
  function renderBoard() {
    const o = bowner();
    if (!o) { bworld.replaceChildren(); bpinsG.replaceChildren(); return; }
    for (const r of o.refs) if (!r.ar) {
      const im = new Image();
      im.onload = () => { r.ar = im.naturalHeight / im.naturalWidth; save(); renderBoardSvgNow(); };
      im.src = refUrl(r.file);
    }
    if (!o.bview || lastBoard !== o) { lastBoard = o; fitBoard(o); }
    renderBoardSvgNow(); applyBView();
  }
  function selectBoard(name) {
    commitBEdit();
    ui.board = name; ui.ref = ui.bpin = null;
    renderBoard();
  }
  function updateCaption(ref, caption) {
    ref.caption = caption;
    save(); renderBoardSvgNow();
  }
  function toggleTarget(ref) {
    const c = comp();
    snap(); c.target = c.target === ref.file ? null : ref.file; c.match = null;
    save(); renderBoard(); syncCompareTarget();
  }
  function removeRef(r) {
    const o = bowner(); if (!r) return; snap();
    o.refs = o.refs.filter(x => x !== r);
    o.bstrokes = o.bstrokes.filter(s => s.ref !== r.id); o.bpins = o.bpins.filter(p => p.ref !== r.id);
    ui.ref = null; save(); renderBoard(); draw();
  }

  let lastBoard = null;
  let bdrag = null, bdraft = null, bediting = null, overBoard = false;
  const bpt = e => { const r = bsvg.getBoundingClientRect(), v = bowner().bview, s = S(); return [((e.clientX - r.left) / s - v.x) / v.z, ((e.clientY - r.top) / s - v.y) / v.z]; };
  const norm = (r, x, y) => [Math.round((x - r.bx) / r.bw * 1e4) / 1e4, Math.round((y - r.by) / r.bw * 1e4) / 1e4];
  on(bsvg, 'pointerdown', e => {
    const o = bowner(); if (!o || e.button !== 0) return;
    if (!o.bview) fitBoard(o);
    e.preventDefault();   // same reason as on the component overlay: keep focus where we put it
    commitBEdit(); board.classList.add('pointer-focus'); board.focus({ preventScroll: true });
    try { bsvg.setPointerCapture(e.pointerId); } catch {}
    const t = e.target, [x, y] = bpt(e);
    const pan = () => ({ k: 'pan', sx: e.clientX, sy: e.clientY, x: o.bview.x, y: o.bview.y, s: S() });
    const ref = o.refs.find(r => r.id === t.closest('[data-rid]')?.dataset.rid);
    const pin = o.bpins.find(p => p.id === t.closest('[data-bpin]')?.dataset.bpin);
    if (ui.btool === 'move') {
      if (t.dataset.grip) bdrag = { k: 'resize', r: ref, sx: x, w: ref.bw };
      else if (pin) { ui.bpin = pin.id; ui.ref = null; renderBoard(); bdrag = { k: 'bpin', p: pin, sx: x, sy: y, cx: e.clientX, cy: e.clientY, u: pin.u, v: pin.v }; }
      else if (ref) { if (ui.ref !== ref.id || ui.bpin) { ui.ref = ref.id; ui.bpin = null; renderBoard(); } bdrag = { k: 'ref', r: ref, ox: x - ref.bx, oy: y - ref.by, cx: e.clientX, cy: e.clientY, cap: y - ref.by > refH(ref) }; }
      else if (t.closest('[data-hub]')) bdrag = { k: 'hub', ox: x - o.hub.x, oy: y - o.hub.y };
      else { bdrag = pan(); if (ui.ref || ui.bpin) { ui.ref = ui.bpin = null; renderBoard(); } }
    } else if (ui.btool === 'pen') {
      bdraft = { id: uid(), tool: 'pen', color: ui.bcolor, size: Math.max(1.5, 3 / o.bview.z), pts: [[x, y]], ref: ref?.id || null };
      bdrag = { k: 'draw' };
    } else if (ui.btool === 'pin') {
      const before = JSON.stringify(model.state);
      const [u, v] = ref ? norm(ref, x, y) : [x, y];
      const p = { id: uid(), ref: ref?.id || null, u, v, text: '', color: ui.bcolor };
      o.bpins.push(p); ui.bpin = p.id; ui.ref = null; ui.btool = 'move'; renderBoard(); editBPin(o.bpins.at(-1), before);
    } else if (ui.btool === 'eraser') { snap(); bdrag = { k: 'erase' }; berase(t); }
  });
  on(bsvg, 'pointermove', e => {
    if (!bdrag) return;
    const o = bowner(); if (!o) { bdrag = null; return; }
    const [x, y] = bpt(e), d = bdrag;
    if (d.k === 'bpin' && !d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 4) return;
    if (d.k !== 'pan' && d.k !== 'draw' && d.k !== 'erase' && !d.moved) { snap(); d.moved = true; }
    if (d.k === 'pan') { o.bview.x = d.x + (e.clientX - d.sx) / d.s; o.bview.y = d.y + (e.clientY - d.sy) / d.s; applyBView(); }
    else if (d.k === 'ref') {
      d.r.bx = x - d.ox; d.r.by = y - d.oy;
      bworld.querySelector(`[data-rid="${d.r.id}"]`)?.setAttribute('transform', `translate(${d.r.bx},${d.r.by})`);
      const eg = bworld.querySelector(`[data-edge="${d.r.id}"]`); if (eg) drawEdge(eg, o, btitle(), d.r, bcolor(), true);
      drawBPins();
    } else if (d.k === 'hub') {
      o.hub = { x: x - d.ox, y: y - d.oy };
      bworld.querySelector('[data-hub]')?.setAttribute('transform', `translate(${o.hub.x},${o.hub.y})`);
      for (const r of o.refs) { const eg = bworld.querySelector(`[data-edge="${r.id}"]`); if (eg) drawEdge(eg, o, btitle(), r, bcolor(), r.id === ui.ref); }
    } else if (d.k === 'resize') {
      d.r.bw = clamp(d.w + x - d.sx, 40, 6000); renderBoardSvgNow();
    } else if (d.k === 'bpin') {
      const r = o.refs.find(r => r.id === d.p.ref), k = r ? r.bw : 1;
      d.p.u = d.u + (x - d.sx) / k; d.p.v = d.v + (y - d.sy) / k;
      drawBPins();
    } else if (d.k === 'draw') {
      const l = bdraft.pts.at(-1);
      if (Math.hypot(x - l[0], y - l[1]) > 1.5 / o.bview.z) bdraft.pts.push([x, y]);
      bdraftG.replaceChildren(sv('path', { d: 'M' + bdraft.pts.map(p => p.join(' ')).join(' L'), fill: 'none', stroke: bdraft.color, 'stroke-width': bdraft.size, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    } else if (d.k === 'erase') berase(document.elementFromPoint(e.clientX, e.clientY));
  });
  const bend = event => {
    if (!bdrag) return;
    const o = bowner(), { k, p, moved } = bdrag, d = bdrag; bdrag = null;
    if (k === 'ref' && d.cap && event.type === 'pointerup' && Math.hypot(event.clientX - d.cx, event.clientY - d.cy) < 4) {
      save(); renderBoardSvgNow(); return editCaption(d.r);
    }
    if (k === 'bpin' && !moved && event.type === 'pointerup') return editBPin(p);
    if (k === 'draw' && bdraft) {
      if (bdraft.pts.length > 2) {
        snap();
        const r = o.refs.find(r => r.id === bdraft.ref);
        bdraft.pts = r ? bdraft.pts.map(p => norm(r, p[0], p[1])) : bdraft.pts.map(p => p.map(n => Math.round(n * 10) / 10));
        o.bstrokes.push(bdraft);
      }
      bdraft = null; bdraftG.replaceChildren();
    }
    save();
    if (k !== 'pan') renderBoardSvgNow();
  };
  on(bsvg, 'pointerup', bend);
  on(bsvg, 'pointercancel', bend);
  function berase(t) {
    const o = bowner(), sid = t?.closest?.('[data-bsid]')?.dataset.bsid, pid = t?.closest?.('[data-bpin]')?.dataset.bpin;
    if (!sid && !pid) return;
    o.bstrokes = o.bstrokes.filter(s => s.id !== sid); o.bpins = o.bpins.filter(p => p.id !== pid);
    save(); renderBoardSvgNow();
  }
  on(bsvg, 'wheel', e => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    const o = bowner(); if (!o?.bview) return;
    commitBEdit();
    const r = bsvg.getBoundingClientRect(), s = S(), mx = (e.clientX - r.left) / s, my = (e.clientY - r.top) / s, v = o.bview;
    const z = clamp(v.z * Math.exp(-e.deltaY * 0.0018), 0.03, 12);
    v.x = mx - (mx - v.x) * z / v.z; v.y = my - (my - v.y) * z / v.z; v.z = z; applyBView(); save();
  }, { passive: false });
  on(bsvg, 'dblclick', e => {
    const o = bowner(); if (!o) return;
    const pin = o.bpins.find(p => p.id === e.target.closest('[data-bpin]')?.dataset.bpin);
    const ref = o.refs.find(r => r.id === e.target.closest('[data-rid]')?.dataset.rid);
    if (pin) editBPin(pin);
    else if (ref) fitBoard(o, { x: ref.bx, y: ref.by, w: ref.bw, h: refH(ref) + CAP });
    else fitBoard(o);
  });
  function editBPin(p, before) {
    const o = bowner(), v = o.bview, [wx, wy] = toWorld(o, p, [p.u, p.v]);
    bediting = { owner: o, p, before };
    bedit.hidden = false; bedit.value = p.text;
    bedit.style.left = clamp(v.x + wx * v.z + 14, 6, Math.max(6, board.clientWidth - 258)) + 'px';
    bedit.style.top = clamp(v.y + wy * v.z - 13, 6, board.clientHeight - 32) + 'px';
    bedit.focus(); bedit.select();
  }
  const pinPlaceholder = bedit.placeholder;
  function editCaption(r) {
    const o = bowner(), v = o.bview;
    bediting = { owner: o, ref: r };
    bedit.hidden = false; bedit.value = r.caption || '';
    bedit.placeholder = 'What should the agent take from this image?';
    bedit.setAttribute('aria-label', 'Reference caption');
    // The field takes the caption strip's exact place and size at this zoom.
    const z = v.z;
    bedit.classList.add('capedit');
    Object.assign(bedit.style, {
      left: v.x + r.bx * z + 'px', top: v.y + (r.by + refH(r)) * z + 'px',
      width: r.bw * z + 'px', height: CAP * z + 'px', fontSize: 10.5 * z + 'px',
      padding: `0 ${7 * z}px`, borderRadius: `0 0 ${7 * z}px ${7 * z}px`,
    });
    const shown = bworld.querySelector(`[data-rid="${r.id}"] [data-caption]`);
    if (shown) shown.style.visibility = 'hidden';
    bedit.focus(); bedit.select();
  }
  function endCaptionEdit() {
    bedit.classList.remove('capedit');
    for (const k of ['width', 'height', 'fontSize', 'padding', 'borderRadius']) bedit.style[k] = '';
  }
  function commitBEdit(cancel) {
    if (!bediting) return;
    const { owner, p, before, ref } = bediting; bediting = null;
    const text = bedit.value.trim();
    if (ref) {
      if (!cancel && text !== (ref.caption || '')) { snap(); ref.caption = text; }
      bedit.placeholder = pinPlaceholder; bedit.setAttribute('aria-label', 'Pin text'); endCaptionEdit();
      bedit.hidden = true; save(); renderBoardSvgNow(); return;
    }
    if (before && (cancel || !text)) { owner.bpins = owner.bpins.filter(x => x !== p); ui.bpin = null; }
    else if (!cancel && text !== p.text) {
      snap(before);
      p.text = text;
    }
    bedit.hidden = true; save(); renderBoardSvgNow();
  }
  on(bedit, 'keydown', e => { e.stopPropagation(); if (e.key === 'Enter') commitBEdit(); if (e.key === 'Escape') commitBEdit(true); });
  on(bedit, 'blur', () => commitBEdit());
  on(board, 'blur', () => board.classList.remove('pointer-focus'));
  on(board, 'pointerenter', () => { overBoard = true; });
  on(board, 'pointerleave', () => { overBoard = false; });

  $('boardFit').onclick = () => fitBoard();
  $('boardMax').onclick = () => { $('boardwrap').classList.toggle('max'); fitBoard(); renderBoard(); };
  async function uploadReference(blob, caption) {
    const response = await fetch(API + 'ref', { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    let ar = 0.66;
    try { const image = await createImageBitmap(blob); ar = image.height / image.width; image.close(); } catch {}
    return { id: uid(), file: result.file, caption, ar };
  }
  function placeReference(owner, reference) {
    // Place in the first free slot of a tidy grid under the hub.
    const bw = 240; let k = 0, bx, by;
    do { bx = owner.hub.x - bw - 12 + (k % 2) * (bw + 24); by = owner.hub.y + 70 + Math.floor(k / 2) * 230; k++; }
    while (owner.refs.some(ref => Math.abs(ref.bx - bx) < bw && Math.abs(ref.by - by) < 200));
    owner.refs.push({ ...reference, bx, by, bw });
  }
  function referenceBlob({ data, mime }) {
    return new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type: mime });
  }
  async function addRefs(files, caption = '') {
    files = files.filter(f => f && f.type.startsWith('image/'));
    if (!files.length) return 0;
    if (!bowner()) ui.board = 'global';
    const o = bowner(); if (!o) return 0;
    snap();
    let added = 0;
    for (const f of files) {
      try {
        const reference = await uploadReference(f, caption);
        placeReference(o, reference);
        ui.ref = reference.id; ui.bpin = null;
        added++;
      } catch (error) { toast(error.message); }
    }
    save(); fitBoard(o); renderBoard(); draw();
    return added;
  }
  const whose = () => ui.board === 'local' && selNote() ? `note “${btitle()}”` : 'the component';
  $('fileBtn').onclick = () => $('fileIn').click();
  $('fileIn').onchange = e => { addRefs([...e.target.files]); e.target.value = ''; };
  on(document, 'paste', async e => {
    if (!model.state || !comp() || !inside() || (e.target instanceof Element && e.target.closest('input,textarea,[contenteditable]'))) return;
    const cd = e.clipboardData; if (!cd) return;
    const files = [...cd.files, ...[...cd.items].filter(i => i.kind === 'file').map(i => i.getAsFile())].filter(f => f && f.type.startsWith('image/'));
    const uniq = files.filter((f, i) => files.findIndex(g => g.size === f.size && g.type === f.type) === i);
    if (!uniq.length) return;
    e.preventDefault();
    e.stopPropagation();
    if (await addRefs(uniq)) toast('Reference added to ' + whose());
  }, { capture: true });
  $('pasteBtn').onclick = async () => {
    try {
      const out = [];
      for (const it of await navigator.clipboard.read()) for (const t of it.types) if (t.startsWith('image/')) out.push(new File([await it.getType(t)], 'pasted', { type: t }));
      if (await addRefs(out)) toast('Reference added to ' + whose()); else toast('No image on the clipboard. Copy an image or take a screenshot first.');
    } catch { toast('Clipboard access was blocked. Hover the app and press Ctrl+V instead.'); }
  };
  for (const zone of [$('right'), vp]) {
    on(zone, 'dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); board.classList.add('drop'); } });
    on(zone, 'dragleave', () => board.classList.remove('drop'));
    on(zone, 'drop', async e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); e.stopPropagation(); board.classList.remove('drop'); if (await addRefs([...e.dataTransfer.files])) toast('Reference added to ' + whose()); });
  }
  // splitter between the panel and the reference canvas
  on($('splitter'), 'pointerdown', e => {
    if (e.button !== 0) return;
    const bw = $('boardwrap'), sy = e.clientY, sh = bw.offsetHeight, s = S();
    e.target.setPointerCapture(e.pointerId);
    e.target.onpointermove = m => {
      const maxHeight = Math.max(150, $('right').clientHeight - 260);
      bw.classList.add('resized');
      bw.style.height = clamp(sh - (m.clientY - sy) / s, 150, maxHeight) + 'px';
    };
    e.target.onlostpointercapture = () => {
      e.target.onpointermove = null;
      try { if (bw.style.height) localStorage.setItem('orvane-uimaker-bh', bw.style.height); } catch {}
    };
  });
  try {
    const height = localStorage.getItem('orvane-uimaker-bh');
    if (height) {
      $('boardwrap').classList.add('resized');
      $('boardwrap').style.height = height;
    }
  } catch {}

  // ---------- keyboard ----------
  // Capture phase on window so a handled key never reaches the canvas
  // shortcuts; only while the pointer is over this app or focus is in it.
  const typing = e => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  on(window, 'keydown', e => {
    if (!inside() || !model.state || e.defaultPrevented) return;
    const handled = () => { e.preventDefault(); };
    if (e.key === 'Escape') {
      if (model.help) { model.help = false; return handled(); }
      if ($('boardwrap').classList.contains('max')) { $('boardwrap').classList.remove('max'); fitBoard(); renderBoard(); return handled(); }
      return;
    }
    if (typing(e) || e.target.closest?.('.select-popover, .um-menu')) return;
    if (e.code === 'Space') return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (key === 'z' || key === 'y')) {
      handled();
      return stepHistory(key === 'y' || e.shiftKey);
    }
    if (!comp()) return;
    if (ui.mode === 'review' && ui.tool === 'element' && hoverElement && (key === '[' || key === ']')) {
      const depth = Math.max(0, elementDepth + (key === '[' ? 1 : -1));
      if (ancestorOf(hoverElement, depth) !== ancestorOf(hoverElement, elementDepth)) elementDepth = depth;
      const target = ancestorOf(hoverElement, elementDepth);
      if (target) { hover = rectOf(target); model.elementPreview = cssPath(target); draw(); }
      return handled();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (ui.mode === 'lab') {
      const round = (model.lab[ui.c] || []).find(r => r.id === ui.labRound);
      const variant = /^[1-9]$/.test(key) && round?.variants[+key - 1];
      if (variant) { ui.labVariant = variant.id; handled(); }
      return;
    }
    const o = bowner();
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (ui.bpin && o) { handled(); snap(); o.bpins = o.bpins.filter(p => p.id !== ui.bpin); ui.bpin = null; save(); return renderBoard(); }
      if (ui.ref && o && (overBoard || document.activeElement === board)) { handled(); return removeRef(o.refs.find(r => r.id === ui.ref)); }
      if (e.key === 'Delete' && selNote() && !overBoard) { handled(); return deleteNote(selNote()); }
      return;
    }
    if (overBoard && o) {
      const m = { v: 'move', p: 'pen', n: 'pin', e: 'eraser' }[key];
      if (m) { ui.btool = m; handled(); }
      if (key === 'f') { fitBoard(); handled(); }
      return;
    }
    const map = { v: 'select', p: 'pen', r: 'rect', a: 'arrow', e: 'eraser', n: 'pin', t: 'element', i: 'interact' };
    if (map[key] && ui.mode === 'review') { setTool(map[key]); handled(); }
  }, { capture: true });

  // ---------- live link ----------
  async function pullVersions() { model.versions = (await post('versions')).versions; }
  async function pullFeed() { const r = await post('state'); model.feed = r.feed; model.lab = r.lab || {}; adoptComponents(r.state); adoptSizes(r.state); }
  async function openSavedView(component, mode, version, reference) {
    await Promise.all([pullVersions(), pullFeed()]);
    if (!model.state.components.some(c => c.id === component))
      throw new Error('UI Maker component not found.');
    if (version !== undefined && !model.versions[component]?.some(item => item.n === version))
      throw new Error('UI Maker version not found.');
    openComp(component, version);
    setMode(mode);
    const view = { component, mode: ui.mode, version: ui.v };
    if (!reference) return view;
    if (!(await addRefs([referenceBlob(reference)], reference.caption))) throw new Error('The visual reference could not be added.');
    await flush();
    return { ...view, referenceAdded: true };
  }
  async function addReviewedReferences(component, candidates) {
    const uploads = await Promise.all(candidates.map(candidate =>
      uploadReference(referenceBlob(candidate), `${candidate.title} · ${candidate.source}`),
    ));
    const target = model.state.components.find(item => item.id === component);
    if (!target) throw new Error('UI Maker component not found.');
    const owner = ensureBoard(target);
    snap();
    for (const upload of uploads) placeReference(owner, upload);
    try { await flush(); }
    catch (error) {
      const added = new Set(uploads.map(upload => upload.id));
      owner.refs = owner.refs.filter(reference => !added.has(reference.id));
      throw error;
    }
    if (comp() === target && ui.board === 'global') { fitBoard(owner); renderBoard(); }
    toast(`${uploads.length} visual ${uploads.length === 1 ? 'reference' : 'references'} added.`);
  }
  // Components another tool or agent added to the saved state join the list.
  // Only additions are taken: this editor's own unsaved edits stay as they are.
  function adoptComponents(saved) {
    if (!model.state || !saved?.components) return;
    const have = new Set(model.state.components.map(c => c.id));
    for (const c of saved.components) if (!have.has(c.id)) { c.refs ||= []; model.state.components.push(c); savedSizes.set(c.id, sizeKey(c)); }
  }
  // A size saved from outside replaces the shown one, unless this editor has
  // since changed that size itself.
  function adoptSizes(saved) {
    if (!model.state || !saved?.components) return;
    for (const s of saved.components) {
      const c = model.state.components.find(x => x.id === s.id), key = sizeKey(s);
      if (!c || key === savedSizes.get(s.id)) continue;
      savedSizes.set(s.id, key);
      if (key === sizeKey(c)) continue;
      c.width = s.width; c.height = s.height ?? null;
      if (c.id === ui.c) { needFit = true; loadFrame(); }
    }
  }
  function listen() {
    events = new EventSource(API + 'events');
    events.onmessage = async m => {
      const d = JSON.parse(m.data);
      if (d.type !== 'fs' || !model.state) return;
      const wasLatest = vers().at(-1)?.n, wasM = ver()?.mtime;
      await pullVersions();
      await pullFeed().catch(() => {});
      const latest = vers().at(-1)?.n;
      if (latest > wasLatest && ui.v === wasLatest) {
        ui.v = latest; ui.note = null; ui.ref = ui.bpin = null; ui.board = 'global';
        rememberView();
        refreshCanvases(); loadFrame();
        if (vers().at(-1)?.response?.lab) toast(`Picked variant saved as v${latest}.`, 4000);
        else toast(`Agent delivered v${latest}. Compare it with v${wasLatest}, then review again.`, 6000);
      } else {
        if (ver()?.mtime !== wasM) loadFrame();
        syncCompareTarget();
      }
    };
  }

  function refreshCanvases() { model.newOpen = false; renderBoard(); syncCompareTarget(); draw(); }
  async function init() {
    const r = await post('state');
    if (lifetime.signal.aborted) return;
    model.state = r.state; model.versions = r.versions; model.feed = r.feed; model.lab = r.lab || {};
    model.state.notes ||= []; model.state.strokes ||= []; model.state.tweaks ||= [];
    for (const n of model.state.notes) n.refs ||= [];
    for (const c of model.state.components) { c.refs ||= []; savedSizes.set(c.id, sizeKey(c)); }
    stage.style.transform = `translate(${ui.px}px,${ui.py}px) scale(${ui.zoom})`;
    const savedComponent = model.state.components.find(c => c.id === view?.c);
    if (savedComponent) {
      const savedVersion = model.versions[savedComponent.id]?.find(v => v.n === view.v);
      openComp(savedComponent.id, savedVersion?.n);
    } else if (view?.c === null || !model.state.components.length) showLibrary();
    else openComp(model.state.components[0].id);
    listen();
    resizeObserver = new ResizeObserver(() => { if (bowner() && !bdrag) { renderBoardSvgNow(); applyBView(); } });
    resizeObserver.observe(board);
    try { if (!localStorage.getItem('orvane-uimaker-seen')) { model.help = true; localStorage.setItem('orvane-uimaker-seen', '1'); } } catch {}
  }
  init().catch(error => { if (error.name !== 'AbortError') model.error = 'Could not load UI Maker: ' + error.message; });
  return {
    dispose() {
      lifetime.abort();
      events?.close();
      resizeObserver?.disconnect();
      cancelAnimationFrame(raf);
      clearTimeout(toastT);
      if (saveT) flush().catch(() => {});
      frame.onload = null;
    },
    openComp, openVersion, openSavedView, newComponent, showLibrary, renameComponent, deleteComponent, resize, setMode,
    setTool, setColor, setBoardColor, selectNote, deleteNote, updateNoteTitle,
    updateNoteColor, setTweak, removeTweak, selectBoard, updateCaption,
    toggleTarget, removeRef, measure, save, copyPrompt, exportBrief, fit, addReviewedReferences,
    async labPick(round, variant) {
      try { const r = await post('lab-pick', { c: ui.c, round, variant }); await pullFeed(); return r; }
      catch (error) { toast(error.message, 5000); }
    },
  };
}
