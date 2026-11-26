# Keep the workbench mounted across layout changes

> Snapshot: 2026-11-26 (commit `f6ab7798`)

The workbench switches between one column and several columns when the browser crosses the current scale's width threshold. Before this change, replacing the shell also replaced its React subtree. For example, closing Settings after a resize returned to Router and lost an unsaved PM Persona edit. The implementation keeps the same content and changes where it appears.

The approved scope includes open provider sign-in forms and computer renames. Desktop Settings uses browser history so Back can return to the page behind it.

## Component ownership

[WorkbenchSurfaces](../src/web/WorkbenchSurfaces.tsx) renders the top-bar Router input, ProjectList, Router, the PM conversation and panel, the Worker page, and shared settings content beside the layout components. [Each surface](../src/web/shell-surfaces.tsx) renders into one persistent DOM node. The layout places that node through an outlet. A surface without an outlet keeps its state in a hidden React Activity, which pauses its effects until it becomes visible. The host and the layout share a fixed set of outlet IDs; only one outlet can show an ID at a time.

Conversation, panel, and Worker identities come from the selected page and device. A layout switch does not change their keys. For example, the PM panel stays mounted while narrow Settings covers it, so closing Settings reveals the same Persona editor. Search and the other editor state now live in their own components. Composer drafts, attachments, and the Router `@` target use their existing conversation slots. The automatic reload still saves and restores composer text, model picks, and the Router target.

Providers keeps one sign-in or account sheet. The same form moves between the desktop dialog and the narrow drawer. Swapping presentation does not cancel an authentication flow; explicitly closing a sign-in sheet cancels a flow owned by this browser. Login inputs stay in memory. The two computer rename editors use the same in-memory draft and retain their existing inline and drawer presentation.

[WorkbenchSettings](../src/web/WorkbenchSettings.tsx) owns one Vendor sync session while Settings is open. Both the Providers dialog and the dedicated Vendor sync page read the same preview, item selections, request status, and result. An open Providers preview stays over Providers in one column. Opening the dedicated Vendor sync page starts with the current workbench computer. Resizing with either view open keeps the scan and apply requests on the selected computer. A different computer or a full page reload requires a fresh scan.

## Settings state audit

Both layouts use the same page state or choose how to display it from the current settings section. The following covers the state owned by each Settings page and its controls.

