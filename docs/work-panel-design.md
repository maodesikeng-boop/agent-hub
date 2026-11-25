# Work panel design

> Snapshot: 2026-11-25 (commit `05492157`)

The right side of the workbench becomes one wide work panel with three tabs, `Active`, `Completed`, and `Info`, and a Worker detail view. It replaces the Pieces side panel and the separate PM settings panel. The decided visual spec, with prototype screenshots and the scripts that hold exact CSS values, is the source for every number below.

## For the user

### Files to review

- [docs/work-panel-design.md](work-panel-design.md): This plan: data shapes, what is deleted and reused, how a graph switches to the vertical list, and the verification plan.
- [docs/ui-standard.md](ui-standard.md) section 12: The work panel recipe the implementation must match, written before any screen changes.
- [migrations/0051_completed_feed.sql](../migrations/0051_completed_feed.sql): Worker end times and the indexes the Completed tab pages on.
- Code skeleton: `src/web/work-status.ts`, `src/web/graph-flow.ts`, `src/web/useGraphOrientation.ts`, `src/web/work-panel-model.ts`, `src/web/useCompletedWork.ts`, `src/web/info-rows.ts`, `src/web/worker-report-view.ts`, the new `src/web/side-panel.ts` exports, `src/web/components/{WorkPanel,WorkStatusIcon,GraphCanvas,ActiveTab,CompletedTab,InfoTab,WorkerDetail,WorkerReportText}.tsx`, and `src/daemon/ledger/completed-work.ts`, each with `it.todo` cases.

### Decisions needed

1. **Phone and the narrowest desktop tier.** Recommendation: on a phone the panel opens as a full page with the same three tabs and a back arrow, replacing the bottom Pieces drawer; Worker detail and Info pages push full pages as they do today. In the desktop `stack` tier the panel covers the conversation exactly as the side panel does today. Option B keeps a bottom drawer holding the tabs; it leaves graphs about 60% of the screen height and nests a sheet inside a sheet.
2. **Router page.** Recommendation: no work panel on the Router this round. Every tab belongs to one PM, and the Router already gathers decisions across PMs. Opening a Worker from the Router keeps going to that PM's conversation with Worker detail open. Option B gives the Router an `Active` tab across all PMs.
3. **Empty, loading, and error states.** Recommendation: one centered muted line per empty tab (`Nothing running`, `Nothing completed yet`), a spinner with `Loading…` while the first page loads, and on failure one red line with the error and a `Retry` text button. A failed next page in Completed shows the same line inline at the end of the list. Info keeps the current persona loading and error rows.
4. **Info rows the spec leaves out.** Today's PM settings also open `Worktree setup` and `History`. Recommendation: keep both as the last two rows of the second group so no feature disappears. Option B drops them from the panel.
5. **The expand icon on an Active graph.** Recommendation: it opens the existing full graph dialog, redrawn with the new nodes, icons, and curves, keeping its decision cards, `Skip step`, and `Cancel graph`. Those actions have no other home. Option B removes the dialog and moves Skip and Cancel into Worker detail's `⋯` menu.
6. **Standalone asks.** The Pieces panel lists `hub ask` cards not tied to a graph under `Needs You`. The spec's Active tab has no such section. Recommendation: drop it; those cards stay in the chat and in the Router tray, and the panel toggle keeps its attention dot.

## For Workers and reviewers

### 1. User goal

> 这里不是这样，这里我们的整个右边栏都要改，包括里面的组件我们慢慢讨论
> 我懂了把我们的右边就做成一个大的面板怎么样？
> 我是希望可以一眼看出各个地方的推进状态
> 这些不能一起改吗

The user wants one wide panel that shows where every running Task Graph and Worker stands at a glance, the finished work by day, and the PM's settings in one place. The PR stacks on PR #439 and ships together with it.

### 2. Current state

