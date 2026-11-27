<script setup lang="ts">
import { Activity, ChevronLeft, Palette } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from "vue";
import {
  getThemeMediaUrl,
  THEME_BACKGROUNDS,
  THEME_COLORS,
  THEME_PRESETS,
  type ThemeBackgroundType,
  type ThemePaletteKey,
  type WorkspaceTheme,
} from "../workspaceTheme";
import Icon from "./Icon.vue";
import { imageMood, paletteFromSwatches, type PaletteStrength } from "../imagePalette";
import dotsSource from "../themeAnimation-dots.ts?raw";
import flowSource from "../themeAnimation-flow.ts?raw";
import auroraSource from "../themeAnimation-aurora.ts?raw";
const animationSources = { dots: dotsSource, flow: flowSource, aurora: auroraSource };

const props = defineProps<{
  theme: WorkspaceTheme;
  dirty: boolean;
  reduced: boolean;
  systemReduced: boolean;
  saving: boolean;
  error?: string;
  changeCount?: number;
}>();
const emit = defineEmits<{
  "update:theme": [theme: WorkspaceTheme];
  "update:reduced": [value: boolean];
  "import-media": [file: File, kind: "image" | "video"];
  "import-palette-image": [file: File];
  apply: [];
  discard: [];
  back: [];
  close: [];
}>();

const backgroundTypes = [
  { id: "plain", label: "Plain" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "code", label: "Code" },
] as const satisfies readonly { id: ThemeBackgroundType; label: string }[];
const background = computed(() => props.theme.backgroundType);
const animationCode = computed(() => animationSources[props.theme.code]
  .split(/\r?\n/).slice(3, -2).map((line) => line.slice(2)).join("\n"));
const mediaKind = computed(() => background.value === "image" || background.value === "video" ? background.value : undefined);
const localMedia = computed(() => mediaKind.value ? props.theme.media?.[mediaKind.value] : undefined);
const backgroundChoices = computed(() => {
  const kind = background.value;
  return kind === "plain" ? [] : THEME_BACKGROUNDS[kind];
});
const contrast = computed(() => {
  const luminance = (hex: string) => rgb(hex).map((channel) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!, 0);
  const text = luminance(props.theme.palette.text);
  const surface = luminance(props.theme.palette.app);
  return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
});

function update(patch: Partial<WorkspaceTheme>) {
  emit("update:theme", { ...props.theme, ...patch });
}

function setPalette(preset: (typeof THEME_PRESETS)[number]) {
  update({ preset: preset.id, palette: { ...preset.palette } });
}

// Palette from image: the panel shows the image, its mood and the palette
// built from it; the file itself is read in useWorkspaceAppearance.
const paletteImage = computed(() => props.theme.paletteImage);
const fromImage = computed(() => props.theme.preset === "image" && !!paletteImage.value);
const imagePalette = computed(() => paletteImage.value
  ? paletteFromSwatches(paletteImage.value.swatches, paletteImage.value.strength)
  : undefined);
const mood = computed(() => paletteImage.value ? imageMood(paletteImage.value.swatches) : []);
const strengths = [
  { id: "quiet", label: "Quiet" },
  { id: "balanced", label: "Balanced" },
  { id: "vivid", label: "Vivid" },
] as const satisfies readonly { id: PaletteStrength; label: string }[];
const imageBackground = computed(() =>
  !!paletteImage.value && background.value === "image" && props.theme.image === paletteImage.value.id);

// "Image" with an image already read selects its palette; otherwise it asks
// for an image.
function choosePaletteImage() {
  if (imagePalette.value && props.theme.preset !== "image")
    update({ preset: "image", palette: { ...imagePalette.value.palette } });
  else if (!paletteImage.value) pickPaletteImage();
}

// A file input made on demand: the panel keeps a single file input (the
// background one), so "the file field" stays unambiguous.
function pickPaletteImage() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/jpeg,image/png,image/webp,image/avif";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) emit("import-palette-image", file);
  }, { once: true });
  input.click();
}

function imageFile(data: DataTransfer | null) {
  return Array.from(data?.files ?? []).find((file) => file.type.startsWith("image/"));
}

// Drop an image on the Palette section, or paste one anywhere in the panel.
function dropPaletteImage(event: DragEvent) {
  const file = imageFile(event.dataTransfer);
  if (!file) return;
  event.preventDefault();
  emit("import-palette-image", file);
}

function pastePaletteImage(event: ClipboardEvent) {
  if ((event.target as HTMLElement).closest("input, textarea")) return;
  const file = imageFile(event.clipboardData);
  if (!file) return;
  event.preventDefault();
  emit("import-palette-image", file);
}

function setStrength(strength: PaletteStrength) {
  const source = paletteImage.value;
  if (!source) return;
  update({
    preset: "image",
    palette: paletteFromSwatches(source.swatches, strength).palette,
    paletteImage: { ...source, strength },
  });
}

function toggleImageBackground() {
  const source = paletteImage.value;
  if (!source) return;
  if (imageBackground.value) {
    // Off: the image stops being the background, so Apply will not store it.
    const { image: _image, ...media } = props.theme.media ?? {};
    update({ backgroundType: "plain", image: "lake", media });
  } else update({
    backgroundType: "image",
    image: source.id,
    media: { ...props.theme.media, image: { id: source.id, name: source.name } },
  });
}

// Previous / next palette, wrapping. From Custom, next is the first preset.
function stepPalette(direction: number) {
  const at = THEME_PRESETS.findIndex((preset) => preset.id === props.theme.preset);
  const start = at < 0 ? (direction > 0 ? -1 : 0) : at;
  const next = THEME_PRESETS[(start + direction + THEME_PRESETS.length) % THEME_PRESETS.length];
  if (next) setPalette(next);
}

