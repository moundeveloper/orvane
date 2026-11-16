<script setup lang="ts">
import { computed, inject, ref } from "vue";
import type { Block } from "../model";
import { imageSource } from "../imageDrop";
import {
  readWidget,
  REFRESH_BROWSER_CLIP,
  workbenchEditable,
  type BrowserClip,
  type BrowserClipRequest,
} from "../workbenchWidgets";
import Icon from "./Icon.vue";
import LiveClip from "./LiveClip.vue";

const props = defineProps<{ block: Block }>();
const editable = inject(workbenchEditable);
const clip = computed(() => readWidget<BrowserClip>(props.block.value));
const busy = ref(false),
  message = ref("");
const sourceUrl = computed(() =>
  typeof clip.value.url === "string" && /^https?:\/\//i.test(clip.value.url)
    ? clip.value.url
    : "",
);
function openOriginal() {
  if (!sourceUrl.value) return;
  window.dispatchEvent(
    new CustomEvent("orvane:open-link", {
      detail: {
        external: true,
        sourceBlockId: clip.value.blockId,
        link: { kind: "page", target: sourceUrl.value, label: sourceUrl.value },
      },
    }),
  );
}
async function refresh() {
  if (!editable?.() || busy.value || !sourceUrl.value || !clip.value.rect)
    return;
  const before = props.block.value;
  const request = { ...clip.value } as BrowserClipRequest;
  busy.value = true;
  message.value = "";
  try {
    window.dispatchEvent(
      new CustomEvent(REFRESH_BROWSER_CLIP, { detail: request }),
    );
    if (!request.respond) {
      request.anySource = true;
      window.dispatchEvent(
        new CustomEvent(REFRESH_BROWSER_CLIP, { detail: request }),
      );
    }
    if (!request.respond)
      throw Error(
        "Open the original page in its Orvane Browser app, then refresh this clip.",
      );
    const image = await request.respond;
    if (editable() && props.block.value === before) {
      props.block.value = JSON.stringify({ ...clip.value, image });
      message.value = "Clip refreshed.";
    }
  } catch (error) {
    message.value =
      error instanceof Error ? error.message : "The clip could not refresh.";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <LiveClip v-if="clip.mode === 'live'" :block="block" />
  <div v-else class="workbench-widget live-clip">
    <div class="workbench-actions">
      <button
        type="button"
        class="subtle-button"
        :disabled="!editable?.() || busy || !sourceUrl"
        @click="refresh"
      >
        <Icon name="refresh" :size="14" />{{
          busy ? "Refreshing…" : "Refresh clip"
        }}
      </button>
      <button
        type="button"
        class="subtle-button"
        :disabled="!sourceUrl"
        @click="openOriginal"
      >
        <Icon name="external" :size="14" />Open original
      </button>
      <span v-if="sourceUrl" class="clip-url" :title="sourceUrl">{{
        sourceUrl
      }}</span>
    </div>
    <p v-if="message" class="workbench-status" role="status">{{ message }}</p>
    <img
      v-if="typeof clip.image === 'string' && imageSource(clip.image)"
      :src="imageSource(clip.image)"
      alt="Clipped area of the source page"
    />
    <p v-else>Pin an area from a page in Orvane Browser.</p>
  </div>
</template>

<style scoped>
.live-clip img {
  display: block;
  width: 100%;
  max-height: 80vh;
  object-fit: contain;
  object-position: top left;
}
.clip-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 120px;
  color: #526b79;
}
</style>
