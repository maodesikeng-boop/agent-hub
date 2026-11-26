# Keep the workbench mounted across layout changes

> Snapshot: 2026-11-26 (commit `f6ab7798`)

The workbench switches between one column and several columns when the browser crosses the current scale's width threshold. Before this change, replacing the shell also replaced its React subtree. For example, closing Settings after a resize returned to Router and lost an unsaved PM Persona edit. The implementation keeps the same content and changes where it appears.

The approved scope includes open provider sign-in forms and computer renames. Desktop Settings uses browser history so Back can return to the page behind it.

## Component ownership

[WorkbenchSurfaces](../src/web/WorkbenchSurfaces.tsx) renders ProjectList, Router, the PM conversation and panel, the Worker page, and shared settings content beside the layout components. [Each surface](../src/web/shell-surfaces.tsx) renders into one persistent DOM node. The layout places that node through an outlet. A surface without an outlet keeps its state in a hidden React Activity, which pauses its effects until it becomes visible. The host and the layout share a fixed set of outlet IDs; only one outlet can show an ID at a time.

Conversation, panel, and Worker identities come from the selected page and device. A layout switch does not change their keys. For example, the PM panel stays mounted while narrow Settings covers it, so closing Settings reveals the same Persona editor. Search and the other editor state now live in their own components. Composer drafts, attachments, and the Router `@` target use their existing conversation slots. The automatic reload still saves and restores composer text, model picks, and the Router target.

Providers keeps one sign-in or account sheet. The same form moves between the desktop dialog and the narrow drawer. Swapping presentation does not cancel an authentication flow; explicitly closing a sign-in sheet cancels a flow owned by this browser. Login inputs stay in memory. The two computer rename editors use the same in-memory draft and retain their existing inline and drawer presentation.

## Navigation and history

[Workbench navigation](../src/web/workbench-nav.ts) reads the page and optional Settings overlay from the URL and history. An open overlay uses `#/settings[/<section>]`. The history entry remembers the page behind it, including the device, so Settings can close onto that page even after a reload.

Opening Settings from a page pushes an entry. Opening a section from Settings home adds one level; switching directly between sections replaces that entry. Desktop Close returns to the page behind Settings. In one column, the Settings button in a section header returns to Settings home; browser Back from home returns to the previous page. A direct settings link without a previous workbench page can close to the default page. When no page is selected, columns display Router and the single column displays the project list without changing the URL.

A settings section retains its own hash even if desktop groups it under a more general tab. For example, a mobile Notifications page maps to the desktop General tab; narrowing again shows Notifications. Resizing never writes history.

## Acceptance scenarios

At Default scale, start at 900px. Narrow to 675px, widen to 900px, then repeat. The section, text, and selection should match after each move. The browser harness also checks that shared editors and controls keep the same DOM node.

| Scenario | Steps and expected result |
| --- | --- |
| Router target | In Router, type `@agent`, choose `agent-hub`, and type a draft. After both trips, press Enter. The captured command has the draft and the selected PM and project IDs. Repeat with Enter in one column. |
| Persona behind Settings | Edit a PM's Persona without saving. Open Settings → Capabilities and select Router. After both trips, the Capabilities selection is still Router. Close Settings to see the original Persona text and enabled Save button. In one column, use the Settings header button, then browser Back. |
| Router tray | Open the second decision and type a reply. For the closed-card case, type a reply, then close the decision from another client. The selected article and the closed card's unsent reply remain visible. |
| Project search | Enter a search in the PM list. After resizing, the search is still present both in the column and when the one-column project list is visible. |
| PM settings | Change Model provider, model, and effort; edit Persona; enter daily and interval schedules; edit or add a memory file; type a Worktree setup command and a Capabilities search. Each unsaved change stays in its page. |
| Settings selections | Select a Capabilities scope or project, choose another computer in Resources, and type a custom relay URL in Computers. The values remain. Change the scale to Large from 700px and check that the narrow view opens on Interface scale. |
| Composer drafts | Enter text, stage an attachment, and choose a `/hub:worker` model in the PM composer. Enter text and stage an attachment in a Worker composer. Both drafts survive. |
| Automatic reload | Select a Router project and type text. After resizing, trigger a daemon resync with a new boot ID. The automatically reloaded page restores the draft and its target. |
| Navigation | Open Router, a PM conversation, a Worker, a PM settings page, and Settings over those pages. Resizing leaves their address and Back entries intact. |
| Provider sign-in | In Settings → Providers, type a sample API key or start browser sign-in and paste a sample code. The same sheet, method, and input remain. A resize sends no cancel request; closing the active browser sign-in sends one. |
| Computer rename | Start renaming a computer. The inline editor and drawer show the same unsaved name on each round trip. |
| Width and touch | Cross each scale's cutoff and open a PM on mouse and touch viewports. At 860px, compare the PM column at all four scales with the baseline. |

Run [the integration tests](../src/web/layout-switch.test.tsx) and [the two-browser harness](../scripts/verify-layout-switch.ts). The browser harness writes paired screenshots and captured Router and provider requests. Run it on a build of `f6ab7798` with `--label before` and the current build with `--label after`. The baseline already preserved the Router target with its draft; DOM identity assertions distinguish that behavior from keeping the editor mounted.