// Left / Right anywhere in the panel steps the palette, except where arrows
// already mean something (radio groups, colour sliders, text fields).
function panelKeys(event: KeyboardEvent) {
  const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!direction || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  if (target.closest('[role="radiogroup"], [role="slider"], input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
  event.stopPropagation();
  stepPalette(direction);
}

function selectBackground(id: string) {
  if (background.value !== "plain") update({ [background.value]: id });
}

function radioKeys(event: KeyboardEvent, columns = 1) {
  const buttons = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[role="radio"]'));
  const current = buttons.indexOf(event.target as HTMLButtonElement);
  if (current < 0 || !buttons.length) return;
  const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = buttons.length - 1;
  else if (offset !== undefined) next = (current + offset + buttons.length) % buttons.length;
  else return;
  event.preventDefault();
  event.stopPropagation();
  buttons[next]?.focus();
  // "Image" without an image yet opens a file picker: only on Enter/Space or click.
  if (buttons[next]?.dataset.select !== "manual") buttons[next]?.click();
}

const fileInput = ref<HTMLInputElement>();
function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file && mediaKind.value) emit("import-media", file, mediaKind.value);
  input.value = "";
}

function rangeValue(event: Event) {
  return (event.target as HTMLInputElement).valueAsNumber;
}

const panel = ref<HTMLElement>();
const popover = ref<HTMLElement>();
const saturationControl = ref<HTMLElement>();
const colorEdit = ref<{ key: ThemePaletteKey; label: string; original: string; anchor: HTMLButtonElement }>();
const position = ref({ left: "", top: "" });
const hexInput = ref("");
const hue = ref(0);
const saturation = ref(0);
const brightness = ref(0);
const normalizedHex = computed(() => /^#?[\da-f]{6}$/i.test(hexInput.value.trim())
  ? "#" + hexInput.value.trim().replace(/^#/, "").toLowerCase()
  : undefined);
const pickerColor = computed(() => hsvHex(hue.value, saturation.value, brightness.value));
const clamp = (n: number, max = 1) => Math.min(max, Math.max(0, n));
const arrow = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 } as Record<string, number>;

function rgb(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255] as const;
}

function loadHex(color: string) {
  const [r, g, b] = rgb(color).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let segment = 0;
  if (delta) {
    if (max === r) segment = (g - b) / delta;
    else if (max === g) segment = (b - r) / delta + 2;
    else segment = (r - g) / delta + 4;
  }
  hue.value = (segment * 60 + 360) % 360;
  saturation.value = max ? delta / max : 0;
  brightness.value = max;
}

function hsvHex(h: number, s: number, v: number) {
  const channel = (offset: number) => {
    const k = (offset + h / 60) % 6;
    const component = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(component * 255).toString(16).padStart(2, "0");
  };
  return "#" + channel(5) + channel(3) + channel(1);
}

function writeColor(color: string) {
  const edit = colorEdit.value;
  if (!edit || props.theme.palette[edit.key] === color) return;
  const palette = { ...props.theme.palette, [edit.key]: color };
  const preset = THEME_PRESETS.find((option) => THEME_COLORS.every(({ key }) => option.palette[key] === palette[key]));
  update({ palette, preset: preset?.id ?? "custom" });
}

function showColor(event: MouseEvent, key: ThemePaletteKey, label: string) {
  const anchor = event.currentTarget as HTMLButtonElement;
  if (colorEdit.value?.anchor === anchor) {
    closeColor();
    return;
  }
  const original = props.theme.palette[key];
  const bounds = anchor.getBoundingClientRect();
  const width = Math.min(232, window.innerWidth - 16);
  position.value = {
    left: `${Math.max(8, Math.min(window.innerWidth - width - 8, bounds.left - width - 10))}px`,
    top: `${Math.max(8, Math.min(window.innerHeight - 300, bounds.top - 40))}px`,
  };
  colorEdit.value = { anchor, key, label, original };
  hexInput.value = original;
  loadHex(original);
  void nextTick(() => saturationControl.value?.focus({ preventScroll: true }));
}

function closeColor(restoreFocus = false, revert = false) {
  const edit = colorEdit.value;
  if (!edit) return;
  if (revert) writeColor(edit.original);
  colorEdit.value = undefined;
  if (restoreFocus) edit.anchor.focus({ preventScroll: true });
}

function updateHex() {
  if (!normalizedHex.value) return;
  loadHex(normalizedHex.value);
  writeColor(normalizedHex.value);
}

function setColorFromControls() {
  hexInput.value = pickerColor.value;
  writeColor(pickerColor.value);
}

function suggestColor(color: string) {
  hexInput.value = color;
  updateHex();
}

function adjustColorPointer(event: PointerEvent, control: "saturation" | "hue") {
  const element = event.currentTarget as HTMLElement;
  if (event.type === "pointerdown") {
    if (event.button !== 0) return;
    element.setPointerCapture(event.pointerId);
  } else if (!element.hasPointerCapture(event.pointerId)) return;
  const bounds = element.getBoundingClientRect();
  const x = clamp((event.clientX - bounds.left) / bounds.width);
  if (control === "saturation") {
    saturation.value = x;
    brightness.value = 1 - clamp((event.clientY - bounds.top) / bounds.height);
  } else hue.value = x * 359;
  setColorFromControls();
}

