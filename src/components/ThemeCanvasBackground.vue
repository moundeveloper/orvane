<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getThemeMediaUrl, THEME_BACKGROUNDS, type WorkspaceTheme } from "../workspaceTheme.ts";
import { themeRgba } from "../themeFrame.ts";
import { draw as dots } from "../themeAnimation-dots.ts";
import { draw as flow } from "../themeAnimation-flow.ts";
import { draw as aurora } from "../themeAnimation-aurora.ts";

const props = defineProps<{ theme: WorkspaceTheme; reduced: boolean }>();
const video = ref<HTMLVideoElement>();
const canvas = ref<HTMLCanvasElement>();
const visible = ref(document.visibilityState === "visible");
const animations = { dots, flow, aurora };
let elapsed = 2;

const image = computed(() => {
  const { image, media } = props.theme;
  return media?.image?.id === image
    ? getThemeMediaUrl(image)
    : THEME_BACKGROUNDS.image.find((option) => option.id === image)?.poster;
});
const videoOption = computed(() => THEME_BACKGROUNDS.video.find((option) => option.id === props.theme.video));
const videoSource = computed(() => {
  const { video, media } = props.theme;
  return media?.video?.id === video ? getThemeMediaUrl(video) : videoOption.value?.source;
});
function visibilityChanged() {
  visible.value = document.visibilityState === "visible";
}
onMounted(() => document.addEventListener("visibilitychange", visibilityChanged));
onBeforeUnmount(() => document.removeEventListener("visibilitychange", visibilityChanged));

watch([video, visible, () => props.reduced, videoSource], ([element, shown, reduced], _, clean) => {
  if (!element) return;
  if (shown && !reduced) void element.play().catch(() => {});
  else element.pause();
  clean(() => element.pause());
}, { flush: "post" });

watch([canvas, visible, () => props.reduced], ([element, shown, reduced], _, clean) => {
  const ctx = element?.getContext("2d");
  if (!element || !ctx) return;
  let frame = 0;
  let previous = 0;
  let width = 0;
  let height = 0;
  function paint() {
    animations[props.theme.code](ctx!, width, height, elapsed, { ...props.theme.palette, rgba: themeRgba });
  }
  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = element!.clientWidth;
    height = element!.clientHeight;
    if (!width || !height) return;
    element!.width = Math.round(width * ratio);
    element!.height = Math.round(height * ratio);
    ctx!.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint();
  }
  function tick(now: number) {
    if (now - previous >= 32) {
      if (previous) elapsed += Math.min(0.1, (now - previous) / 1000) * props.theme.speed;
      previous = now;
      paint();
    }
    frame = requestAnimationFrame(tick);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(element);
  const repaint = watch(() => [props.theme.palette, props.theme.code], paint);
  if (shown && !reduced) frame = requestAnimationFrame(tick);
  clean(() => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    repaint();
  });
}, { flush: "post" });
</script>

<template>
  <div v-if="theme.backgroundType !== 'plain'" class="theme-wallpaper" aria-hidden="true">
    <div
      v-if="theme.backgroundType === 'image' && image"
      class="wallpaper-image"
      :class="{ tiled: theme.image === 'paper' }"
      :style="{ backgroundImage: `url('${image}')` }"
    />
    <video
      v-else-if="theme.backgroundType === 'video' && videoSource"
      ref="video"
      :key="videoSource"
      :src="videoSource"
      :poster="videoOption?.poster"
      muted loop playsinline
      :preload="visible ? 'auto' : 'none'"
    />
    <canvas v-else-if="theme.backgroundType === 'code'" ref="canvas" />
    <div class="wallpaper-veil" :style="{ opacity: theme.soften / 100 }" />
  </div>
</template>

<style scoped>
.theme-wallpaper, .theme-wallpaper > * { position: absolute; inset: 0; pointer-events: none; width: 100%; height: 100%; }
.wallpaper-image { background-position: center; background-size: cover; background-repeat: no-repeat; }
.wallpaper-image.tiled { background-size: 120px; background-repeat: repeat; }
.theme-wallpaper video { object-fit: cover; }
.wallpaper-veil { background: var(--theme-canvas, #e9edf0); }
</style>
