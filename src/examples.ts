import {
  makeBlock,
  uid,
  flatten,
  type Workspace,
  type CanvasApp,
} from "./model";

export function exampleApps(originX = 120, originY = 100): CanvasApp[] {
  const app = (
    name: string,
    icon: string,
    x: number,
    y: number,
    width: number,
    height: number,
  ): CanvasApp => ({
    id: uid(),
    name,
    icon,
    x: originX + x,
    y: originY + y,
    width,
    height,
    blocks: [],
    archived: false,
    group: "Examples",
    exposed: false,
    accent: "#6f8998",
    padding: 24,
    gap: 18,
    radius: 8,
  });
  const tasks = app("Daily list", "list", 0, 0, 350, 400);
  const notes = app("Notes", "text", 380, 0, 340, 330);
  const tally = app("Tally", "counter", 380, 360, 340, 275);
  const calculator = app("Calculator", "counter", 0, 430, 350, 390);
  const title = makeBlock("text");
  title.label = "A few things for today.";
  const input = makeBlock("input");
  input.label = "New task";
  const list = makeBlock("list");
  list.label = "On your mind";
  list.items = [
    "Try moving an app with Alt + drag",
    "Make this little list your own",
  ].map((text) => ({ id: uid(), text, done: false }));
  const add = makeBlock("button");
  add.label = "Add to the list";
  const captured = makeBlock("counter");
  captured.label = "Ideas captured";
  const tea = makeBlock("counter");
  tea.label = "Cups of tea";
  tea.count = 1;
  const pause = makeBlock("checkbox");
  pause.label = "Make a little time for a break";
  tally.exposed = true;
  tally.blocks = [captured, makeBlock("divider"), tea, pause];
  add.rules = [
    {
      id: uid(),
      action: "add-item",
      target: list.id,
      appId: "",
      value: "{New task}",
    },
    { id: uid(), action: "clear", target: input.id, appId: "", value: "" },
    {
      id: uid(),
      action: "increment",
      target: captured.id,
      appId: tally.id,
      value: "1",
    },
  ];
  tasks.blocks = [title, input, add, list];
  const noteTitle = makeBlock("text");
  noteTitle.label = "Leave a little room.";
  const thought = makeBlock("input");
  thought.label = "A thought to come back to";
  thought.value = "What could I make a little simpler?";
  const reminders = makeBlock("list");
  reminders.label = "Worth remembering";
  reminders.items = [
    {
      id: uid(),
      text: "These are real components. Open Build app to explore.",
      done: false,
    },
  ];
  notes.blocks = [noteTitle, thought, reminders];
  const code = makeBlock("code");
  code.label = "Calculator";
  code.height = 285;
  code.sizing = "fill";
  code.code = CALCULATOR_CODE;
  calculator.blocks = [code];
  return [tasks, notes, tally, calculator];
}

export const LEGACY_CALCULATOR_CODE = `<style>*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#455968;background:#f7f9fa}output{display:block;text-align:right;font-size:30px;padding:5px 6px 18px;font-variant-numeric:tabular-nums;overflow:hidden}main{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}button{font:inherit;color:inherit;background:#e9eff3;border:0;border-radius:4px;padding:11px;cursor:pointer}button:hover{background:#dce7ee}button:focus-visible{outline:none;box-shadow:inset 0 -2px #8da5b4}.operator{background:#dde8ee}</style><output aria-live="polite">0</output><main></main><script>let current='0',previous=null,operation=null,fresh=false;const output=document.querySelector('output');const calculate=()=>{const a=Number(previous),b=Number(current);return operation==='+'?a+b:operation==='−'?a-b:operation==='×'?a*b:b===0?'Cannot divide by zero':a/b};for(const key of ['C','±','%','÷','7','8','9','×','4','5','6','−','1','2','3','+','0','.','⌫','=']){const button=document.createElement('button');button.textContent=key;if(['÷','×','−','+','='].includes(key))button.className='operator';button.onclick=()=>{if(key==='C'){current='0';previous=null;operation=null}else if(key==='⌫'){current=current.slice(0,-1)||'0'}else if(key==='±')current=String(-Number(current));else if(key==='%')current=String(Number(current)/100);else if(['÷','×','−','+'].includes(key)){if(previous!==null&&!fresh)current=String(calculate());previous=current;operation=key;fresh=true}else if(key==='='){if(previous!==null){current=String(calculate());previous=null;operation=null;fresh=true}}else{if(fresh||!Number.isFinite(Number(current))){current='0';fresh=false}if(key==='.'&&current.includes('.'))return;current=current==='0'&&key!=='.'?key:current+key}output.textContent=current};document.querySelector('main').append(button)}<\/script>`;
export const CALCULATOR_CODE = LEGACY_CALCULATOR_CODE.replace(
  "</style>",
  "html,body{height:100%;min-height:0;overflow:hidden}body{display:flex;flex-direction:column}output{flex:0 0 20%;min-height:0;padding:0 6px 8px;display:flex;align-items:center;justify-content:flex-end;font-size:clamp(18px,9vh,34px);line-height:1.1}main{flex:1;min-height:0;grid-template-rows:repeat(5,minmax(0,1fr));gap:clamp(2px,2vh,6px)}button{min-height:0;padding:0;font-size:clamp(10px,4.5vh,15px);line-height:1.1;overflow:hidden}</style>",
);
export function upgradeExampleApps(workspace: Workspace) {
  for (const app of workspace.apps)
    for (const block of flatten(app.blocks))
      if (block.kind === "code" && block.code === LEGACY_CALCULATOR_CODE) {
        block.code = CALCULATOR_CODE;
        block.sizing = "fill";
      }
}