function adjustColorKey(event: KeyboardEvent, control: "saturation" | "hue") {
  const direction = arrow[event.key];
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  if (control === "hue") hue.value = (hue.value + direction * (event.shiftKey ? 15 : 3) + 360) % 360;
  else {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") saturation.value = clamp(saturation.value + direction * step);
    else brightness.value = clamp(brightness.value + direction * step);
  }
  setColorFromControls();
}

function pickerKeys(event: KeyboardEvent) {
  if (event.key === "Tab") {
    const edit = colorEdit.value;
    if (!edit) return;
    const controls = Array.from(popover.value?.querySelectorAll<HTMLElement>("button, input, [tabindex='0']") ?? []);
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (event.target !== edge) return;
    // Continue panel tab order after the anchor when leaving the teleported picker.
    event.preventDefault();
    closeColor(true);
    const buttons = Array.from(panel.value?.querySelectorAll<HTMLButtonElement>(".theme-token") ?? []);
    if (!event.shiftKey) (buttons[buttons.indexOf(edit.anchor) + 1] ?? panel.value?.querySelector<HTMLButtonElement>(".theme-background-types button[tabindex='0']"))?.focus();
  } else if (event.key === "Escape" || (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !(event.target instanceof HTMLButtonElement))) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") closeColor(true, true);
    else if (normalizedHex.value) closeColor(true);
  }
}

function outsideColor(event: PointerEvent) {
  const target = event.target;
  if (target instanceof Node && !popover.value?.contains(target) && !colorEdit.value?.anchor.contains(target)) closeColor();
}
const dismissColor = () => closeColor();

onMounted(() => {
  panel.value?.focus({ preventScroll: true });
  document.addEventListener("pointerdown", outsideColor, true);
  window.addEventListener("resize", dismissColor);
  window.addEventListener("orvane:guest-pointer-down", dismissColor);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outsideColor, true);
  window.removeEventListener("resize", dismissColor);
  window.removeEventListener("orvane:guest-pointer-down", dismissColor);
});

const presetStyle = (palette: WorkspaceTheme["palette"]): CSSProperties => ({
  "--preset-canvas": palette.canvas,
  "--preset-app": palette.app,
  "--preset-text": palette.text,
  "--preset-accent": palette.accent,
  "--preset-run": palette.run,
});
</script>

