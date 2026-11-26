# Top-bar Router input and reply popover

> Snapshot: 2026-11-25 (commit `25fa8da4`)

Bellwood's desktop shell already reserves a `40px` wood top bar above the rail and panels, and native macOS centers the window traffic lights in it. This plan adds the centered quick Router input to that bar and the anchored reply popover beneath it so you can message Router from any project without leaving the current page.

## For the user

### Files to review

- [docs/router-topbar-design.md](router-topbar-design.md): This plan: locked visual and interaction rules, the settled product details, architecture trade-offs, bounds, deletions, and verification plan.
- [docs/ui-standard.md](ui-standard.md) sections 1, 2.4, 10, 16, and 21.1: The visual tokens, spacing, contrast math on the dark frame wood, dialog chrome rules, and popover geometry written before implementation.
- [docs/README.md](README.md): Adds this design document to the documentation index.
- [src/web/limits.ts](../src/web/limits.ts): Adds `TOPBAR_ROUTER_POPOVER_TURNS_MAX`, `TOPBAR_ROUTER_INPUT_MAX_REM`, and `TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM`.
- [src/web/ui/popover.tsx](../src/web/ui/popover.tsx): Re-exports `PopoverAnchor` from `@radix-ui/react-popover` so the popover anchors to the text input container without button trigger semantics.
- [src/web/router-commands.ts](../src/web/router-commands.ts) and [src/web/router-commands.test.ts](../src/web/router-commands.test.ts): Shared React Query command and retry mutations, the optimistic pending turn builder, and the retry state that `RouterWorkbench` and `RouterTopBar` read from one cache.
- [src/shared/api.ts](../src/shared/api.ts), [src/shared/router.ts](../src/shared/router.ts), [src/daemon/ui-server/schemas.ts](../src/daemon/ui-server/schemas.ts), [src/daemon/router/plan-base.ts](../src/daemon/router/plan-base.ts), and [src/daemon/router/dispatcher.ts](../src/daemon/router/dispatcher.ts): The optional `routerOnly` flag on `POST /api/router/commands`, kept in `plan.routerOnly` so a retry plans the same way.
- [src/daemon/ui-server/routes-router.ts](../src/daemon/ui-server/routes-router.ts) and [src/daemon/router/dispatcher.ts](../src/daemon/router/dispatcher.ts): `POST /api/router/commands/:id/retry` takes `{ retryId, fromRetryId }` and starts a run only when the command is failed and its `plan.retryId` equals `fromRetryId`. The new run records `retryId` in `plan.retryId`, so a repeated or stale retry request is rejected with `conflict`.
- [src/web/router-topbar-model.ts](../src/web/router-topbar-model.ts) and [src/web/router-topbar-model.test.ts](../src/web/router-topbar-model.test.ts): Pure quick-chat session state, turn projection, message validation, draft handoff on `Expand`, and outside-press dismissal policy.
- [src/web/router-stream.ts](../src/web/router-stream.ts): Adds `routerTurnsOf`, the local Router's live turns cached per commands array, so the top bar never runs the fleet stream merge, and `runRetryIdOf`, the id of the retry that started a command's current run.
- [src/web/styles.css](../src/web/styles.css), [src/web/lib/palette.test.ts](../src/web/lib/palette.test.ts), and [src/web/selectors-cache.test.ts](../src/web/selectors-cache.test.ts): The top-bar tokens, safe-gutter grid, and field states, with their contrast and reference-stability guards.
- [src/web/ui/dialog.tsx](../src/web/ui/dialog.tsx), [src/web/components/Deliverables.tsx](../src/web/components/Deliverables.tsx), and [scripts/verify-window-drag.ts](../scripts/verify-window-drag.ts): A press on a control in the window chrome closes the Settings page and keeps its focus; `CardNoteForm` takes a label, a placeholder, and an invalid reason for the popover reply row; the smoke check drags on the wood beside the input.
- [test/ui-polish/screens.ts](../test/ui-polish/screens.ts) and [test/ui-polish/patches.ts](../test/ui-polish/patches.ts): The `router.quick-*` screens and the `router-quick-working` and `router-quick-reply` patches that answer the top-bar POST.
- [src/web/components/RouterTurnRow.tsx](../src/web/components/RouterTurnRow.tsx): Shared turn renderer (user bubble, Router header, clickable destinations, Markdown reply, retry row, and inline `ForwardReply`) reused by `RouterStream` and `RouterTopBarPopover`.
- [src/web/components/RouterTopBar.tsx](../src/web/components/RouterTopBar.tsx), [src/web/components/RouterTopBarPopover.tsx](../src/web/components/RouterTopBarPopover.tsx), and [src/web/router-topbar.test.tsx](../src/web/router-topbar.test.tsx): Top-bar Router input component, anchored quick-reply popover component, and integration `it.todo` specification.

