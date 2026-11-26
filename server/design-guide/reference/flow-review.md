# Flow review for UI mocks

Give a lower-cost model a constrained build task. Supply an approved Orvane example, the real controls and data shape, and a small set of workflows that say what must survive each transition. Run those workflows in a browser and feed back the first real failure. Inspect visual quality separately.

## From the request to a repair

1. **Choose the moment with a real decision.** Write the shortest story that includes the user’s goal, the information they need before acting, where the action lands, and how they get back. For open design questions, sketch two genuinely different flows and choose the one that makes the decision easiest to understand.
2. **Ground the build.** Retrieve one approved mock with a similar interaction and one current Orvane surface. Supply their structure and component references, design tokens, and representative data. Choose a focal state and explain why it matters. For the recommendation handoff, the result stays beside the chat it came from. The parent composer receives a reference and retains the author’s wording.
3. **Freeze the checks before writing the UI.** Give the builder observable outcomes from the user’s goal. Check the first decision, the main transition, and a recovery or return path. For the handoff, the browser must see the original wording still in the draft, open the same source from the sent turn, and remove the attachment without changing the draft. Keep the tests outside the generated mock when running a real model comparison.
4. **Give the builder the smallest useful correction.** Replay the failed path and return the first failed step, expected and observed states, and a screenshot at that point. Let the same inexpensive model repair the relevant transition. Replay the siblings afterward. Stop after two focused repairs, or escalate the design choice when the trace shows the problem keeps recurring.
5. **Review the visuals in the working states.** Compare captured decision and landing states against the approved reference and current app. Review whether the action is visible, the copy and hierarchy support the decision, motion shows what changed, and the narrow layout and focus order still make sense. A human or stronger visual model can make this judgment. Ask for concrete changes tied to screenshot evidence.

## Orvane mock

**Flow review** in UI Maker Lab replays three workflows against two local versions of the recommendation handoff. The first version appends the recommendation as text. The supplied repair keeps the existing draft and carries a structured source reference. The replay buttons run the preview’s controls, inspect the rendered result, and save a state for every step. Build brief exports the workflows and the first failure for the selected flow.

The production version can start from UI Maker’s existing Lab variants and isolated rendering route. Run browser scripts in a separate test context against the saved variant, capture trace evidence, then pass a small repair brief to the selected builder through the existing agent harness. Save the patch as a sibling variant and compare it with the previous version. Store the brief, record the model and effort, and retain the failure evidence with the round.

## What would establish the quality claim

Compare the same inexpensive model with and without this workflow, then include an Opus build from the same brief as the reference. Use several Orvane tasks with different interaction shapes and keep hidden review paths outside the model prompt. Compare browser outcomes and have the owner review the anonymous mocks for visual quality, clarity of the landing state, and whether the interaction feels like Orvane. Record cost and time as well. The current mock verifies the replay and repair mechanism on one example. Model quality parity remains a benchmark question.

## Sources

- [Anthropic’s evaluator–optimizer workflow](https://www.anthropic.com/research/building-effective-agents) describes the conditions under which a separate feedback loop adds value.
- [WebArena](https://arxiv.org/abs/2307.13854) evaluates web tasks by whether the intended outcome occurs.
- [Design2Code](https://arxiv.org/abs/2403.03163) studies screenshot-to-frontend fidelity and uses human evaluation alongside automatic metrics. Its benchmark addresses visual reproduction.
- [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer-intro) shows recorded browser actions and their page states.