<template>
  <section
    ref="panel"
    class="workspace-panel floating-panel appearance-settings"
    aria-label="Appearance settings"
    tabindex="-1"
    @pointerdown.stop
    @wheel.stop
    @keydown="panelKeys"
    @paste="pastePaletteImage"
  >
    <header class="appearance-heading">
      <button type="button" class="appearance-icon" aria-label="Back to Your workspace" title="Your workspace" @click="emit('back')">
        <ChevronLeft :size="14" aria-hidden="true" />
      </button>
      <h1>Appearance</h1>
      <button type="button" class="appearance-icon" aria-label="Close settings" @click="emit('close')">
        <Icon name="close" :size="14" />
      </button>
    </header>

    <div class="appearance-body" @scroll="dismissColor">
      <p class="appearance-help">Changes preview on the canvas behind this panel. Nothing is saved until you apply.</p>

      <section class="appearance-section" aria-labelledby="appearance-palette-title" @dragover.prevent @drop="dropPaletteImage">
        <h2 id="appearance-palette-title" class="appearance-section-heading">
          <Palette :size="14" :stroke-width="1.75" aria-hidden="true" />
          Palette
          <span class="theme-preset-steps">
            <button type="button" aria-label="Previous palette" title="Previous palette (←)" @click="stepPalette(-1)"><kbd>←</kbd></button>
            <button type="button" aria-label="Next palette" title="Next palette (→)" @click="stepPalette(1)"><kbd>→</kbd></button>
          </span>
        </h2>
        <div class="theme-presets" role="radiogroup" aria-label="Palette" @keydown="radioKeys($event, 6)">
          <button
            v-for="preset in THEME_PRESETS"
            :key="preset.id"
            class="theme-preset"
            type="button"
            role="radio"
            :aria-checked="theme.preset === preset.id"
            :tabindex="theme.preset === preset.id ? 0 : -1"
            @click="setPalette(preset)"
          >
            <span class="theme-preset-sample" :style="presetStyle(preset.palette)"></span>
            {{ preset.name }}
          </button>
          <button
            type="button"
            class="theme-preset from-image"
            role="radio"
            :aria-checked="theme.preset === 'image'"
            :tabindex="theme.preset === 'image' ? 0 : -1"
            :data-select="paletteImage ? undefined : 'manual'"
            aria-label="Palette from image"
            :title="paletteImage ? `Palette from ${paletteImage.name}` : theme.preset === 'image' ? 'Saved palette from an image. Click to build a new one' : 'Build a palette from an image (or drop or paste one here)'"
            @click="choosePaletteImage"
          >
            <span v-if="imagePalette || theme.preset === 'image'" class="theme-preset-sample" :style="presetStyle(imagePalette?.palette ?? theme.palette)"></span>
            <span v-else class="theme-preset-sample empty"><Icon name="image" :size="14" /></span>
            Image
          </button>
          <button v-if="theme.preset === 'custom'" type="button" class="theme-preset custom" role="radio" aria-checked="true">
            <span class="theme-preset-sample" :style="presetStyle(theme.palette)"></span>
            Custom
          </button>
        </div>
        <div v-if="fromImage && paletteImage" class="theme-image-source" aria-label="Palette image">
          <div class="theme-image-row">
            <img class="theme-image-thumb" :src="getThemeMediaUrl(paletteImage.id)" alt="" />
            <span class="theme-image-name">
              <b :title="paletteImage.name">{{ paletteImage.name }}</b>
              <small>{{ paletteImage.width }}×{{ paletteImage.height }}</small>
            </span>
            <button type="button" class="theme-action" aria-label="Change palette image" @click="pickPaletteImage">Change</button>
          </div>
          <div class="theme-image-mood" aria-label="Image mood">
            <span v-for="tag in mood" :key="tag">{{ tag }}</span>
          </div>
          <div class="theme-image-raw">
            In the image
            <span class="theme-image-strip" role="img" :aria-label="`Image colours: ${paletteImage.swatches.map((s) => s.hex).join(', ')}`">
              <i v-for="swatch in paletteImage.swatches" :key="swatch.hex" :style="{ flex: swatch.weight, background: swatch.hex }" :title="`${swatch.hex} · ${Math.round(swatch.weight * 100)}%`"></i>
            </span>
          </div>
        </div>
        <div v-if="fromImage" class="theme-image-label">For the UI</div>
        <div class="theme-tokens" :class="{ 'with-why': fromImage }">
          <button
            v-for="{ key, label } in THEME_COLORS"
            :key="key"
            type="button"
            class="theme-token"
            aria-haspopup="dialog"
            :aria-expanded="colorEdit?.key === key"
            :aria-label="`Edit ${label} colour, ${theme.palette[key]}`"
            @click="showColor($event, key, label)"
          >
            {{ label }}
            <small v-if="fromImage && imagePalette" class="theme-token-why">{{ imagePalette.why[key] }}</small>
            <span><i class="color-swatch" :style="{ background: theme.palette[key] }"></i>{{ theme.palette[key] }}</span>
          </button>
        </div>
        <div class="theme-contrast" :class="{ low: contrast < 4.5 }">
          <Icon :name="contrast < 4.5 ? 'alert' : 'check'" :size="12" />
          Text on windows {{ contrast.toFixed(1) }}:1{{ contrast < 4.5 ? " · below 4.5:1" : "" }}
        </div>
        <template v-if="fromImage && paletteImage">
          <div class="theme-background-types theme-strength" role="radiogroup" aria-label="Colour strength" @keydown="radioKeys($event)">
            <button
              v-for="option in strengths"
              :key="option.id"
              type="button"
              role="radio"
              :aria-checked="paletteImage.strength === option.id"
              :tabindex="paletteImage.strength === option.id ? 0 : -1"
              @click="setStrength(option.id)"
            >
              {{ option.label }}
            </button>
          </div>
          <div class="theme-setting-row">
            <span>Also use it as canvas background</span>
            <button type="button" class="theme-switch" role="switch" :aria-checked="imageBackground" aria-label="Use the palette image as canvas background" @click="toggleImageBackground"></button>
          </div>
        </template>
      </section>

      <section class="appearance-section" aria-labelledby="appearance-background-title">
        <h2 id="appearance-background-title" class="appearance-section-heading">
          <Icon name="image" :size="14" />
          Canvas background
          <span aria-hidden="true"><kbd>Alt</kbd><kbd>1-4</kbd></span>
        </h2>
        <div class="theme-background-types" role="radiogroup" aria-label="Background type" @keydown="radioKeys($event)">
          <button
            v-for="(type, index) in backgroundTypes"
            :key="type.id"
            type="button"
            role="radio"
            :aria-checked="background === type.id"
            :tabindex="background === type.id ? 0 : -1"
            :aria-keyshortcuts="`Alt+${index + 1}`"
            @click="update({ backgroundType: type.id })"
          >
            {{ type.label }}
          </button>
        </div>
        <template v-if="background !== 'plain'">
          <div class="theme-background-options">
            <div class="theme-background-radios" role="radiogroup" aria-label="Background" @keydown="radioKeys($event, 3)">
              <button
                v-for="option in backgroundChoices"
                :key="option.id"
                type="button"
                class="theme-thumbnail"
                role="radio"
                :aria-checked="theme[background] === option.id"
                :tabindex="theme[background] === option.id ? 0 : -1"
                @click="selectBackground(option.id)"
              >
                <span class="theme-thumbnail-picture">
                  <img v-if="option.poster" :src="option.poster" alt="" />
                  <span v-if="background === 'video'" class="theme-duration">{{ option.detail.split(' ')[0] }}</span>
                </span>
                <span class="theme-thumbnail-name">{{ option.name }}</span>
                <span class="theme-thumbnail-detail">{{ option.detail }}</span>
              </button>
              <button
                v-if="localMedia"
                type="button"
                class="theme-thumbnail"
                role="radio"
                :aria-checked="theme[background] === localMedia.id"
                :tabindex="theme[background] === localMedia.id ? 0 : -1"
                @click="selectBackground(localMedia.id)"
              >
                <span class="theme-thumbnail-picture local">
                  <img v-if="background === 'image'" :src="getThemeMediaUrl(localMedia.id)" alt="" />
                  <Icon v-else name="video" :size="16" />
                </span>
                <span class="theme-thumbnail-name" :title="localMedia.name">{{ localMedia.name }}</span>
                <span class="theme-thumbnail-detail">Local file</span>
              </button>
            </div>
            <button v-if="mediaKind === 'image'" type="button" class="theme-thumbnail add" @click="fileInput?.click()">
              <span class="theme-thumbnail-picture"><Icon name="plus" :size="16" /></span>
              <span class="theme-thumbnail-name">From file…</span>
              <span class="theme-thumbnail-detail">jpg png webp avif</span>
            </button>
            <input
              v-if="mediaKind"
              ref="fileInput"
              type="file"
              hidden
              :accept="mediaKind === 'video' ? 'video/mp4,video/webm' : 'image/jpeg,image/png,image/webp,image/avif'"
              @change="importFile"
            />
          </div>
          <div v-if="background === 'video'" class="theme-setting-row">
            <span>Playback<small>Muted, loops, pauses when hidden</small></span>
            <button type="button" class="theme-action video-import" aria-label="Import video from file" title="MP4 or WebM" @click="fileInput?.click()">From file…</button>
          </div>
          <template v-if="background === 'code'">
            <label class="theme-setting-row">
              Speed
              <span class="theme-range-value">
                <span class="theme-range" :style="{ '--range-progress': ((theme.speed - 0.25) / 1.75) * 100 + '%' }">
                  <span class="theme-range-track"></span>
                  <input type="range" min="0.25" max="2" step="0.25" :value="theme.speed" aria-label="Animation speed" :aria-valuetext="theme.speed + '×'" @input="update({ speed: rangeValue($event) })" />
                </span>
                <output>{{ theme.speed }}×</output>
              </span>
            </label>
            <div class="theme-code-heading">
              <span>{{ theme.code }}.js · uses your palette</span>
              <span>Read only here</span>
            </div>
            <pre class="theme-code" tabindex="0" aria-label="Animation code"><code>{{ animationCode }}</code></pre>
          </template>
        </template>
        <label class="theme-setting-row">
          <span>Soften<small>Canvas colour over it</small></span>
          <span class="theme-range-value">
            <span class="theme-range" :class="{ disabled: background === 'plain' }" :style="{ '--range-progress': theme.soften / 0.8 + '%' }">
              <span class="theme-range-track"></span>
              <input type="range" min="0" max="80" step="5" :disabled="background === 'plain'" :value="theme.soften" aria-label="Soften background" :aria-valuetext="theme.soften + '%'" @input="update({ soften: rangeValue($event) })" />
            </span>
            <output>{{ background === 'plain' ? "—" : theme.soften + "%" }}</output>
          </span>
        </label>
        <div class="theme-setting-row">
          <span>Dot grid</span>
          <button type="button" class="theme-switch" role="switch" :aria-checked="theme.dots" aria-label="Dot grid" @click="update({ dots: !theme.dots })"></button>
        </div>
      </section>

      <section class="appearance-section" aria-labelledby="appearance-motion-title">
        <h2 id="appearance-motion-title" class="appearance-section-heading">
          <Activity :size="14" :stroke-width="1.75" aria-hidden="true" />
          Motion
        </h2>
        <div class="theme-setting-row">
          <span>Preview reduced motion<small>Video and code backgrounds hold one still frame</small></span>
          <button type="button" class="theme-switch" role="switch" :aria-checked="reduced || systemReduced" :disabled="systemReduced" aria-label="Preview reduced motion" @click="emit('update:reduced', !reduced)"></button>
        </div>
        <p class="appearance-help motion-help">{{ systemReduced ? "Your system setting reduces motion." : "Off follows your system’s motion setting." }}</p>
      </section>
    </div>

    <p v-if="error" class="appearance-error" role="alert">{{ error }}</p>
    <footer class="appearance-footer">
      <span class="theme-change-status" aria-live="polite">
        <i v-if="dirty" aria-hidden="true"></i>
        {{ saving ? "Saving…" : !dirty ? "No changes" : changeCount ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : "Unsaved changes" }}
      </span>
      <button type="button" class="theme-action" :disabled="!dirty || saving" aria-keyshortcuts="Escape" @click="emit('discard')">
        Discard <kbd>Esc</kbd>
      </button>
      <button type="button" class="theme-action primary" :disabled="!dirty || saving" aria-keyshortcuts="Control+Enter Meta+Enter" @click="emit('apply')">
        Apply <kbd>Ctrl ↵</kbd>
      </button>
    </footer>
  </section>

  <Teleport to="body">
    <div v-if="colorEdit" ref="popover" class="select-popover theme-color-popover" :style="position" role="dialog" aria-label="Edit colour" @keydown="pickerKeys">
      <div class="theme-color-heading"><b>{{ colorEdit.label }}</b><span>Esc reverts</span></div>
      <div
        ref="saturationControl"
        class="theme-saturation"
        :style="{ background: `hsl(${hue} 100% 50%)` }"
        tabindex="0"
        role="slider"
        aria-label="Saturation and brightness"
        :aria-valuenow="Math.round(saturation * 100)"
        :aria-valuetext="`${Math.round(saturation * 100)}% saturation, ${Math.round(brightness * 100)}% brightness`"
        @keydown="adjustColorKey($event, 'saturation')"
        @pointerdown="adjustColorPointer($event, 'saturation')"
        @pointermove="adjustColorPointer($event, 'saturation')"
      >
        <span :style="{ left: saturation * 100 + '%', top: (1 - brightness) * 100 + '%', background: pickerColor }"></span>
      </div>
      <div
        class="theme-hue"
        tabindex="0"
        role="slider"
        aria-label="Hue"
        aria-valuemin="0"
        aria-valuemax="359"
        :aria-valuenow="Math.min(359, Math.round(hue))"
        @keydown="adjustColorKey($event, 'hue')"
        @pointerdown="adjustColorPointer($event, 'hue')"
        @pointermove="adjustColorPointer($event, 'hue')"
      >
        <span :style="{ left: hue / 360 * 100 + '%' }"></span>
      </div>
      <div class="theme-hex-row">
        <span class="color-swatch" :style="{ background: pickerColor }"></span>
        <input v-model="hexInput" type="text" class="theme-hex-input" aria-label="Hex colour" :aria-invalid="!normalizedHex" maxlength="7" spellcheck="false" @input="updateHex" />
      </div>
      <div class="theme-color-suggestions">
        From palette
        <button v-for="preset in THEME_PRESETS" :key="preset.id" type="button" :aria-label="`${preset.name} accent ${preset.palette.accent}`" :style="{ background: preset.palette.accent }" @click="suggestColor(preset.palette.accent)" />
      </div>
      <div class="theme-color-caption"><span><kbd>↑↓←→</kbd> adjust</span><span><kbd>↵</kbd> keep</span></div>
    </div>
  </Teleport>
