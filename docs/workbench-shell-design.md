# Workbench shell design

The web workbench moves to one layout and one visual language. A fixed honey-yellow rail holds Router, the linked computers, usage, Settings, and the account. A cream column lists the selected computer's Project Managers, with a pinned group on top. The conversation sits on one white sheet, and a warm-gray side panel to its right shows Pieces, a Worker, or the PM's settings. Columns resize within limits, and every control uses square pixel corners, 2px lines, and pixelarticons.

## For the user

### Files to review

- [Workbench shell design](workbench-shell-design.md): this document. It covers the layout, the visual tokens, resizing, narrow windows, the phone, pinning, what gets deleted, and how the implementation splits into two steps.
- [`src/web/shell-layout.ts`](../src/web/shell-layout.ts): how the columns give way when the window narrows.
- [`src/web/pane-widths.ts`](../src/web/pane-widths.ts): where column widths are remembered.
- [`src/web/project-list.ts`](../src/web/project-list.ts): how the PM column orders pinned, active, and archived PMs.
- [`src/web/side-panel.ts`](../src/web/side-panel.ts): which content the side panel shows for each route.
- [`migrations/0049_pm_pins.sql`](../migrations/0049_pm_pins.sql): the table that stores pins on each computer.
- The prototype images are review artifacts outside the repository, and the step report links them. The approved v1 set shows the PM conversation, a Worker in the side panel, PM settings in the side panel, and the resize limits. The v2 set adds the Router page, three narrow-window widths, six phone screens, the settings dialog, and the drawn pin icon.

### Decisions needed

1. Switching computers on a phone. (a) Three fixed bottom tabs, Router, Projects, and Settings, where the Projects header names the computer and opens a computer list, the same header as the desktop PM column. (b) One bottom tab per computer, as first discussed. Recommendation: (a). The tab bar keeps the same three tabs whether you link one computer or five, and a phone never runs out of room for tabs.
2. The Router page on a computer. (a) Router fills the whole sheet and the PM column is hidden. (b) The last computer's PM column stays beside Router. Recommendation: (a). Router answers for every computer at once, so one computer's list beside it suggests a scope it does not have, and the rail reaches any computer in one click.

## For Workers and reviewers

### 1. User goal

Original user requests, verbatim and in order. Messages that compared the layout with other apps are summarized instead of quoted.

1. "顺手修修我们视觉不统一的问题？"
2. "视觉不统一的问题我们先来讨论"
3. Summarized: the generic rounded components, such as the composer, the search field, and every control in Settings, do not match the pixel pieces.
4. Summarized: the user wants a clearer column layout, built in Bellwood's own pixel style.
5. "最左边放 router 我们的设备？不同的设备分一个 下面是额度，设置，和用户怎么样"
6. "可以，我觉得不错，然后我们就可以支持置顶项目经理了"
7. "点击项目经理的设置，它的设置可以出现在旁边，而不是整屏，可以做到吗"
8. "先出一版吧，颜色也要区分，左边可以试一下像素暖黄色？就给我看看打开worker界面的效果，项目经理里面的效果，中间怎么分割呢？我们整体还是像素风，先出一版让我看看"
9. "为什么我们的每个格子宽度都是固定的不能拉开"
10. Summarized: columns should be draggable, with an upper limit.
11. After prototype v1: "就 a 比较好"
12. On the start card: "开工，其余按推荐"

The workbench ends up with one visual language and the layout the user approved in prototype v1, option A. The three main screens match v1: the PM conversation, a Worker opened in the side panel, and PM settings in the side panel. The Router page, the settings dialog, narrow windows, and the phone use the same language. Columns resize within limits and remember their widths, and PMs can be pinned.

Settled before this plan, by the user or by accepting the PM's recommendation:

- Option A colors. Rail `#ffcb3d`, the Router bell's yellow. PM column pale cream, conversation white, side panel light warm gray. The working area is one white sheet split by 2px solid lines.
- Widths at the `Default` interface scale. Rail fixed at 72px. PM column 264px by default, draggable from 220 to 400. Side panel 440px by default, draggable from 360 to 720. The conversation keeps at least 480. Double-clicking a handle restores the default. Widths are remembered per device.
- Worker reports in the conversation become thread cards with a title, a status, and the latest line. Clicking one opens the full Worker conversation in the side panel.
- The send key is a pixel paper plane in the PM's own color. The blue `Edit` and `New` links in the settings panel become dark brown. A pin icon is drawn, because pixelarticons has none.
- Pins are scoped to one computer and ordered by when they were pinned. Drag reordering is out of scope for this version.
- Computer cells are hidden while only one computer is linked.
- PM settings open in the side panel. On a phone they stay full screen.

Hard limits: the Geist body font stays, character sprites stay, nothing childish, no purple or blue-violet gradients, no large radii, heavy shadows, glow, or frosted glass. Cross-computer pins, pin reordering, Feishu, and the Channels page are out of scope.

### 2. Current state

Measurements were taken on `main` at `60fc1413`. Searches used `grep -rn` over `src/web` with test files excluded unless noted.

