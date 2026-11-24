<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import type { AgentAnswer, AgentQuestion } from "../agentSessions";

// Claude's AskUserQuestion shown as questions (UI Maker "Agent questions",
// variant Claude asks): one tab per question, options picked by click or
// number key, "Other" text, an optional note and the option's preview.
const props = defineProps<{ questions: AgentQuestion[]; who: string; busy?: boolean }>();
const emit = defineEmits<{ answer: [AgentAnswer]; skip: [] }>();

const at = ref(0);
const picks = reactive(props.questions.map(() => new Set<number>()));
const other = reactive(props.questions.map(() => ""));
const notes = reactive(props.questions.map(() => ""));
const focusOn = reactive(props.questions.map(() => 0));
const root = ref<HTMLElement>();
const otherField = ref<HTMLInputElement>();

const current = computed(() => props.questions[at.value]!);
const answered = (index: number) => picks[index]!.size > 0 || other[index]!.trim() !== "";
const done = computed(() => props.questions.filter((_, index) => answered(index)).length);
const complete = computed(() => done.value === props.questions.length);
const last = computed(() => at.value === props.questions.length - 1);
const hovered = computed(() => current.value.options[focusOn[at.value]!]);
const preview = computed(() => (!current.value.multiSelect && hovered.value?.preview) || "");

function pick(index: number) {
  const question = current.value;
  if (index === question.options.length) return otherField.value?.focus();
  if (!question.options[index]) return;
  const set = picks[at.value]!;
  focusOn[at.value] = index;
  if (question.multiSelect) {
    if (set.has(index)) set.delete(index);
    else set.add(index);
  } else {
    set.clear();
    set.add(index);
    other[at.value] = "";
  }
}
function typedOther(value: string) {
  other[at.value] = value;
  // A typed answer replaces a single choice; multi-select keeps both.
  if (value && !current.value.multiSelect) picks[at.value]!.clear();
}
function go(step: number) {
  at.value = Math.max(0, Math.min(props.questions.length - 1, at.value + step));
  // The focused option is redrawn for the new question: keep the keys here.
  void nextTick(() => {
    if (!root.value?.contains(document.activeElement)) root.value?.focus({ preventScroll: true });
  });
}
function send() {
  if (!complete.value || props.busy) return;
  const answers: Record<string, string> = {};
  const annotations: NonNullable<AgentAnswer["annotations"]> = {};
  props.questions.forEach((question, index) => {
    const labels = [...picks[index]!].sort((a, b) => a - b).map((i) => question.options[i]!.label);
    const typed = other[index]!.trim();
    answers[question.question] = [...labels, ...(typed ? [typed] : [])].join(", ");
    const note = notes[index]!.trim();
    const chosen = !question.multiSelect && labels.length ? question.options[[...picks[index]!][0]!]?.preview : undefined;
    if (note || chosen) annotations[question.question] = { ...(note ? { notes: note } : {}), ...(chosen ? { preview: chosen } : {}) };
  });
  emit("answer", { answers, ...(Object.keys(annotations).length ? { annotations } : {}) });
}
function next() {
  // Enter moves on; on the last question (or once all are answered) it sends.
  if (last.value || complete.value) send();
  else go(1);
}
function key(event: KeyboardEvent) {
  const typing = (event.target as Element | null)?.closest("input");
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    return send();
  }
  if (typing) {
    if (event.key === "Escape") {
      event.stopPropagation();
      root.value?.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      next();
    }
    return;
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (/^[1-9]$/.test(event.key)) {
    event.preventDefault();
    pick(Number(event.key) - 1);
  } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    go(event.key === "ArrowRight" ? 1 : -1);
  } else if (event.key === "Enter" && !(event.target as Element | null)?.closest("button")) {
    event.preventDefault();
    next();
  }
}
defineExpose({ focus: () => root.value?.focus() });
</script>