- [Measured] The side panel has three contents chosen by `sidePanelOf` (`src/web/side-panel.ts:34`): Pieces, a Worker, or the PM profile. `DesktopSidePanel` renders each with its own header (`src/web/App.tsx:233`). Read from source.
- [Measured] The Pieces content is `RailGroups` (`src/web/components/RightRail.tsx:386`, 623 lines): four collapsible groups (Task Graph, Needs You, Pieces, Completed). The graph group draws `PeelTrackList` (`src/web/components/PeelTrack.tsx:952`) with pixel pipes from `src/web/pixel-path.ts` and the sprout icon from `src/web/task-progress.ts`.
- [Measured] Completed loads through two unrelated cursors: graphs by `id DESC` from `GET /api/projects/:id/task-graphs` (`src/daemon/ledger/task-graphs/lifecycle.ts:65`), and ended Workers by conversation id through `loadEndedWorkers` into hub state (`src/web/device-hub.ts:547`). Neither orders by finish time, so a merged list sorted by day would reorder as pages arrive.
- [Measured] A Worker's end time is not stored. Ending sets `workers.updated_at` (`src/daemon/ledger/workers/lifecycle.ts:28`, `:181`, `src/daemon/ledger/workers/worktree.ts:149`), and a later worktree move rewrites it (`src/daemon/daemon.ts:587`). Read from source.
- [Measured] Report lines carry status and summary but no PR (`src/shared/domain.ts:485`); `insertReport` already parses the PR field (`src/daemon/ledger/workers/reports.ts:91`).
- [Measured] The profile panel `ProfilePanel` (`src/web/components/ProfilePanel.tsx:718`, 826 lines) edits Model, Mode, and Schedules in place and opens Capabilities, Persona, Memory files, Worktree setup, and History as pages (`src/web/route.ts:5`).
- [Measured] The Worker view `WorkerConversation` (`src/web/components/WorkerConversation.tsx:18`) already uses the chat's `MessageList` and `DraftComposer`. Messages already clamp a long brief with `Show more` (`LongBrief`, `src/web/components/Messages.tsx:678`).
- [Measured] The panel defaults to `27.5rem` (440px) and caps at `45rem` (`src/web/limits.ts:12`); the spec asks for about 640px at 1440x900.
- [Measured] On a phone, Pieces opens as a bottom drawer (`src/web/mobile/PiecesDrawer.tsx`) and the profile as a full page (`src/web/App.tsx:725`).
- [Measured] User-facing `Piece` copy also lives outside the panel: `src/web/format.ts:128`, `src/web/router-stream.ts:158`, `src/web/components/ProfilePanel.tsx:296`, `src/web/components/WorkerConversation.tsx`, and the `Piece` title fallbacks in `src/web/App.tsx:162`. Found with `grep -rn Piece src/web`.

### 3. Approach comparison

**Completed data source**

| Option | How | Order by finish time | Count for the tab | Cost |
| --- | --- | --- | --- | --- |
| A. Keep two cursors, merge on the client | Existing graph history plus `loadEndedWorkers` | Wrong across pages (both page by id) | Needs two more count calls | No backend work, wrong order |
| B. One feed endpoint (chosen) | `GET /api/pms/:id/completed?cursor=` merges finished graphs and standalone Workers in SQL by `(finishedAt, kind, id)` | Exact; keyset cursor never overlaps | `total` on every page | One query module, one migration |
| C. Put all finished work in the snapshot | Grow the snapshot | Exact | Free | Breaks the snapshot size bound |

Option B, through `useInfiniteQuery`, is the standard keyset pattern and keeps the snapshot as it is.

**Horizontal or vertical graph**

| Option | Signal | Weakness |
| --- | --- | --- |
| A. Panel width breakpoint | `@container` query at a fixed width | A three-step graph fits at 380px while a seven-step one overflows at 642px; one breakpoint is wrong for both |
| B. Render horizontally, measure `scrollWidth`, flip | DOM overflow | Once vertical there is nothing left to measure, so it flips back and forth and flashes on first paint |
| C. Compute the needed width, compare with the box (chosen) | `horizontalLayoutOf(flow).width` from canvas text widths vs `ResizeObserver` content width | Needs the label font, read from a probe element |

Option C decides per graph, does not depend on what is on screen, and runs in a layout effect before paint.

**Graph drawing**

| Option | Notes |
| --- | --- |
| Reuse the dagre layout in `task-graph-layout.ts` | Built for the pixel pipes and orthogonal routes; 920 lines of geometry the new canvas does not use |
| Layered columns from `computeGraphLayers` with curves between layers (chosen) | Matches the prototype's fork and join curves; handles any DAG, since an edge that skips a layer draws one longer curve |

**Worker detail**

Worker detail stays `WorkerConversation`, so the message list, the composer, its height, and its focus handling are the main chat's. Only the header changes (`WorkerDetailHeader`), and report messages render through `WorkerReportText` when `leanReportOf` recognizes them. A separate detail component would fork the chat.

### 4. Performance and bounds