### Decisions needed

None. The user locked the two core choices on 2026-11-25 (cards #292 and #293), and the seven secondary details were settled on 2026-11-26 by taking every recommended option (A):

- **Appearance.** The `40px` wood top bar holds a centered `35rem` (`560px` at `Compact`) translucent input that blends into the dark wood at rest (`b`) and turns solid with a crisp focus ring while typing (`d`), led by Router's pixel bell and the placeholder `Message Router…`.
- **Interaction.** Sending keeps you on the current page, opens a popover below the input with Router's reply, lets you keep chatting inside it, and offers `Expand` to open `#/router`.

1. **Turns in the popover.** Only the turns sent in the open quick-chat session, oldest first and capped at `TOPBAR_ROUTER_POPOVER_TURNS_MAX = 20`. Closing the popover resets the session, and every turn stays in `#/router`.
2. **Follow-ups.** A full-bleed reply row at the bottom of the popover (`Reply to Router…`, `Enter` sends, `Shift+Enter` adds a newline) takes focus when the popover opens. The top-bar input clears after sending, and a new line typed there joins the open popover.
3. **`#/router`.** The `40px` wood top bar stays so the frame and the traffic lights never shift, the quick input hides, and `Expand` or any navigation to `#/router` closes the popover.
4. **Settings page.** The input stays visible above Settings. Blank wood still drags or zooms the window without closing Settings, and clicking the input closes Settings and focuses the input.
5. **Mobile shell.** `RouterTopBar` renders once as the `topbar` workbench surface, and only `DesktopWorkbench` places it, through `SurfaceOutlet`. The phone keeps the `Router` tab in its `TabBar`. When the window narrows to one column and widens again, the same input returns with its unsent draft, and an open popover returns with its turns and unsent follow-up.
6. **Dismissal.** The popover is a non-modal Radix `Popover` that closes on an outside click (except on the top-bar input or inside an open dialog such as `FilePreview`), `Escape`, `Close`, `Expand`, or a PM or Worker destination click. Closing never cancels a running Router command. `Escape` and `Close` return focus to the top-bar input, and an outside click leaves focus where it landed. While the popover is open, `Tab` from the top bar moves into the popover and `Shift+Tab` from its first control moves back, so the keyboard path between them never closes it.
7. **What the quick input does.** Plain text, retry for unsent and failed turns, clickable destinations, and live `ForwardReply`. `@` targets, attachments, `Needs You` cards, and the model picker stay in `#/router`. Every quick message is sent with `routerOnly: true`, so Router itself plans a typed or pasted `@name` instead of the daemon forwarding it straight to that project.

## For Workers and reviewers

### 1. User goal

> 外层的顶部宽一点，有包裹感，留一个框……不过我们的作用是直接私信 router
> 顶部的输入栏忘记了，没有加上

The user wants a centered quick-message input built into the `40px` desktop wood top bar that blends into the wood at rest, turns solid with a focus ring while typing, and opens an anchored reply popover below it for live Router responses, follow-up turns, and one-click expansion to `#/router`.

### 2. Current state

- [Measured] `DesktopWorkbench` renders an empty `aria-hidden="true"` `<div data-window-drag className="shell-topbar shrink-0" />` above the rail and panels (`src/web/App.tsx:263`). Read from source.
- [Measured] `.shell-topbar` sets `height: var(--topbar-height)` (`40px`) and `pointer-events: auto` so window dragging works even when a modal page dialog sets `pointer-events: none` on `body` (`src/web/styles.css:141`, `:1321-1324`). `src/web/ui/ui-standard.test.tsx:266-267` asserts both `--topbar-height: 40px;` and `.shell-topbar { height: var(--topbar-height);`. Read from source.
- [Measured] Dark frame wood uses `--wood-top: #5f3302`, `--wood-bottom: #542d00`, `--rail-ink: #fcf2e5`, `--list-ink-soft: #eed8c0`, and grain sheen `#f3cfa3` at `0.048` opacity (`src/web/styles.css:137-166`, `src/web/lib/palette.test.ts:98-103`). Contrast calculation via `contrastRatio` on `mix("#f3cfa3", 4.8, "#5f3302")` (`#663a0a`) confirms `--topbar-field: rgb(255 244 228 / 0.12)` yields `#785024` (`5.12:1` for `#eed8c0` placeholder, `6.38:1` for `#fcf2e5` ink) and `--topbar-field-hover: rgb(255 244 228 / 0.15)` yields `#7d562b` (`4.70:1` for `#eed8c0`, `5.86:1` for `#fcf2e5`). Solid `--background` (`#ffffff`) gives `17.49:1` for `--foreground` (`#1c1917`) and `5.48:1` for `--muted-foreground` (`#6f6862`). Measured with Node calculation against `src/shared/slimes.ts` formula.
- [Measured] Native macOS centers the three traffic lights vertically in `webTopBarHeight: CGFloat = 40` (`apps/macos/MainWindowController.swift:16`, `:140-155`), sets `isMovableByWindowBackground = false`, and receives drags via `window.webkit.messageHandlers.windowDrag` (`src/web/shell-actions.ts:22-34`). `DRAG_INTERACTIVE_SELECTOR` already skips `button, a, input, textarea, select, [role="button"], [data-no-drag]` (`src/web/shell-actions.ts:11`). Read from source.
- [Measured] Native Windows (`apps/windows/crates/fusa-desktop/src/lib.rs:258-283`) renders the same web workbench inside a standard decorated Tauri window (`min_inner_size(800.0, 560.0)`) and requires no Rust window-chrome changes. Read from source.
- [Measured] `DialogContent page` keeps `keepWindowChrome` (`src/web/ui/dialog.tsx:16-19`), which calls `event.preventDefault()` on any `target.closest("[data-window-drag]")`. It does not currently exclude `[data-no-drag]`. `scripts/verify-window-drag.ts:26-39` currently clicks the exact horizontal midpoint `(topBar.x + topBar.width / 2, topBar.y + topBar.height / 2)` while Settings is open on `#/c/1`. Read from source.
- [Measured] Router command submission (`useMutation` on `ROUTER_COMMAND_MUTATION_KEY`, `useMutationState`, `pruneRouterCommandMutations`, and `handleRetryUnsent`) is currently private inside `RouterWorkbench.tsx:62-106`, `:580-702`. Retry state (`retryingMap`, `retryErrors`, `handleRetryCommand`) and `TurnRow` / `DestinationRow` are currently private inside `RouterStream.tsx:146-335`, `:620-666`. `RouterStream.tsx` is at `1000` lines, the exact `FILE_MAX_LINES` ceiling in `src/code-hygiene.test.ts:6`. Read from source.
- [Measured] `POST /api/router/commands` validates `[...rawText].length <= ROUTER_COMMAND_MAX_CHARS` (`4_000`) in `src/daemon/router/dispatcher.ts:1052` and `src/daemon/ui-server/schemas.ts:199`. Router runs stateless single-turn sessions and pushes updates via `router.command.created` and `router.command.updated` WebSocket changes into `state.router.commands` (`src/web/state.ts:421-444`), while `c.routerSummary.working` already tracks any `planning` command (`src/web/shell-model.ts:447`). Read from source.
- [Measured] `src/web/ui/popover.tsx` wraps `@radix-ui/react-popover` and exports `Popover`, `PopoverTrigger`, and `PopoverContent`, but does not yet export `PopoverAnchor`. Read from source.
- [Measured] `test/ui-polish/in-page.ts:109`, `:236-237`, `:325` treats `[data-radix-popper-content-wrapper]` as its own overlay layer (no false overlap or `box-in-box` hits), treats `:has(> input)` as a control shell, and checks every visible `.composer-frame` with `composerRowHits`. `src/web/ui/ui-standard.test.tsx:344` matches the exact 7-class scrollbar selector list including `.router-timeline`. Read from source.
- [Measured] `src/web/shell-layout.ts` and `src/web/ui-scale.ts` are currently modified by parallel Task Graph #131 and do not need changes for the top bar.

### 3. Approach comparison

**Popover container**

| Option | How | Collision and viewport bounds | Works with `ui:polish` checks | Cost |
| --- | --- | --- | --- | --- |
| A. Radix `Popover` + `PopoverAnchor` with `modal={false}` (recommended) | Re-export `PopoverAnchor` from `src/web/ui/popover.tsx`, portal below top-bar anchor | Built-in `--radix-popover-trigger-width`, `--radix-popover-content-available-width`, `--radix-popover-content-available-height`, and `collisionPadding` | Already recognized by `in-page.ts` (`[data-radix-popper-content-wrapper]`) and `Composer.tsx` `OPEN_OVERLAY_SELECTOR` | 1-line export in `popover.tsx` |
| B. Custom `position: fixed` dropdown div | Manual `getBoundingClientRect` + `ResizeObserver` + document click/Escape listeners | Custom collision math and stacking bugs on narrow or short windows | Needs custom exclusions in `in-page.ts` and `Composer.tsx` | Reinvents Radix `Popover` |
| C. Radix `Dialog` without scrim | Modal dialog anchored near top | Traps focus and blocks outside clicks or scrolls on the workbench | Blocks background chat interaction | Wrong interaction model for a quick popover |

Option A uses the library already listed in `AGENTS.md` and satisfies `in-page.ts` and `Composer.tsx` `Escape` isolation automatically.

**Command dispatch and turn rendering**

| Option | How | Parity with `#/router` | File-size impact |
| --- | --- | --- | --- |
| A. Extract shared `src/web/router-commands.ts` and `src/web/components/RouterTurnRow.tsx` (recommended) | Both `RouterWorkbench` / `RouterStream` and `RouterTopBar` / `RouterTopBarPopover` share one React Query mutation cache (`ROUTER_COMMAND_MUTATION_KEY`) and one `RouterTurnRow` component | Exact: optimistic sending, `Working…`, Markdown, retry, destinations, `ForwardReply`, and zero duplicate turns on `Expand` | Shrinks `RouterStream.tsx` below its 1,000-line cap |
| B. Duplicate `useMutation` and a miniature turn renderer inside `RouterTopBar` | Separate fetch and JSX for quick replies | Drifts on `ForwardReply`, retry errors, and optimistic deduplication on `Expand` | Duplicates ~300 lines of logic |
| C. Lift Router command state into `useShellModel` | Store quick-chat turns and mutation state at shell root | Triggers shell-wide re-renders during Router updates and risks `streaming.test.tsx` regressions | Widens blast radius across every pane |

Option A keeps `RouterTopBar`'s open state local so opening, typing, and closing cause zero re-renders in `ProjectList`, `Conversation`, `DraftComposer`, or `WorkPanel`, while sharing one canonical command cache and turn renderer with `#/router`.

**Top-bar centering and traffic-light clearance**

| Option | How | Narrow window (`480px` to `640px`) and scale safety | Conflict with Task Graph #131 |
| --- | --- | --- | --- |
| A. CSS symmetric safe-gutter grid on `.shell-topbar` (recommended) | `grid-template-columns: minmax(var(--topbar-safe-inline), 1fr) minmax(0, var(--topbar-input-max)) minmax(var(--topbar-safe-inline), 1fr)` with `--topbar-safe-inline: 88px` on `html[data-macos-app="true"]` and `clamp(12px, 8vw, 88px)` in plain browsers | Dead-center `35rem` (`560px`) at `>= 760px`; shrinks smoothly down to `304px` at macOS `480px` min width, always clear of traffic lights | Zero edits to `shell-layout.ts` or `ui-scale.ts` |
| B. Measure width in `src/web/shell-layout.ts` | Add top-bar width calculation to `shellLimitsPx` | Requires JS resize effect and extra state | Direct merge conflict with Task Graph #131 |
| C. Fixed `w-[560px] mx-auto` | Static width | Fails `ui-scale.test.tsx`, clips on narrow viewports, collides with macOS traffic lights below `740px` | Breaks layout |

Option A uses pure CSS, respects all four interface scales (`--topbar-input-max: 35rem`, height `min(1.75rem, calc(var(--topbar-height) - 8px))`), and avoids Task Graph #131 completely.

**Follow-up input surface inside the popover**

| Option | How | Guard compatibility |
| --- | --- | --- |
| A. Full-bleed hairline footer row (recommended) | Same pattern as `CardNoteForm variant="row"`: `border-t border-border`, auto-sizing `<textarea rows={1}>`, `1px` inset `--border-focus` ring on focus, `30px` honey pastel `Send` button | Zero `box-in-box`, zero `thick-line`, zero `composer-row` |
| B. Reuse `.composer-frame` inside the popover | Two-row framed composer | Violates `machine:composer-row` (`in-page.ts:325` compares every visible `.composer-frame`) and creates a framed box inside a popover |

### 4. Performance and bounds

1. **Invalidation.** Quick-chat turns read live command records from `state.router.commands` (updated immediately on `router.command.created` and `router.command.updated`) merged with `ROUTER_COMMAND_MUTATION_KEY` mutations. Once a mutation's `clientId` appears in `state.router.commands`, `pruneRouterCommandMutations` removes the confirmed mutation entry. Failed-command retries are `ROUTER_RETRY_MUTATION_KEY` mutations in the same shared cache, so the popover and `#/router` show one retry state and a command has at most one retry in flight across both. Each retry posts a fresh client `retryId` with `fromRetryId`, the `plan.retryId` of the failed run on screen. A failed turn shows `Working…` while that retry is in flight or accepted, as long as the command still shows the run it retried. A command record that carries any other run, normally the retry's own run in a `router.command.*` change or a snapshot, ends that state, whichever of the change and the HTTP reply arrives first. A resync that returns the unchanged failure keeps `Working…`. Timestamps, page-side counters, and arrival order never decide it. `pruneRouterRetryMutations` drops a settled retry once a newer retry of the command replaces it, or once its command stops failing, leaves the live window, or shows another run. Closing the popover resets the session to `CLOSED_TOPBAR_SESSION`, clearing `clientIds` and releasing popover state immediately; failed sends stay retryable while open and never pollute normal cache entries.
2. **Upper bounds.** A quick-chat session holds at most `TOPBAR_ROUTER_POPOVER_TURNS_MAX = 20` `clientId` entries (FIFO eviction of the oldest ID from the popover only; the daemon retains full history per `ROUTER_COMMANDS_RETENTION_MAX = 500` and `ROUTER_STREAM_LIVE_MAX = 200`). Message length enforces `ROUTER_COMMAND_MAX_CHARS = 4_000` (existing `src/shared/limits.ts:335`) before dispatch. Mutation cache entries remain capped at `ROUTER_STREAM_LIVE_MAX = 200`, and retry entries hold at most one per failed live command. No new daemon API endpoints are added. The API changes are the optional `routerOnly` request flag, kept as `plan.routerOnly`, and the required `{ retryId, fromRetryId }` retry body, kept as `plan.retryId` with no schema migration.
3. **Stable references.** `RouterTopBar` is `memo` and keeps its open state, drafts, and session local, so opening, typing, and closing re-render nothing outside the top bar. It reads the local Router's turns through `routerTurnsOf` (cached per `state.router.commands` array) instead of the fleet stream merge, and `selectQuickRouterTurns` caches per session array and reuses its previous result while the session's turns are the same objects, so PM streaming frames and background Worker `session.status` pulses return the same turn array and the memoized timeline skips rendering. `buildPendingRouterTurns` returns the previous array when no pending entry's key, status, command, or error changed.
4. **Measured verification.** Implementation verifies zero re-renders of `DraftComposer`, `Conversation`, `ProjectList`, and `ActiveTab` during streaming and background Worker pulses (`src/web/streaming.test.tsx`), adds `selectQuickRouterTurns` and `buildPendingRouterTurns` reference-stability cases to `src/web/selectors-cache.test.ts`, and measures top-bar + popover render in headless Chromium via `pnpm verify` and `pnpm ui:polish`.

| Constant | File | Value | Sizing |
| --- | --- | --- | --- |
| `TOPBAR_ROUTER_POPOVER_TURNS_MAX` | `src/web/limits.ts` | `20` | Bounds one quick-chat popup session while full history stays in `#/router` (30-day ledger cap `ROUTER_COMMANDS_RETENTION_MAX = 500`) |
| `TOPBAR_ROUTER_INPUT_MAX_REM` | `src/web/limits.ts` | `35` | `560px` at `Compact` (`16px` root) and `612.5px` at `Default` (`17.5px` root), the decided `560px` width scaling with `rem` like the rest of the shell |
| `TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM` | `src/web/limits.ts` | `32` | `512px` at `Compact` and `560px` at `Default`, further clamped by `--radix-popover-content-available-height` on short windows |
| `ROUTER_COMMAND_MAX_CHARS` | `src/shared/limits.ts` (existing) | `4_000` | Matches `POST /api/router/commands` server validation |
| `ROUTER_STREAM_LIVE_MAX` | `src/shared/limits.ts` (existing) | `200` | Caps live command cache and unconfirmed React Query mutations |

### 5. Cross-vendor and cross-platform unification

- **Vendors (`src/shared/vendors.ts`).** Quick top-bar commands post to the single vendor-neutral `POST /api/router/commands` endpoint (`localClient.postRouterCommand`). The daemon resolves the active Router provider, model, and effort through `src/shared/router-model.ts` and `VENDOR_LIST`, so every registered vendor works without vendor-specific UI code. A future vendor implements nothing here (it only provides its existing `routerDefault` in `src/vendors/<vendor>/spec.ts`).
- **Platforms (`macOS`, `Windows`, `Linux`).** The top-bar Router input and reply popover live entirely in platform-neutral web code under `src/web/` and behave identically across macOS (`apps/macos/` `WKWebView`), Windows (`apps/windows/` Tauri WebView2), and Linux browsers. On macOS, `MainWindowController.swift` already centers the traffic lights in the `40px` bar (`webTopBarHeight = 40`), `html[data-macos-app="true"]` keeps `--topbar-safe-inline: 88px` so the input never overlaps the traffic lights, and `data-no-drag` on the input wrapper keeps dragging and double-click zoom restricted to the wood outside the input. Windows keeps its native title bar and renders the identical `40px` wood top bar and centered input inside the webview.

### 6. Deletions

Deleted or replaced in the same implementation PR so old and new paths never coexist:

- Empty `<div aria-hidden="true" data-window-drag className="shell-topbar shrink-0" />` placeholder in `src/web/App.tsx:263`, replaced by `<SurfaceOutlet id="topbar" />`, which places `RouterTopBar` from `src/web/WorkbenchSurfaces.tsx`.
- Private `ROUTER_COMMAND_MUTATION_KEY`, `RouterCommandVariables`, `RawRouterMutation`, `pruneRouterCommandMutations`, `pendingTurns` builder, and `handleRetryUnsent` inside `src/web/components/RouterWorkbench.tsx:62-106`, `:580-702`, replaced by `useRouterCommands` from `src/web/router-commands.ts`.
- Private `TurnRow`, `DestinationRow`, and command retry state (`retryingMap`, `retryErrors`, `handleRetryCommand`) inside `src/web/components/RouterStream.tsx:146-335`, `:620-666`, replaced by `RouterTurnRow` and `useRouterCommands`.
- Outdated "plain wood" top-bar description in `docs/ui-standard.md` (updated in this planning PR) and the center-only drag coordinate in `scripts/verify-window-drag.ts:27` (updated in Step 2 to probe the wood drag area beside the centered input and verify `[data-no-drag]` on the input itself).

### 7. Skeleton files

- `docs/ui-standard.md`: Documents the top-bar Router input tokens, spacing, contrast guarantees, Settings-page interaction, and reply popover layout.
- `docs/router-topbar-design.md`: This design document.
- `docs/README.md`: Indexes `docs/router-topbar-design.md`.
- `src/web/limits.ts`: Adds `TOPBAR_ROUTER_POPOVER_TURNS_MAX`, `TOPBAR_ROUTER_INPUT_MAX_REM`, and `TOPBAR_ROUTER_POPOVER_MAX_HEIGHT_REM`.
- `src/web/ui/popover.tsx`: Exports `PopoverAnchor` from `@radix-ui/react-popover`.
- `src/web/router-commands.ts`: Shared Router command dispatch, pending mutation projection, cache pruning, and the failed-command retry state shared across surfaces.
- `src/web/router-commands.test.ts`: Unit test skeleton (`it.todo`) for `pruneRouterCommandMutations` and `buildPendingRouterTurns`.
- `src/web/router-topbar-model.ts`: Pure quick-chat session state, turn selector, length validation, draft handoff (unsent quick drafts join any draft already in the Router composer instead of replacing it), and outside-press dismissal contracts.
- `src/web/router-topbar-model.test.ts`: Unit test skeleton (`it.todo`) covering every contract clause in `router-topbar-model.ts`.
- `src/web/components/RouterTurnRow.tsx`: Shared `RouterTurnRow` component contract used by `RouterStream` and `RouterTopBarPopover`.
- `src/web/components/RouterTopBar.tsx`: Top-bar Router input shell contract hosting the translucent-to-solid field, `RouterAvatar`, and popover orchestration.
- `src/web/components/RouterTopBarPopover.tsx`: Anchored quick-reply popover contract hosting the header (`Expand`, `Close`), scrollable `.router-timeline`, and follow-up reply row.
- `src/web/router-topbar.test.tsx`: Component and integration test skeleton (`it.todo`) covering visual states, messaging flow, `Expand`, dismissal, window-drag boundaries, and narrow/mobile behavior.

### 8. Verification plan

1. **Unit, selector, and component tests (Step 2):**
   - Convert every `it.todo` in `src/web/router-commands.test.ts`, `src/web/router-topbar-model.test.ts`, and `src/web/router-topbar.test.tsx` into failing assertions first, then implement until green.
   - Add contrast assertions for `--topbar-field`, `--topbar-field-hover`, and focused solid state in `src/web/lib/palette.test.ts`.
   - Add `selectQuickRouterTurns` and `buildPendingRouterTurns` reference-stability tests in `src/web/selectors-cache.test.ts`.
   - Update `src/web/shell.test.tsx` to verify that clicking blank wood in `.shell-topbar` triggers `windowDrag`, clicking inside the Router input (`[data-no-drag]`) does not trigger `windowDrag`, and clicking the Router input while Settings is open dismisses Settings cleanly.
   - Confirm `src/web/router-workbench.test.tsx`, `src/web/streaming.test.tsx`, `src/web/ui/ui-standard.test.tsx`, `src/web/ui-scale.test.tsx`, and all `ALWAYS_RUN_TESTS` guards pass.
2. **Real-browser paired screenshots (Step 2):**
   - Capture before-and-after pairs in `/tmp/router-topbar/shots/` and index every pair in `/tmp/router-topbar/shots/index.md`: top bar at rest, hover, focused typing, popover open after send (including `Working…` in progress and settled reply with `ForwardReply`), follow-up message inside popover, after clicking `Expand` (`#/router`), after closing popover, all four interface scales (`Compact`, `Default`, `Large`, `XL`), narrow desktop (`640px` `slim` and `480px` macOS min), and phone width (`390px` mobile shell).
3. **Automated visual and smoke gates (Step 2):**
   - Run full `pnpm ui:polish` and confirm `0` machine warnings (`clipped`, `page-overflow`, `overlap`, `contrast`, `touch-target`, `off-scale-font`, `thick-line`, `box-in-box`, `ragged-edge`, `composer-row`).
   - Run `pnpm lint`, `pnpm typecheck`, `pnpm exec knip --treat-config-hints-as-errors`, targeted tests + `ALWAYS_RUN_TESTS`, `pnpm verify` (with updated `scripts/verify-window-drag.ts`), and `bash scripts/build-mac-app.sh` (without `--install`) + `TrafficLightTests.swift`.
4. **Plan-step gate (Step 1):**
   - Run `pnpm lint`, `pnpm typecheck`, `pnpm exec knip --treat-config-hints-as-errors`, `ALWAYS_RUN_TESTS`, new skeleton test files, and `pnpm verify` so the planning PR lands green with zero runtime regressions.