</template>

<style scoped>
.appearance-settings,
.theme-color-popover {
  --appearance-app: #f7f9fa;
  --appearance-text: #455968;
  --appearance-strong: #273f50;
  --appearance-muted: #5d7381;
  --appearance-faint: #687d8a;
  --appearance-run: #365f78;
  --appearance-line: #e0e8ed;
  --appearance-border: #dbe5eb;
  --appearance-outline: #7b97a7;
  --appearance-pop: #d3dee5;
  --appearance-hover: #eef3f6;
  --appearance-selected: #e4edf2;
  --appearance-mono: "Cascadia Code", Consolas, monospace;
  color: var(--appearance-text);
  line-height: 1.5;
}

.appearance-settings {
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
  max-height: min(648px, calc(100dvh - 150px));
  background: var(--appearance-app);
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
}

.appearance-settings button,
.theme-color-popover button {
  padding: 0;
}

.appearance-settings button:focus-visible,
.theme-color-popover :is(button, [role="slider"]):focus-visible {
  outline: 2px solid var(--appearance-outline);
  outline-offset: 2px;
}

.appearance-settings kbd,
.theme-color-popover kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  font: 10.5px/1 var(--appearance-mono);
  color: var(--appearance-muted);
}

.appearance-heading {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 14px 14px 2px 12px;
}