- [Measured] The left sidebar is fixed at `w-75` (300px) in `src/web/components/Sidebar.tsx:395` and becomes a 72px avatar rail under `NARROW_QUERY` (`max-width: 1100px`, `src/web/useMediaQuery.ts:3`). The right rail is fixed at `w-80` in `src/web/components/RightRail.tsx:650`. A search for `col-resize`, `onPointerMove`, and `setPointerCapture` returns nothing, so no column can be resized.
- [Measured] Opening a Worker replaces the whole conversation (`src/web/App.tsx:191`) and shows a Back slot (`src/web/components/WorkerConversation.tsx:104`). Opening PM settings also replaces the conversation (`src/web/App.tsx:190`) with a centered `max-w-160` page and a Back slot (`src/web/components/PmProfile.tsx:714`, `:725`).
- [Measured] Worker reports render as gray speech bubbles with `rounded-[22px]` (`src/web/components/Messages.tsx:67`, `WorkerSpeech` at `:666`).
- [Measured] Radii come from three soft tiers: pill buttons through `--radius-btn` (`src/web/ui/button.tsx:19`), `rounded-xl` fields (`src/web/ui/input.tsx:6`), and `rounded-2xl` dialogs and popovers (`src/web/ui/dialog.tsx:35`, `src/web/ui/popover.tsx:15`). The segmented control and the switch are pills (`src/web/ui/segmented.tsx:26`, `src/web/ui/switch.tsx:17`). `grep -rEo "rounded-(full|xl|2xl|t-2xl|\[[^]]*\])"` finds 141 occurrences in 52 files.
- [Measured] Selection uses two styles. PM rows and right-rail rows use the fruit-tinted `bg-jelly` (`src/web/components/Sidebar.tsx:23`, `src/web/components/RightRail.tsx:42`), while the Router row, settings tabs, and grouped rows use neutral `bg-sidebar-active` (`src/web/components/Sidebar.tsx:71`). There are 34 jelly usages.
- [Measured] Shell surfaces are tinted with the active PM's fruit color through `FruitTint` (`src/web/App.tsx:359`) and the `--mix-chat`, `--mix-sidebar`, and `--mix-line` tokens (`src/web/styles.css:110`). There are 27 uses of the tinted surface classes and `.tint-fade`.
- [Measured] The composer has a blurred halo on focus (`.composer-frame`, `src/web/styles.css:294`) and a gray rounded send key with a line icon (`src/web/components/Composer.tsx:46`, `:420`, `ComposerSend` in `src/web/ui/icons.ts:86`). Seven `Composer*` line icons sit beside the pixelarticons set, used in `Composer.tsx`, `RouterWorkbench.tsx`, and `WorkerPickTag.tsx`.
- [Measured] The `Pm` type has no pin field (`src/shared/domain.ts:82`), and the sidebar orders conversations by last activity only (`src/web/selectors.ts:130`).
- [Measured] `useShellModel` is 474 lines and listed in `src/code-hygiene.baseline.json`, so it cannot grow. New shell state has to live in new modules.
- [Measured] `src/web/ui/ui-standard.test.tsx:238` forbids hover-only actions, matching section 19 of the UI standard. The approved prototype reveals pin and settings shortcuts on row hover, so the rule needs an amendment, described below.
- [Measured] The gear opens Settings on `Computers` whenever computers are managed, because `initialSection` falls back to it (`src/web/components/SettingsDialog.tsx:57`).
- [Measured] `pnpm build` produces a main chunk of 1,299.56 kB, 398.24 kB gzip.
- [Measured] `react-resizable-panels` 4.24.1, published 2026-11-18 under MIT with React 18 or 19 as peers, exports `Group`, `Panel`, and `Separator`. I read its type definitions after `npm pack`. Panel sizes accept pixels and `rem`. Double-clicking a separator resizes the adjacent panel to its `defaultSize`, and `disableDoubleClick` opts out. Separators carry the ARIA `separator` role and move with the arrow keys, and `groupResizeBehavior: "preserve-pixel-size"` keeps a panel's width when the window resizes. Bundling only those three exports with esbuild, React external, gives 48,261 bytes minified and 16,204 bytes gzip. The shadcn `resizable` registry item wraps the same package at `^4`.
- [Measured] Every proposed text color passes WCAG AA on its surface, checked with the WCAG relative-luminance formula: `#75561b` on `#fff4cc` is 6.14:1, `#6f6862` on `#f7f4ed` is 4.99:1, `#8a5a00` on `#fff6d6` is 5.48:1, `#4a2e00` on `#ffcb3d` is 8.24:1, and white on the grapefruit send key `#c83220` is 5.34:1.
- [Inferred] Changing tokens and primitives restyles most screens at once, but 16 test files assert today's classes (`rounded-xl`, `bg-jelly`, `surface-chat`, `composer-frame`, `w-75`, `w-80`) and change with the code.

Older complaints and what happens to them:

- The gear opening `Computers` is fixed by the new rail. The gear opens `General`, and the account cell opens `Computers`, or `Security & Access` when no account is linked.
- `Providers` being too heavy is not fixed. Per-PM model settings move into the side panel's `Model` section, but the global `Providers` tab keeps its content. Left for later.
- The `Custom` capability badge being unclear is not fixed. It takes the pixel badge style with the same word. Left for later.
- The phone `Resources` row showing `0 B` is not fixed. Its summary comes from `describeResourcesSummary` (`src/web/resources-model.ts:75`), which this change does not touch. Left for later.

### 3. Approach comparison

#### Layout and zones

The user compared four options in prototype v1 and chose A: a honey rail beside one white sheet whose columns are split by 2px lines. Option B gave each column its own framed window with honey gaps between them, C used a pale cream rail, and D a wood-brown rail. A keeps the rail as the only loud color and lets the content read as one page.

The chosen layout, at the `Default` scale:

- **Rail.** `4.5rem` wide, `--rail` background, outside the sheet. Router cell on top with the bell sprite, a `Router` label, and a dark count badge for pending decisions. A 2px divider. One cell per computer when two or more are linked, with a pixel computer icon from `PlatformIcon`, a short name, a square status dot (green online, amber reconnecting, gray offline), and a badge for unanswered asks on that computer. At the bottom, the Update cell when an update is waiting, the usage meter, the Settings gear with the amber resources dot, and the account cell. The selected cell is filled with `--list` and outlined in `--rail-outline`, so it reads as attached to the cream column beside it.
- **Sheet.** Inset `6px` from the window's top, right, and bottom edges, with a 2px `--rail-shade` outline and stepped corners.
- **PM column.** `--list` background. A `3.5rem` header with the computer's name, a chevron that opens `ComputerSwitcher`, and the New PM slot. A cream search field. Groups `Pinned`, `Project managers`, and a collapsed `Archived`. Rows are `3.25rem` tall with a `2.25rem` avatar, a `text-body` semibold name, and a `text-minor` preview, with a time or a square status dot on the right.
- **Conversation.** White. The header holds the PM's avatar, name, and a chevron as one button that opens PM settings, and a `Pieces` slot with the live count on the right.
- **Side panel.** `--panel` background, a `3.5rem` header, and three contents: Pieces, a Worker, or PM settings.

#### Visual language

| | Stepped corners with `clip-path` | `border-radius: 2px` | `border-image` sprites |
| --- | --- | --- | --- |
| Looks hand-pixeled | Yes, matches the slot buttons and Task Graph cards | No, reads as slightly rounded | Yes |
| Works with 2px borders | Yes, the notch cuts the border corner | Yes | Needs a sprite per border color |
| Focus ring | Needs an inset outline, because `clip-path` cuts outer rings | Normal ring | Normal ring |
| Already in the codebase | `.pixel-card` in `src/web/styles.css` | No | No |

Recommendation: two `clip-path` utilities in `src/web/styles.css`. `px-corner` cuts a 2px notch and goes on controls, rows, cells, and badges. `px-corner-lg` cuts a two-step 4px notch and goes on cards, dialogs, popovers, drawers, and the sheet. Focus shows as a 2px inset outline (`outline-offset: -2px`), which survives the clip. No `rounded-*` class remains in the shell, and status dots become squares.

Color tokens, replacing the zinc neutrals, fruit tints, and jelly highlights:

| Token | Value | Use |
| --- | --- | --- |
| `--rail` | `#ffcb3d` | Rail and phone tab bar |
| `--rail-shade` | `#e9a417` | Rail divider, sheet outline, handle bar on hover |
| `--rail-hover` | `#ffd966` | Rail cell hover |
| `--rail-ink` | `#4a2e00` | Rail text and icons, badges, the primary button and text links outside a PM |
| `--rail-ink-soft` | `#6e4a00` | Offline computer labels |
| `--rail-outline` | `#8a5300` | Selected rail cell, handle grip |
| `--list` | `#fff4cc` | PM column, settings dialog tabs, phone Projects page |
| `--list-edge` | `#efd27d` | PM column header line and the line beside the column |
| `--list-hover` | `#ffedb0` | PM row hover |
| `--list-field` | `#fffbeb` | Search field on cream |
| `--list-ink`, `--list-ink-soft` | `#3b2600`, `#75561b` | PM column text |
| `--select-line` | `#e0b03c` | Selected row outline on cream |
| `--background` | `#ffffff` | Conversation, dialogs, cards |
| `--panel` | `#f7f4ed` | Side panel, phone Worker and Profile pages, phone Settings background |
| `--border` | `#eee8dc` | 2px dividers |
| `--border-strong` | `#ddd4c2` | Control and card borders |
| `--hover` | `#f6f2e9` | Hover on white and warm gray |
| `--open`, `--open-line` | `#fff6d6`, `#e9c25a` | Open thread card, gate row, selected item on white or warm gray |
| `--foreground`, `--muted-foreground` | `#1c1917`, `#6f6862` | Text, now warm |

One selection style remains, an outlined block: white with `--select-line` on cream, and `--open` with `--open-line` on white or warm gray. The PM accent keeps its jobs inside `AccentScope`: user bubbles, the primary button, the send key, switches, and radio marks. Outside a PM, those use `--rail-ink`, and Router's send key is honey with a brown plane.

