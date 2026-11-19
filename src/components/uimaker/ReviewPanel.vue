<script setup>
import { computed } from 'vue';
import UiIcon from './UiIcon.vue';
import { ago, KINDS, PROPS } from './editor.js';
import { cssPath } from './overlay.js';

const props = defineProps({ ui: Object, notes: Array, tweaks: Array, versions: Array, feed: Array, editor: Object });
const feedIcons = { brief: 'send', iteration: 'plus', import: 'box', error: 'bell' };
const targetText = target => target
  ? (target.text ? '“' + target.text.slice(0, 34) + '”' : '<' + target.tag + '>')
  : 'outside the component';
const replies = computed(() => {
  const result = {};
  for (const version of props.versions)
    for (const [id, text] of Object.entries(version.response?.notes ?? {}))
      if (text && !result[id]) result[id] = { version: version.n, text };
  return result;
});
const inspected = computed(() => {
  const el = props.ui.el;
  if (!el?.isConnected) return null;
  const selector = cssPath(el);
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  const fields = PROPS.map(name => {
    const tweak = props.tweaks.find(t => t.selector === selector && t.prop === name);
    return { name, tweak, value: tweak ? tweak.value : style.getPropertyValue(name) };
  });
  return { selector, style, fields };
});
const items = computed(() => props.feed.filter(f => !f.c || f.c === props.ui.c).slice(-60).reverse());
</script>

<template>
  <template v-if="ui.tab === 'notes'">
    <div v-if="!notes.length" class="empty">No notes on v{{ ui.v }} yet. Press N, click the exact spot on the component and type what you mean. Each note gets its own reference canvas below.</div>
    <template v-for="(note, index) in notes" :key="note.id">
      <div class="nrow" :class="{ on: note.id === ui.note }" role="button" tabindex="0"
        @click="editor.selectNote(note.id === ui.note ? null : note.id)"
        @keydown.enter.prevent="$event.currentTarget.click()" @keydown.space.stop.prevent="$event.currentTarget.click()">
        <b class="num" :style="{ background: note.color }">{{ index + 1 }}</b>
        <div class="tt"><b :class="{ ph: !note.title }">{{ note.title || 'Untitled note' }}</b><small>on {{ targetText(note.target) }}</small></div>
        <span v-if="note.refs?.length" class="chip"><UiIcon name="image" />{{ note.refs.length }}</span>
        <span v-if="replies[note.id]" class="chip green"><UiIcon name="check" />Answered</span>
      </div>
      <div v-if="note.id === ui.note" class="editor">
        <label>Label on the canvas<input class="title" :value="note.title" placeholder="e.g. Buttons feel heavy"
          @input="editor.updateNoteTitle(note, $event.target.value)"></label>
        <label>Details<textarea v-model="note.text" placeholder="What should change here, and why? Point at references on the canvas below."
          @input="editor.save()"></textarea></label>
        <div class="foot">
          <button v-for="[color, name] in KINDS" :key="name" class="kind" :class="{ on: note.color === color }"
            :style="{ '--c': color }" @click="editor.updateNoteColor(note, color)">{{ name }}</button>
          <div class="spacer"></div>
          <button class="iconbtn" aria-label="Delete note (Del)" @click="editor.deleteNote(note)"><UiIcon name="trash" /></button>
        </div>
        <div class="where"><UiIcon name="cursor" />Pinned on {{ targetText(note.target) }}
          <span v-if="note.elementPin" class="chip">Element pin</span>
          <code v-if="note.target">{{ note.target.selector.split(' > ').at(-1) }}</code>
        </div>
        <div v-if="replies[note.id]" class="reply"><b>Agent · v{{ replies[note.id].version }}</b>{{ replies[note.id].text }}</div>
      </div>
    </template>
  </template>
  <div v-else-if="ui.tab === 'inspect'" class="insp">
    <div v-if="!inspected" class="empty">Click an element on the artboard. You can read its real values and type exact ones. The agent receives them as exact values, not as a description.</div>
    <template v-else>
      <div class="sel">{{ inspected.selector }}</div>
      <label v-for="{ name, tweak, value } in inspected.fields" :key="name" class="prop" :class="{ changed: tweak }">
        {{ name }}<input :value="value" spellcheck="false"
          @change="editor.setTweak(inspected.selector, name, $event.target.value.trim(), inspected.style.getPropertyValue(name))">
      </label>
    </template>
    <template v-if="tweaks.length">
      <h4>Exact values on v{{ ui.v }}</h4>
      <div v-for="tweak in tweaks" :key="tweak.id" class="tweak">
        <span>{{ tweak.selector.split(' > ').at(-1) }} { {{ tweak.prop }}: {{ tweak.value }} }</span>
        <button class="iconbtn" aria-label="Remove exact value" @click="editor.removeTweak(tweak)"><UiIcon name="trash" /></button>
      </div>
    </template>
  </div>
  <template v-else>
    <div v-if="!items.length" class="empty">Nothing yet. Exported briefs, delivered iterations and the agent's summaries show up here.</div>
    <div v-for="item in items" :key="item.id" class="fitem" :class="'k-' + item.kind">
      <UiIcon :name="feedIcons[item.kind] || 'dotc'" /><div class="t">{{ item.text }}</div><time>{{ ago(item.at) }}</time>
    </div>
  </template>
</template>
