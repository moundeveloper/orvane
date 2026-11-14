<script setup lang="ts">
// Image widget: shows one picture, stored by the local server (or a web
// address when the page would not let it be downloaded).
import { computed, ref } from "vue";
import Icon from "./Icon.vue";
import type { Block } from "../model";
import { imageSource, importDrop, mayHoldImage, type PlacedImage } from "../imageDrop";
import { api } from "./files/explorer";

const props = defineProps<{ block: Block; editing: boolean }>();
const src = computed(() => imageSource(props.block.value));
const broken = ref(false);
const busy = ref(false);
const error = ref("");
const over = ref(false);
const input = ref<HTMLInputElement>();
async function take(job: Promise<PlacedImage> | undefined) {
  if (!job) return;
  busy.value = true;
  error.value = "";
  try {
    const placed = await job;
    props.block.value = placed.value;
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
function picked() {
  const file = input.value?.files?.[0];
  if (!file) return;
  void take(
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).then((dataUrl) =>
      api<{ id: string; name: string }>("import-image", { dataUrl, name: file.name.replace(/\.[^.]+$/, "") }).then(
        (r) => ({ value: r.id, name: r.name }),
      ),
    ),
  );
  input.value!.value = "";
}
</script>
<template>
  <div
    class="image-widget"
    :class="{ over, empty: !src }"
    @dragover="dragover"
    @dragleave.self="over = false"
    @drop="drop"
  >
    <img
      v-if="src && !broken"
      :src="src"
      :alt="block.label"
      draggable="false"
      @error="broken = true"
    />
    <div v-else class="image-empty">
      <Icon name="image" :size="28" />
      <p v-if="busy">Placing the image…</p>
      <p v-else-if="broken">The image could not be loaded.</p>
      <p v-else>Drop an image here</p>
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
.image-widget img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
}
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
</style>
