<script setup lang="ts">
// Calendar app: a month view and the selected day's items. An item can have
// a time and a reminder; App.vue shows due reminders as notifications.
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import Icon from "./Icon.vue";
import TimePicker from "./pickers/TimePicker.vue";
import MonthYearGrid from "./pickers/MonthYearGrid.vue";
import { usePopover } from "./pickers/usePopover";
import { registerCommands } from "../commands";
import { uid, type Block } from "../model";
import {
  dayKey,
  formatDay,
  monthDays,
  parseDay,
  readCalendar,
  sortItems,
  weekdayLabels,
  type CalendarData,
  type CalendarItem,
} from "../calendar";

const props = defineProps<{ block: Block }>();
const data = computed(() => readCalendar(props.block.value));
function save(next: CalendarData) {
  props.block.value = JSON.stringify(next);
}
function update(id: string, patch: Partial<CalendarItem>) {
  save({
    items: data.value.items.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item, ...patch };
      // Changing when (or whether) to remind makes the reminder due again.
      if ("time" in patch || "date" in patch || "remind" in patch) delete next.notified;
      if (!next.time) {
        delete next.time;
        delete next.remind;
      }
      return next;
    }),
  });
}
function remove(id: string) {
  save({ items: data.value.items.filter((item) => item.id !== id) });
}

const today = ref(dayKey(new Date()));
const selected = ref(today.value);
const month = ref(parseDay(today.value));
month.value.setDate(1);
// Keep "today" right across midnight.
const todayTimer = setInterval(() => (today.value = dayKey(new Date())), 60_000);
onBeforeUnmount(() => clearInterval(todayTimer));

// The week starts on the locale's first day (Monday when unknown).
const weekdays = weekdayLabels;
const monthLabel = computed(() =>
  month.value.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
);
const byDay = computed(() => {
  const map = new Map<string, CalendarItem[]>();
  for (const item of data.value.items) map.set(item.date, [...(map.get(item.date) ?? []), item]);
  return map;
});
const cells = computed(() =>
  monthDays(month.value).map((day) => ({ ...day, items: byDay.value.get(day.key) ?? [] })),
);
// Jump to any month: the month title opens a month/year grid.
const monthButton = ref<HTMLButtonElement>();
const monthPopover = ref<HTMLDivElement>();
const monthPicker = usePopover(monthButton, monthPopover, 220);
function jumpTo(year: number, m: number) {
  month.value = new Date(year, m, 1);
  monthPicker.close(true);
}
function shiftMonth(by: number) {
  const next = new Date(month.value);
  next.setMonth(next.getMonth() + by);
  month.value = next;
}
function select(key: string) {
  selected.value = key;
  const day = parseDay(key);
  if (day.getMonth() !== month.value.getMonth() || day.getFullYear() !== month.value.getFullYear()) {
    day.setDate(1);
    month.value = day;
  }
}
const dayItems = computed(() => sortItems(byDay.value.get(selected.value) ?? []));

const newTitle = ref("");
const newTime = ref("");
const titleInput = ref<HTMLInputElement>();
function add() {
  const title = newTitle.value.trim();
  if (!title) return;
  const item: CalendarItem = { id: uid(), title, date: selected.value };
  if (newTime.value) {
    item.time = newTime.value;
    item.remind = true;
    askPermission();
  }
  save({ items: [...data.value.items, item] });
  newTitle.value = "";
  newTime.value = "";
}
function toggleRemind(item: CalendarItem) {
  if (!item.time) return;
  if (!item.remind) askPermission();
  update(item.id, { remind: !item.remind });
}
// Outside the desktop app, reminders use the browser's notifications.
function askPermission() {
  const desktop = (window as { orvaneDesktop?: unknown }).orvaneDesktop;
  if (!desktop && "Notification" in window && Notification.permission === "default")
    void Notification.requestPermission().catch(() => undefined);
}

