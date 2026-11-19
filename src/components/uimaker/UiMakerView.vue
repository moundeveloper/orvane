<script setup>
// UI Maker inside Orvane: draw the brief on a live component, hand it to an
// agent through the orvane MCP server (uimaker_* tools), review the next
// iteration the same way. The editor engine is editor.js; this file is layout.
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue';
import CustomSelect from '../CustomSelect.vue';
import CustomNumber from '../CustomNumber.vue';
import UiIcon from './UiIcon.vue';
import ReviewPanel from './ReviewPanel.vue';
import { measureFrame } from './overlay.js';
import { createEditorModel, mountEditor, COLORS, TOOLS, BTOOLS, compUrl, refUrl } from './editor.js';

const props = defineProps({ block: Object });
const model = createEditorModel();
const { ui } = model;
const root = ref(null);
const editor = shallowRef(null);
function savedView() {
  try { return JSON.parse(props.block.value || '{}'); } catch { return {}; }
}
onMounted(() => {
  editor.value = mountEditor(model, root.value, {
    view: savedView(),
    onView: view => {
      const value = JSON.stringify(view);
      if (props.block.value !== value) props.block.value = value;
    },
  });
});
onUnmounted(() => editor.value?.dispose());

const component = computed(() => model.state?.components.find(c => c.id === ui.c));
const versions = computed(() => model.versions[ui.c] ?? []);
const latest = computed(() => versions.value.at(-1)?.n);
const version = computed(() => versions.value.find(v => v.n === ui.v));
const current = entries => entries?.filter(entry => entry.c === ui.c && entry.v === ui.v) ?? [];
const notes = computed(() => current(model.state?.notes));
const tweaks = computed(() => current(model.state?.tweaks));
const boardOwner = computed(() => ui.board === 'local' ? notes.value.find(note => note.id === ui.note) : component.value);
const selectedRef = computed(() => boardOwner.value?.refs.find(r => r.id === ui.ref));
const stats = computed(() => [
  [notes.value.length, 'Notes'], [current(model.state?.strokes).length, 'Strokes'],
  [tweaks.value.length, 'Exact values'], [component.value?.match && component.value.match.v === ui.v ? component.value.match.pct + '%' : '—', 'Ref match'],
]);
const sidebarOpen = ref(true);
const componentSearch = ref('');
const filteredComponents = computed(() => {
  const query = componentSearch.value.trim().toLowerCase();
  return (model.state?.components ?? []).filter(item => item.name.toLowerCase().includes(query));
});

// Row menu: rename inline, delete after a second confirming click. Lives in
// the app (not the page) so it pans and zooms with the canvas.
const menu = ref(null);
const renameValue = ref('');
const captionBefore = ref('');
const renameInput = ref(null);
function openMenu(event, item) {
  if (menu.value?.item.id === item.id) return closeMenu();
  const box = root.value.getBoundingClientRect(), scale = box.width / root.value.offsetWidth || 1;
  const anchor = event.currentTarget.getBoundingClientRect();
  const x = (event.type === 'contextmenu' ? event.clientX : anchor.right - 150 * scale) - box.left;
  const y = (event.type === 'contextmenu' ? event.clientY : anchor.bottom + 4 * scale) - box.top;
  menu.value = { item, mode: 'actions', x: Math.max(4, Math.min(x / scale, root.value.offsetWidth - 170)), y: Math.max(4, Math.min(y / scale, root.value.offsetHeight - 120)) };
}
function closeMenu() { menu.value = null; }
async function startRename() {
  renameValue.value = menu.value.item.name;
  menu.value.mode = 'rename';
  await nextTick();
  renameInput.value?.select();
}
function commitRename() {
  if (renameValue.value.trim()) editor.value.renameComponent(menu.value.item, renameValue.value);
  closeMenu();
}
function confirmDelete() {
  if (menu.value.mode !== 'delete') { menu.value.mode = 'delete'; return; }
  editor.value.deleteComponent(menu.value.item);
  closeMenu();
}
function outsideMenu(event) {
  if (menu.value && !event.target.closest?.('.um-menu')) closeMenu();
}
onMounted(() => window.addEventListener('pointerdown', outsideMenu, true));
onUnmounted(() => window.removeEventListener('pointerdown', outsideMenu, true));