Primitives that change:

- `src/web/ui/button.tsx`. Every variant gets `px-corner` and a 2px border. `default` is a solid accent fill with a darker border and a 2px inset bottom shade, `outline` is white with `--border-strong`, `ghost` has no border and hovers `--hover`, `slot` keeps the honey colors with a 2px border at 36px, and `destructive` matches `default` in `--danger`.
- `src/web/ui/input.tsx`. `Input`, `Textarea`, and `Select` get a 2px `--border-strong` border and `px-corner`. On focus the border darkens to `#4a4038`, which is visible without a ring.
- `src/web/ui/segmented.tsx`. A bordered track of square cells, with the checked cell in slot colors.
- `src/web/ui/switch.tsx`. A `40x22` square track with a 2px border and a square thumb. On is the accent, or `--rail-ink` outside a PM.
- `src/web/ui/dialog.tsx`, `src/web/ui/popover.tsx`, and `src/web/ui/drawer.tsx`. A 2px `--border-strong` border, `px-corner-lg`, and a `rgb(28 25 23 / 0.34)` backdrop.
- `src/web/ui/icons.ts`. pixelarticons only. The drawn `Pin` and `PinFilled` join `MoreHorizontal` and `User`, and the `Composer*` line icons go.
- `src/web/components/SettingsList.tsx`, `ChoiceRows.tsx`, and `ModeRows.tsx`. Group boxes get a 2px `--border` and `px-corner-lg`, and `RadioMark` becomes an `18px` square with an `8px` inner square.
- `src/web/components/SearchField.tsx`. A pixel field, cream inside the PM column.
- `src/web/components/OptionRow.tsx`. Warm option fills and pixel keycaps for `A` and `B`, and `Recommended` in slot colors.
- `src/web/components/QuotaPopover.tsx`. Bars become 10-cell pixel meters.
- `src/web/components/Composer.tsx`. A 2px border, no shadow, a pixel `Plus`, and a `36px` send key with the pixelarticons `Send` plane in the agent color. Disabled is `#f3efe6` with a `--border-strong` border.
- `.tool-slot` and `.tool-badge` in `src/web/styles.css` move from a 1px to a 2px border.

The drawn pin, on the 24 grid with 2px strokes. The outline form means "Pin" and the solid form means "Pinned".

- Outline: `M8 2h8v2H8zM8 4h2v6H8zM14 4h2v6h-2zM6 10h2v2H6zM16 10h2v2h-2zM4 12h16v2H4zM11 14h2v8h-2z`
- Solid: `M8 2h8v8h2v2h2v2H4v-2h2v-2h2zM11 14h2v8h-2z`

#### Resizing columns

| | `react-resizable-panels` v4 | Custom pointer handle | CSS `resize` |
| --- | --- | --- | --- |
| Limits in `rem` per column | Yes, `minSize` and `maxSize` | Write and test the clamping | No neighbor-aware limits |
| Double-click to default | Built in | Write it | No |
| Keyboard and ARIA | `separator` role, arrow keys | Write it | No |
| Touch hit area | `resizeTargetMinimumSize` | Write it | Corner grip only |
| Keeps pixel width on window resize | `preserve-pixel-size` | Write it | Not applicable |
| Size | 16.2 kB gzip, measured | About 150 lines to own | 0 |

Recommendation: `react-resizable-panels` v4 behind `src/web/ui/resizable.tsx`, copied from the shadcn `resizable` pattern and restyled. AGENTS.md asks for established libraries over hand-written state machines, and this one covers every behavior the user approved. The implementation adds it to the dependency list in `AGENTS.md`.

How it is wired:

- The PM column, conversation, and side panel are three panels in one `PaneGroup`. The column and the panel keep their pixel widths when the window resizes, so the conversation absorbs the change.
- A panel's `defaultSize` is its remembered width from `usePaneWidths`. The handle turns off the library's double-click and calls the store's `reset`, so a reset clears the stored width and returns to `16.5rem` or `27.5rem`.
- Widths are stored in `rem` under the `agent-hub.paneWidths` key in `localStorage`, one entry per browser profile, which is one per device for the native apps. Storing `rem` keeps proportions when the interface scale changes. Values are clamped on read, and only user drags are written.
- The handle draws a 2px line in the column's edge color: `--list-edge` beside the PM column and `--border-strong` beside the side panel. On hover or keyboard focus it becomes a 4px `--rail-shade` bar with a `12x32` honey grip, outlined in `--rail-outline` with three 2px dots. While dragging, the bar darkens to `#c98800`. At a limit the cursor becomes a one-way arrow.

#### Narrow windows

| | Measured fit from column minimums | Fixed media-query breakpoints |
| --- | --- | --- |
| Follows the interface scale | Yes, minimums are in `rem` | No, media queries ignore the root font size |
| Shares its limits with resizing | Yes, the same `SHELL_*` constants | No, a second set of numbers |
| Testable as a pure function | Yes | Partly |