<template>
  <section ref="root" class="aq" role="group" :aria-label="`Questions from ${who}`" tabindex="-1" @keydown="key">
    <header class="aq-head">
      <span class="aq-wait" aria-hidden="true" />
      <span class="aq-who"><strong>{{ who }}</strong> asks {{ questions.length === 1 ? "a question" : `${questions.length} questions` }}</span>
      <span class="aq-grow" />
      <div v-if="questions.length > 1" class="aq-tabs" role="tablist" aria-label="Questions">
        <button
          v-for="(question, index) in questions"
          :key="index"
          type="button"
          class="aq-tab"
          role="tab"
          :aria-selected="index === at"
          @click="at = index"
        >
          <svg v-if="answered(index)" viewBox="0 0 24 24" aria-label="Answered"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
          <span v-else class="aq-num">{{ index + 1 }}</span>{{ question.header }}
        </button>
      </div>
    </header>
    <div class="aq-body" :class="{ 'has-preview': preview }">
      <div class="aq-q">
        <h3>{{ current.question }}</h3>
        <div class="aq-mode">{{ current.multiSelect ? "Pick any that apply" : "Pick one" }}</div>
        <div
          class="aq-opts"
          :class="current.multiSelect ? 'multi' : 'single'"
          :role="current.multiSelect ? 'group' : 'radiogroup'"
          :aria-label="current.header"
        >
          <button
            v-for="(option, index) in current.options"
            :key="`${at}:${index}`"
            type="button"
            class="aq-opt"
            :role="current.multiSelect ? 'checkbox' : 'radio'"
            :aria-checked="picks[at]!.has(index)"
            @click="pick(index)"
            @mouseenter="focusOn[at] = index"
            @focus="focusOn[at] = index"
          >
            <kbd>{{ index + 1 }}</kbd>
            <span class="aq-mark"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></span>
            <span>
              <span class="aq-lbl">{{ option.label }}</span>
              <span v-if="option.description" class="aq-desc">{{ option.description }}</span>
            </span>
          </button>
          <label class="aq-other">
            <kbd>{{ current.options.length + 1 }}</kbd><span />
            <input
              ref="otherField"
              class="aq-field"
              :aria-label="`Other answer for ${current.header}`"
              placeholder="Something else: type your answer"
              :value="other[at]"
              @input="typedOther(($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
        <label class="aq-note">
          <span>Note for {{ who }}</span>
          <input v-model="notes[at]" class="aq-field" :aria-label="`Note for ${current.header}`" placeholder="Optional" />
        </label>
      </div>
      <aside v-if="preview" class="aq-preview" aria-label="Preview">
        <span class="aq-cap">Preview · {{ hovered?.label }}</span>
        <pre>{{ preview }}</pre>
      </aside>
    </div>
    <footer class="aq-foot">
      <span class="aq-count">{{ done }} of {{ questions.length }} answered</span>
      <span class="aq-grow" />
      <span class="aq-hints">
        <span><kbd>1</kbd>–<kbd>{{ current.options.length + 1 }}</kbd> pick</span>
        <span v-if="questions.length > 1"><kbd>←</kbd><kbd>→</kbd> question</span>
      </span>
      <button type="button" class="aq-btn aq-ghost" :disabled="busy" @click="emit('skip')">Skip</button>
      <button
        v-if="!last && !complete"
        type="button"
        class="aq-btn aq-primary"
        @click="go(1)"
      >
        Next <kbd>↵</kbd>
      </button>
      <button v-else type="button" class="aq-btn aq-primary" :disabled="!complete || busy" @click="send">
        Send answers <kbd>Ctrl ↵</kbd>
      </button>
    </footer>
  </section>
</template>