const live = computed(() => ui.mode === 'review' && ui.tool === 'interact');
const cursor = computed(() => {
  if (ui.mode === 'inspect' || ui.tool === 'element' && ui.mode === 'review') return 'crosshair';
  if (ui.mode === 'compare' || ui.tool === 'select') return 'grab';
  return ui.tool === 'eraser' ? 'cell' : 'crosshair';
});
const hint = computed(() => {
  if (ui.mode === 'inspect') return 'Click any element to read and set exact values';
  if (ui.mode === 'compare') return 'Drag to pan · wheel to zoom';
  return ({
    interact: 'Live: hover, click and type in the component',
    pin: 'Click the exact spot, then type',
    element: 'Hover an element · [ parent · ] child · click to pin',
    select: 'Drag to pan · wheel to zoom · double-click a label to edit',
    eraser: 'Drag over strokes to erase',
  })[ui.tool] || 'Red = wrong · Green = want';
});
const compareOptions = computed(() => [
  ...versions.value.filter(v => v.n !== ui.v).map(v => ({ value: 'v' + v.n, label: 'v' + v.n })),
  ...(component.value?.target ? [{ value: 'ref', label: 'Reference overlay' }] : []),
]);
const comparing = computed(() => ui.mode === 'compare' && compareOptions.value.some(o => o.value === ui.cmp.against));
const comparedHeight = computed(() => comparing.value ? Math.max(ui.h, ui.compareHeight || 0) : ui.h);
const compareStyle = computed(() => ({ clipPath: 'inset(0 0 0 ' + ui.cmp.val + '%)' }));
watch(() => [ui.c, ui.v, ui.cmp.against, component.value?.width, component.value?.height], () => {
  ui.compareHeight = 0;
});
function hidePreviewScrollbars(frame) {
  const doc = frame.contentDocument;
  if (!doc?.head || doc.getElementById('uimaker-preview-scrollbars')) return;
  const style = doc.createElement('style');
  style.id = 'uimaker-preview-scrollbars';
  style.textContent = 'html, body { scrollbar-width: none !important; } html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }';
  doc.head.append(style);
}
function loadComparison(frame) {
  hidePreviewScrollbars(frame);
  const doc = frame.contentDocument;
  if (!doc) return;
  function measure() {
    if (!frame.isConnected || frame.contentDocument !== doc || !component.value) return;
    ui.compareHeight = component.value.height || measureFrame(frame);
    frame.style.height = comparedHeight.value + 'px';
  }
  measure();
  doc.fonts?.ready.then(measure);
}
function dragDivider(event) {
  const rect = event.currentTarget.closest('.artboard').getBoundingClientRect();
  if (rect.width) ui.cmp.val = Math.round(Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100)));
}
function startDivider(event) {
  if (event.button !== 0) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  dragDivider(event);
}
function moveDivider(event) {
  if (event.currentTarget.hasPointerCapture(event.pointerId)) dragDivider(event);
}
function dividerKey(event) {
  const delta = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 };
  if (event.key === 'Home') ui.cmp.val = 0;
  else if (event.key === 'End') ui.cmp.val = 100;
  else if (event.key in delta) ui.cmp.val = Math.max(0, Math.min(100, ui.cmp.val + delta[event.key] * (event.shiftKey ? 10 : 1)));
  else return;
  event.preventDefault();
  event.stopPropagation();
}
const newName = ref(null);
async function showNew() {
  sidebarOpen.value = true;
  model.newOpen = true;
  await nextTick();
  newName.value?.focus();
}
function submitNew() {
  const name = newName.value?.value.trim();
  if (name) { componentSearch.value = ''; editor.value.newComponent(name); }
}
const sizeDraft = reactive({ width: 320, height: 0 });
watch(() => [component.value?.width, component.value?.height, ui.h], () => {
  sizeDraft.width = component.value?.width ?? 320;
  sizeDraft.height = component.value?.height ?? Math.round(ui.h);
}, { immediate: true });
</script>