.appearance-heading h1 {
  flex: 1;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--appearance-strong);
}

.appearance-icon {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: #556c7a;
}

.appearance-icon:hover {
  background: #e5ecf0;
}

.appearance-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 4px 20px 14px;
}

.appearance-help {
  margin: 4px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: #586c7a;
}

.appearance-section {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--appearance-line);
}

.appearance-section-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 26px;
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 550;
  color: #566c7a;
}

.appearance-section-heading span {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.theme-preset-steps button {
  display: flex;
  padding: 0;
  border-radius: 4px;
  cursor: pointer;
}

.theme-preset-steps button:hover kbd {
  background: var(--appearance-selected);
}

.theme-preset-steps button:focus-visible {
  outline: 2px solid var(--appearance-outline);
  outline-offset: 1px;
}

.theme-preset-sample.empty {
  display: grid;
  place-items: center;
  background: transparent;
  box-shadow: inset 0 0 0 1px #263f5526;
  color: var(--appearance-faint);
}

.theme-preset-sample.empty::before,
.theme-preset-sample.empty::after {
  display: none;
}

.theme-image-source {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid var(--appearance-line);
  border-radius: 9px;
}

.theme-image-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.theme-image-thumb {
  flex: none;
  width: 64px;
  height: 42px;
  border-radius: 6px;
  object-fit: cover;
}

.theme-image-name {
  flex: 1;
  min-width: 0;
}

.theme-image-name b {
  display: block;
  overflow: hidden;
  font: 500 11.5px var(--appearance-mono);
  color: var(--appearance-strong);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.theme-image-name small {
  font-size: 10.5px;
  color: var(--appearance-faint);
}

.theme-image-mood {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 9px;
}

.theme-image-mood span {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--appearance-hover);
  font-size: 10.5px;
  color: var(--appearance-muted);
}

.theme-image-raw {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 10.5px;
  color: var(--appearance-faint);
}

.theme-image-strip {
  flex: 1;
  display: flex;
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
}

.theme-image-label {
  margin-top: 12px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--appearance-faint);
}

.theme-tokens.with-why .theme-token {
  gap: 8px;
}

.theme-token-why {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-size: 10.5px;
  color: var(--appearance-faint);
  text-align: left;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.theme-strength {
  margin-top: 10px;
}

.theme-presets {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 6px;
}

.appearance-settings .theme-preset {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 2px 3px;
  border-radius: 7px;
  font-size: 10.5px;
  color: var(--appearance-muted);
}

.theme-preset:hover,
.theme-token:hover,
.theme-thumbnail:hover {
  background: var(--appearance-hover);
}

.theme-preset[aria-checked="true"],
.theme-thumbnail[aria-checked="true"] {
  background: var(--appearance-selected);
  color: var(--appearance-strong);
}

.theme-preset-sample {
  position: relative;
  width: min(42px, 100%);
  height: 30px;
  border-radius: 6px;
  background: var(--preset-canvas);
  box-shadow: inset 0 0 0 1px #263f5512;
}

.theme-preset-sample::before,
.theme-preset-sample::after {
  content: "";
  position: absolute;
}

.theme-preset-sample::before {
  inset: 7px 7px 0;
  border-radius: 4px 4px 0 0;
  background: var(--preset-app);
}

.theme-preset-sample::after {
  top: 12px;
  left: 12px;
  width: min(14px, calc(100% - 18px));
  height: 3px;
  border-radius: 2px;
  background: var(--preset-text);
  box-shadow: 0 6px 0 -0.5px var(--preset-accent);
}

.theme-preset .theme-preset-sample {
  align-self: stretch;
  margin-inline: auto;
}

.theme-preset[aria-checked="true"] .theme-preset-sample {
  box-shadow: inset 0 0 0 1px #263f5512, 0 0 0 1.5px var(--appearance-outline);
}

.theme-preset.custom .theme-preset-sample {
  background: conic-gradient(from 200deg, var(--preset-canvas), var(--preset-accent), var(--preset-run), var(--preset-text), var(--preset-canvas));
}

.theme-preset.custom .theme-preset-sample::before,
.theme-preset.custom .theme-preset-sample::after {
  display: none;
}

.theme-tokens {
  margin-top: 8px;
}

.appearance-settings .theme-token {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 30px;
  width: 100%;
  padding: 0 4px 0 2px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--appearance-text);
}