Recommendation: `shellTierOf()` in `src/web/shell-layout.ts`, fed by a `ResizeObserver` on the shell. It replaces `NARROW_QUERY` and `COMPACT_QUERY` in the shell. The settings dialog keeps its own `720px` breakpoint.

Columns give way in this order. First the PM column and the side panel shrink toward their minimums. When rail, PM column, conversation, and panel still do not fit, the tier is `strip`: the PM column collapses to a `4.5rem` avatar strip with New PM on top and pinned PMs above a divider, and it stops being resizable. When even the strip does not fit, the tier is `stack`: the side panel covers the conversation until it closes. Its back button returns to Pieces and its close button returns to the conversation, which stays mounted inside a hidden `<Activity>` so the draft and scroll position survive. The conversation's `30rem` minimum holds until the stack tier.

| Interface scale | Four columns side by side | Strip and panel | Panel covers conversation | PM column full width with the panel closed |
| --- | --- | --- | --- | --- |
| `Default` | 1146px and wider | 998 to 1145px | below 998px | 784px and wider |
| `Large`, the default | 1253px and wider | 1091 to 1252px | below 1091px | 857px and wider |

#### Side panel and routes

| | Route-driven panel | Panel state held in a store |
| --- | --- | --- |
| Back button and shared links | Work | Lost |
| Phone reuses the same routes | Yes | Needs a second scheme |
| Code that already exists | `#/w/<id>`, `#/pm/<id>` | None |

Recommendation: the route decides the panel's content on the desktop.

- `#/c/<id>` shows the conversation, with Pieces in the panel when Pieces is open. Pieces still opens by itself while something needs you, and the header `Pieces` slot toggles it. The existing `agent-hub.rightRail` keys keep the user's choice.
- `#/w/<id>` shows the owning PM's conversation, with the Worker in the panel and its thread card marked open.
- `#/pm/<id>` shows the PM's conversation with the settings summary in the panel. `#/pm/<id>/<page>` drills into `capabilities`, `persona`, `memory`, `worktree`, or `history` inside the panel, with a back arrow to the summary.
- The panel's close button goes to `#/c/<id>`, where Pieces shows only if it was open. The Worker's back arrow goes to `#/c/<id>` and opens Pieces.
- The phone keeps full-screen pages for the same routes.

The settings summary follows prototype v1. A header with the PM's tile, name, and project, and the `Pinned`, `New session...`, and `...` buttons, where `...` holds `Archive...`. Then `Model`, `Mode`, `Folders`, and `Schedules` as short sections, each with a dark brown `Edit` or `New` that swaps the section into its existing editor in place. Then drill-down rows for `Capabilities`, `Persona`, `Memory files`, `Worktree setup`, and `History`.

#### Pins

| | Ledger table on each computer | Browser `localStorage` |
| --- | --- | --- |
| Phone and desktop see the same pins | Yes | No, each browser keeps its own |
| Remote computers | Through the device proxy like other PM writes | Stored in the viewing browser, keyed by device |
| Survives clearing browser data | Yes | No |
| Cost | Migration, ledger method, route, client call | A few lines |

Recommendation: a `pm_pins` table on each computer's ledger, `(pm_id INTEGER PRIMARY KEY REFERENCES pms (id) ON DELETE CASCADE, pinned_at INTEGER NOT NULL) STRICT`, in the same shape as `pm_looks`. "Pinned on this computer" then means the same thing on every screen that looks at that computer.

- `PUT /api/pms/:id/pin` with `{ pinned: boolean }` returns `{ pm }` and emits `pm.updated`. Pinning an already pinned PM keeps its first `pinnedAt`, so the order stays put. Pinning or unpinning an archived PM fails with `conflict`.
- `Pm.pinnedAt` is `number | null`. An older daemon omits it, and the web treats a missing value as unpinned.
- The `Pinned` group lists unarchived pinned PMs by `pinnedAt`, oldest first. The other groups keep today's order by last activity.
- Rows toggle pins from the hover shortcut, and PM settings toggle them from the `Pinned` button. Both are disabled while the computer is offline.

#### Phone

The rail becomes a bottom tab bar, `4rem` tall plus the safe area, in rail colors and cell styles. It shows on the three top-level pages, `#/` for Projects, `#/router`, and `#/settings`, and hides on pushed pages and while the keyboard is open. Projects uses `ProjectList` in its page layout, and its header opens `ComputerSwitcher` as a bottom drawer. Usage moves to the top of the Settings home. Worker and PM settings pages use `--panel` and the side panel's header. Decision 1 above covers the alternative of one tab per computer.

#### Hover shortcuts on list rows

The approved prototype shows the pin toggle and a settings shortcut when a row is hovered, and the UI standard forbids hover-only actions. Both hold if hover only reveals shortcuts to actions that have another path. Pinning also lives in the PM settings panel, and PM settings also open from the conversation header. The shortcuts appear on `:hover` and `:focus-within` under `@media (hover: hover)` and never on touch screens. The guard in `src/web/ui/ui-standard.test.tsx` changes to allow exactly one class for this, `.row-shortcuts`, defined in `src/web/styles.css`.

#### UI standard changes

