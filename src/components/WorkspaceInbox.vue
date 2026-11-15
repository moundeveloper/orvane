<script setup lang="ts">
import { onMounted, ref } from "vue";
import { captureLink, CAPTURE_TEXT_LIMIT, type InboxCapture } from "../inbox";
import { imageSource } from "../imageDrop";
import Icon from "./Icon.vue";

defineProps<{
  captures: InboxCapture[];
  busy: boolean;
  editable: boolean;
  desktop: boolean;
  message: string;
}>();
const draft = defineModel<string>("draft", { required: true });
const emit = defineEmits<{
  close: [];
  save: [];
  "paste-image": [file: File];
  clipboard: [];
  move: [
    capture: InboxCapture,
    destination: "note" | "calendar" | "image" | "discard",
  ];
}>();

const dialog = ref<HTMLDialogElement>();
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
onMounted(() => dialog.value?.showModal());

function paste(event: ClipboardEvent) {
  const image = Array.from(event.clipboardData?.files ?? []).find((file) =>
    file.type.startsWith("image/"),
  );
  if (!image) return;
  event.preventDefault();
  emit("paste-image", image);
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="workspace-inbox"
      aria-labelledby="inbox-title"
      @close="emit('close')"
      @keydown.stop
      @wheel.stop
    >
      <header class="inbox-header">
        <h2 id="inbox-title">Workspace inbox</h2>
        <button
          type="button"
          class="icon-button"
          aria-label="Close inbox"
          @click="dialog?.close()"
        >
          <Icon name="close" />
        </button>
      </header>
      <form class="inbox-compose" @submit.prevent="emit('save')">
        <label for="inbox-draft">New capture</label>
        <textarea
          id="inbox-draft"
          v-model="draft"
          autofocus
          rows="3"
          :maxlength="CAPTURE_TEXT_LIMIT"
          :readonly="busy || !editable"
          placeholder="Type a note or paste text, a link, or an image"
          @paste.stop="paste"
        ></textarea>
        <div class="inbox-actions">
          <button
            type="submit"
            class="subtle-button"
            :disabled="busy || !editable || !draft.trim()"
          >
            <Icon name="plus" :size="14" />Save capture
          </button>
          <button
            v-if="desktop"
            type="button"
            class="subtle-button"
            :disabled="busy || !editable"
            @click="emit('clipboard')"
          >
            Capture clipboard
          </button>
        </div>
      </form>
      <p v-if="message" class="inbox-feedback" role="status">{{ message }}</p>
      <p v-if="!editable" class="inbox-feedback">
        Capture and triage are available in the editing window.
      </p>
      <p v-if="!captures.length" class="inbox-feedback">No captures yet.</p>
      <ul v-else class="inbox-captures" aria-label="Captures">
        <li v-for="capture in captures" :key="capture.id">
          <div class="inbox-meta">
            <span>{{
              capture.kind === "image"
                ? "Image"
                : captureLink(capture.value)
                  ? "Link"
                  : "Text"
            }}</span>
            <time :datetime="new Date(capture.capturedAt).toISOString()">{{
              dateFormat.format(capture.capturedAt)
            }}</time>
          </div>
          <img
            v-if="capture.kind === 'image'"
            :src="imageSource(capture.value)"
            alt="Captured clipboard image"
            loading="lazy"
          />
          <details v-else-if="capture.value.length > 240">
            <summary class="inbox-text">
              {{ capture.value.slice(0, 240) }}…
            </summary>
            <p class="inbox-text">{{ capture.value }}</p>
          </details>
          <p v-else class="inbox-text">{{ capture.value }}</p>
          <div class="inbox-actions">
            <template v-if="capture.kind === 'text'">
              <button
                type="button"
                class="subtle-button"
                :disabled="busy || !editable"
                @click="emit('move', capture, 'note')"
              >
                Sticky note
              </button>
              <button
                type="button"
                class="subtle-button"
                :disabled="busy || !editable"
                @click="emit('move', capture, 'calendar')"
              >
                Calendar today
              </button>
            </template>
            <button
              v-else
              type="button"
              class="subtle-button"
              :disabled="busy || !editable"
              @click="emit('move', capture, 'image')"
            >
              Place on canvas
            </button>
            <button
              type="button"
              class="icon-button inbox-discard"
              aria-label="Discard capture"
              title="Discard capture"
              :disabled="busy || !editable"
              @click="emit('move', capture, 'discard')"
            >
              <Icon name="trash" :size="14" />
            </button>
          </div>
        </li>
      </ul>
    </dialog>
  </Teleport>
</template>

<style scoped>
.workspace-inbox {
  width: min(560px, calc(100vw - 40px));
  max-height: calc(100dvh - 70px);
  padding: 20px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid rgb(68 92 106 / 19%);
  border-radius: 14px;
  background: #f5f8fa;
  color: #243b49;
  font: inherit;
  box-shadow: 0 22px 60px rgb(26 43 55 / 22%);
}
.workspace-inbox::backdrop {
  background: rgb(49 68 81 / 22%);
  backdrop-filter: blur(4px);
}
.inbox-header,
.inbox-meta,
.inbox-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inbox-header,
.inbox-meta {
  justify-content: space-between;
}
.inbox-header h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 620;
}
.inbox-compose {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}
.inbox-compose label {
  font-size: 12px;
  font-weight: 600;
}
.inbox-compose textarea {
  width: 100%;
  min-height: 76px;
  max-height: 240px;
  padding: 9px 10px;
  resize: vertical;
  border: 1px solid #c5d2d9;
  border-radius: 7px;
  background: #fff;
  color: inherit;
  font: inherit;
}
.inbox-actions {
  flex-wrap: wrap;
}
.inbox-captures {
  display: grid;
  gap: 8px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.inbox-captures li {
  display: grid;
  gap: 9px;
  padding: 12px;
  border: 1px solid #dbe4e9;
  border-radius: 8px;
  background: #fff;
}
.inbox-feedback,
.inbox-meta {
  font-size: 12px;
  color: #526b79;
}
.inbox-meta > span {
  font-weight: 650;
}
.inbox-text {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
details > p {
  margin-top: 8px;
}
.inbox-captures img {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: 200px;
  border-radius: 5px;
}
.inbox-discard {
  margin-left: auto;
}
</style>
