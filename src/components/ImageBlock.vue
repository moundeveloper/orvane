<script setup lang="ts">
// Image widget: one picture with rotate, crop, caption and frame tools.
// Pictures are stored by the local server (block.value is the image id, or a
// web address when a page would not let it be downloaded). Rotate and crop
// produce a new stored image; the original id is kept in the settings so
// Reset restores it. Settings live in block.code as JSON.
import { computed, nextTick, ref } from "vue";
import Icon from "./Icon.vue";
import type { Block } from "../model";
import { IMAGE_ID, imageSource, importDrop, mayHoldImage, type PlacedImage } from "../imageDrop";
import { api } from "./files/explorer";

type Frame = "none" | "border" | "polaroid" | "shadow" | "rounded";
type Settings = { original?: string; caption?: string; frame?: Frame };
const FRAMES: { id: Frame; label: string }[] = [
  { id: "none", label: "No frame" },
  { id: "border", label: "Mat border" },
  { id: "polaroid", label: "Polaroid" },
  { id: "shadow", label: "Shadow" },
  { id: "rounded", label: "Rounded" },
];
const props = defineProps<{ block: Block; editing: boolean }>();
function readSettings(): Settings {
  try {
    const value = JSON.parse(props.block.code || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const settings = ref<Settings>(readSettings());
function save(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  props.block.code = JSON.stringify(settings.value);
}
const src = computed(() => imageSource(props.block.value));
const stored = computed(() => IMAGE_ID.test(props.block.value));
const frame = computed<Frame>(() => settings.value.frame ?? "none");
const broken = ref(false);
const busy = ref(false);
const error = ref("");
const over = ref(false);
const input = ref<HTMLInputElement>();

// ---- Filling an empty widget ----
async function take(job: Promise<PlacedImage> | undefined) {
  if (!job) return;
  busy.value = true;
  error.value = "";
  try {
    const placed = await job;
    props.block.value = placed.value;
    save({ original: undefined });
    if (!props.block.label || props.block.label === "Image") props.block.label = placed.name;
    broken.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
function dragover(event: DragEvent) {
  if (!mayHoldImage(event.dataTransfer)) return;
  event.preventDefault();
  event.stopPropagation();
  over.value = true;
}
function drop(event: DragEvent) {
  over.value = false;
  if (!event.dataTransfer) return;
  event.preventDefault();
  event.stopPropagation();
  const { jobs } = importDrop(event.dataTransfer);
  if (!jobs.length) error.value = "Drop an image file or an image from a web page.";
  void take(jobs[0]);
}
function readFile(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
function picked() {
  const file = input.value?.files?.[0];
  if (!file) return;
  void take(
    readFile(file).then((dataUrl) =>
      api<{ id: string; name: string }>("import-image", { dataUrl, name: file.name.replace(/\.[^.]+$/, "") }).then(
        (r) => ({ value: r.id, name: r.name }),
      ),
    ),
  );
  input.value!.value = "";
}

// ---- Editing: everything is drawn on a canvas and stored as a new image ----
function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("The image could not be read for editing."));
    img.src = url;
  });
}
async function transform(draw: (img: HTMLImageElement) => HTMLCanvasElement) {
  if (!stored.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const img = await loadImage(src.value);
    const canvas = draw(img);
    const jpeg = /\.jpg$/.test(props.block.value);
    const dataUrl = canvas.toDataURL(jpeg ? "image/jpeg" : "image/png", 0.92);
    const result = await api<{ id: string }>("import-image", { dataUrl, name: props.block.label });
    if (!settings.value.original) save({ original: props.block.value });
    props.block.value = result.id;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
function rotate(quarter: 1 | -1) {
  void transform((img) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalHeight;
    canvas.height = img.naturalWidth;
    const g = canvas.getContext("2d")!;
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((quarter * Math.PI) / 2);
    g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    return canvas;
  });
}
function flip() {
  void transform((img) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext("2d")!;
    g.translate(canvas.width, 0);
    g.scale(-1, 1);
    g.drawImage(img, 0, 0);
    return canvas;
  });
}
function reset() {
  if (!settings.value.original) return;
  props.block.value = settings.value.original;
  save({ original: undefined });
}

// ---- Crop: a rectangle in fractions of the picture ----
const cropping = ref(false);
const crop = ref({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
const cropBox = ref<HTMLElement>();
function startCrop() {
  crop.value = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  cropping.value = true;
  menuOpen.value = false;
}
function dragCrop(event: PointerEvent, handle: "move" | "nw" | "ne" | "sw" | "se") {
  const box = cropBox.value?.getBoundingClientRect();
  if (!box) return;
  event.preventDefault();
  event.stopPropagation();
  const start = { ...crop.value },
    sx = event.clientX,
    sy = event.clientY;
  const MIN = 0.04;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const move = (e: PointerEvent) => {
    // Bounding-box fractions stay correct at any canvas zoom.
    const dx = (e.clientX - sx) / box.width,
      dy = (e.clientY - sy) / box.height;
    let { x, y, w, h } = start;
    if (handle === "move") {
      x = clamp(x + dx, 0, 1 - w);
      y = clamp(y + dy, 0, 1 - h);
    } else {
      if (handle.includes("w")) {
        const nx = clamp(x + dx, 0, x + w - MIN);
        w += x - nx;
        x = nx;
      }
      if (handle.includes("e")) w = clamp(w + dx, MIN, 1 - x);
      if (handle.includes("n")) {
        const ny = clamp(y + dy, 0, y + h - MIN);
        h += y - ny;
        y = ny;
      }
      if (handle.includes("s")) h = clamp(h + dy, MIN, 1 - y);
    }
    crop.value = { x, y, w, h };
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
}
function applyCrop() {
  const c = crop.value;
  cropping.value = false;
  void transform((img) => {
    const canvas = document.createElement("canvas");
    const sx = Math.round(c.x * img.naturalWidth),
      sy = Math.round(c.y * img.naturalHeight);
    canvas.width = Math.max(1, Math.round(c.w * img.naturalWidth));
    canvas.height = Math.max(1, Math.round(c.h * img.naturalHeight));
    canvas.getContext("2d")!.drawImage(img, sx, sy, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  });
}
function cropKeys(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === "Enter") (event.preventDefault(), applyCrop());
  else if (event.key === "Escape") (event.preventDefault(), (cropping.value = false));
}

// ---- Caption and frame ----
const captionInput = ref<HTMLInputElement>();
const editingCaption = ref(false);
function editCaption() {
  editingCaption.value = true;
  menuOpen.value = false;
  void nextTick(() => captionInput.value?.focus());
}
function commitCaption(event: Event) {
  save({ caption: (event.target as HTMLInputElement).value.trim() || undefined });
  editingCaption.value = false;
}
const menuOpen = ref(false);
function escapeMenu(event: KeyboardEvent) {
  if (!menuOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  menuOpen.value = false;
}
function setFrame(id: Frame) {
  save({ frame: id === "none" ? undefined : id });
  menuOpen.value = false;
}
</script>
<template>
  <div
    class="image-widget"
    :class="[{ over, empty: !src }, `frame-${frame}`]"
    @dragover="dragover"
    @dragleave.self="over = false"
    @drop="drop"
    @keydown.esc="escapeMenu"
  >
    <template v-if="src && !broken">
      <figure class="image-figure">
        <div v-if="cropping" class="crop-stage" tabindex="-1" @keydown="cropKeys">
          <div ref="cropBox" class="crop-box">
            <img :src="src" :alt="block.label" draggable="false" />
            <div class="crop-shade" :style="{ clipPath: `polygon(0 0,100% 0,100% 100%,0 100%,0 0,${crop.x * 100}% ${crop.y * 100}%,${crop.x * 100}% ${(crop.y + crop.h) * 100}%,${(crop.x + crop.w) * 100}% ${(crop.y + crop.h) * 100}%,${(crop.x + crop.w) * 100}% ${crop.y * 100}%,${crop.x * 100}% ${crop.y * 100}%)` }"></div>
            <div
              class="crop-rect"
              :style="{ left: crop.x * 100 + '%', top: crop.y * 100 + '%', width: crop.w * 100 + '%', height: crop.h * 100 + '%' }"
              @pointerdown="dragCrop($event, 'move')"
            >
              <i v-for="h in ['nw', 'ne', 'sw', 'se'] as const" :key="h" :class="h" @pointerdown="dragCrop($event, h)"></i>
            </div>
          </div>
        </div>
        <img v-else class="image-main" :src="src" :alt="block.label" draggable="false" @error="broken = true" />
        <figcaption v-if="editingCaption || settings.caption" @dblclick="editCaption">
          <input
            v-if="editingCaption"
            ref="captionInput"
            :value="settings.caption ?? ''"
            placeholder="Add a caption…"
            aria-label="Caption"
            @keydown.enter.prevent="commitCaption"
            @keydown.esc.prevent="editingCaption = false"
            @keydown.stop
            @blur="commitCaption"
          />
          <template v-else>{{ settings.caption }}</template>
        </figcaption>
      </figure>
      <div v-if="cropping" class="image-tools always">
        <button type="button" class="primary" @click="applyCrop"><Icon name="check" :size="13" />Crop</button
        ><button type="button" @click="cropping = false">Cancel</button>
      </div>
      <div v-else class="image-tools" :class="{ always: menuOpen || busy }">
        <span v-if="busy" class="image-spinner" title="Saving…"></span>
        <template v-if="stored">
          <button type="button" title="Rotate left" aria-label="Rotate left" :disabled="busy" @click="rotate(-1)">
            <Icon name="undo" :size="13" /></button
          ><button type="button" title="Rotate right" aria-label="Rotate right" :disabled="busy" @click="rotate(1)">
            <Icon name="undo" :size="13" class="mirror" /></button
          ><button type="button" title="Flip horizontally" aria-label="Flip horizontally" :disabled="busy" @click="flip">
            <Icon name="swap" :size="13" /></button
          ><button type="button" title="Crop" aria-label="Crop" :disabled="busy" @click="startCrop">
            <Icon name="crop" :size="13" />
          </button>
        </template>
        <button type="button" title="Caption" aria-label="Caption" @click="editCaption">
          <Icon name="text" :size="13" /></button
        ><button type="button" title="Frame" aria-label="Frame" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
          <Icon name="box" :size="13" />
        </button>
        <button v-if="settings.original" type="button" title="Reset to the original" aria-label="Reset to the original" @click="reset">
          <Icon name="refresh" :size="13" />
        </button>
        <div v-if="menuOpen" class="image-menu" role="menu">
          <button
            v-for="f in FRAMES"
            :key="f.id"
            role="menuitemradio"
            :aria-checked="frame === f.id"
            @click="setFrame(f.id)"
          >
            {{ f.label }}<Icon v-if="frame === f.id" name="check" :size="12" />
          </button>
        </div>
      </div>
      <p v-if="error" class="image-error floating">{{ error }}</p>
    </template>
    <div v-else class="image-empty">
      <Icon name="image" :size="28" />
      <p v-if="busy">Placing the image…</p>
      <p v-else-if="broken">The image could not be loaded.</p>
      <p v-else>Drop or paste an image here</p>
      <button type="button" :disabled="busy" @click="input?.click()">Choose image…</button>
      <p v-if="error" class="image-error">{{ error }}</p>
    </div>
    <input ref="input" type="file" accept="image/*" hidden @change="picked" />
  </div>
</template>
<style>
.app-content:has(> .block-image:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-image {
  display: flex;
  flex: 1;
  min-height: 120px;
}
.block-image:not(:only-child) {
  height: 280px;
}
</style>
<style scoped>
.image-widget {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  align-items: center;
  justify-content: center;
}
.image-widget.over {
  box-shadow: inset 0 0 0 2px #6f9ab0;
  background: #eef5f8;
}
.image-figure {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  margin: 0;
}
.image-main {
  flex: 1;
  min-height: 0;
  width: 100%;
  object-fit: contain;
  user-select: none;
}
figcaption {
  flex: none;
  width: 100%;
  padding: 6px 12px 8px;
  color: #455968;
  font-size: 12px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
figcaption input {
  width: 100%;
  padding: 3px 6px;
  border: 0;
  border-radius: 4px;
  background: #edf3f6;
  color: inherit;
  font: inherit;
  text-align: center;
  outline: none;
}
/* Frames */
.frame-border .image-figure {
  padding: 14px;
  background: #fff;
  box-shadow: inset 0 0 0 1px #d9e3e8;
}
.frame-polaroid .image-figure {
  padding: 12px 12px 4px;
  background: #fffdf8;
}
.frame-polaroid .image-main {
  box-shadow: 0 0 0 1px #e8e2d6;
}
.frame-polaroid figcaption {
  padding: 10px 8px 14px;
  font-family: "Segoe Print", "Bradley Hand", cursive;
  font-size: 13px;
}
.frame-shadow .image-figure {
  padding: 18px;
}
.frame-shadow .image-main {
  filter: drop-shadow(0 10px 18px rgb(39 63 78 / 28%));
}
.frame-rounded .image-figure {
  padding: 10px;
}
.frame-rounded .image-main {
  border-radius: 14px;
  /* Rounds the picture itself, not its letterbox. */
  object-fit: cover;
}
/* Tools */
.image-tools {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: #f8fafbeb;
  box-shadow: 0 2px 8px rgb(60 83 96 / 14%);
  opacity: 0;
  transition: opacity 0.15s;
}
.image-widget:hover .image-tools,
.image-tools:focus-within,
.image-tools.always {
  opacity: 1;
}
.image-tools button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 26px;
  height: 26px;
  padding: 0 6px;
  border-radius: 4px;
  background: none;
  color: #607583;
  font-size: 12px;
}
.image-tools button:hover:not(:disabled) {
  background: #e3edf2;
}
.image-tools button.primary {
  background: #4f7b93;
  color: #fff;
}
.image-tools .mirror {
  transform: scaleX(-1);
}
.image-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  width: 150px;
  padding: 4px;
  border: 1px solid #dce5e9;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 8px 22px #425c6b2e;
}
.image-menu button {
  justify-content: space-between;
  width: 100%;
  padding: 6px 8px;
  color: #455968;
}
.image-spinner {
  width: 12px;
  height: 12px;
  margin: 0 6px;
  border: 2px solid #c7d6dd;
  border-top-color: #557a8e;
  border-radius: 50%;
  animation: image-spin 0.8s linear infinite;
}
@keyframes image-spin {
  to {
    transform: rotate(360deg);
  }
}
/* Crop */
.crop-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 10px;
  outline: none;
}
.crop-box {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  max-height: 100%;
  touch-action: none;
}
.crop-box img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  min-height: 0;
  object-fit: contain;
  user-select: none;
}
.crop-shade {
  position: absolute;
  inset: 0;
  background: rgb(30 42 49 / 45%);
  pointer-events: none;
}
.crop-rect {
  position: absolute;
  box-shadow: 0 0 0 1px #fff, 0 0 0 2px rgb(30 42 49 / 40%);
  cursor: move;
  background-image:
    linear-gradient(to right, transparent 33%, #ffffff66 33%, #ffffff66 calc(33% + 1px), transparent calc(33% + 1px), transparent 66%, #ffffff66 66%, #ffffff66 calc(66% + 1px), transparent calc(66% + 1px)),
    linear-gradient(to bottom, transparent 33%, #ffffff66 33%, #ffffff66 calc(33% + 1px), transparent calc(33% + 1px), transparent 66%, #ffffff66 66%, #ffffff66 calc(66% + 1px), transparent calc(66% + 1px));
}
.crop-rect i {
  position: absolute;
  width: 12px;
  height: 12px;
  border: 2px solid #fff;
  background: #4f7b93;
  border-radius: 2px;
}
.crop-rect .nw { left: -6px; top: -6px; cursor: nwse-resize; }
.crop-rect .ne { right: -6px; top: -6px; cursor: nesw-resize; }
.crop-rect .sw { left: -6px; bottom: -6px; cursor: nesw-resize; }
.crop-rect .se { right: -6px; bottom: -6px; cursor: nwse-resize; }
/* Empty state */
.image-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: #8798a3;
  font-size: 12px;
  text-align: center;
}
.image-empty p {
  margin: 0;
}
.image-empty button {
  padding: 5px 11px;
  border-radius: 5px;
  background: #e7edf0;
  color: #455968;
  font-size: 12px;
}
.image-error {
  color: #a5603d;
}
.image-error.floating {
  position: absolute;
  left: 8px;
  bottom: 8px;
  margin: 0;
  padding: 5px 9px;
  border-radius: 5px;
  background: #fff;
  font-size: 11px;
}
</style>