.theme-token span {
  display: flex;
  align-items: center;
  gap: 7px;
  font: 11px var(--appearance-mono);
  color: var(--appearance-muted);
}

.color-swatch {
  display: inline-block;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px #263f551f;
}

.theme-contrast {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding-left: 2px;
  font-size: 10.5px;
  color: var(--appearance-faint);
}

.theme-contrast svg {
  color: #4f7d5f;
}

.theme-contrast.low {
  color: #8a6a33;
}

.theme-contrast.low svg {
  color: #a27c3c;
}

.theme-background-types {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: #e8eff3;
}

.theme-background-types button {
  flex: 1;
  height: 24px;
  border-radius: 5px;
  font-size: 11.5px;
  color: var(--appearance-muted);
}

.theme-background-types button:hover {
  color: var(--appearance-strong);
}

.theme-background-types button[aria-checked="true"] {
  background: #fbfcfd;
  color: var(--appearance-strong);
  box-shadow: 0 1px 2px #263f5512;
}

.theme-background-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin-top: 10px;
}

.theme-background-radios {
  display: contents;
}

.appearance-settings .theme-thumbnail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  min-width: 0;
  padding: 3px;
  border-radius: 8px;
  text-align: left;
}

.theme-thumbnail-picture {
  position: relative;
  height: 52px;
  overflow: hidden;
  border-radius: 6px;
  background: #dfe7ec;
  box-shadow: inset 0 0 0 1px #263f5512;
}

.theme-thumbnail-picture img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.theme-thumbnail[aria-checked="true"] .theme-thumbnail-picture {
  box-shadow: 0 0 0 1.5px var(--appearance-outline);
}

.theme-thumbnail-name {
  overflow: hidden;
  padding: 0 2px;
  font-size: 11px;
  line-height: 1.2;
  color: var(--appearance-strong);
  white-space: nowrap;
  text-overflow: ellipsis;
}

.theme-thumbnail-detail {
  padding: 0 2px;
  font: 10px/1.2 var(--appearance-mono);
  color: var(--appearance-faint);
}

.theme-thumbnail.add .theme-thumbnail-picture,
.theme-thumbnail-picture.local {
  display: grid;
  place-items: center;
  color: var(--appearance-faint);
}

.theme-thumbnail.add .theme-thumbnail-picture {
  background: transparent;
  box-shadow: inset 0 0 0 1px #c9d6de;
}

.theme-duration {
  position: absolute;
  right: 4px;
  bottom: 4px;
  height: 15px;
  padding: 0 4px;
  border-radius: 4px;
  background: #263f50a6;
  font: 9.5px/15px var(--appearance-mono);
  color: #fff;
}

.theme-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 34px;
  font-size: 11.5px;
}

.theme-setting-row small {
  display: block;
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--appearance-faint);
}
.video-import { white-space: nowrap; }

.theme-range-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.theme-range-value output {
  min-width: 34px;
  text-align: right;
  font: 11px var(--appearance-mono);
  color: var(--appearance-muted);
}

.theme-range {
  position: relative;
  flex: none;
  width: 112px;
  height: 22px;
  border-radius: 7px;
}

.theme-range-track {
  position: absolute;
  inset: 8px 8px;
  border-radius: 3px;
  background: #e3ebf0;
  pointer-events: none;
}

.theme-range-track::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--range-progress);
  border-radius: inherit;
  background: linear-gradient(90deg, #d5e2ea, #a9c0ce);
}

.theme-range input {
  position: absolute;
  inset: 0;
  appearance: none;
  width: 100%;
  height: 22px;
  margin: 0;
  border-radius: inherit;
  background: transparent;
}
.theme-range input::-webkit-slider-runnable-track { background: transparent; border: 0; }
.theme-range input::-moz-range-track { background: transparent; border: 0; }

.theme-range input::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: radial-gradient(circle, var(--appearance-run) 3px, #fff 3px);
  box-shadow: 0 0 0 1.5px var(--appearance-run), 0 1px 3px #263f5530;
}

.theme-range input::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: radial-gradient(circle, var(--appearance-run) 3px, #fff 3px);
  box-shadow: 0 0 0 1.5px var(--appearance-run), 0 1px 3px #263f5530;
}

.theme-range.disabled {
  opacity: 0.5;
}

.theme-range input:disabled {
  cursor: default;
}

.theme-switch {
  position: relative;
  flex: none;
  width: 30px;
  height: 18px;
  border-radius: 9px;
  background: #d5e0e7;
}

.theme-switch::after {
  content: "";
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px #263f5530;
  transition: transform 0.16s ease-out;
}

.theme-switch[aria-checked="true"] {
  background: var(--appearance-run);
}

.theme-switch[aria-checked="true"]::after {
  transform: translateX(12px);
}

.motion-help {
  margin-top: 2px;
}

.theme-code-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 8px;
  font-size: 10.5px;
  color: var(--appearance-faint);
}

