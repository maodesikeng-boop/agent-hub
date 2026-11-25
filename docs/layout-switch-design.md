# Layout switch without a rebuild

> Snapshot: 2026-11-26 (commit `f6ab7798`)

## For the user

### Files to review

- [layout-switch-design.md](layout-switch-design.md): Why the workbench loses state when a browser window crosses the one-column width, the fix that keeps one set of components alive and only moves them, the acceptance scenarios, and what gets deleted.
- [src/web/workbench-nav.ts](../src/web/workbench-nav.ts): The one navigation state both layouts read: the page, the open settings section, and the page behind settings. Specs in [workbench-nav.test.ts](../src/web/workbench-nav.test.ts).
- [src/web/shell-surfaces.tsx](../src/web/shell-surfaces.tsx): Surfaces that render once and outlets that each layout places, so a layout switch moves components instead of rebuilding them. Specs in [shell-surfaces.test.tsx](../src/web/shell-surfaces.test.tsx).
- [src/web/surface-set.ts](../src/web/surface-set.ts): Which surfaces exist, computed from navigation alone. Specs in [surface-set.test.ts](../src/web/surface-set.test.ts).
- [src/web/WorkbenchSurfaces.tsx](../src/web/WorkbenchSurfaces.tsx): The host that renders every surface above the layout switch.
- [src/web/settings-drafts.ts](../src/web/settings-drafts.ts): The Providers sign-in sheet and the computer rename draft, shared by both settings presentations (decision 1). Specs in [settings-drafts.test.ts](../src/web/settings-drafts.test.ts).
- [src/web/layout-switch.test.tsx](../src/web/layout-switch.test.tsx): One test per acceptance scenario, each crossing the width twice.
- [scripts/verify-layout-switch.ts](../scripts/verify-layout-switch.ts): The same scenarios in Chromium and WebKit, with paired screenshots and captured requests.

### Decisions needed

**Decision 1: Fix Providers sign-in and computer rename in this line?**

Desktop and phone settings use different components for these two tasks: a dialog versus a drawer for sign-in, and an inline row versus a drawer for rename. A component that does not exist in the other layout cannot be moved there, so its input needs a home outside both.

- **Option A (recommended): include them.** The open sign-in sheet (computer, provider, sign-in or account view) and the rename draft (computer, typed name) move into `settings-drafts.ts`. Both presentations read it. The sign-in form itself becomes a surface, so the chosen method, API key, and pasted code survive the move. A sign-in flow is cancelled only when the user closes the sheet, never when the layout swaps it. Cost: about 200 changed lines plus tests in `ProvidersSettings.tsx`, `ProvidersPage.tsx`, `DeviceSettings.tsx`, `ComputersPage.tsx`, and `settings-model.ts`, and the sign-in flow joins the review scope. `ProvidersSettings.tsx` is on the oversized-file baseline and must not grow, which this change satisfies because state moves out of it.
- **Option B: leave them as known gaps.** Cost: a browser user who resizes across the width in the middle of a sign-in sees the sheet close and must start again, including retyping an API key or pasting a new code. A browser sign-in started in another tab keeps running on the daemon, but this window stops watching it. A half-typed computer name is lost. This only happens in a browser window between about 618 and 791px wide, or on a touch device rotating across the width.

**Decision 2: Should the settings dialog get a history entry too?**

Today the settings dialog changes no URL, while the phone settings page is `#/settings/<section>`. One navigation state needs one rule.

- **Option A (recommended): yes.** Opening settings in either layout pushes `#/settings/<section>` and remembers the page behind it, and browser Back closes settings in both layouts. The desktop apps show no Back button, so they look the same.
- **Option B: no.** The dialog stays out of history, so the one-column layout has to add a history entry when it takes over open settings. That is a write caused by the layout switch, which breaks the invariant this plan rests on, and Back in one column behaves differently depending on where settings was opened.

## For Workers and reviewers

### 1. User goal

The user's words:

- After the third review of PR #448 found that the Router's selected project was lost when the layout switched: 「这个新问题是这次引入的吗」
- After the fourth review found more state lost on a switch, the user chose on the decision card: 「A：先合并，根因另开一条线马上做」. Option A read: 先合并 #448，根因另开一条线马上做：切换布局时不再重建，导航和草稿放到布局外面，切换只换排版，同时删掉这次逐个搬运的代码。

Outcome: crossing the one-column width in either direction keeps every page, open setting, and unsaved input exactly as it was, because the components stay mounted and only move. Navigation and drafts live above the layout. The per-field carry code from #448 is deleted in the same PR.

### 2. Current state

All `[Measured]` findings come from reading `f6ab7798` and from runs noted inline.

- `[Measured]` `App` renders `<ShellCarryScope key={mobile ? "mobile" : "desktop"}>` around `MobileWorkbench` or `DesktopWorkbench` (`src/web/App.tsx:641-663`). The key change and the different component types rebuild everything under it on every switch.
- `[Measured]` The two shells place the same components at different tree positions. `RouterWorkbench` sits in `main` under `shell-frame` on desktop (`App.tsx:283-297`) and in the phone body (`App.tsx:499-516`). The PM settings pages render through `WorkPanelTabsSheet` from `DesktopWorkPanel` and from `MobileWorkPanel` (`src/web/components/WorkPanelShell.tsx:253`, `:323`). `ProjectList`, `ConversationPane`, and the Worker `WorkPanel` follow the same pattern with a `layout` or `mobile` prop. Same component, same props apart from layout, different parents.
- `[Measured]` `useShellCarry()` (`src/web/shell-carry.tsx:25-43`) copies a value from the old tree to the new one only when the new instance renders in the task that swaps them. `git grep -n useShellCarry` finds 23 calls in 10 files: `AccountSettings`, `CapabilitiesPanel`, `CapabilitiesSettings`, `InfoTab`, `PmMemoryFilesGroup`, `ProjectGroups`, `ResourcesSettings`, `RouterWorkbench`, `ScheduleGroup`, and `pm-persona.ts`.
- `[Measured]` Navigation is rewritten by the switch. Entering one column turns an open dialog into the route `#/settings/<section>` and replaces the page under it (`src/web/settings-nav.ts:58-63`). Entering columns turns any settings route into the dialog and replaces the route with `#/router` (`src/web/shell-model.ts:271-274`), and a null route becomes `#/router` (`shell-model.ts:262-264`). The fourth review reproduced the result in Chromium and WebKit: Persona at 900px, Settings → Capabilities, 675px, back to 900px, close Settings, and the workbench shows Router with the Persona draft gone.
- `[Measured]` `layout` leaks into what is selected, not only where it shows: `routerActive` and `active` read `autoSelect` (`shell-model.ts:184`, `:194`), so the same route resolves to different content per layout.
- `[Measured]` Settings has two presentations. Columns: `SettingsDialog` with six tabs and its own `activeSection` state synced from props (`src/web/components/SettingsDialog.tsx:67-80`). One column: `MobileSettings` with a home list and ten subpages (`src/web/mobile/settings/MobileSettings.tsx:68-89`). `CapabilitiesSettings`, `ResourcesSettings`, and `AccountSettings` are the same component in both. Providers sign-in is a `Dialog` inside `ProvidersSettings` (`ProvidersSettings.tsx:1109-1168`) versus a `SettingsDrawer` inside `ProvidersPage` (`ProvidersPage.tsx:33-112`); both wrap the same `ProviderSignInBody`. Rename is `RenameRow` inline (`DeviceSettings.tsx:13`, `:55`) versus `RenameForm` in a drawer (`ComputersPage.tsx:39`, `:114-135`); both use `useDeviceRename()`, which keeps the typed name in `useState` (`settings-model.ts:173-174`).
- `[Measured]` The project list search moved into the shell model only so it could cross the switch (`shell-model.ts:170`, #448 commit message: "because the phone list mounts later, behind `<Activity>`").
- `[Measured]` The Router `@` target lives in the draft slot with the text, and the automatic reload saves and restores it (`src/web/auto-reload.ts:15-19`, `src/web/upload.ts`). That is the draft itself, not carry code, and it stays.
- `[Measured]` A portal into a persistent element keeps its React state when the element moves between parents. A throwaway Vitest run on this commit rendered an input through `createPortal` into one element, typed `hello`, swapped the outer layout twice (including a pass with no outlet and the surface hidden in `<Activity>`), and read `hello` back each time. With outlets placed before the host in tree order, the input's layout effect saw a connected element. Focus did not survive the move: `document.activeElement` was `BODY` afterwards.
- `[Inferred]` Moving a scrolled element out of the document resets its scroll offset. The conversation list sticks to the bottom on its own; other panes reopen at the top, as the #448 audit already accepts.

### 3. Approach comparison

| | A. Surfaces with outlets (recommended) | B. One tree, CSS-only layout | C. Keep two shells, move every draft into stores |
| --- | --- | --- | --- |
| Components rebuilt on a switch | None of the surfaces | None, if every position matches | All |
| Work per new stateful field | None | None | One store field each, forever |
| Covers state nobody listed | Yes | Yes | No, the #448 failure mode |
| Resizable panes | Unchanged; outlets sit inside panes | The pane library would have to lay out one column too, which it does not support | Unchanged |
| Visual change | None | Risky: the phone layout is not a CSS variant of the desktop one | None |
| Settings presentations that differ (sign-in, rename) | Need a shared draft (decision 1) | Same | Same |

For A, the mechanism is about 80 lines in `shell-surfaces.tsx`. The library `react-reverse-portal` implements the same idea, but it would be a new dependency for 80 lines and its React 19 support is not stated, so the plan writes it in-house. AGENTS.md prefers libraries for state machines and caches; this is neither.

Recommendation: A. Each stateful region renders once in a host above the layout switch (`WorkbenchSurfaces`). Each layout places `SurfaceOutlet`s where the region should appear. A layout switch unmounts one set of outlets and mounts the other in the same commit; the surfaces' elements move and their React trees stay. A surface with no outlet stays mounted inside a hidden `<Activity>`, so its state is kept and its effects pause. Navigation moves to `workbench-nav.ts`, which never reads the layout. Which surfaces exist is a pure function of navigation (`surface-set.ts`), so a switch cannot change it.

What becomes a surface:

| Surface | Contents | Key that remounts it |
| --- | --- | --- |
| `list` | `ProjectList` | Never |
| `router` | `RouterWorkbench` | Never |
| `conversation` | `ConversationPane` for the active PM conversation | Conversation key |
| `panel` | `WorkPanelTabsSheet` with the PM's Info pages | `device:pmId` |
| `worker` | Worker `WorkPanel` with `WorkerPane` | Worker conversation key |
| `settings:capabilities`, `settings:resources`, `settings:account` | The shared settings bodies | Never while settings is open |
| `settings:provider-sheet` | `ProviderSignInBody` or `ProviderAccountBody` (decision 1, A) | `device:vendor:mode` |

What stays per layout: `AppRail`, `TabBar`, the pane group and handles, the dialog or page chrome around settings, `MobileShell`, and the phone drawer flag. None of them hold user input.

Navigation rules:

- `WorkbenchNav` is `{ page, settings }`. `page` is never a settings route. With settings open, the URL is `#/settings[/<section>]` and the history entry's state records the page behind it, so a reload restores both. A bare `#/settings/<section>` link opens settings over the layout's default page.
- The default for `page === null` is resolved at render: Router in columns, the project list in one column. Nothing writes it back.
- Settings sections stay fine-grained (`SettingsSection`). The dialog shows the tab that contains the section. Picking a tab keeps the current section when it belongs to that tab, otherwise it takes the tab's first section, so a phone user on Notifications who widens and narrows again returns to Notifications.
- Closing settings returns to `page`. In one column, Back from a section goes to the settings home, and Back from the home closes settings.

### 4. Performance and bounds

None of the four cache rules gain a new collection:

1. Invalidation: surfaces unmount when navigation drops them, as today; the settings draft store clears on close and on success.
2. Upper bounds: the surface set is a closed union of 9 ids with at most one instance each. The settings draft store holds at most one sheet and one rename. No new `limits.ts` constants.
3. Stable references: `useWorkbenchNav()` returns the same `nav` object while the URL and history state are unchanged; `surfaceSetOf()` is memoized per nav and keys.
4. Measured verification: record the commit time of a switch at 900 → 675px in Chromium, before and after, using the React Profiler in `verify-layout-switch.ts`, and rerun `scripts/bench-message-list.ts` to show the conversation surface renders no slower inside a portal.

A surface hidden in one column stays mounted with its effects stopped. The extra cost is the fiber tree of at most four hidden regions, all of which the desktop layout already keeps mounted at once.

### 5. Cross-vendor and cross-platform unification

Web only. Vendors are untouched. The macOS and Windows windows stop at 860px and never reach one column; browsers on all three platforms run the same code. No future vendor implements anything here.

### 6. Deletions

In the implementation PR:

- `src/web/shell-carry.tsx` and `src/web/shell-carry.test.tsx`.
- Every `useShellCarry` call (23 in 10 files) returns to `useState`.
- `ShellCarryScope` and its `key` in `App.tsx`.
- `src/web/settings-nav.ts`: `useSettingsNav`, `dialogTargetOf`, `pageRouteOf`, `ROUTE_SECTION_OF`, and the effect that turns the dialog into a route. Callers use `workbench-nav.ts`.
- In `shell-model.ts`: the effect that turns a settings route into the dialog plus `#/router` (`:271-274`), the null-route write (`:262-264`), the `autoSelect` reads that choose content, and `listQuery` with `setListQuery`, which return to `ProjectList` state.
- In `SettingsDialog.tsx`: `activeSection`, `prevSyncRef`, and `defaultSection`; the section becomes a controlled prop from navigation.
- The separate `desktop.providerDevice` and `mobileProviderDevice`; one `settings.providerDevice` replaces them.
- The "Swapping shells remounts everything below `App`" list in `docs/workbench-shell-design.md`, replaced with a link here.
- With decision 1 as A: the `modal` state in `ProvidersSettings`, the drawer target and `modeOverride` in `ProvidersPage`, `renaming` in `DeviceRow`, and the rename drawer target in `ComputersPage`.

Kept on purpose: the Router `@` target in the draft slot, because it is the draft and the automatic reload depends on it.

Proof in the PR: `git grep -n -E "useShellCarry|ShellCarryScope|shell-carry|useSettingsNav|dialogTargetOf|pageRouteOf|setListQuery"` prints nothing.

### 7. Skeleton files

- `src/web/workbench-nav.ts`: `WorkbenchNav`, URL and history-state parsing, the dialog tab mapping, and the `useWorkbenchNav()` actions.
- `src/web/workbench-nav.test.ts`: `it.todo` specs for parsing, reload, defaults, tab mapping, and Back.
- `src/web/shell-surfaces.tsx`: `SurfaceScope`, `Surface`, `SurfaceOutlet`, and the `SurfaceId` union.
- `src/web/shell-surfaces.test.tsx`: `it.todo` specs for state across moves, hidden surfaces, focus, and the one-outlet rule.
- `src/web/surface-set.ts`: `SurfaceSet` and `surfaceSetOf()`, with no layout input.
- `src/web/surface-set.test.ts`: `it.todo` specs for each surface's presence and keys.
- `src/web/WorkbenchSurfaces.tsx`: the host component's props.
- `src/web/settings-drafts.ts`: the provider sheet and rename draft store.
- `src/web/settings-drafts.test.ts`: `it.todo` specs, including that a swap never cancels a sign-in.
- `src/web/layout-switch.test.tsx`: `it.todo` acceptance scenarios beside the existing tests.
- `scripts/verify-layout-switch.ts`: the browser run's entry and options.

### 8. Verification plan

Acceptance scenarios. Each one crosses the width twice: 900 → 675 → 900 → 675 → 900px at `Default` with a mouse, and also at the scale's own threshold (618, 676, 733, and 791px) once.

1. **Router target (third review).** On Router at 900px, type `@agent`, pick `agent-hub`, type a command. Narrow and widen twice. The Router page shows the same text and the `agent-hub` chip after each move. Press Enter. The captured `POST /api/router/commands` carries the text and `target: { pmId, projectId }`, and the chip clears. Repeat with the send made in one column.
2. **Persona behind Settings (fourth review).** At 900px open a PM's Persona page, type text without saving, open Settings, pick Capabilities, choose the Router scope. Narrow: the Capabilities page shows with Router picked. Widen: the dialog is on Capabilities with Router picked. Repeat. Close Settings: the URL is `#/pm/<id>/persona`, the typed Persona text is there, and Save is enabled. Variant: close Settings with Back while in one column, then widen.
3. **Router tray.** Open the second decision card and type a reply; separately, keep an unsent reply on a card another client resolves. After two round trips the same card is open with the reply, and the closed card still shows its reply.
4. **Project list search.** Type a search. After two round trips the column and the phone list page both show it.
5. **PM settings pages.** Unsaved Model vendor, model, and effort; Persona text; an open Schedules form with daily and interval fields; a Memory file being edited and a new file form; the Worktree setup command; the Capabilities search. Each survives two round trips.
6. **Settings choices.** Capabilities scope (Project defaults, Router, a project and its pick), the Resources computer, and a custom relay URL survive two round trips. Changing the scale to Large in a 700px window lands on the Interface scale page.
7. **Composer drafts.** PM and Worker composer text, the `/hub:worker` pick, and a staged attachment survive two round trips.
8. **Automatic reload after a switch.** After two round trips, trigger the automatic reload. The composer drafts and the Router target come back as they do without a switch.
9. **Navigation round trips.** Starting from Router, a PM conversation, a Worker, a PM settings page, and Settings over each: after two round trips the URL and the page match the start, and Back walks the same entries as without a switch.
10. **Providers sign-in (decision 1, A).** Settings → Providers → sign in, choose API key, type a key. After two round trips the sheet is open on the same provider and method with the key. No cancel request is sent. Closing the sheet by hand sends the cancel.
11. **Computer rename (decision 1, A).** Start renaming, type a name. After two round trips the editor is open with the typed name.
12. **No layout regression.** The 42 width and touch measurements from the previous round, taken with that round's script, match `f6ab7798` exactly, and at 860px all four scales keep the PM column at its minimum.

Evidence:

- `src/web/layout-switch.test.tsx`: one test per scenario 1 to 11. Besides the visible value, each test holds the input's DOM element from before the first switch and expects the very same element after every switch, which only a move can satisfy. So every scenario fails on `f6ab7798`, including those whose values the carry code keeps today. Record the failing run with the tests applied to `f6ab7798` alone.
- `src/web/workbench-nav.test.ts`, `src/web/shell-surfaces.test.tsx`, `src/web/surface-set.test.ts`, `src/web/settings-drafts.test.ts`: every `it.todo` becomes a passing test.
- `scripts/verify-layout-switch.ts` in Chromium and WebKit against a build of `f6ab7798` and against the change: the viewport resized in steps with a mouse pointer, a before/after screenshot pair per scenario, and the captured request bodies for scenarios 1 and 10, written to an output folder listed in the report.
- The 42 measurements rerun with the previous script and compared line by line with its `f6ab7798` output.
- The `git grep` deletion proof above.
- `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify --composer-layout`, and `pnpm ui:polish`, then green cloud checks on the PR.
