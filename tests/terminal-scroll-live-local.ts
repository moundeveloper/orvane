import { createApp, h, reactive } from "vue";
import { Terminal } from "@xterm/xterm";
import TerminalView from "../src/components/terminal/TerminalView.vue";
import { makeBlock } from "../src/model";
import "../src/style.css";
const open = Terminal.prototype.open;
const capturedTerms: Terminal[] = [];
Terminal.prototype.open = function (...args) {
  capturedTerms.push(this);
  return open.apply(this, args);
};
Object.assign(window, { capturedTerms });
const block = reactive(makeBlock("terminal"));
createApp({ render: () => h(TerminalView, { block }) }).mount("#term");
