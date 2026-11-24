# Shared lessons for Claude and Codex

## What the system learns

Orvane should carry a proven technique from one agent's work into the other agent's next relevant task. The unit of learning is a versioned lesson with a specific trigger, one behavior to try, and a check that can fail. The same lesson can help either provider. The contributor and learner identify the trial's provenance rather than defining permanent strengths or weaknesses.

The first case uses the continuation feature. Claude's r3 mock lets the user open an exact source turn from the destination draft, then return with the typed message intact. Codex's r2 mock has a reference to the entire source and a route back to the draft. The extra technique to learn is **make the round trip part of the design, then prove it at the narrowest supported width**.

The reciprocal case starts from Codex's resize regression. The old pinned composer overflowed by about 130 px at a 470 px panel width. The useful technique is to measure the control bounds during the drag, especially just before the wrap threshold, then repeat at the minimum width. A static before-and-after screenshot can accompany that check.

## Workflow

| Stage | Agent or owner action | What Orvane records |
| --- | --- | --- |
| Compare | An agent selects two outcomes for the same brief and names one observable difference. The owner can open both artifacts in Memory. | Source and baseline versions, context, observed difference, and the owner feedback that prompted the comparison. |
| Propose | The agent writes a trigger, an action, and pass criteria. The owner can discard it or authorize a trial. | A candidate lesson with its author and scope. |
| Apply | The next matching task offers the lesson as a small composer chip. The learner can inspect or remove it. Sending the task supplies the short procedure and links it can read. | A trial bound to one task, one learner, and one lesson version. |
| Verify | The learner attaches a distinct example and the result of the declared check. Interaction checks can report measurements. Design judgment stays with the owner. | The new artifact version, evidence per criterion, and pass, fail, or incomplete verdict. |
| Keep | The owner reviews the trial and can approve the lesson for future matches. A failed trial leaves its evidence available for revision. | An approved version, its outcome history, and any later suspension or replacement. |

The trial should use a different task or fixture from the original comparison. For the navigation lesson, try a pinned draft linked to a prior File Explorer session. Type something new, open an exact turn, return, and compare the draft text and composer focus. Use a narrow panel. Copying the original Browser mock would demonstrate reproduction of the artifact and leave the transfer question open.

## Data and entry points

- **Memory → Shared lessons** joins the existing notes and procedures. Each row shows the state, project, and most recent trial. Review opens the two artifacts, the proposed behavior, and the pass criteria. Use the existing Memory review and disable conventions.
- **Agent Sessions** shows the matched lesson in the composer and records its use in the run activity. The lesson chip contains a short procedure and opens its evidence. The normal composer remains available when there is no match or the chip is removed.
- **UI Maker Lab** keeps the compared HTML and renders in their original rounds. **Agent sessions** keeps CLI transcripts read-only. Evidence references resolve through Orvane's existing artifact and transcript readers. The lesson store can keep a short, explicitly selected excerpt when a reference needs a preview.

Store lifecycle records in the existing local `workspace.sqlite` with a dedicated repository beside `WorkspaceMemoryStore`. The current memory format serves compact owner preferences and procedures. Lessons need separate version and trial history so an approved version's evidence remains stable.

| Record | Fields that matter |
| --- | --- |
| Lesson version | Stable ID, version, contributor, title, scope, trigger, procedure, criteria, baseline references, review state, owner decision, creation date. |
| Evidence reference | Artifact kind, project, stable artifact ID, version or digest, optional bounded anchor such as a transcript turn, and availability. |
| Trial | Lesson version, learner provider and run ID, task ID, context and scope, new artifact version, check outcomes, owner verdict. |

SQLite owns the state transitions and enforces unique trial records for a given lesson version and run. Artifact URLs and paths resolve server-side against the corresponding project and artifact store. An edit to a procedure creates a candidate version. An owner can suspend an active version immediately. Missing evidence marks its check incomplete. Existing trial history continues to point to the original version.

## How the agents receive it

1. An agent uses explicit shared-lesson actions over Orvane MCP to propose a version or attach trial evidence. The server validates the project, artifact identifiers, sizes, state transition, and caller role.
2. The same deterministic lookup serves Claude and Codex. Start with project, task kind and required surfaces such as `ui-mock` and `pinned-chat`. Return at most two relevant approved lessons plus an owner-authorized trial, if selected for that task. An unmatched task keeps its original context.
3. The approved short procedure appears as task context, with provenance and applicable scope. The current request and repository instructions retain precedence. Raw artifact content is loaded only when needed and is always treated as data. Transcript excerpts and model output cannot approve changes, run commands, or alter future instructions.
4. The owner chooses when a trial runs. A trial uses the normal permissions and account of its task. Orvane can record checks from existing Playwright, UI Maker, or Flow tests, but a lesson cannot start either CLI, run a tool, or copy artifacts to another provider by itself.

Use one evidence adapter for UI Maker revisions first and one for test results. Capture provider, run, and task IDs from the application rather than trusting agent-supplied labels. A citation proves where a claim came from. A check result proves only the behavior and environment it actually exercised.

## How to tell whether it helps

- **Design trial:** Codex applies Claude's navigation technique on a different mock. The owner reviews the resulting round trip while the recorder checks source anchor, retained draft text, and restored focus.
- **Resize trial:** Claude applies Codex's timing technique to another responsive control. Verify containment during movement at the wrap threshold and at the published minimum. Include an old-layout failure when possible. A claim without measured bounds stays incomplete.
- Record the before and after outcomes under the same criteria. For subjective criteria, give the owner both versions with the provider labels hidden during review where practical. One passing trial supports a scoped lesson. Repeated failures or changed assumptions send it back for revision.

## First build

1. Add the local records and the owner review surface. Support manually linked UI Maker artifacts and one proposed lesson. Exercise approval, rejection, disable, versioning, and missing evidence.
2. Attach a selected lesson to an Agent Sessions draft and pass it to either CLI through the same context envelope. Record the version used and allow removal before sending.
3. Add trial evidence with separate task IDs and explicit owner review. Add more task scopes only after these two examples produce useful evidence.

The Lab prototypes show this proposed workflow with example trials. The two continuation previews use the existing mock artifacts. The trial actions in the Lab exercise the prototype's local state and do not run either agent.