.theme-code {
  max-height: 120px;
  margin: 8px 0 0;
  overflow: auto;
  padding: 8px 10px;
  border: 1px solid var(--appearance-border);
  border-radius: 8px;
  background: #fbfcfd;
  font: 10.5px/1.55 var(--appearance-mono);
  color: var(--appearance-text);
}

.theme-code code {
  font: inherit;
}

.appearance-error {
  margin: 0;
  padding: 4px 20px 8px;
  font-size: 11px;
  color: #953f3c;
}

.appearance-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 12px 20px;
  border-top: 1px solid var(--appearance-line);
}

.theme-change-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--appearance-faint);
}

.theme-change-status i {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: #b08a4a;
}

.appearance-settings .theme-action {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--appearance-pop);
  border-radius: 7px;
  background: #fbfcfd;
  font-size: 12px;
  color: var(--appearance-strong);
}

.theme-action:hover:not(:disabled) {
  background: var(--appearance-hover);
}

.appearance-settings .theme-action.primary {
  border-color: var(--appearance-run);
  background: var(--appearance-run);
  color: #fff;
}

.theme-action.primary:hover:not(:disabled) {
  background: #2f5469;
}

.theme-action.primary kbd {
  border-color: #ffffff55;
  background: transparent;
  color: #e6eef3;
}

.theme-color-popover {
  width: min(232px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  padding: 10px;
  border: 1px solid var(--appearance-pop);
  border-radius: 10px;
  background: #fbfcfd;
  box-shadow: 0 1px 2px #263f5514, 0 12px 30px #263f5526;
}

.theme-color-heading,
.theme-color-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}

.theme-color-heading {
  margin: 0 2px 8px;
  font-size: 11px;
  color: var(--appearance-muted);
}

.theme-color-heading b {
  font-weight: 550;
  color: var(--appearance-strong);
}

.theme-saturation,
.theme-hue {
  position: relative;
  touch-action: none;
}

.theme-saturation {
  height: 120px;
  border-radius: 7px;
  cursor: crosshair;
}

.theme-saturation::before,
.theme-saturation::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  pointer-events: none;
}

.theme-saturation::before {
  background: linear-gradient(90deg, #fff, transparent);
}

.theme-saturation::after {
  background: linear-gradient(0deg, #000, transparent);
}

.theme-saturation span,
.theme-hue span {
  position: absolute;
  z-index: 1;
  pointer-events: none;
}

.theme-saturation span {
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: 50%;
  box-shadow: 0 0 0 2px #fff, 0 0 0 3px #263f5540;
}

.theme-hue {
  height: 12px;
  margin-top: 10px;
  border-radius: 6px;
  background: linear-gradient(90deg, red, #ff0, lime, cyan, blue, #f0f, red);
  cursor: pointer;
}

.theme-hue span {
  top: -2px;
  width: 8px;
  height: 16px;
  margin-left: -4px;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 0 0 1px #263f5540, 0 1px 3px #263f5530;
}

.theme-hex-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

.theme-hex-row .color-swatch {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}

input.theme-hex-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--appearance-border);
  border-radius: 7px;
  background: #fff;
  font: 11.5px var(--appearance-mono);
  color: var(--appearance-strong);
}

input.theme-hex-input:focus {
  border-color: var(--appearance-outline);
}

.theme-color-suggestions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  font-size: 10.5px;
  color: var(--appearance-faint);
}

.theme-color-suggestions button {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  box-shadow: inset 0 0 0 1px #263f551f;
}

.theme-color-caption {
  margin-top: 9px;
  font-size: 10.5px;
  color: var(--appearance-faint);
}

@media (max-width: 600px) {
  .appearance-settings {
    max-height: calc(100dvh - 135px);
  }
}

@media (max-width: 350px) {
  .theme-presets {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .appearance-body,
  .appearance-footer {
    padding-inline: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .theme-switch::after {
    transition: none;
  }
}
</style>
<style>
/* The panel takes the palette it previews (see "Workspace palettes" in
   style.css); the default palette keeps the values above. */
html.orvane-themed :is(.appearance-settings, .theme-color-popover) {
  --appearance-app: var(--shell-surface);
  --appearance-text: var(--shell-text);
  --appearance-strong: var(--shell-strong);
  --appearance-muted: var(--shell-muted);
  --appearance-faint: var(--shell-faint);
  --appearance-run: var(--theme-run);
  --appearance-line: var(--shell-line);
  --appearance-border: color-mix(in oklab, var(--theme-text) 17%, var(--theme-surface));
  --appearance-outline: var(--shell-focus);
  --appearance-pop: color-mix(in oklab, var(--theme-text) 20%, var(--theme-surface));
  --appearance-hover: var(--shell-hover);
  --appearance-selected: var(--shell-selected);
}
html.orvane-themed :is(.appearance-icon, .appearance-help, .appearance-section-heading) {
  color: var(--shell-muted);
}
html.orvane-themed .appearance-icon:hover {
  background: var(--shell-hover);
}
html.orvane-themed :is(.theme-background-types, .theme-range-track, .theme-thumbnail-picture) {
  background: var(--shell-field);
}
html.orvane-themed .theme-background-types button[aria-checked="true"] {
  background: color-mix(in oklab, var(--theme-surface) 55%, #fff);
}
html.orvane-themed .theme-range-track::after {
  background: linear-gradient(90deg, var(--shell-selected), color-mix(in oklab, var(--theme-accent) 60%, var(--theme-surface)));
}
html.orvane-themed .theme-switch:not([aria-checked="true"]) {
  background: color-mix(in oklab, var(--theme-text) 20%, var(--theme-surface));
}
</style>