- **Invalidation.** The Completed query key is `["completed-work", device, pmId]`. When a graph leaves `activeTaskGraphs` or a Worker of the PM ends, the hook refetches from the first page. Failed pages are not cached; `Retry` refetches. The text-width LRU clears on `document.fonts` `loadingdone` and on an interface scale change.
- **Upper bounds.** Completed stops paging at `COMPLETED_WORK_MAX_PAGES` x `COMPLETED_WORK_PAGE_SIZE` = 400 items, more than a month of use (300 finished Workers plus their graphs, minus Workers owned by graphs). Each graph item carries at most `MAX_GRAPH_NODES` (32) steps of key and title. Rows are virtualized with `@tanstack/react-virtual`. The server clamps `limit` to the page size. Active derives from the existing snapshot and adds no collection.
- **Stable references.** `activeWorkOf`, `graphFlowOf`, and `completedDaysOf` cache per input object in `WeakMap`s; `horizontalLayoutOf` results are cached per flow and measure function. Tab bodies are `memo` and receive these objects.
- **Measured verification.** The implementation records render time of the Active tab with 4 graphs and of Completed with 400 rows, before and after, per `.agents/skills/benchmark-checklist/SKILL.md`.

| Constant | File | Value | Sizing |
| --- | --- | --- | --- |
| `COMPLETED_WORK_PAGE_SIZE` | `src/shared/limits.ts` | 50 | About one week of work per page |
| `COMPLETED_WORK_MAX_PAGES` | `src/web/limits.ts` | 8 | 400 items, more than one month |
| `GRAPH_TEXT_WIDTH_CACHE_MAX` | `src/web/limits.ts` | 2,000 | A month of graphs holds about 500 distinct step titles |
| `WORK_GRAPH_PX` | `src/web/limits.ts` | 26px node, 6px gap, 24px line, 28px fork, 1.35px stroke | Prototype geometry |

`SHELL_PANEL_REM` changes to `{ min: 22.5, default: 40, max: 50 }` so the panel opens at 640px at the default scale while the conversation keeps its `30rem` minimum; `shellTierOf` already uses only the minimum.

### 5. Cross-vendor and cross-platform unification

The panel reads vendor-neutral data: Task Graphs, Worker entries, report lines, and the PM persona. Model names in Info and in the Worker `⋯` menu come from the existing model catalog (`useModelCatalog`), so every vendor in `src/shared/vendors.ts` shows its own labels with no new code. The feed query is plain SQLite and the web code is platform-neutral, so macOS, Windows, and Linux behave the same. A future vendor implements nothing here.

### 6. Deletions

Deleted in the same PR so the old and new panels never coexist:

- `src/web/components/RightRail.tsx` (`RailGroups`, `CompletedGroup`, `PiecesSlot`, `PieceMeta`, `RIGHT_RAIL_*`) and its tests (`src/web/right-rail.test.tsx`, Pieces parts of `src/web/task-graph-rail.test.tsx`). `RouterWorkbench` stops importing `RIGHT_RAIL_VISIBLE_ROWS`; it gets its own constant.
- `src/web/components/PeelTrack.tsx`, `src/web/pixel-path.ts`, `src/web/task-progress.ts`, `src/web/components/TaskProgressIcon.tsx`, and the pipe and bead geometry in `src/web/task-graph-layout.ts`, once the graph dialog draws with `GraphCanvas` (decision 5). `GateDecisionCard` moves to its own file if the dialog keeps it.
- `src/web/mobile/PiecesDrawer.tsx` (decision 1).
- `src/web/components/SidePanel.tsx` and the old `SidePanelContent`, `sidePanelOf`, and `panelExitsOf` in `src/web/side-panel.ts`, replaced by `WorkPanel` and the `workPanel*` exports.
- `ProfilePanel` as a panel and a page: its summary layout, `SectionFrame`, `SummaryHeader`, the in-place Model, Mode, and Schedules editors, and the `variant` prop. The editors it wraps stay and move under `InfoTab`. `ProfilePage` and `PROFILE_PAGES` in `src/web/route.ts` become `InfoPage` and `INFO_PAGES`.
- `GET /api/pms/:id/ended-workers`, `endedWorkersPage`, `fetchEndedWorkers`, `HubDevice.loadEndedWorkers`, `state.olderEndedWorkers` and its snapshot field; `GET /api/projects/:id/task-graphs`, `listProjectHistory` (if `hub graph list` no longer needs it), `fetchProjectTaskGraphs`, `GRAPH_HISTORY_PAGE_SIZE`, and `MAX_COMPLETED_GRAPH_PAGES`.
- The `agent-hub.rightRail.collapsed` per-group key; `agent-hub.rightRail` keeps the open or closed choice.
- Every user-facing `Piece` or `Pieces` string in `src/web`, listed in section 2, becomes `Worker` or `Workers`. `cleanPieceTitle` becomes `cleanWorkerTitle`.
- Docs: `docs/ui-standard.md` sections 3, 4, 8, 10, 12.1, and 20 where they describe Pieces, the peel track, or the drawer; `docs/workbench-shell-design.md` Pieces paragraphs; the `docs/README.md` index line; `docs/ui-polish/baseline/style-brief.md`; and the Pieces screens in `test/ui-polish/screens.ts` and `test/ui-polish/in-page.ts`.

