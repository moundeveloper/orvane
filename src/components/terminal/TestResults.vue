<script setup lang="ts">
import { computed, inject, nextTick, ref } from "vue";
import type { Block } from "../../model";
import {
  readWidget,
  revealWorkbenchDetail,
  workbenchEditable,
} from "../../workbenchWidgets";
import type { PlaywrightRun as Run, TestFailure } from "../../playwrightReport";
import { api, baseName } from "../files/explorer";
import Icon from "../Icon.vue";

const props = defineProps<{ block: Block }>();
const editable = inject(workbenchEditable);
const saved = readWidget<{ cwd: string; run: Run }>(props.block.value);
const cwd = ref(typeof saved.cwd === "string" ? saved.cwd : "");
const reportPath = ref("");
const run = ref<Run | undefined>(
  Array.isArray(saved.run?.failures) ? saved.run : undefined,
);
const project = ref(cwd.value);
const busy = ref(false),
  message = ref("");
const showingSource = ref<{
  file: string;
  line: number;
  lines: { n: number; text: string }[];
}>();
const sourcePanel = ref<HTMLElement>();
const sameProject = computed(() => cwd.value.trim() === project.value);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function execute(
  operation: "playwright-run" | "playwright-report",
  failure?: TestFailure,
) {
  if (
    !editable?.() ||
    busy.value ||
    !cwd.value.trim() ||
    (failure && !sameProject.value)
  )
    return;
  const folder = cwd.value.trim();
  busy.value = true;
  message.value =
    operation === "playwright-report"
      ? "Reading report…"
      : failure
        ? "Rerunning test…"
        : "Running Playwright suite…";
  try {
    const result = await api<Run>(operation, {
      cwd: folder,
      path: reportPath.value.trim(),
      ...(failure
        ? {
            file: failure.file,
            line: failure.line,
            project: failure.project,
            testTitle: failure.testTitle,
          }
        : {}),
    });
    if (!editable()) return;
    if (failure && run.value) {
      if (result.error || !result.selected || result.selected === "skipped") {
        message.value = result.error || "The selected test did not run.";
        return;
      }
      const prior = run.value;
      const remaining = prior.failures.filter((entry) => entry !== failure);
      if (!result.failures.length && result.selected === "unexpected") {
        message.value =
          "Playwright reported a failure without a source location.";
        return;
      }
      run.value = {
        ...prior,
        failures: [...result.failures, ...remaining],
        stats: {
          ...prior.stats,
          expected:
            prior.stats.expected + Number(result.selected === "expected"),
          flaky: prior.stats.flaky + Number(result.selected === "flaky"),
          unexpected:
            prior.stats.unexpected - Number(result.selected !== "unexpected"),
        },
      };
      message.value = result.failures.length
        ? "The test still fails."
        : result.selected === "flaky"
          ? "The test passed on retry."
          : "The test passed.";
    } else {
      project.value = folder;
      run.value = result;
      showingSource.value = undefined;
      message.value = result.error;
    }
    props.block.value = JSON.stringify({ cwd: folder, run: run.value });
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
async function openSource(failure: TestFailure) {
  busy.value = true;
  message.value = "";
  try {
    const response = await api<{ kind: string; text?: string }>("preview", {
      path: failure.sourceFile,
    });
    const lines = response.text?.split(/\r?\n/);
    if (
      response.kind !== "text" ||
      !lines ||
      failure.sourceLine < 1 ||
      failure.sourceLine > lines.length
    )
      throw Error(
        "That source line is unavailable. The file may have changed since the run.",
      );
    const start = Math.max(0, failure.sourceLine - 7);
    showingSource.value = {
      file: failure.sourceFile,
      line: failure.sourceLine,
      lines: lines
        .slice(start, failure.sourceLine + 5)
        .map((text, i) => ({ n: start + i + 1, text })),
    };
    await nextTick();
    revealWorkbenchDetail(sourcePanel.value);
  } catch (error) {
    message.value = errorText(error);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="workbench-widget">
    <form class="workbench-actions" @submit.prevent="execute('playwright-run')">
      <label class="project-input"
        >Project folder<input
          v-model="cwd"
          placeholder="Absolute path to the Playwright project"
          :readonly="busy || !editable?.()"
      /></label>
      <button
        type="submit"
        class="subtle-button"
        :disabled="busy || !editable?.() || !cwd.trim()"
      >
        <Icon name="play" :size="14" />Run suite
      </button>
    </form>
    <details v-if="editable?.()" class="report-import">
      <summary>Import a report from Terminal</summary>
      <form
        class="workbench-actions"
        @submit.prevent="execute('playwright-report')"
      >
        <label class="project-input"
          >JSON report path<input
            v-model="reportPath"
            placeholder="Absolute path to results.json"
            :readonly="busy"
        /></label>
        <button
          type="submit"
          class="subtle-button"
          :disabled="busy || !reportPath.trim() || !cwd.trim()"
        >
          Import report
        </button>
      </form>
    </details>
    <p v-if="message" class="workbench-status" role="status">{{ message }}</p>
    <template v-if="run && sameProject">
      <p class="workbench-status">
        {{ run.stats.expected }} passed · {{ run.stats.unexpected }} failed ·
        {{ run.stats.flaky }} flaky · {{ run.stats.skipped }} skipped
      </p>
      <ul
        v-if="run.failures.length"
        class="test-failures"
        aria-label="Failed tests"
      >
        <li
          v-for="failure in run.failures"
          :key="
            JSON.stringify([
              failure.file,
              failure.line,
              failure.project,
              failure.title,
            ])
          "
          class="workbench-detail"
        >
          <strong>{{ failure.title }}</strong>
          <small v-if="failure.project">{{ failure.project }}</small>
          <pre>{{ failure.message }}</pre>
          <div class="workbench-actions">
            <button
              type="button"
              class="subtle-button"
              :disabled="busy"
              :title="failure.sourceFile"
              @click="openSource(failure)"
            >
              {{ baseName(failure.sourceFile) }}:{{ failure.sourceLine }}
            </button>
            <button
              type="button"
              class="subtle-button"
              :disabled="busy || !editable?.()"
              @click="execute('playwright-run', failure)"
            >
              Rerun test
            </button>
          </div>
        </li>
      </ul>
    </template>
    <section
      v-if="showingSource && sameProject"
      ref="sourcePanel"
      class="workbench-detail source-detail"
      aria-label="Test source"
    >
      <div class="workbench-actions">
        <strong>{{ showingSource.file }}:{{ showingSource.line }}</strong>
        <button
          type="button"
          class="subtle-button"
          @click="showingSource = undefined"
        >
          Close source
        </button>
      </div>
      <pre
        class="source-lines"
      ><code v-for="row in showingSource.lines" :key="row.n" :class="{ target: row.n === showingSource.line }"><span>{{ row.n }}</span>{{ row.text }}</code></pre>
    </section>
  </div>
</template>

<style scoped>
.project-input {
  flex: 1;
  min-width: 190px;
}
.report-import {
  margin: 10px 0;
}
.report-import form {
  margin-top: 8px;
}
.test-failures {
  display: grid;
  gap: 8px;
  list-style: none;
  padding: 0;
}
.test-failures small {
  margin-left: 8px;
  color: #526b79;
}
.test-failures pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.source-detail {
  margin-top: 10px;
  overflow-wrap: anywhere;
}
.source-lines {
  overflow: auto;
}
.source-lines code {
  display: block;
  min-width: max-content;
  padding: 3px 6px;
}
.source-lines code.target {
  background: #e0edf5;
  font-weight: 650;
}
.source-lines span {
  display: inline-block;
  width: 5ch;
  color: #526b79;
}
</style>
