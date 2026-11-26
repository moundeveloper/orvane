import { createApp, h, reactive, watch } from "vue";
import { createPinia } from "pinia";
import NotesView from "../components/notes/NotesView.vue";
import { makeBlock } from "../model";
import "../style.css";
import "../scrollbars.css";
import "../selectPopover.css";
import "./csrf";

const key = "orvane-host-notes-block";
const block = reactive(makeBlock("notes"));
block.id = "host-notes";
block.value = localStorage.getItem(key) ?? "";
watch(() => block.value, (value) => localStorage.setItem(key, value));

createApp({
  render: () => h(NotesView, { block, editing: false, tabId: block.id }),
}).use(createPinia()).mount("#host-notes");
