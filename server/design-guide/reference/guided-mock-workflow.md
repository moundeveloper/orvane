## Guided mock workflow

Use this worksheet for an interactive mock. Keep it in your working notes. The Lab preview should open on the working UI.

1. **Anchor it in Orvane.** Inspect one relevant approved example and the current app surface. Write down the part you will reuse, the real data that makes the scenario believable, and the one decision the mock needs to make clear.
2. **Write the whole interaction before building.** Describe the entry state, the action, the landing state, and how the user returns. Name the state that survives the transition. Pick a related alternate path such as cancel, remove, or reopen. If two approaches are plausible, evaluate which puts the evidence closest to the decision.
3. **Implement the path with connected state.** When an action carries context between surfaces, model that context as a reference to its source. Preserve the draft or selection as appropriate. Start the preview at the important decision and make both the main path and the return path usable with the keyboard.
4. **Replay outcomes in a browser.** Check the visible landing state and what carried through it. Inspect a screenshot of the decision and another of the landing at a realistic viewport. If the flow fails, record the first mismatch, fix that transition, then replay the main and alternate paths. Report whether you ran the workflow or only inspected a render.

**Worked example.** Start with a non-empty Claude draft and an open Codex review. Use the recommendation. Claude’s draft keeps its wording and receives a removable source chip. Send the message and reopen the chip to return to the same Codex review. Check that removing the chip before sending keeps the text. Compare the landing with Orvane’s existing composer and keep the action and focus visible.

For a separate builder or a persistent replay brief, call `design_guide` with `topic: "flow"`.