Each implementation step edits its sections of `docs/ui-standard.md` before touching components.

| Section | Change | Step |
| --- | --- | --- |
| 0. Interface scale | Pane widths and tier thresholds are `rem` values that follow the scale | 3 |
| 1. Spacing scale | Add the rail, the `3.5rem` column headers, `3.25rem` PM rows, side panel padding, and the `6px` sheet inset. Drop the right-rail row | 3 |
| 2. Border radius scale | Becomes "Corners": `px-corner`, `px-corner-lg`, no `rounded-*` in the shell, square status dots | 2 |
| 4. Colors and avatars | Zone tokens replace fruit-tinted surfaces and jelly highlights. One outlined selection style. Accent jobs listed above. Dark brown text links outside Markdown | 2 |
| 5. Icons | pixelarticons only, the drawn pin, no `Composer*` line icons | 2 |
| 6. Control dimensions and tool slots | Pixel button variants and 36px slots with 2px borders | 2 |
| 7. Focus states and chat composer | Inset 2px outline for focus, darker field border on focus, no composer halo, pixel paper-plane send key in the agent color | 2 |
| 8. Alignment and chat column width | Conversation header button for PM settings and the `Pieces` slot. The centered profile page goes | 3 |
| 9. Grouped settings lists | Pixel group boxes, segmented control, switch, radio mark, and search field | 2 |
| 10. Dialogs and bottom drawers | Pixel frames, the new backdrop, settings tabs as a cream column with the PM row selection style | 2 |
| 11. Popovers and usage bars | Pixel popovers, 10-cell meters in the popover, 5-cell meter in the rail | 2 and 3 |
| 12. Right rail | Becomes "Side panel": Pieces, Worker, and Profile contents, header, width limits, close and back targets | 3 |
| 13. Fonts, numbers, and list rows | `3.25rem` PM rows with `2.25rem` avatars and `text-body` names | 3 |
| 14. Interaction states and motion | Drop `.tint-fade` | 2 |
| 15. Markdown, code blocks, and charts | Code blocks and images use `px-corner-lg` | 2 |
| 16. Shell layout | Rail, sheet, PM column or strip, conversation, side panel, resize handles, tiers, macOS traffic lights over the rail | 3 |
| 17. Message stream | `ThreadCard` replaces Worker speech bubbles. Pixel ask cards and bubbles | 2 |
| 19. Touch screens and safe areas | The hover-shortcut amendment | 3 |
| 20. Mobile shell | Tab bar, computer switcher drawer, usage in Settings, profile drill-down pages | 3 |
| 21. Router workbench | Full sheet on the desktop, pixel cards, honey send key | 2 and 3 |
| 23. Capabilities and worktree setup | `Capabilities` and `Worktree setup` open as panel drill-down pages | 3 |
| New: Pins | The `Pinned` group, its order, and where pins are toggled | 3 |

### 4. Performance and bounds

1. **Invalidation.** Pane widths are read from `localStorage` once, clamped on read, written on drag end when the change came from the user, and removed on reset. A `pm_pins` row is deleted on unpin and removed by `ON DELETE CASCADE` when the PM is purged. Archiving keeps the row, so restoring a PM restores its pin. Pin changes reach every browser through the existing `pm.updated` change.
2. **Upper bounds.** Widths are two numbers. `pm_pins` holds at most one row per PM, and the snapshot grows by one nullable number per PM. No collection grows over time, so there is no new cap.
3. **Stable front-end references.** `projectListOf` caches its result per `entries` array in a `WeakMap`, so the PM column's `memo` boundary holds while the list is unchanged. `railComputersOf` and `quotaMeterOf` cache per input array the same way.
4. **Measured verification.** The PR records `pnpm build` chunk sizes before and after. The library should add about 48 kB minified and 16 kB gzip, 3.7% of the current main chunk. Thread cards change how Worker reports render, so the PR also records `scripts/bench-message-list.ts` before and after, following `.agents/skills/benchmark-checklist/SKILL.md`.

New constants in `src/shared/limits.ts` are layout thresholds rather than collection caps, so one-month sizing does not apply.

| Constant | Value | Meaning |
| --- | --- | --- |
| `SHELL_RAIL_REM` | `4.5` | Rail width, 72px at `Default` |
| `SHELL_STRIP_REM` | `4.5` | PM column collapsed to avatars |
| `SHELL_LIST_REM` | `{ min: 13.75, default: 16.5, max: 25 }` | PM column, 220, 264, and 400px |
| `SHELL_PANEL_REM` | `{ min: 22.5, default: 27.5, max: 45 }` | Side panel, 360, 440, and 720px |
| `SHELL_CHAT_MIN_REM` | `30` | Conversation minimum, 480px |
| `SHELL_FRAME_PX` | `10` | Sheet inset and outline beside the rail |
| `SHELL_SEAM_PX` | `2` | One column line |

### 5. Cross-vendor and cross-platform unification