Reused, not rewritten: `WorkerConversation`, `MessageList`, `DraftComposer`, `LongBrief`, `AgentRows`, `ModeRows`, `ScheduleGroup`, `CapabilitiesPanel`, `PmMemoryFilesGroup`, `WorktreeSetupGroup`, the persona editor and history list, `SlimePicker` through the existing look button logic, `ArchiveStatusGroup`, `DeliverableFiles`, the archive confirmation, `Tabs` and `Popover` primitives, `computeGraphLayers`, `sortActiveGraphs`, `boundWorkerIdsOf`, and `workersOf`.

### 7. Skeleton files

- `migrations/0051_completed_feed.sql`: `worker_endings` side table (backfilled), its `(pm_id, ended_at)` index, and the finished-graph index by `completed_at`.
- `src/shared/api.ts`: `CompletedWorkItem`, `CompletedWorkPage`, `CompletedCursor`, and `API_PATHS.completedWork`.
- `src/shared/domain.ts`: optional `prUrl` on report lines, written by `insertReport`.
- `src/shared/ledger.ts`, `src/daemon/ledger/ledger.ts`, `src/daemon/ui-server/fake-ledger.ts`: `completedWork` on the ledger.
- `src/daemon/ledger/completed-work.ts`: the feed query and `recordWorkerEnded`, called from the three places that end a Worker. The route goes in `src/daemon/ui-server/routes-conversations.ts`.
- `src/shared/resource-registry.ts`: registers `worker_endings`, removed with its Worker or PM.
- `src/shared/limits.ts`, `src/web/limits.ts`: the constants in section 4.
- `src/web/client.ts`: `fetchCompletedWork`.
- `src/web/work-status.ts`: the five statuses and graph progress.
- `src/web/graph-flow.ts`: layers, horizontal geometry, vertical rows, and `orientationOf`.
- `src/web/useGraphOrientation.ts`: text measurement and the per-graph orientation hook.
- `src/web/work-panel-model.ts`: tabs, `activeWorkOf`, day groups, PR labels, and step click targets.
- `src/web/useCompletedWork.ts`: the paged Completed query.
- `src/web/info-rows.ts`: Info pages and row values.
- `src/web/worker-report-view.ts`: the summary and question kept from a report.
- `src/web/side-panel.ts`: `WorkPanelContent`, `workPanelOf`, and `workPanelExitsOf`. The route decides Worker and Info; the remembered tab decides Active or Completed.
- `src/web/components/WorkPanel.tsx`: the sheet and both header kinds.
- `src/web/components/WorkStatusIcon.tsx`, `GraphCanvas.tsx`, `ActiveTab.tsx`, `CompletedTab.tsx`, `InfoTab.tsx`, `WorkerDetail.tsx`, `WorkerReportText.tsx`: one component per surface.
- Tests: `src/web/{work-status,graph-flow,work-panel-model,info-rows,worker-report-view}.test.ts`, `src/web/work-panel.test.tsx`, and `src/daemon/ledger/completed-work.test.ts`.

The panel opens and closes as today: by itself while something needs the user, and from the toggle in the conversation header, which keeps the PM's note sprite with the label `Show work panel` or `Hide work panel`. Selecting `Info` navigates to `#/pm/<id>`; selecting `Active` or `Completed` navigates to `#/c/<id>` and remembers the tab in `localStorage`. Worker detail lives at `#/w/<id>`. Clicking a step opens the result of `stepTargetOf`.

### 8. Verification plan

- Unit and component tests: every `it.todo` above becomes a passing test. The migration test runs `0051` twice and on a ledger written by the last release (`docs/ledger-database.md`). `src/web/selectors-cache.test.ts` gains the new selectors. A tree guard fails on user-facing `Piece` text in `src/web` and joins `ALWAYS_RUN_TESTS`.
- Composer alignment: a `pnpm ui:polish` structure check compares the Worker detail composer frame with the chat composer frame and fails when top, bottom, or height differ by more than 0.5px. The target at 1440x900 is top 785, bottom 874, height 89. PR #439 owns the alignment itself; this PR adds the check if #439 has not.
- Screenshots at 642px, 460px, and 380px panel widths, before and after: Active (several graphs, vertical when narrow), Completed (collapsed, expanded, hover, cancelled), Info (static, avatar hover, and the Model, Schedules, Capabilities, Persona, and Memory files pages), Worker detail (running, waiting, done, `⋯` open), empty and error states for each tab, and the phone and stack layouts from decision 1. `pnpm ui:polish` reports 0 machine warnings.
- Gate: `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, `pnpm verify --composer-layout`, then `node scripts/wait-checks.ts <PR>` after push.