// Ctrl+K: upcoming items open their day; "Add" jumps to the new-item field.
const stopCommands = registerCommands(`calendar:${props.block.id}`, () => {
  const from = dayKey(new Date());
  return [
    {
      id: `calendar-today:${props.block.id}`,
      title: "Show today in the calendar",
      icon: "calendar",
      blockId: props.block.id,
      keywords: "calendar date",
      run: () => select(dayKey(new Date())),
    },
    {
      id: `calendar-add:${props.block.id}`,
      title: "Add a calendar item",
      icon: "plus",
      blockId: props.block.id,
      keywords: "calendar reminder task event",
      run: async () => {
        await nextTick();
        titleInput.value?.focus();
      },
    },
    ...sortItems(data.value.items)
      .filter((item) => !item.done && item.date >= from)
      .slice(0, 50)
      .map((item) => ({
        id: `calendar-item:${props.block.id}:${item.id}`,
        title: item.title,
        detail: `Calendar · ${formatDay(item.date)}${item.time ? ` ${item.time}` : ""}`,
        icon: item.remind ? "bell" : "calendar",
        blockId: props.block.id,
        keywords: "calendar reminder",
        run: () => select(item.date),
      })),
  ];
});
onBeforeUnmount(stopCommands);
</script>

<template>
  <div class="calendar-view">
    <section class="cal-month" aria-label="Month">
      <header class="cal-head">
        <h2>
          <button
            ref="monthButton"
            type="button"
            class="cal-month-button"
            aria-haspopup="dialog"
            :aria-expanded="monthPicker.open.value"
            aria-label="Choose month and year"
            @click.stop="monthPicker.show"
          >
            {{ monthLabel }}<Icon name="down" :size="12" />
          </button>
        </h2>
        <Teleport to="body">
          <div
            v-if="monthPicker.open.value"
            ref="monthPopover"
            class="select-popover picker-popover"
            role="dialog"
            aria-label="Choose month and year"
            tabindex="-1"
            :style="monthPicker.style.value"
            @pointerdown.stop
            @keydown.esc.stop="monthPicker.close(true)"
            @wheel.stop
          >
            <MonthYearGrid :year="month.getFullYear()" :month="month.getMonth()" @pick="jumpTo" />
          </div>
        </Teleport>
        <button class="icon-button" aria-label="Previous month" @click="shiftMonth(-1)">
          <Icon name="back" :size="14" />
        </button>
        <button class="subtle-button" @click="select(today)">Today</button>
        <button class="icon-button" aria-label="Next month" @click="shiftMonth(1)">
          <Icon name="forward" :size="14" />
        </button>
      </header>
      <div class="cal-grid" role="grid">
        <span v-for="(day, i) in weekdays" :key="i" class="cal-weekday" aria-hidden="true">{{ day }}</span>
        <button
          v-for="cell in cells"
          :key="cell.key"
          class="cal-day"
          :class="{
            outside: cell.outside,
            today: cell.key === today,
            selected: cell.key === selected,
          }"
          :aria-label="`${formatDay(cell.key)}${cell.items.length ? `, ${cell.items.length} item${cell.items.length > 1 ? 's' : ''}` : ''}`"
          :aria-pressed="cell.key === selected"
          @click="select(cell.key)"
        >
          <span class="cal-date">{{ cell.date }}</span>
          <span v-if="cell.items.length" class="cal-dots" aria-hidden="true">
            <i
              v-for="item in cell.items.slice(0, 3)"
              :key="item.id"
              :class="{ done: item.done, remind: item.remind }"
            ></i>
          </span>
        </button>
      </div>
    </section>
    <section class="cal-day-panel" :aria-label="formatDay(selected)">
      <h3>{{ formatDay(selected) }}</h3>
      <form class="cal-add" @submit.prevent="add">
        <input
          ref="titleInput"
          v-model="newTitle"
          placeholder="Add an item…"
          aria-label="New item"
          maxlength="200"
        />
        <TimePicker v-model="newTime" aria-label="Time (optional; adds a reminder)" />
        <button class="subtle-button" type="submit" :disabled="!newTitle.trim()">
          <Icon name="plus" :size="13" />Add
        </button>
      </form>
      <p v-if="!dayItems.length" class="cal-empty">Nothing on this day.</p>
      <ul class="cal-items">
        <li v-for="item in dayItems" :key="item.id" :class="{ done: item.done }">
          <input
            type="checkbox"
            :checked="item.done"
            :aria-label="`Done: ${item.title}`"
            @change="update(item.id, { done: ($event.target as HTMLInputElement).checked })"
          />
          <input
            class="cal-title"
            :value="item.title"
            aria-label="Item"
            maxlength="200"
            @change="
              ($event.target as HTMLInputElement).value.trim() &&
                update(item.id, { title: ($event.target as HTMLInputElement).value.trim() })
            "
          />
          <TimePicker
            :model-value="item.time ?? ''"
            :aria-label="`Time for ${item.title}`"
            @change="update(item.id, { time: $event || undefined })"
          />
          <button
            class="icon-button cal-bell"
            :class="{ on: item.remind }"
            :disabled="!item.time"
            :aria-pressed="!!item.remind"
            :aria-label="item.time ? (item.remind ? 'Turn reminder off' : 'Remind me') : 'Set a time to get a reminder'"
            :title="item.time ? (item.remind ? 'Reminder on' : 'Reminder off') : 'Set a time to get a reminder'"
            @click="toggleRemind(item)"
          >
            <Icon name="bell" :size="14" />
          </button>
          <button class="icon-button" :aria-label="`Delete ${item.title}`" @click="remove(item.id)">
            <Icon name="trash" :size="14" />
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.calendar-view {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 18px;
  padding: 18px;
  overflow: auto;
}
@container (max-width: 620px) {
  .calendar-view {
    grid-template-columns: minmax(0, 1fr);
  }
}
.cal-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 10px;
}
.cal-head h2 {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: #3d505d;
  text-transform: capitalize;
}
.cal-month-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: -6px;
  padding: 4px 6px;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-transform: capitalize;
}
.cal-month-button:hover,
.cal-month-button[aria-expanded="true"] {
  background: #e8eef2;
}
.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 3px;
}
.cal-weekday {
  text-align: center;
  font-size: 10px;
  color: var(--muted);
  padding-bottom: 4px;
  text-transform: uppercase;
}
.cal-day {
  aspect-ratio: 1 / 0.86;
  min-height: 34px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: 6px;
  background: transparent;
  color: #455968;
  font-size: 12px;
}
.cal-day:hover {
  background: #e8eef2;
}
.cal-day.outside {
  color: #a6b4bd;
}
.cal-day.today .cal-date {
  color: var(--app-accent, var(--accent));
  font-weight: 700;
}
.cal-day.selected {
  background: #dfe8ed;
  box-shadow: inset 0 0 0 1.5px var(--app-accent, var(--accent));
}
.cal-dots {
  display: flex;
  gap: 3px;
}
.cal-dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #8fa3b0;
}
.cal-dots i.remind {
  background: var(--app-accent, var(--accent));
}
.cal-dots i.done {
  opacity: 0.35;
}
.cal-day-panel {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cal-day-panel h3 {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: #3d505d;
}
.cal-add {
  display: flex;
  gap: 6px;
}
.cal-add input:first-child {
  flex: 1;
  min-width: 0;
}
.cal-add input,
.cal-items input:not([type="checkbox"]) {
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #fff;
  padding: 6px 8px;
  font-size: 12px;
}
.cal-empty {
  margin: 4px 0;
  font-size: 12px;
  color: var(--muted);
}
.cal-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
}
.cal-items li {
  display: flex;
  align-items: center;
  gap: 6px;
}
.cal-items .cal-title {
  flex: 1;
  min-width: 0;
  border-color: transparent !important;
  background: transparent !important;
}
.cal-items .cal-title:focus {
  border-color: var(--line) !important;
  background: #fff !important;
}
.cal-items li.done .cal-title {
  text-decoration: line-through;
  color: var(--muted);
}
.cal-items .picker-trigger {
  flex: none;
  width: 78px;
}
.cal-bell {
  color: #a6b4bd;
}
.cal-bell.on {
  color: var(--app-accent, var(--accent));
}
.cal-bell:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>

<style>
/* Fills its app, like the other built-in apps. */
.app-content:has(> .block-calendar:only-child) {
  padding: 0;
  overflow: hidden;
}
.app-content > .block-calendar {
  display: flex;
  flex: 1;
  min-height: 360px;
}
.app-content > .block-calendar > * {
  flex: 1;
  min-width: 0;
}
.block-calendar:not(:only-child) {
  height: 520px;
}
</style>