The shell has no vendor-specific code. The rail's usage meter reads `quotaUsage()` in `src/web/selectors.ts`, which walks every vendor in `src/shared/vendors.ts` that declares a `quota` spec, and shows the single fullest window. A future vendor appears in the meter by declaring `quota` in its own `src/vendors/<vendor>/` spec, the file it already implements. Thread card status words come from `workerStatusOf` in `src/web/worker-status.ts`, which is vendor-neutral.

Computer cells reuse `PlatformIcon` from `src/web/components/DeviceBadges.tsx`, which already covers `darwin`, `win32`, and `linux`. In the native macOS app the rail starts below `--macos-traffic-lights-height` and acts as the window drag region. The Windows Tauri shell draws a native title bar, and Linux runs in a browser, so neither needs anything extra. Pins are SQLite rows, identical on all three platforms, and nothing in `src/daemon/platform/index.ts` changes.

### 6. Deletions

Step 2, the visual language:

- `FruitTint` in `src/web/lib/accent-scope.tsx`, `tintStyleOf` in `src/web/lib/palette.ts`, the `--mix-chat`, `--mix-sidebar`, and `--mix-line` tokens, `.tint-fade`, and the matching caps in `src/web/lib/palette.test.ts`.
- Jelly selection: `--color-jelly`, `--color-jelly-hover`, `jellyStyleOf`, `JELLY_ROW`, `ITEM_SELECTED`, and `ITEM_HOVER`.
- The composer halo, meaning the `.composer-frame` shadow rules and `--motion-focus`, plus `SQUARE_BUTTON` and the gray rounded send key.
- The seven `Composer*` line icons in `src/web/ui/icons.ts`, replaced by pixelarticons `Plus`, `Send`, `Stop`, `FileText`, `Video`, `Close`, and `Robot`.
- `--radius-btn` and every `rounded-*` class in shell components. The radius guard in `src/web/web-guard.test.ts` widens from `lg`, `md`, and `sm` to every `rounded-*` class.
- `BUBBLE` with `rounded-[22px]` and `WorkerSpeech` in `src/web/components/Messages.tsx`, replaced by `ThreadCard`.
- Cool zinc neutrals such as `bg-zinc-300` in `src/web/ui/switch.tsx`.
- The `docs/ui-standard.md` text for pill buttons, the `rounded-xl` and `rounded-2xl` tiers, jelly highlights, fruit-tinted surfaces, the focus halo, and Worker speech bubbles.

Step 3, the shell structure:

- `src/web/components/Sidebar.tsx` with its `wide`, `rail`, and `page` layouts, `RouterRowButton`, `NarrowRouterButton`, and the desktop `DeviceGroup` list. `ProjectList` and `AppRail` replace it.
- `src/web/components/SidebarTools.tsx`. The rail takes usage, Update, and Settings, and the PM column header takes New PM.
- The `RightRail` `aside` container and `RightRailToggle`. `SidePanel` and the header `Pieces` slot replace them, and `RailGroups` moves into the panel's Pieces view.
- The `top` right-rail layout and the shell's use of `COMPACT_QUERY` and `NARROW_QUERY`, replaced by `shellTierOf()`.
- The full-page path of `PmProfile` and its Back slot. `ProfilePanel` replaces it on the desktop and the phone, and the `ProjectCapabilitiesPage` header becomes a drill-down header.
- The desktop Back slot in `WorkerConversation` and the desktop branch that renders a Worker in place of the conversation.
- On the phone, the Router row and the Settings slot in the list, replaced by the tab bar, and the usage slot in the list, which moves to the Settings home.
- `ui:polish` screens that describe removed layouts, `sidebar.rail`, `sidebar.devices`, `rail.under-header`, and `rail.collapsed`, renamed or replaced in `test/ui-polish/screens.ts`.
- `docs/screenshots/readme/workspace-*.png`, which show the old shell, are re-captured.

### 7. Skeleton files

Shared and daemon:

- `migrations/0049_pm_pins.sql` and its `migrations/manifest.sha256` line create `pm_pins`.
- `src/shared/resource-registry.ts` registers `pm_pins` as retained metadata written by `src/daemon/ledger/pm-pins.ts` and cleaned with the PM by `src/daemon/ledger/persona.ts`.
- `src/shared/domain.ts` adds `Pm.pinnedAt`.
- `src/shared/api.ts` adds `API_PATHS.pmPin`, `PmPinRequest`, and `PmPinResponse`.
- `src/shared/ledger.ts` adds `Ledger.setPmPinned` and its contract.
- `src/daemon/ledger/pm-pins.ts` holds the pin operations, kept out of `createLedgerPersona` because that factory sits at its size limit. `src/daemon/ledger/ledger.ts` wires it in, and `src/daemon/ui-server/fake-ledger.ts` carries a stub so the interface typechecks.
- `src/web/client.ts` adds the `putPmPin` call as a stub.
- `src/daemon/ledger/pm-pins.test.ts` and `src/daemon/ui-server/pm-pin-route.test.ts` hold the ledger and route cases.
- `src/shared/limits.ts` adds the layout constants from section 4.

Web state:

