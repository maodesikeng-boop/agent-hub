# Concentric inner corners for clipped card and strip rows

> Snapshot: 2026-11-28 (commit `88d616f1`)

Decision cards, the top-bar Router reply popover, collapsible event strips, and code block headers use `overflow-hidden` on an `8px` rounded shell (`--radius-sm`). Full-bleed child rows inside those shells currently have `0px` corners or an outer focus outline, so the shell clips the corners of inset focus rings, invalid error rings, and keyboard focus outlines. This plan introduces concentric inner-corner CSS recipes in `src/web/styles.css`, deletes the unused `CardNoteForm` `variant="field"` branch, fixes `.md-code` toolbar focus offset, and adds automated geometry and visual checks.

## Plan review and decisions

### Files to review

- [docs/card-inner-corners-design.md](card-inner-corners-design.md): This design document, including the full-repository audit of all `overflow-hidden` containers, candidate comparison, `REVIEW.md` rule mapping, and verification plan.
- [docs/ui-standard.md](ui-standard.md): Updates sections 2.1, 7, 17, and 21.1 to define concentric inner-corner rules for full-bleed edge rows and clipped toolbar buttons.
- [docs/README.md](README.md): Indexes this design document under Standards.
- [src/web/components/Deliverables.tsx](../src/web/components/Deliverables.tsx): Exports the typed `CardNoteFormProps` contract for the unified reply row.
- [scripts/verify-card-corners.ts](../scripts/verify-card-corners.ts): Typed skeleton for concentric corner geometry validation (`checkConcentricCornerGeometry`) and real-browser Playwright corner verification (`verifyCardCorners`).
- [src/web/card-corners.test.tsx](../src/web/card-corners.test.tsx): Runnable pre-implementation acceptance test suite covering CSS recipes, all four `CardNoteForm` hosts, `CollapsibleEvent`, `EventStripShell` + `WorkerNoticeRow`, `CodeBlock` `BarButton`, dead-branch deletion, `checkConcentricCornerGeometry`, and unchanged-rule regression cases.

### Project Manager plan review

Confirm three checks before implementation starts:

1. Every quoted user sentence in Section 1 maps to at least one acceptance scenario in Section 8.
2. Every applicable verification category in Section 8 has a concrete scenario, and each inapplicable category states in one sentence why it cannot apply.
3. The candidate designs in Section 3 are structurally distinct, not minor tweaks inside one approach.

### Decisions needed

None. This change repairs clipped focus and error strokes so they follow the existing container corner radius without changing card layout, spacing, copy, or interaction semantics.

## For Workers and reviewers

### 1. User goal

> 这个框选后有问题，左右下角不完整

When the user focuses or triggers an error state on a decision card reply row (`Reply or add a note…`) or keyboard-focuses any edge interactive control inside a rounded `overflow-hidden` container, every corner of the focus or error outline must render as a complete, unclipped curve matching the outer container.

### 2. Current state and history

#### Design history

