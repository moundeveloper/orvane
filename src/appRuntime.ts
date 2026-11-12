import source from "./appRuntimeSource.js?raw";

/** A task this long in a code app is reported to its author in Build mode. */
export const SLOW_TASK_MS = 200;

/** Inline script that installs `window.orvane` in a code app's sandbox. */
export const APP_RUNTIME = `<script>${source.replace(
  ")(SLOW_TASK_MS);",
  `)(${SLOW_TASK_MS});`,
)}</scr${""}ipt>`;