<style scoped>
.aq {
  --aq-mono: "Cascadia Code", Consolas, monospace;
  border: 1px solid #e3d7c0;
  border-radius: 11px;
  background: #fdfbf7;
  box-shadow: 0 8px 24px #4a3c2012;
  animation: aq-rise 170ms ease-out;
  outline: none;
}
@keyframes aq-rise {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
.aq-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid #efe6d6;
}
.aq-who {
  font-size: 12.5px;
  color: #455968;
}
.aq-who strong {
  color: #273f50;
  font-weight: 600;
}
.aq-wait {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #b08a4a;
  box-shadow: 0 0 0 3px #b08a4a22;
}
.aq-grow {
  flex: 1;
}
.aq-tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: #f1ebe0;
  min-width: 0;
  overflow: hidden;
}
.aq-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 11.5px;
  color: #5d7381;
  white-space: nowrap;
  cursor: pointer;
}
.aq-tab[aria-selected="true"] {
  background: #fbfcfd;
  color: #273f50;
  box-shadow: 0 1px 2px #263f5512;
}
.aq-tab svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: #4f7d5f;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.aq-num {
  font: 10.5px var(--aq-mono);
  color: #8296a2;
}
.aq-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
}
.aq-body.has-preview {
  grid-template-columns: minmax(0, 1fr) minmax(0, 300px);
}
.aq-q {
  padding: 12px 14px 10px;
  min-width: 0;
}
.aq-q h3 {
  margin: 0 0 2px;
  font-size: 13.5px;
  font-weight: 550;
  color: #273f50;
  line-height: 1.45;
}
.aq-mode {
  font-size: 11.5px;
  color: #8296a2;
  margin-bottom: 8px;
}
.aq-opts {
  display: grid;
  gap: 2px;
}
.aq-opt {
  display: grid;
  grid-template-columns: 18px 16px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  width: 100%;
  min-height: 40px;
  padding: 7px 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.aq-opt:hover {
  background: #eef3f6;
}
.aq-opt:focus-visible {
  outline: none;
  border-color: #9fb6c3;
}
.aq-opt[aria-checked="true"] {
  background: #e4edf2;
  border-color: #cfdde6;
}
.aq kbd {
  display: inline-grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border: 1px solid #d6e0e6;
  border-bottom-width: 2px;
  border-radius: 4px;
  background: #fbfcfd;
  font: 10.5px/1 var(--aq-mono);
  color: #5d7381;
}
.aq-mark {
  margin-top: 1px;
  width: 16px;
  height: 16px;
  border: 1.5px solid #a9bcc7;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #fff;
}
.multi .aq-mark {
  border-radius: 4px;
}
.aq-mark svg {
  width: 10px;
  height: 10px;
  fill: none;
  stroke: #fff;
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
}
.multi .aq-opt[aria-checked="true"] .aq-mark {
  border-color: #365f78;
  background: #365f78;
}
.multi .aq-opt[aria-checked="true"] .aq-mark svg {
  opacity: 1;
}
.single .aq-opt[aria-checked="true"] .aq-mark {
  border-color: #365f78;
}
.single .aq-opt[aria-checked="true"] .aq-mark svg {
  display: none;
}
.single .aq-opt[aria-checked="true"] .aq-mark::after {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #365f78;
}
.aq-lbl {
  font-weight: 550;
  color: #273f50;
}
.aq-desc {
  display: block;
  font-size: 12px;
  color: #5d7381;
  line-height: 1.45;
}
.aq-other {
  display: grid;
  grid-template-columns: 18px 16px minmax(0, 1fr);
  gap: 9px;
  align-items: center;
  padding: 5px 8px;
}
.aq-field {
  height: 30px;
  width: 100%;
  min-width: 0;
  padding: 0 9px;
  border: 1px solid #dbe5eb;
  border-radius: 7px;
  background: #fbfcfd;
  font: inherit;
  font-size: 12.5px;
  color: #273f50;
  outline: none;
}
.aq-field:focus {
  border-color: #7b97a7;
}
.aq-note {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.aq-note .aq-field {
  height: 28px;
  font-size: 12px;
}
.aq-note span {
  font-size: 11.5px;
  color: #8296a2;
  white-space: nowrap;
}
.aq-preview {
  border-left: 1px solid #efe6d6;
  padding: 12px 14px;
  background: #f7f4ee;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.aq-cap {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #8a7a5c;
}
.aq-preview pre {
  margin: 0;
  flex: 1;
  max-height: 260px;
  padding: 9px 10px;
  border: 1px solid #e9e0cf;
  border-radius: 7px;
  background: #fffdf9;
  font: 11px/1.55 var(--aq-mono);
  color: #4b4130;
  white-space: pre;
  overflow: auto;
}
.aq-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  padding: 0 12px;
  border-top: 1px solid #efe6d6;
}
.aq-count {
  font-size: 12px;
  color: #5d7381;
  font-variant-numeric: tabular-nums;
}
.aq-hints {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: #8296a2;
}
.aq-hints span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.aq-btn {
  height: 28px;
  padding: 0 11px;
  border: 1px solid #dfd2b8;
  border-radius: 7px;
  background: #fbfcfd;
  font: inherit;
  font-size: 12.5px;
  color: #455968;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.aq-btn:hover:not(:disabled) {
  background: #f3ece0;
}
.aq-ghost {
  border-color: transparent;
  background: none;
}
.aq-primary {
  background: #365f78;
  border-color: #365f78;
  color: #fff;
}
.aq-primary:hover:not(:disabled) {
  background: #2f5469;
}
.aq-primary:disabled {
  background: #dfe8ee;
  border-color: #dfe8ee;
  color: #8aa0ad;
  cursor: default;
}
.aq-primary kbd {
  height: 16px;
  min-width: 16px;
  font-size: 10px;
  background: #ffffff26;
  border-color: #ffffff40;
  color: #fff;
}
.aq-primary:disabled kbd {
  background: none;
  border-color: #c9d6de;
  color: #8aa0ad;
}
@media (prefers-reduced-motion: reduce) {
  .aq {
    animation: none;
  }
}
</style>