<template>
<div ref="root" class="uimaker" :class="{ 'side-collapsed': !sidebarOpen, 'library-open': model.library }"
  @wheel="$event.ctrlKey || $event.metaKey || $event.stopPropagation()">
  <aside class="side" aria-label="Components sidebar">
    <div class="sidehead">
      <button v-if="sidebarOpen" class="side-title" @click="editor?.showLibrary()">Components</button>
      <button class="iconbtn" :title="sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'"
        :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><UiIcon name="sidebar" /></button>
    </div>
    <div v-show="sidebarOpen" class="sidebar-content">
      <div class="sidebar-search">
        <input v-model="componentSearch" type="text" aria-label="Search components" placeholder="Search components">
        <button class="iconbtn" title="New component" :disabled="!model.state" @click="showNew"><UiIcon name="plus" /></button>
      </div>
      <div v-if="model.newOpen" class="newinput">
        <UiIcon name="plus" />
        <input ref="newName" placeholder="Name, then Enter" aria-label="New component name"
          @keydown.enter="submitNew" @keydown.esc="model.newOpen = false" @blur="model.newOpen = false">
      </div>
      <nav class="nav" aria-label="Components">
        <div v-for="item in filteredComponents" :key="item.id" class="nav-row" :class="{ on: item.id === ui.c }"
          @contextmenu.prevent.stop="openMenu($event, item)">
          <button class="nav-item" :aria-current="item.id === ui.c ? 'page' : undefined" @click="editor.openComp(item.id)">
            <UiIcon name="box" /><span>{{ item.name }}</span><small>v{{ model.versions[item.id]?.at(-1)?.n ?? 1 }}</small>
          </button>
          <button class="iconbtn row-menu" :title="'Actions for ' + item.name" :aria-expanded="menu?.item.id === item.id"
            @click.stop="openMenu($event, item)">⋯</button>
        </div>
      </nav>
      <p v-if="componentSearch.trim() && !filteredComponents.length" class="sidebar-empty">No matching components.</p>
      <button class="nav-item sidebar-help" @click="model.help = true"><UiIcon name="help" /><span>How it works</span></button>
    </div>
  </aside>

  <main class="main">
    <header class="top">
      <nav class="crumb" aria-label="Breadcrumb">
        <button v-if="!model.library" @click="editor?.showLibrary()">Components</button>
        <span v-else aria-current="page">Components</span>
        <template v-if="component"><em aria-hidden="true">/</em><b aria-current="page">{{ component.name }}</b></template>
      </nav>
      <div v-show="!model.library" class="editor-controls">
        <div class="pills">
          <button v-for="mode in ['review', 'inspect', 'compare']" :key="mode" :class="{ on: ui.mode === mode }"
            :disabled="!component" @click="editor.setMode(mode)">{{ mode[0].toUpperCase() + mode.slice(1) }}</button>
        </div>
        <div class="spacer"></div>
        <div class="size" title="Artboard width × height">
          <CustomNumber v-model="sizeDraft.width" :min="40" :max="3000" :disabled="!component" aria-label="Artboard width"
            @change="editor.resize('width', $event)" />
          <span>×</span>
          <CustomNumber v-model="sizeDraft.height" :min="20" :max="6000" :disabled="!component || !component.height" aria-label="Artboard height"
            @change="editor.resize('height', $event)" />
          <button class="auto" :class="{ on: component && !component.height }" :disabled="!component"
            title="Height follows the content" @click="editor.resize('height', component.height ? 0 : Math.round(ui.h))">Auto</button>
        </div>
        <div class="field zoom">
          <button data-el="zOut" title="Zoom out">−</button><span>{{ Math.round(ui.zoom * 100) }}%</span>
          <button data-el="zIn" title="Zoom in">+</button><button data-el="zFit">Fit</button>
        </div>
      </div>
    </header>

    <section v-if="model.library" class="library" aria-labelledby="um-library-title">
      <header><h1 id="um-library-title">Components</h1><button class="btn primary" @click="showNew"><UiIcon name="plus" />New component</button></header>
      <div v-if="model.state?.components.length" class="library-list">
        <div v-for="item in model.state.components" :key="item.id" class="library-row" @contextmenu.prevent.stop="openMenu($event, item)">
          <button class="library-item" @click="editor.openComp(item.id)">
            <UiIcon name="box" /><b>{{ item.name }}</b><span>{{ model.versions[item.id]?.length || 0 }} versions</span>
          </button>
          <button class="iconbtn row-menu" :title="'Actions for ' + item.name" @click.stop="openMenu($event, item)">⋯</button>
        </div>
      </div>
      <p v-else class="empty">No components yet.</p>
    </section>

    <section v-show="!model.library" class="viewport" data-el="viewport">
      <div class="stage" data-el="stage">
        <div class="artboard" data-el="artboard" :style="{ minHeight: comparedHeight + 'px', '--handle-scale': 1 / ui.zoom }">
          <iframe data-el="frame" title="Component" scrolling="no" @load="hidePreviewScrollbars($event.target)"></iframe>
          <div v-show="comparing" class="cmp-layer">
            <template v-if="comparing">
              <img v-if="ui.cmp.against === 'ref'" :src="refUrl(component.target)" alt="" :style="compareStyle">
              <iframe v-else :key="[component.id, ui.cmp.against, component.width, component.height].join(':')" scrolling="no"
                :src="compUrl(component.id, ui.cmp.against.slice(1))" title="Compared version" @load="loadComparison($event.target)"
                :style="[compareStyle, { height: comparedHeight + 'px' }]"></iframe>
            </template>
          </div>
          <svg data-el="overlay" class="overlay" :style="{ pointerEvents: live ? 'none' : '', cursor }"><rect x="-8000" y="-8000" width="16000" height="16000" fill="transparent"/></svg>
          <div v-if="comparing" class="split-divider" :style="{ left: ui.cmp.val + '%' }">
            <button type="button" class="split-handle" role="slider" aria-label="Comparison divider"
              :aria-valuemin="0" :aria-valuemax="100" :aria-valuenow="ui.cmp.val" :aria-valuetext="ui.cmp.val + '%'"
              @pointerdown.stop="startDivider" @pointermove="moveDivider" @keydown="dividerKey">‹ ›</button>
          </div>
        </div>
      </div>
      <div v-show="!live" class="labels" data-el="labels"></div>
      <div v-show="component && ui.mode === 'review'" class="rail">
        <button v-for="[id, icon, title] in TOOLS" :key="id" :class="{ on: ui.tool === id }" :title="title"
          :aria-label="title" @click="editor.setTool(id)"><UiIcon :name="icon" /></button>
        <hr>
        <button v-for="[color, title] in COLORS" :key="color" class="sw" :class="{ on: ui.color === color }" :style="{ color }"
          :title="title" :aria-label="title" @click="editor.setColor(color)"><span :style="{ background: color }"></span></button>
        <hr>
        <input v-model.number="ui.size" class="stroke-size" type="range" min="1" max="12" title="Stroke size" aria-label="Stroke size">
      </div>
      <div v-if="ui.mode === 'compare'" class="cmpbar">
        <template v-if="comparing">
          v{{ ui.v }} against
          <CustomSelect v-model="ui.cmp.against" :options="compareOptions" class="cmp-select" aria-label="Compare against" />
          <button v-if="ui.cmp.against === 'ref'" class="btn" @click="editor.measure()">Measure</button>
          <span v-if="ui.cmp.against === 'ref' && component.match?.v === ui.v" class="match">{{ component.match.pct }}% match</span>
        </template>
        <template v-else>Nothing to compare yet. You need a second iteration, or mark a reference as the overlay (◎ on the reference canvas).</template>
      </div>
      <div class="hint" :role="model.error ? 'alert' : undefined">{{ model.error || (component ? model.elementPreview || hint : 'Loading UI Maker…') }}</div>
      <div class="timeline">
        <button v-for="entry in versions" :key="entry.n"
          :class="{ on: ui.v === entry.n, cmp: ui.mode === 'compare' && ui.cmp.against === 'v' + entry.n }"
          :title="entry.response?.summary || (entry.n === 1 ? 'Starting point' : 'Iteration ' + entry.n)" @click="editor.openVersion(entry.n)">
          <span class="who" :class="{ ai: entry.response }"></span>v{{ entry.n }}
          <template v-for="count in [model.state?.notes.filter(n => n.c === ui.c && n.v === entry.n).length]" :key="count">
            <small v-if="count">{{ count }} {{ count === 1 ? 'note' : 'notes' }}</small>
          </template>
        </button>
      </div>
    </section>
  </main>

  <aside v-show="!model.library" class="right" data-el="right">
    <div v-if="component" class="card">
      <div class="head">
        <h3>{{ component.name }}</h3>
        <span class="chip"><UiIcon name="eye" />v{{ ui.v }}{{ ui.v === latest ? ' · latest' : '' }}</span>
        <span v-if="version?.response" class="chip green"><UiIcon name="check" />Agent revision</span>
      </div>
      <textarea v-model="component.intent" placeholder="What is this component for, and what should it feel like? The agent reads this first."
        aria-label="Component intent" @input="editor.save()"></textarea>
      <div class="tiles">
        <div v-for="[value, label] in stats" :key="label" class="tile" :class="{ accent: label === 'Ref match' }"><b>{{ value }}</b><span>{{ label }}</span></div>
      </div>
      <div class="actions">
        <button class="btn primary" title="Copies a one-line prompt; the agent reads the brief through the Orvane MCP server" @click="editor.copyPrompt()"><UiIcon name="send" />Copy prompt for agent</button>
        <button class="btn" title="Writes brief.md and the renders to disk" @click="editor.exportBrief()">Export brief</button>
      </div>
    </div>
    <div class="pills tabs">
      <button v-for="tab in ui.mode === 'inspect' ? ['notes', 'inspect', 'feed'] : ['notes', 'feed']" :key="tab" :class="{ on: ui.tab === tab }"
        @click="ui.tab = tab">{{ tab[0].toUpperCase() + tab.slice(1) }}</button>
    </div>
    <div class="panel">
      <ReviewPanel v-if="component" :ui="ui" :notes="notes" :tweaks="tweaks" :versions="versions" :feed="model.feed" :editor="editor" />
    </div>
    <div class="splitter" data-el="splitter" title="Drag to resize"></div>
    <div class="boardwrap" data-el="boardwrap">
      <div class="boardhead">
        <div class="seg">
          <button :class="{ on: ui.board === 'local' }" :disabled="!component" @click="editor.selectBoard('local')">Note</button>
          <button :class="{ on: ui.board === 'global' }" :disabled="!component" @click="editor.selectBoard('global')">Component</button>
        </div>
        <div class="spacer"></div>
        <button class="iconbtn" data-el="pasteBtn" title="Paste image from clipboard (Ctrl+V)"><UiIcon name="paste" /></button>
        <button class="iconbtn" data-el="fileBtn" title="Add image files"><UiIcon name="image" /></button>
        <input type="file" data-el="fileIn" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
        <button class="iconbtn" data-el="boardFit" title="Fit everything (F)"><UiIcon name="fit" /></button>
        <button class="iconbtn" data-el="boardMax" title="Maximise board (Esc to restore)"><UiIcon name="expand" /></button>
      </div>
      <div class="board" data-el="board" tabindex="0">
        <svg data-el="bsvg" class="bsvg" :style="{ cursor: ui.btool === 'move' ? 'grab' : ui.btool === 'eraser' ? 'cell' : 'crosshair' }"><g data-el="bworld"></g></svg>
        <div v-show="boardOwner" class="rail mini">
          <button v-for="[id, icon, title] in BTOOLS" :key="id" :class="{ on: ui.btool === id }" :title="title"
            :aria-label="title" @click="ui.btool = id"><UiIcon :name="icon" /></button>
          <hr>
          <button v-for="[color, title] in COLORS.slice(0, 3)" :key="color" class="sw" :class="{ on: ui.bcolor === color }" :style="{ color }"
            :title="title" :aria-label="title" @click="editor.setBoardColor(color)"><span :style="{ background: color }"></span></button>
        </div>
        <div v-if="component && !boardOwner?.refs.length" class="bempty">
          <template v-if="boardOwner">
            <b>Add a visual reference</b><span>Paste <kbd>Ctrl V</kbd>, drop, or add images here. Then draw and pin on them to point at the exact part.</span>
          </template>
          <template v-else>
            <b>No note selected</b>Select a note to open its own reference canvas, or switch to Component for references that apply to everything.
          </template>
        </div>
        <input class="floatedit" data-el="bedit" hidden placeholder="What should the agent take from here?" aria-label="Pin text">
      </div>
      <div v-if="selectedRef" :key="selectedRef.id" class="refbar">
        <input :value="selectedRef.caption" placeholder="What should the agent take from this image?" aria-label="Reference caption"
          @input="editor.updateCaption(selectedRef, $event.target.value)"
          @focus="captionBefore = selectedRef.caption" @keydown.enter="$event.target.blur()"
          @keydown.esc.stop="editor.updateCaption(selectedRef, captionBefore); $event.target.blur()">
        <button class="iconbtn" :class="{ active: component.target === selectedRef.file }"
          :title="component.target === selectedRef.file ? 'Stop using as overlay' : 'Use as pixel overlay in Compare'"
          @click="editor.toggleTarget(selectedRef)"><UiIcon name="target" /></button>
        <button class="iconbtn" title="Remove reference (Del)" @click="editor.removeRef(selectedRef)"><UiIcon name="trash" /></button>
      </div>
    </div>
  </aside>

  <div v-if="menu" class="um-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" role="group" aria-label="Component actions"
    @keydown.esc.stop="closeMenu()">
    <template v-if="menu.mode === 'rename'">
      <input ref="renameInput" v-model="renameValue" aria-label="Component name" @keydown.enter="commitRename" @keydown.esc.stop="closeMenu()">
      <button @click="commitRename">Rename</button>
    </template>
    <template v-else>
      <button @click="editor.openComp(menu.item.id); closeMenu()">Open</button>
      <button @click="startRename">Rename</button>
      <button :class="{ danger: menu.mode === 'delete' }" @click="confirmDelete">{{ menu.mode === 'delete' ? 'Click again to remove' : 'Remove from list' }}</button>
    </template>
  </div>
  <div class="toast" :class="{ show: model.toast }" role="status">{{ model.toast }}</div>
  <div v-if="model.help" class="help" @pointerdown.self="model.help = false">
    <div class="sheet">
      <h2>You draw the brief. Your agent builds the next iteration.</h2>
      <ol>
        <li><b>Sketch.</b> Draw straight on the component. <span class="c-red">Red</span> is wrong or remove, <span class="c-green">green</span> is add or want.</li>
        <li><b>Pin notes.</b> Drop a pin on the exact spot and type what you mean right there. Double-click any label to edit it.</li>
        <li><b>Show, don't tell.</b> Every note has its own reference canvas. Paste or drop images, then draw and pin on the images to point at the exact part you mean.</li>
        <li><b>Set exact values.</b> In Inspect, click an element and type the value. The agent receives it as an exact value.</li>
        <li><b>Hand it over.</b> Copy the prompt into Claude. It reads the brief, renders and references through the Orvane MCP server (<code>uimaker_brief</code>), delivers the next version and answers each note.</li>
        <li><b>Compare.</b> Split against any version or a reference overlay. Then review again.</li>
      </ol>
      <p class="keys">V move · P pen · R box · A arrow · E eraser · N pin · T element pin · I interact · Ctrl+Z undo · Ctrl+Y redo · wheel zoom · Ctrl+V paste a reference</p>
      <button class="btn primary" @click="model.help = false">Got it</button>
    </div>
  </div>
</div>
</template>

<style>
/* Fills its app, like the other built-in apps. */
.app-content:has(> .block-uimaker:only-child) { padding: 0; overflow: hidden; }
.app-content > .block-uimaker { display: flex; flex: 1; min-height: 520px; }
.app-content > .block-uimaker > * { flex: 1; min-width: 0; }
.block-uimaker:not(:only-child) { height: 720px; }
</style>
<style src="./uimaker.css"></style>
