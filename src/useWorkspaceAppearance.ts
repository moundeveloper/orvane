import { computed, onBeforeUnmount, ref } from "vue";
import {
  addThemeMediaPreview, clearThemeMediaPreview, DEFAULT_THEME, MAX_THEME_MEDIA,
  THEME_COLORS, THEME_MEDIA_TYPES, themePaletteStyle, workspaceThemeSchema,
  type ThemeMediaKind, type WorkspaceTheme,
} from "./workspaceTheme.ts";

export function useWorkspaceAppearance(
  current: () => WorkspaceTheme | undefined,
  upload: (id: string, file: File) => Promise<void>,
  save: (theme: WorkspaceTheme) => Promise<void>,
) {
  const saved = computed(() => current() ?? DEFAULT_THEME);
  const draft = ref<WorkspaceTheme>();
  const theme = computed(() => draft.value ?? saved.value);
  const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== JSON.stringify(saved.value));
  const changeCount = computed(() => {
    if (!dirty.value) return 0;
    const current = theme.value;
    const original = saved.value;
    const colors = THEME_COLORS.filter(({ key }) => current.palette[key] !== original.palette[key]).length;
    const settings = (["backgroundType", "image", "video", "code", "soften", "dots", "speed"] as const)
      .filter((key) => current[key] !== original[key]).length;
    return Math.max(1, colors + settings);
  });
  const pending = new Map<string, File>();
  const selection = { image: 0, video: 0 };
  const systemMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const systemReduced = ref(systemMotion.matches);
  const previewReduced = ref(false);
  const reduced = computed(() => systemReduced.value || previewReduced.value);
  const saving = ref(false);
  const error = ref("");
  const paletteStyle = computed(() => themePaletteStyle(theme.value.palette));

  function systemMotionChanged(event: MediaQueryListEvent) {
    systemReduced.value = event.matches;
  }
  systemMotion.addEventListener("change", systemMotionChanged);

  function releasePreviews() {
    for (const id of pending.keys()) clearThemeMediaPreview(id);
    pending.clear();
  }
  function invalidateSelection() {
    selection.image++;
    selection.video++;
  }
  function discard() {
    if (saving.value) return;
    releasePreviews();
    invalidateSelection();
    draft.value = workspaceThemeSchema.parse(saved.value);
    error.value = "";
  }
  function close() {
    invalidateSelection();
    previewReduced.value = false;
    draft.value = undefined;
    error.value = "";
    if (!saving.value) releasePreviews();
  }
  onBeforeUnmount(() => {
    invalidateSelection();
    releasePreviews();
    systemMotion.removeEventListener("change", systemMotionChanged);
  });

  function update(theme: WorkspaceTheme) {
    if (!saving.value && draft.value) {
      draft.value = theme;
      error.value = "";
    }
  }
  async function importMedia(file: File, kind: ThemeMediaKind) {
    if (!draft.value || saving.value) return;
    const revision = ++selection[kind];
    const types: readonly string[] = THEME_MEDIA_TYPES[kind];
    if (!types.includes(file.type) || !file.size || file.size > MAX_THEME_MEDIA) {
      error.value = kind === "image"
        ? "Choose a JPG, PNG, WebP, or AVIF image up to 30 MB."
        : "Choose an MP4 or WebM video up to 30 MB.";
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      if (kind === "image") {
        const image = new Image();
        image.src = url;
        await image.decode();
      } else {
        await new Promise<void>((resolve, reject) => {
          const video = document.createElement("video");
          video.preload = "metadata";
          function finish(ok: boolean) {
            clearTimeout(timeout);
            video.onloadedmetadata = video.onerror = null;
            video.removeAttribute("src");
            video.load();
            if (ok) resolve();
            else reject(new Error("Unsupported video"));
          }
          const timeout = setTimeout(() => finish(false), 8000);
          video.onloadedmetadata = () => finish(video.videoWidth > 0);
          video.onerror = () => finish(false);
          video.src = url;
        });
      }
    } catch {
      if (revision === selection[kind]) error.value = "This background file could not be opened.";
      return;
    } finally {
      URL.revokeObjectURL(url);
    }
    if (!draft.value || saving.value || revision !== selection[kind]) return;
    const old = draft.value.media?.[kind]?.id;
    if (old && pending.delete(old)) clearThemeMediaPreview(old);
    const id = crypto.randomUUID();
    pending.set(id, file);
    addThemeMediaPreview(id, file);
    update({
      ...draft.value,
      backgroundType: kind,
      [kind]: id,
      media: { ...draft.value.media, [kind]: { id, name: file.name.slice(0, 200) } },
    });
  }
  async function apply() {
    if (!draft.value || !dirty.value || saving.value) return;
    saving.value = true;
    error.value = "";
    try {
      const value = workspaceThemeSchema.parse(draft.value);
      for (const [id, file] of pending) await upload(id, file);
      await save(value);
      releasePreviews();
      if (draft.value) draft.value = value;
    } catch (cause) {
      if (draft.value) error.value = cause instanceof Error ? cause.message : "Appearance could not be saved.";
    } finally {
      saving.value = false;
      if (!draft.value) releasePreviews();
    }
  }
  return { theme, dirty, changeCount, reduced, previewReduced, systemReduced, saving, error, paletteStyle, discard, close, update, importMedia, apply };
}