| Settings page | State and owner | What happens on resize |
| --- | --- | --- |
| General: Interface scale | The [scale store](../src/web/settings-model.ts#L83) holds the selection used by the desktop row and single column page. | Both read the same saved scale. |
| General: Notifications | [Notification preferences](../src/web/notify.ts#L150) hold permission and the enabled setting. Both views receive the same model. | Both read the same permission and preference. |
| General: Updates | The [update model](../src/web/update-model.ts#L24) shares the status query and version dismissal. Each [Updates view](../src/web/components/UpdateSettings.tsx#L75) observes its own manual check. | A resize may clear that view's spinner or error. A completed check still writes its result to the shared query. Checking again has no effect on the installed version. |
| Providers: list and computer | [The provider model](../src/web/settings-model.ts#L863) holds the selected computer, action errors, busy action, and running job and flow IDs. [Provider rows](../src/web/components/ProvidersSettings.tsx#L75) hold installation log expansion. | Both use the same model and row instances while Providers is open. |
| Providers: sign in and account | The [sheet model](../src/web/settings-drafts.ts#L11) holds the open sheet and mode. The [form](../src/web/components/ProvidersSettings.tsx#L301) holds the target, method, variant, API key, manual code, and flow, error, and copy state. [Account actions](../src/web/components/ProvidersSettings.tsx#L843) hold their busy indicator and error. | Both move the same sheet body. Changes to the dialog or drawer leave the form and request state intact. |
| Providers: Vendor sync | The [sync model](../src/web/settings-model.ts#L602) holds the preview and its computer, checked MCP servers and skills, summary, and scan and apply mutations. | Both read the same session. The dialog and page have their own focus and scroll positions. |
| Capabilities | The [shared page](../src/web/components/CapabilitiesSettings.tsx#L15) holds the scope and project selection. | Both move the same page. |
| Resources | The [shared page](../src/web/components/ResourcesSettings.tsx#L404) holds the computer and pending discard, including the [branch checkbox](../src/web/components/ResourcesSettings.tsx#L334). The [resource model](../src/web/resources-model.ts#L164) holds action errors, pending actions, and cleanup results. Storage and kept resource groups hold their expansion in [CollapsibleGroup](../src/web/components/SettingsList.tsx#L59). | Both move the same page and its controls. |
| Computers: account and relay | The [shared account page](../src/web/components/AccountSettings.tsx#L61) holds the custom relay choice and URL. The [account model](../src/web/settings-model.ts#L228) holds action errors and pending status. | Both move the same account controls. |
| Computers: rename | The [rename model](../src/web/settings-drafts.ts#L25) holds the device and draft name. The [inline editor](../src/web/components/DeviceSettings.tsx#L14) and [drawer form](../src/web/mobile/settings/ComputersPage.tsx#L33) each observe their own [save status](../src/web/settings-model.ts#L173). | The name stays editable in both views. A submitted save continues and refreshes the device list on success. A local spinner or error may reset when the other editor appears. No name is discarded. |
| Computers: removal | The [desktop row](../src/web/components/DeviceSettings.tsx#L54) holds the remove confirmation. The [mobile drawer](../src/web/mobile/settings/ComputersPage.tsx#L114) holds its target and [menu or confirmation step](../src/web/mobile/settings/ComputersPage.tsx#L76). Both have local [removal status](../src/web/settings-model.ts#L206). | A resize closes an unsubmitted confirmation, so the user confirms again in the current layout. A submitted removal still refreshes the device list on success. |
| Security & Access: sign in on another device | [Desktop](../src/web/components/BrowserSessions.tsx#L10) and [single column](../src/web/mobile/settings/SignInPage.tsx#L12) each hold a [generated link and QR code](../src/web/settings-model.ts#L288), its expiration, the browser session baseline, and the request and copy feedback. | The displayed link can reset. The link contains no draft input, and the user can generate another. A link already copied still follows its original expiration. |
| Security & Access: signed-in browsers | [Desktop](../src/web/components/BrowserSessions.tsx#L64) holds list expansion and inline confirmations. The [single column page](../src/web/mobile/settings/BrowsersPage.tsx#L18) holds its confirmation drawer target and sign out all flag. The [browser session model](../src/web/settings-model.ts#L388) shares the session query, with local mutation status, errors, and confirmation timers. | The list can collapse and a confirmation closes so the user confirms again. A submitted sign-out still updates the shared list or signs out the current browser. |

The Settings shell can reset scroll, open menus, and focus owned by its dialog, tabs, or page header. These controls hold no settings values. Shared page controls and drafts belong to the components listed above.

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
| Top-bar Router | In a PM conversation, send a message from the top bar, then type an unsent top-bar draft and an unsent follow-up in the reply popover. One column has no top bar. After both trips, the same input shows the draft, and the popover shows the turn and the follow-up. |
| Router tray | Open the second decision and type a reply. For the closed-card case, type a reply, then close the decision from another client. The selected article and the closed card's unsent reply remain visible. |
| Project search | Enter a search in the PM list. After resizing, the search is still present both in the column and when the one-column project list is visible. |
| PM settings | Change Model provider, model, and effort; edit Persona; enter daily and interval schedules; edit or add a memory file; type a Worktree setup command and a Capabilities search. Each unsaved change stays in its page. |
| Settings selections | Select a Capabilities scope or project, choose another computer in Resources, and type a custom relay URL in Computers. The values remain. Change the scale to Large from 700px and check that the narrow view opens on Interface scale. |
| Composer drafts | Enter text, stage an attachment, and choose a `/hub:worker` model in the PM composer. Enter text and stage an attachment in a Worker composer. Both drafts survive. |
| Automatic reload | Select a Router project and type text. After resizing, trigger a daemon resync with a new boot ID. The automatically reloaded page restores the draft and its target. |
| Navigation | Open Router, a PM conversation, a Worker, a PM settings page, and Settings over those pages. Resizing leaves their address and Back entries intact. |
| Provider sign-in | In Settings → Providers, type a sample API key or start browser sign-in and paste a sample code. The same sheet, method, and input remain. A resize sends no cancel request; closing the active browser sign-in sends one. |
| Vendor sync | In desktop Settings → Providers, select another computer, click **Scan…**, and clear one skill. After both trips, the preview shows the same choices. Click **Sync** in one column. The captured request goes to the selected computer and puts the cleared skill in the removal list. Repeat starting in the single column Vendor sync page and applying in columns. |
| Computer rename | Start renaming a computer. The inline editor and drawer show the same unsaved name on each round trip. |
| Width and touch | Cross each scale's cutoff and open a PM on mouse and touch viewports. At 860px, compare the PM column at all four scales with the baseline. |

Run [the integration tests](../src/web/layout-switch.test.tsx) and [the two-browser script](../scripts/verify-layout-switch.ts). The script writes paired screenshots and captures Router, provider sign-in, and Vendor sync requests. Run it on a build of `f6ab7798` with `--label before` and the current build with `--label after`. The baseline already preserved the Router target with its draft; DOM identity assertions distinguish that behavior from keeping the editor mounted.