- `[Measured]` In commit `9dd20f40` (#407), `AskCard` and `CardNoteForm` used sharp `0px` corners with `border-2` nested boxes (`git log -L 211,224:src/web/components/Deliverables.tsx`).
- `[Measured]` In commit `8ea09acb` (#439), Bellwood unified cards around one `1px`-bordered `overflow-hidden rounded-sm` frame (`--radius-sm: 8px` in `src/web/styles.css:103`), replaced the nested reply box with a full-bleed bottom row (`CardNoteForm variant="row"` in `src/web/components/Deliverables.tsx:212-223`) using `focus-within:shadow-[inset_0_0_0_1px_var(--border-focus)]`, and documented `rounded-none` for full-bleed rows in `docs/ui-standard.md:53`. The premise was that `overflow-hidden` clips hover fills cleanly and square corners prevent notching internal hairline dividers.
- `[Measured]` That premise broke for perimeter strokes. CSS `overflow: hidden` clips a child to the parent's padding-box curve (`R_inner = max(0, R_outer - border_width)`). On a `1px`-bordered `8px` card (`R_inner = 7px`), a `1px` inset box-shadow on a square (`0px`) bottom row extends past the `7px` arc by `7 * (1 - 1 / sqrt(2)) = 2.05px` diagonally at both bottom corners, so the browser slices off both bottom-left and bottom-right corners. Visual inspection of `/tmp/askcard-focus-corners/user-screenshot.png` confirms straight dark `#4a4038` focus edges terminating before the rounded bottom-left and bottom-right card corners.
- `[Measured]` In commit `08ee5151` (#449), `CardNoteForm` added an `invalid` prop rendering `shadow-[inset_0_0_0_1px_var(--danger)]` (`src/web/components/Deliverables.tsx:218`) and gained a fourth host (`RouterTopBarPopover`), inheriting the identical bottom-corner clipping for both focus and red error rings.
- `[Measured]` In commit `12ecc502` (#465), keyboard `focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-[-2px]` was restored on `EVENT_TRIGGER` (`src/web/components/Messages.tsx:332-333`), exposing the same `0px`-vs-`8px` clipping on borderless `overflow-hidden rounded-sm` event strips (`8 * (1 - 1 / sqrt(2)) = 2.34px` cut off each outer corner).
- `[Measured]` The current code is not a deep stack of workarounds; it is one missing geometric rule (concentric inner radii on container-edge rows and inset outline offset on `.md-code` bar buttons) plus one dead legacy branch (`CardNoteForm` `variant="field"` at `src/web/components/Deliverables.tsx:164,220`, which has zero callers).

#### Core concepts

- **Outer shell clip radius (`R_inner`)**: Owned by each `overflow-hidden rounded-sm` container. For `1px`-bordered cards and popovers (`AskCard`, `RouterDecisionCard`, `GateDecisionCard`, `RouterTopBarPopover`), `R_inner = calc(var(--radius-sm) - 1px)` (`7px`). For borderless event strips (`CollapsibleEvent`, `EventStripShell`), `R_inner = var(--radius-sm)` (`8px`).
- **Row stroke geometry**: Currently split across inline Tailwind arbitrary shadows in `Deliverables.tsx:218` and `rounded-none` utilities in `Messages.tsx:333`. No shared CSS token or recipe expresses the concentric inner radius (`--card-inner-radius`).
- **Clipped toolbar outline**: `.md-code` (`src/web/styles.css:1142-1155`) sets `overflow: hidden` and `.md-code-bar` has `height: 1.75rem`, matching `BarButton`'s `size-7` (`1.75rem`) in `src/web/components/CodeBlock.tsx:74`. Because `BarButton` omits `outline-offset`, its `2px` outer `focus-visible` outline renders outside the button box and its top edge is clipped by `.md-code`.
- **Missing concept**: A single CSS definition for concentric inner corners (`--card-inner-radius`, `.card-reply-row`, `.event-strip-shell` + `.event-strip-trigger`) that keeps divider-facing corners square (`0`) while curving outer container-edge corners to match `R_inner`.

#### Verified evidence and full-repository audit

Every occurrence of `overflow-hidden`, `overflow: hidden`, `rounded-none`, `shadow-[inset_`, and `outline-offset` in `src/web/` was scanned with `git grep` on commit `88d616f1`.

| File and line | Container and inner control | Status | Evidence |
| --- | --- | --- | --- |
| `src/web/components/AskCard.tsx:94,147-155` | `overflow-hidden rounded-sm border` + `CardNoteForm variant="row"` | Affected (`[Measured]`) | Bottom-left and bottom-right corners of `1px` focus ring and `1px` invalid ring clipped by `7px` padding-box arc; matches `/tmp/askcard-focus-corners/user-screenshot.png`. |
| `src/web/components/RouterDecisionCard.tsx:47,111-121` | `overflow-hidden rounded-sm border` + `CardNoteForm variant="row"` | Affected (`[Measured]`) | Shares `CardNoteForm` at bottom (`-mx-4 -mb-4`); identical bottom-corner clipping. |
| `src/web/components/GateDecisionCard.tsx:84,118-128` | `overflow-hidden rounded-sm border border-select-line bg-open` + `CardNoteForm variant="row"` | Affected (`[Measured]`) | Shares `CardNoteForm` at bottom (`-mx-3.5 -mb-3 pl-3.5`); identical bottom-corner clipping. |
| `src/web/components/RouterTopBarPopover.tsx:111,151-162` | `PopoverContent` (`overflow-hidden rounded-sm border p-0`) + `CardNoteForm variant="row"` with `invalid={replyInvalid}` | Affected (`[Measured]`) | Clips both focus ring and live red error ring (`--danger`) at bottom-left and bottom-right corners. |
| `src/web/components/Messages.tsx:474-475` | `CollapsibleEvent` (`overflow-hidden rounded-sm bg-panel`, borderless) + `CollapsibleTrigger` (`EVENT_TRIGGER`, `rounded-none`, `outline-offset-[-2px]`) | Affected (`[Measured]`) | Clips all 4 focus-outline corners when collapsed (`data-state="closed"`) and both top corners when expanded (`data-state="open"`). |
| `src/web/components/Messages.tsx:416,556-571` | `EventStripShell` (`overflow-hidden rounded-sm bg-panel`, borderless) + `WorkerNoticeRow` (`EVENT_TRIGGER`, `rounded-none`, `outline-offset-[-2px]`) | Affected (`[Measured]`) | Clips top focus-outline corners on first row, bottom corners on last row, and all 4 corners on sole row. |
| `src/web/components/CodeBlock.tsx:68-79,117-130` and `ChartBlock.tsx:144-158` | `.md-code` (`overflow: hidden; border: 1px; border-radius: 8px`) + `BarButton` (`size-7` in `h-7` bar, `outline-offset: 0`) | Affected (`[Measured]`) | Outer `2px` focus outline on top edge is clipped by `.md-code`. |
| `src/web/components/OptionRow.tsx:24` and `GateDecisionCard.tsx:104` | Option buttons in `AskCard`, `RouterDecisionCard`, `GateDecisionCard` | Safe (`[Measured]`) | Always above `CardNoteForm` while interactive (`!answered`); buttons are `disabled` when settled and cannot receive focus. |
| `src/web/components/Deliverables.tsx:55` (`MediaThumb`), `RouterModelPicker.tsx:473` | Elements with `overflow-hidden` on themselves and `focus-visible:outline-2` | Safe (`[Measured]`) | CSS `outline` paints outside an element's own `overflow: hidden` box and has `16px` parent padding clearance in cards. |
| `src/web/ui/dialog.tsx:86,114`, `SettingsDialog.tsx:135,147`, `Composer.tsx:114`, `SearchField.tsx:23`, `RouterTopBar.tsx:158` | Dialog close button, settings tabs, chip close, search field, top-bar input | Safe (`[Measured]`) | Controls either have padding clearance from rounded parent corners or draw borders on the rounded outer shell itself. |
| `src/web/components/Attachments.tsx:50`, `QuotaPopover.tsx:31`, `MobileSettings.tsx:119`, `WorkerConversation.tsx:41,91`, `ui/avatar.tsx:9` | Non-interactive clipped thumbnails, progress tracks, status strips, avatars | Safe (`[Measured]`) | No interactive focus ring or inset error border. |
| `src/web/components/SandboxApprovalCard.tsx:42`, `AppApprovalCard.tsx:40`, `UserBlockerCard.tsx:44`, `ComposerMenu.tsx:37` | Cards and menus without `overflow-hidden` or with padded button footers | Safe (`[Measured]`) | Inner buttons sit inside `px-3.5 py-3` or `p-1.5` padding with full outline clearance. |

Also verified against repository guards:

- `[Measured]` `src/web/web-guard.test.ts:699-709` permits only `rounded-xs`, `rounded-sm`, `rounded-t-sm`, `rounded-tile`, `rounded-full`, and `rounded-none` in `.ts`/`.tsx` files. Arbitrary `rounded-b-[...]` classes in TSX would fail this guard.
- `[Measured]` `src/web/ask.test.tsx:431-432` asserts `expect(row.className).not.toMatch(/shadow-\[var\(--shadow-tile\)\]|border-border-strong|rounded-sm/)` and `expect(card).toHaveClass("overflow-hidden", "rounded-sm")`.
- `[Measured]` `test/ui-polish/in-page.ts:236,278` classifies any container matching `:has(> textarea)` as a control shell (`control: true`), so a `1px` inset ring on `.card-reply-row` triggers zero `machine:box-in-box` or `machine:thick-line` warnings.

### 3. Reference designs and approach comparison

#### Reference designs

1. **CSS Backgrounds and Borders Level 3: Corner Clipping** (`https://drafts.csswg.org/css-backgrounds/#corner-clipping`): Specifies that `overflow: hidden` clips children to the parent's padding edge whose inner corner radius is `max(0, border-radius - border-width)`. Matching a flush child's border-radius to that inner curve eliminates both clipping and corner gaps.
2. **Apple Human Interface Guidelines: Concentricity** (`https://developer.apple.com/design/human-interface-guidelines/layout`): Nested rounded surfaces compute their inner corner radius concentrically (`R_inner = R_outer - inset`) so adjacent arcs share a center point and maintain uniform visual thickness around every corner.
3. **Radix Primitives and Primer Box edge-row styling** (`https://www.radix-ui.com/primitives`, `https://primer.style/foundations/primitives`): Full-bleed interactive rows inside divided rounded containers keep divider-facing corners square (`0`) and apply the container's inner radius only to edge-facing corners via `:first-child`, `:last-child`, and `[data-state]` selectors, preserving clean hairline dividers without clipping focus indicators.

#### Candidate comparison

| Criterion | Candidate A: Concentric inner-corner CSS recipes in `styles.css` (Recommended, day-one design) | Candidate B: Remove `overflow-hidden` from cards and strips (No-clip split-shell) | Candidate C: Padded standalone input box inside card footer |
| --- | --- | --- | --- |
| Mechanism | Define `--card-inner-radius: calc(var(--radius-sm) - 1px)` (`7px`), `.card-reply-row`, and `.event-strip-shell` / `.event-strip-trigger` in `src/web/styles.css`; add `outline-offset-[-2px]` on `BarButton`; delete unused `variant="field"`. | Remove `overflow-hidden` from `AskCard`, `RouterDecisionCard`, `GateDecisionCard`, `RouterTopBarPopover`, `CollapsibleEvent`, and `EventStripShell`; give every edge child its own corner radius and outer focus outline. | Stop bleeding `CardNoteForm` to card edges; render a standalone bordered input box inside card `p-4` padding; pad event strip triggers. |
| Visual fidelity | Exact concentric `7px` arc inside `8px`/`1px` cards and `8px` arc inside borderless strips; zero gap, zero double corners, zero divider notches. | Risk of subpixel background bleed past `1px` outer card borders on `bg-open` settled rows, hover rows, and scrolling popover timelines. | Violates `docs/ui-standard.md` sections 2.2, 12.1, 17, 21, and 21.1 ("one frame and nothing framed inside it") and triggers `machine:box-in-box`. |
| Ownership and guards | Single CSS source of truth in `styles.css`; passes `web-guard.test.ts` radius-token guard and `ask.test.tsx:431-432` unchanged; CSS selectors avoid prop-drilling `isFirst`/`isLast`/`open`. | Splits corner ownership across every child component (`OptionRow`, settled `answerNote`, `CardNoteForm`, hover fills, timelines); breaks `ask.test.tsx:432`. | Reverts the `8ea09acb` visual language and changes card height and layout contrary to user constraints. |
| Implementation scope | Small, localized changes in 4 production files (`styles.css`, `Deliverables.tsx`, `Messages.tsx`, `CodeBlock.tsx`) plus `verify-card-corners.ts`. | High churn across 10+ components and tests with recurring maintenance cost for every future card child. | Medium churn plus UI regression and broken `ui:polish` checks. |

**Recommendation**: Choose **Candidate A**. It is the design we would build from day one: one container owns clipping (`overflow-hidden rounded-sm`), one CSS custom property (`--card-inner-radius`) derives the exact inner arc from `--radius-sm`, and semantic component classes apply concentric corners to edge rows while leaving divider-facing corners square.

#### Design red flags check

Checked against `.agents/skills/architect/references/design-red-flags.md`:

- **Shallow module / Pass-through method**: Avoided by keeping row corner geometry in `src/web/styles.css` rather than wrapping CSS class names in unnecessary React components or forwarding helpers. `scripts/verify-card-corners.ts` encapsulates real concentric-radius geometry validation and Playwright inspection.
- **Information leakage / Hand-synced list**: Avoided by deriving `--card-inner-radius: calc(var(--radius-sm) - 1px)` directly from `--radius-sm` instead of hardcoding `7px`, and by using CSS structural selectors (`[data-state="closed"]`, `[data-state="open"]`, `:first-child`, `:last-child`) instead of manually syncing corner props in React callers.
- **Split ownership**: Avoided by placing both focus (`:focus-within`) and invalid (`[data-invalid="true"]`) ring styles and their radii in one `.card-reply-row` rule in `styles.css`.
- **Two ways to do one task**: Avoided by deleting the unused `variant="field"` branch from `CardNoteForm` in the same PR.

### 4. Performance and bounds

None. This change adds pure CSS corner and focus rules in `src/web/styles.css` and a test/verification helper in `scripts/verify-card-corners.ts`. It adds no in-memory caches, growing collections, API responses, or timers, and keeps `[data-ask-card] { contain: layout style }` and the existing bounded decision draft store untouched.

### 5. Cross-vendor and cross-platform unification

- **Vendors (`src/shared/vendors.ts`)**: All eight registered vendors render decisions, event strips, and code blocks through the shared vendor-neutral React components (`AskCard`, `RouterDecisionCard`, `GateDecisionCard`, `RouterTopBarPopover`, `Messages`, `CodeBlock`). A future vendor implements zero changes here (only its existing `src/vendors/<vendor>/spec.ts`).
- **Platforms (`macOS`, `Windows`, `Linux`)**: Logical corner radius properties (`border-end-start-radius`, `border-end-end-radius`, `border-start-start-radius`, `border-start-end-radius`), `calc()`, `box-shadow: inset`, and `outline` following `border-radius` are standard across Chromium (Linux, Windows WebView2) and WebKit (macOS `WKWebView` Safari 16.4+). Zero platform-specific code under `src/daemon/platform/` or `apps/` is required.

### 6. Deletions

Deleted in the implementation step so old and new paths never coexist:

- Inline arbitrary inset shadow utilities (`focus-within:shadow-[inset_0_0_0_1px_var(--border-focus)]` and `shadow-[inset_0_0_0_1px_var(--danger)]`) in `src/web/components/Deliverables.tsx:218`, replaced by `.card-reply-row` in `src/web/styles.css`.
- Dead `variant="field"` branch in `src/web/components/Deliverables.tsx:164,179,220` (zero callers in the repository), simplifying `CardNoteForm` to one row recipe.
- Conflicting `rounded-none` class on `EVENT_TRIGGER` in `src/web/components/Messages.tsx:333`, replaced by `.event-strip-trigger` inside `.event-strip-shell` and `CollapsibleEvent`.

### 7. Skeleton files

- `docs/card-inner-corners-design.md`: This design document.
- `docs/ui-standard.md`: Documents the concentric inner-corner contract for full-bleed edge rows and clipped `.md-code` toolbar buttons.
- `docs/README.md`: Indexes `docs/card-inner-corners-design.md`.
- `src/web/components/Deliverables.tsx`: Exports `CardNoteFormProps` as the typed prop contract for `CardNoteForm` while keeping runtime behavior unchanged until Step 2.
- `scripts/verify-card-corners.ts`: Typed skeleton for `checkConcentricCornerGeometry` and Playwright `verifyCardCorners`.
- `src/web/card-corners.test.tsx`: Runnable acceptance and regression test suite for CSS rules, all affected components, dead-code removal, and concentric corner geometry checks.

### 8. Verification plan

#### Acceptance scenarios

Every quoted user sentence, settled rule, matching `REVIEW.md` rule, and applicable category maps to executable tests in `src/web/card-corners.test.tsx` and real-browser verification in `scripts/verify-card-corners.ts`:

1. **Primary user goal (`AskCard` focus and error bottom corners)**:
   - First: Open a PM conversation with an unanswered `AskCard` (`Reply or add a note…`) and an option list.
   - Next: Focus the reply textarea, type a note, and also test an invalid state (`data-invalid="true"`) and a failed submit (`err !== null`).
   - User sees: Complete, continuous `1px` dark `#4a4038` focus ring (and `1px` `--danger` error ring when invalid) curving concentrically (`7px`) along both bottom-left and bottom-right corners of the `8px` card with zero clipping and crisp square top joins against the divider.
2. **All sibling `CardNoteForm` hosts (`RouterDecisionCard`, `GateDecisionCard`, `RouterTopBarPopover`)**:
   - First: Open `#/router` with a pending `RouterDecisionCard`, open `TaskGraphDialog` with a `GateDecisionCard`, and send a quick message from the desktop top bar to open `RouterTopBarPopover`.
   - Next: Focus the reply row in each host, type input, and exceed `ROUTER_COMMAND_MAX_CHARS` in `RouterTopBarPopover` so `invalid` triggers.
   - User sees: Complete concentric `7px` bottom-left and bottom-right focus rings in all three hosts, and a complete concentric red `--danger` ring in `RouterTopBarPopover` (both focused and blurred) with `Send` disabled until shortened.
3. **Sibling borderless event strips (`CollapsibleEvent`, `EventStripShell` + `WorkerNoticeRow`) and `.md-code` `BarButton`**:
   - First: Render a `ScheduleRun` / `WakeupNotice` / `SessionRenewed` collapsible strip, a grouped `EventStripShell` containing first/middle/last `WorkerNoticeRow` triggers (and a single-row strip), and a fenced code block with `Copy code`.
   - Next: Move keyboard focus (`Tab`) onto each trigger in collapsed, expanded, first, middle, last, and sole positions, and onto `Copy code`.
   - User sees: Unclipped `8px`-curved `2px` focus outlines on outer container corners, square `0px` divider-facing corners (hover never notches dividers), and an unclipped top focus outline edge on `BarButton`.
4. **Two consecutive turns in the same conversation**:
   - First: In one PM conversation, answer ask card #1 via its reply row so it settles cleanly.
   - Next: Receive ask card #2 in turn 2 (and send two consecutive turns inside `RouterTopBarPopover`), focus the new reply row, and submit.
   - User sees: Card #1 stays settled with a flush bottom row (`-mb-4`) and no reply input; card #2 renders its own focused reply row with complete bottom corners and independent draft state.
5. **Restart in the middle of the operation**:
   - First: Leave an unanswered `AskCard` open in a conversation and restart the daemon (or reload the browser page against persisted state).
   - Next: Reopen the conversation and focus the restored `AskCard` reply row.
   - User sees: The unanswered card reloads intact and its focused reply row renders complete bottom-left and bottom-right corners.
6. **State or configuration change while queued**:
   - First: Focus an `AskCard` reply row and type an unsent draft.
   - Next: Change interface scale (`Compact`, `Default`, `Large`, `XL`) while focused, and then settle the card remotely via a WebSocket `message.updated` event.
   - User sees: At every interface scale, bottom corners stay concentric (`7px` inside `8px`/`1px`) without clipping; after remote settlement, the reply row disappears cleanly and `UnsentDraftBanner` preserves the draft.
7. **Reopening a closed view after cached data becomes stale**:
   - First: Open `TaskGraphDialog` (`GateDecisionCard`) and `RouterTopBarPopover`, enter a draft, close them, and let cached data become stale while holding the refresh response open.
   - Next: Reopen the dialog or popover before the refresh finishes, then let the refresh complete.
   - User sees: The cached view renders without layout jumps or clipped bottom corners while refreshing, preserves shared drafts, and stays intact once fresh data lands.
8. **Large data volume (one-month sizing: 300 finished Workers, 30,000 messages, 50,000 step logs)**:
   - First: Render an ask card with many options and a multi-line reply exceeding `NOTE_MAX_HEIGHT_PX` (`144px`) inside a chat stream.
   - Next: Scroll the textarea and focus/blur the reply row.
   - User sees: Textarea caps height at `max-h-36` with internal vertical scrolling, `[data-ask-card] { contain: layout style }` stays intact, and bottom corners remain complete with zero added memory collections or per-frame JS work.
9. **Malformed or dirty data**:
   - First: Render an ask card with empty `options: []`, an unbroken 5,000-character reply string, whitespace-only input, and a `CollapsibleEvent` with `children={null}` (disabled trigger).
   - Next: Attempt to submit whitespace or over-limit text, and inspect layout at `390px` width.
   - User sees: Whitespace never submits, over-limit text triggers `data-invalid="true"` with complete red bottom corners and no horizontal overflow, and disabled event triggers stay non-interactive without broken corners.
10. **Cross-vendor coverage and prompt-cache preservation**:
    - All eight vendors in `src/shared/vendors.ts` share the identical web UI components; this change does not touch system prompts, tool or MCP lists, session messages, or vendor drivers, so `TokenUsage.cacheRead` is structurally unaffected across every vendor (one-sentence non-applicability for prompt-cache before/after CLI diff).
11. **Cross-platform coverage (`macOS`, `Windows`, `Linux`)**:
    - Pure standard CSS logical corner radii and inset box-shadows/outlines behave identically across Chromium (Linux, Windows WebView2) and WebKit (macOS `WKWebView`).
12. **Cross-entry-point and layout coverage**:
    - Wide desktop (`1440x900`) and narrow mobile (`390x844`) web screens across all four interface scales, plus multi-computer `RouterDecisionCard` (online and dimmed offline states). Feishu and `hub` CLI do not apply because Feishu renders native Feishu interactive cards and `hub` CLI outputs terminal text without web CSS clipping.

#### Matching `REVIEW.md` rules from `origin/main`

Checked against `git show origin/main:REVIEW.md`:

- **Stale in-flight queries never overwrite fresh mutations** (`src/web/**`): No React Query cache writes or query functions are added or changed; existing mutation guards remain untouched.
- **Interface changes come with a real-browser render** (`src/web/components/**`, `src/web/styles.css`): Implementation delivers paired before-and-after Playwright screenshots across all affected surfaces, all interactive states (idle, focus, typing, error/invalid, hover, keyboard `focus-visible`), desktop wide (`1440x900`) and mobile narrow (`390x844`), plus `pnpm verify` and `pnpm ui:polish`.
- **A rewrite keeps what the old code guaranteed** (`src/web/**`): Keeps `overflow-hidden rounded-sm` card shells, `data-card-reply="row"`, `Enter`/`Shift+Enter`/IME submission, shared decision draft persistence, `UnsentDraftBanner`, read-only settled cards, `aria-invalid`, and layout containment; only unused `variant="field"` is removed.
- **Tests wait for events, not for time** (`**/*.test.tsx`): Every test uses synchronous DOM assertions or event-driven `waitFor` / Playwright locator waits with zero fixed sleeps or wall-clock checks.
- **Detached child processes and temp dirs stay inside the session boundary** (`scripts/**`): `scripts/verify-card-corners.ts` spawns no processes and creates no temp directories.
- **A result is matched to its request by an id both carry** (`src/web/**`): Existing `clientId` and `retryId` request-matching paths are untouched.
- **Planned acceptance scenarios cover every requirement and pass real tests** (`**`): All user quotes, rules, and categories above are backed by runnable assertions in `src/web/card-corners.test.tsx`, recorded pre-implementation failing baseline, and real-browser verification in `scripts/verify-card-corners.ts`.
- **Paths that require a review stamp**: None of the modified paths (`docs/**`, `src/web/**`, `scripts/verify-card-corners.ts`) fall under the stamp-required list in `REVIEW.md`.

#### Real-environment and real-CLI verification

All scenarios are web-only flows that run locally against an isolated temporary Bellwood instance and headless Chromium via Playwright (none may claim `not verified`):

- Start an isolated local Bellwood daemon with a temporary data directory, seed all affected surfaces (`AskCard`, `RouterDecisionCard`, `GateDecisionCard`, `RouterTopBarPopover`, `CollapsibleEvent`, `EventStripShell` + `WorkerNoticeRow`, and fenced `CodeBlock`), and run `verifyCardCorners(page)` plus paired before-and-after screenshot capture covering:
  - States: idle, focused, typing multi-line, invalid/error (both focused and blurred), hover on adjacent options/triggers, and keyboard `focus-visible` (`Tab`).
  - Viewports: desktop wide (`1440x900`) and mobile narrow (`390x844`), plus zoomed corner crops inspecting bottom-left, bottom-right, top-left, and top-right corners pixel by pixel.
  - Evidence: start-to-finish screenshot sequences (and optional H.264 MP4 walkthrough) saved in `/tmp/askcard-focus-corners/shots/` and referenced in the implementation and review handoffs.

#### Commands and visual checks

- **Plan step (Step 1)**:
  - `pnpm typecheck` (must exit 0).
  - `pnpm exec vitest run src/docs-guard.test.ts src/web/web-guard.test.ts` (must pass).
  - `pnpm exec vitest run src/web/card-corners.test.tsx` (pre-implementation baseline: every new/changed behavior test must fail, every unchanged-rule regression test must pass).
- **Implementation step (Step 2)**:
  - Re-run `pnpm exec vitest run src/web/card-corners.test.tsx` before editing production code to confirm the pre-implementation baseline, then implement until all tests pass without weakening any planning test.
  - Run `pnpm exec vitest run src/web/card-corners.test.tsx src/web/ask.test.tsx src/web/deliverables.test.tsx src/web/router-topbar.test.tsx src/web/router-workbench.test.tsx src/web/ui/ui-standard.test.tsx src/web/web-guard.test.ts`.
  - Capture before/after paired screenshots across all affected surfaces, states, and wide/narrow viewports and inspect every image visually.
  - Run the full local gate once after all edits are final: `pnpm lint`, `pnpm typecheck`, `pnpm test:related`, and `pnpm verify` (including `verifyCardCorners`).
