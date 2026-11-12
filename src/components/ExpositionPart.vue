<script setup lang="ts">
import { computed, reactive } from "vue";
import type { ExpositionPart } from "../exposition";
import ExpositionFlow from "./ExpositionFlow.vue";
import ExpositionCanvas from "./ExpositionCanvas.vue";
import ExpositionSequence from "./ExpositionSequence.vue";
const props = defineProps<{ part: ExpositionPart }>();
const local = reactive({
  present: [true, true],
  normal: false,
  recovered: false,
  retries: true,
  available: [] as string[],
  changed: false,
});
const available = computed(() =>
  props.part.type === "checks"
    ? local.changed
      ? local.available
      : props.part.available
    : [],
);
const requirements = computed(() =>
  props.part.type === "checks"
    ? [...new Set(props.part.checks.flatMap((c) => c.requires))]
    : [],
);
function toggle(key: string) {
  local.available = [...available.value];
  local.changed = true;
  local.available = local.available.includes(key)
    ? local.available.filter((k) => k !== key)
    : [...local.available, key];
}
const fmt = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (part: number, whole: number) =>
  ((part / whole) * 100).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  }) + "%";
const routeRows = computed(() =>
  props.part.type === "routes"
    ? [
        ...props.part.lanes.map((lane) => ({ ...lane, shared: false })),
        { label: props.part.merge, steps: props.part.shared, shared: true },
      ]
    : [],
);
</script>
<template>
  <section class="ex-part">
    <h4>{{ part.title }}</h4>
    <ExpositionCanvas
      v-if="part.type === 'routes'"
      :label="part.title"
      :min-width="
        140 +
        Math.max(
          part.shared.length,
          ...part.lanes.map((lane) => lane.steps.length),
        ) *
          152
      "
    >
      <div class="ex-routes">
        <div
          v-for="(row, i) in routeRows"
          :key="i"
          class="ex-route"
          :class="{ 'ex-route-shared': row.shared }"
        >
          <strong class="ex-route-label">{{ row.label }}</strong>
          <ol class="ex-route-steps" :aria-label="row.label">
            <li v-for="(step, j) in row.steps" :key="j">
              <strong>{{ step.title }}</strong>
              <span v-if="step.note">{{ step.note }}</span>
            </li>
          </ol>
        </div>
        <p v-if="part.exception" class="ex-route-exception">
          <strong>{{ part.exception.title }}</strong>
          <span>{{ part.exception.note }}</span>
        </p>
      </div>
    </ExpositionCanvas>
    <template v-else-if="part.type === 'identity'">
      <div class="ex-pair">
        <div v-for="(o, i) in part.owners" :key="i" class="ex-record">
          <div class="ex-record-title">
            <strong>{{ o.name }}</strong
            ><span class="ex-tag">{{
              o.active ? "Active source" : "Unused"
            }}</span>
          </div>
          <div class="ex-field" :class="{ missing: !local.present[i] }">
            <span>{{ o.label }}</span
            ><code>{{ o.field }}</code
            ><span class="ex-tag">{{
              local.present[i] ? "Present" : "Removed in simulation"
            }}</span>
          </div>
          <label class="ex-control"
            ><input type="checkbox" v-model="local.present[i]" />Field
            present</label
          >
        </div>
      </div>
      <p class="ex-result" aria-live="polite">
        {{
          local.present[part.owners.findIndex((o) => o.active)]
            ? "The lookup reads the active source. Removing the unused field does not change it."
            : "The active field is missing. The similarly named unused field cannot replace it."
        }}
      </p>
    </template>
    <template v-else-if="part.type === 'allocation'">
      <div
        role="img"
        :aria-label="`${part.label}: ${part.part} of ${part.total} capacity; ${part.consumed} consumed.`"
      >
        <div class="ex-bar-label">
          <strong>Capacity · {{ fmt(part.total) }}</strong
          ><span>{{ part.label }} · {{ fmt(part.part) }}</span>
        </div>
        <div class="ex-bar">
          <span
            class="ex-consumed"
            :style="{ width: (part.consumed / part.total) * 100 + '%' }"
          ></span
          ><span
            class="ex-amount"
            :style="{ width: (part.part / part.total) * 100 + '%' }"
          ></span>
        </div>
        <div class="ex-key">
          <span>Capacity</span><span>Consumed</span
          ><span>{{ part.label }}</span>
        </div>
        <div class="ex-lens">
          <span class="ex-tag"
            >Consumed only · magnified ×{{
              fmt(part.total / part.consumed)
            }}</span
          >
          <div class="ex-bar-label">
            {{ part.approximate ? "≈ " : "" }}{{ fmt(part.consumed) }} consumed
          </div>
          <div class="ex-bar">
            <span class="ex-consumed" style="width: 100%"></span
            ><span
              class="ex-amount"
              :style="{ width: (part.part / part.consumed) * 100 + '%' }"
            ></span>
          </div>
        </div>
      </div>
      <div class="ex-pair ex-fractions">
        <div>
          <span>{{ fmt(part.part) }} / {{ fmt(part.total) }} capacity</span
          ><strong>{{ pct(part.part, part.total) }}</strong>
        </div>
        <div>
          <span
            >{{ fmt(part.part) }} / {{ part.approximate ? "≈ " : ""
            }}{{ fmt(part.consumed) }} consumed</span
          ><strong
            >{{ part.approximate ? "≈ " : ""
            }}{{ pct(part.part, part.consumed) }}</strong
          >
        </div>
      </div>
    </template>
    <template v-else-if="part.type === 'recovery'">
      <div class="ex-record-title">
        <strong>{{ part.batch }}</strong
        ><span
          class="ex-tag"
          :class="{ problem: !local.normal && !local.recovered }"
          >{{
            local.normal
              ? "Normal"
              : local.recovered
                ? "Recovery applied"
                : "Stalled"
          }}</span
        >
      </div>
      <div class="ex-event-chain">
        <span class="ex-tag">Session ends</span
        ><span class="ex-step" aria-hidden="true"></span
        ><span class="ex-tag" :class="{ problem: !local.normal }">{{
          local.normal ? "Handoff received" : "Handoff missing"
        }}</span
        ><span class="ex-step" aria-hidden="true"></span
        ><span class="ex-tag">{{
          local.normal
            ? "Next session starts"
            : local.recovered
              ? local.retries && part.retriesAvailable
                ? "Continue same batch"
                : "Batch failed"
              : "Queue waits"
        }}</span>
      </div>
      <div v-if="!local.normal" class="ex-lens">
        <span class="ex-tag">Independent check · {{ part.cadence }}</span
        ><span>{{
          local.recovered
            ? local.retries && part.retriesAvailable
              ? "Eligible stalled work resumes within the retry budget."
              : "Exhausted budget ends this batch; the next can proceed."
            : "Recovery acts only when the stalled session is eligible."
        }}</span>
      </div>
      <div class="ex-record-title">
        <span>{{ part.next }}</span
        ><span>{{
          local.recovered && !(local.retries && part.retriesAvailable)
            ? "Can proceed"
            : "Waits for current batch"
        }}</span>
      </div>
      <div class="ex-controls">
        <label class="ex-control"
          ><input
            type="checkbox"
            v-model="local.normal"
            @change="local.recovered = false"
          />Normal handoff</label
        ><label class="ex-control"
          ><input
            type="checkbox"
            v-model="local.retries"
            @change="local.recovered = false"
            :disabled="!part.retriesAvailable"
          />Retry budget available</label
        ><button
          type="button"
          :disabled="local.normal || local.recovered"
          @click="local.recovered = true"
        >
          Run eligible recovery check
        </button>
      </div>
      <p class="ex-caption">
        Local simulation. Polling cadence does not guarantee recovery time.
      </p>
    </template>
    <template v-else-if="part.type === 'checks'">
      <div class="ex-controls">
        <label v-for="key in requirements" :key="key" class="ex-control"
          ><input
            type="checkbox"
            :checked="available.includes(key)"
            @change="toggle(key)"
          />{{ key }} available</label
        >
      </div>
      <div class="ex-save">One evaluation pass · all eligible checks</div>
      <div class="ex-check-grid">
        <div v-for="c in part.checks" :key="c.id" class="ex-check">
          <strong>{{ c.name }}</strong
          ><template v-if="c.requires.some((r) => !available.includes(r))"
            ><span class="ex-tag problem"
              >Missing:
              {{
                c.requires.filter((r) => !available.includes(r)).join(", ")
              }}</span
            ><span>Not evaluated</span></template
          ><template v-else
            ><span class="ex-tag">Eligible</span
            ><span :class="{ 'ex-problem': c.finding }">{{
              c.finding || "Result not supplied"
            }}</span></template
          >
        </div>
      </div>
      <div class="ex-findings">
        <strong>Findings in this example</strong
        ><span
          v-for="c in part.checks.filter(
            (c) => c.requires.every((r) => available.includes(r)) && c.finding,
          )"
          :key="c.id"
          >{{ c.finding }}</span
        ><span
          v-if="
            !part.checks.some(
              (c) =>
                c.requires.every((r) => available.includes(r)) && c.finding,
            )
          "
          >No supplied findings from eligible checks.</span
        >
      </div>
      <p class="ex-caption">
        Changing availability explores dependencies; it does not run a live
        audit.
      </p>
    </template>
    <ExpositionFlow v-else-if="part.type === 'flow'" :part="part" />
    <ExpositionSequence v-else-if="part.type === 'sequence'" :part="part" />
    <div v-else-if="part.type === 'comparison'" class="ex-compare">
      <div class="ex-compare-row ex-compare-head">
        <span>Field</span><strong>{{ part.left }}</strong
        ><strong>{{ part.right }}</strong>
      </div>
      <div
        v-for="(r, i) in part.rows"
        :key="i"
        class="ex-compare-row"
        :class="{ different: r.left !== r.right }"
      >
        <span>{{ r.label }}</span
        ><span>{{ r.left }}</span
        ><span>{{ r.right }}</span>
      </div>
    </div>
  </section>
</template>