- `src/web/shell-layout.ts` picks the `wide`, `strip`, or `stack` tier and turns the `rem` limits into pixels.
- `src/web/pane-widths.ts` keeps the remembered widths in a small `zustand` store backed by `localStorage`.
- `src/web/project-list.ts` splits a computer's conversations into pinned, active, and archived sections.
- `src/web/side-panel.ts` resolves the side panel's content from the route and the Pieces state, and where its close and back buttons go.
- `src/web/rail-model.ts` builds the rail's computer cells and the usage meter.
- `src/web/route.ts` widens the profile route's `page` to every drill-down page.

Web components:

- `src/web/ui/resizable.tsx` wraps the resize library as `PaneGroup`, `Pane`, and `PaneHandle`.
- `src/web/components/AppRail.tsx` is the honey rail.
- `src/web/components/ProjectList.tsx` is the PM column in its column, strip, and page layouts.
- `src/web/components/ComputerSwitcher.tsx` is the computer list behind the PM column header.
- `src/web/components/SidePanel.tsx` is the warm-gray panel and its header.
- `src/web/components/ProfilePanel.tsx` is the PM settings summary with its drill-down pages.
- `src/web/components/ThreadCard.tsx` is the Worker report card in the conversation.
- `src/web/mobile/TabBar.tsx` is the phone's bottom tab bar.
- Each of these files has a matching test file with `it.todo` cases.

Implementation order. The whole change does not fit one implementation session of 400K to 600K tokens. It rewrites most of `docs/ui-standard.md`, touches about 50 component files and 16 test files for the visual language, and adds about ten modules for the shell. It splits into two steps on this branch, in this order:

1. **Visual language.** Tokens and corner utilities in `src/web/styles.css`, the primitives listed in section 3, the composer and send key, `ThreadCard`, ask cards and bubbles, Router cards, the settings dialog, the step 2 deletions, the guard tests, and the step 2 rows of the UI standard table. Screens keep today's layout and take the new look. The pin backend lands here too, because it does not depend on the UI: the migration, ledger method, route, client call, and `Pm.pinnedAt`.
2. **Shell structure.** The resize library and its `AGENTS.md` entry, `AppRail`, `ProjectList` with pins, `SidePanel` with Pieces, Worker, and Profile, the profile drill-down routes, narrow tiers, the phone tab bar and computer switcher, the step 3 deletions, the step 3 rows of the UI standard table, and the new `ui:polish` screens.

Visual language goes first, so the new shell components are built from finished primitives instead of being restyled twice.

### 8. Verification plan

Unit and component tests, converted from the `it.todo` cases:

- `src/web/shell-layout.test.ts`: tier boundaries at the `Default` and `Large` scales, the panel-closed case, and re-evaluation on resize and scale changes.
- `src/web/pane-widths.test.ts`: defaults, clamping, ignoring corrupt storage, writing only user-driven changes, and reset.
- `src/web/project-list.test.ts`: pinned order by `pinnedAt`, archived PMs leaving the pinned group, search, and reference stability.
- `src/web/side-panel.test.ts`: content per route, and close and back targets.
- `src/web/rail-model.test.ts`: computer cells hidden for one computer, badges per computer, meter cells, and the warning state.
- `src/web/route.test.ts`: round trips for every profile page.
- `src/daemon/ledger/pm-pins.test.ts` and `src/daemon/ui-server/pm-pin-route.test.ts`: idempotent pin and unpin, the first `pinnedAt` kept, `pm.updated` emitted, archived PMs rejected, and the cascade on purge.
- The component tests listed in section 7.

Guards that change and must pass: `src/web/web-guard.test.ts` for every `rounded-*` class, `src/web/ui/ui-standard.test.tsx` for the pixel primitives and the hover-shortcut rule, `src/web/lib/palette.test.ts`, `src/daemon/resources/registry.test.ts`, `src/daemon/store/store.test.ts`, `src/code-hygiene.test.ts`, and `src/web/selectors-cache.test.ts`.

Real artifacts:

- `pnpm ui:polish shots` before and after, with machine checks at 0, for `chat.normal`, `chat.worker-speech` (renamed for thread cards), `composer.focus`, `worker.normal`, `profile.normal`, `router.normal`, `settings.general`, `settings.providers`, `settings.computers-multi`, `new-pm.default`, `quota.normal`, `m-settings.home`, `sidebar.list-mobile`, and `rail.drawer-mobile` on every viewport they list. Step 3 adds screens for the pinned group, a hovered row, the side panel with a Worker and with PM settings, a profile drill-down page, the `strip` and `stack` tiers on the `narrow` and `slim` viewports, widths seeded past their limits, and the phone tab bar and computer switcher.
- `scripts/verify-smoke.ts` gains a real-browser check. It drags the PM column handle 600px to the right and expects `25rem`, double-clicks the handle and expects `16.5rem`, then drags again, reloads, and expects the dragged width to survive.
- `pnpm typecheck`, `pnpm test:related`, and `pnpm verify` pass. The PR records `pnpm build` chunk sizes and `scripts/bench-message-list.ts` before and after.
- Side-by-side before and after images for the three main screens against prototype v1, and for the Router page, settings dialog, narrow tiers, and phone screens against prototype v2.
