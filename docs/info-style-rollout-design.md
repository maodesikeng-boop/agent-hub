# Info-style settings, dialogs, and small surfaces

> Snapshot: 2026-11-26 (commit `80be62d0`)

## Plan review and decisions

### Files to review

- This document: the inventory of surfaces that do not follow the current standard, the template they copy (the project manager `Info` tab), the change list per surface, and the color choices.
- [`docs/ui-standard.md`](ui-standard.md): section 9 now states the Info row recipe for every settings list, dialog, popover, and phone settings page; sections 1, 3, and 10 are aligned with it.
- [`docs/info-style-rollout/`](info-style-rollout/): before contact sheets, Chromium on the left and WebKit on the right, one per area (`before-settings.webp`, `before-new-pm.webp`, `before-profile.webp`, `before-m-settings.webp`, `before-popovers-states.webp`).
- `test/ui-polish/capture.ts` and `test/ui-polish/cli.ts`: `pnpm ui:polish shots --engine webkit` captures the same inventory in WebKit into `<round>/webkit/`. WebKit contexts block service workers, because WebKit sends a service worker's fetches past `page.route` and the request patches would not apply.
- `test/ui-polish/screens.ts`: six new interaction-state screens: `settings.nav-hover`, `settings.button-hover`, `settings.group-hover`, `new-pm.row-hover`, `new-pm.look-open`, and `new-pm.device-open`.

### Project Manager plan review

Check that each quoted sentence in section 1 maps to a scenario in section 8, that each of the nine categories in section 8 has a scenario or a one-sentence reason, and that every surface in the inventory names its file, its before screenshot, and its change list. The user fixed the template ("直接抄pm info的风格"), so section 3 records one approach and the alternative it replaces instead of a broad design comparison.

### Decisions needed

The user asked for care where color is involved ("需要颜色的地方稍微斟酌"). Every color choice is in [Colors](#colors). The two choices that change what the user sees on many screens went to the user, who settled both on the recommended option: 「A 两项都按推荐」 (decision card for graph #150).

- **D1. Primary buttons, decided: pastel** (`Create`, `Save`, `Submit`, `Restore`, `Download for macOS`). Recommended and chosen: the pastel send recipe, a light tint of the PM color with dark text, honey outside a PM, the same as the composer `Send`. This follows the 2026-11-25 rule that a button carrying the PM color is the same hue made light with a dark icon. Alternative: keep the solid `--primary` (dark brown outside a PM, the PM accent inside one). Example: today `Create` in the New PM dialog is solid `#4a2e00` with white text; under D1 it is honey `#fed782`-hued pastel with dark brown text, exactly like the Router `Send`.
- **D2. Interface scale control, decided: a menu.** Recommended and chosen: the Info value style, `Interface scale  Default ⌄` opening a menu of the four scales. Alternative: keep the four-cell segmented control, shrunk to fit a `30px` row. The menu costs one extra click when changing scale; the segmented control is the only boxed control left on the page.

The Project Manager settles the rest, and the plan follows the recommendations unless the Project Manager changes them: D3 (switch tracks always `--brand-ink`), D4 (copy the Info colors through shared classes instead of new tokens), and D5 (implementation split, section 7).

## 1. User goal

The user's request: 「同步去把设置页面，新建pm页面，还有之前各种没有按规范触及到的小页面都修成我们现在的标准，然后等这批都修完了，我们就发新版本」

The user's follow-up for this plan: 「不需要这么高，风格已经确定了，直接抄pm info的风格就行，方案也不用花太长时间，需要颜色的地方稍微斟酌」

Outcome: the Settings page (every category and its sheets), the New PM dialog, the Info drill-down pages, phone settings, the remaining dialogs and popovers, and the full-page states read like the PM `Info` tab: `30px` rows, `13.5px` labels, muted values on the right, groups parted by one soft line, text actions instead of outline buttons. Only looks and interaction change; no product behavior or data changes.

## 2. Current state and history

### Design history

The `Info` tab arrived with the wide work panel (#445, cards #335 and #336): a frameless `44px` avatar, then groups of `30px` rows with the label on the left and a muted value and chevron on the right, parted by one `#efeae2` line, and text actions at the bottom. The wood shell (#439) restyled the frame, the PM list, the rail, and the Settings categories column, but the settings primitives in `src/web/components/SettingsList.tsx` kept their older shape: `15px` titles, `36px` controls, `52px` rows, group boxes in dialogs and on the phone, and flat groups with a divider under every row on the Settings page. Nearly every settings-like surface composes those primitives, so the gap is in one place rather than a stack of patches.

### Core concepts

- **Row primitives.** `SettingsGroup`, `SettingsRow`, `CollapsibleGroup` (`SettingsList.tsx`), `ChoiceRows` and `ModeRows`, `AgentRows`, and the phone `SettingsNavRow`. Settings (desktop and phone), the New PM dialog, the Info drill-down pages, and most sheets render through them.
- **Box versus flat.** The `FlatGroups` context switches a group between a hairline box (dialogs, panels, phone) and flat sections (Settings page). The Info tab uses neither; its rows and lines are the `.work-info-*` classes in `src/web/styles.css`.
- **Missing concept.** There is no shared "Info row": the approved look lives only in work panel CSS, so other surfaces cannot use it without copying literals.

### Verified evidence

- [Measured] Info rows are `h-7.5` buttons with a `text-minor` label, a `.work-info-val` value, and a `size-3.5` chevron (`src/web/components/InfoTab.tsx:306-323`); groups are `.work-info-sec` with `8px` padding and a `1px #efeae2` bottom line, and rows bleed `8px` with a `#f5f1eb` `6px` hover band (`src/web/styles.css:2012-2040`). Read from source.
- [Measured] `SettingsRow` is `px-4` with `py-2` and `min-h-9` (about `52px`), `py-3` with a detail line, and a `text-body` label (`src/web/components/SettingsList.tsx:110-116`); `CollapsibleGroup` triggers are `min-h-13` (`SettingsList.tsx:69`); `ChoiceRows` rows are `min-h-12` or `py-3` with `text-body` labels (`src/web/components/ChoiceRows.tsx:57-64`).
- [Measured] Settings categories are `h-9` `text-body` rows (`src/web/components/SettingsDialog.tsx:121`), while PM list rows on the same year rings are `h-6.5` `text-minor`.
- [Measured] The Settings body is inset `px-2` with a left-aligned `max-w-180` column (`SettingsDialog.tsx:142-144`), leaving about a quarter of the sheet blank on the right in a `1440px` window (`settings.general@desktop`); Info pages center a `max-w-160` column (`InfoTab.tsx:603`).
- [Measured] Dialogs use `p-6`, a `size-8` close at `top-4 right-4`, `h-9` footer buttons, and group boxes inside (`src/web/ui/dialog.tsx:86`, `:114`; `new-pm.default@desktop`).
- [Measured] Resources draws two parallel hairlines between `Storage breakdown` and `Kept`: in flat mode each `CollapsibleGroup` has `border-y`, and the page puts `gap-6` between groups (`SettingsList.tsx:67`; `settings.resources@desktop`).
- [Measured] Info drill-down pages still render boxed `SettingsGroup`s with `15px` rows (`InfoTab.tsx:490-568`; `profile.vendor-unavailable@desktop`).
- [Measured] The loading, signed-out, and load-error pages render on a bare white page outside the wood frame (`src/web/WorkbenchSurfaces.tsx:56`; `shell.signed-out@desktop`).
- [Measured] Before screenshots: `pnpm ui:polish shots --round U1 --only settings,new-pm,m-settings,quota,profile,shell.loading,shell.signed-out,shell.load-error,graph.cancel-confirm,sidebar.switcher,router.model-picker,router.model-picker-vendor,rail.empty,router.empty,worker.menu,chat.file-preview,chat.user-blocker`, then the same with `--engine webkit`. Each engine captured 74 screens and 48 crops (Chromium 159.0, WebKit 27.2) on commit `80be62d0` plus this branch's tooling changes, with every machine check at `0`, so the gaps are style, not breakage. Full-size images: `/tmp/fusa-ui-polish/U1/` and `/tmp/fusa-ui-polish/U1/webkit/`.

## 3. Reference design and approach

The reference is internal and fixed by the user: the PM `Info` tab. No external products are compared.

| Approach | Structure | Verdict |
| --- | --- | --- |
| A. One Info row recipe in shared classes and primitives | Move the `.work-info-*` rules into shared `.info-*` classes, rebuild `SettingsGroup`, `SettingsRow`, `CollapsibleGroup`, `ChoiceRows`, and `SettingsNavRow` on them, delete the box and flat variants, then fix the per-surface controls (outline buttons to text actions, segmented tracks to tabs or menus) | **Chosen.** One source for the look; the Info tab renders through the same classes, so the two cannot drift. This is also the day-one design |
| B. Restyle each surface in place | Each settings component gets its own row classes | Rejected: about 30 files would each carry a copy of the recipe, the trap that left Settings behind the Info tab |

Red flags checked against `.agents/skills/architect/references/design-red-flags.md`: approach A removes the parallel box and flat paths instead of adding a third; no surface keeps a private row style; no new color tokens (D4).

### The Info recipe

Each surface below names the rules it adopts by these IDs. `docs/ui-standard.md` section 9 carries the same rules.

| ID | Rule |
| --- | --- |
| R1 Row | `h-7.5` (`30px`, `pointer-coarse:min-h-11`); label `text-minor` in ink on the left; value `text-minor tabular-nums` `#6f665d` on the right (`max-w-44`, truncated with `title`); a `14px` `#756c63` `ChevronRight` when the row opens a page or sheet, `ChevronDown` when it opens a menu. A row that opens something is one button with the `#f5f1eb` `6px` hover band bled `8px` past the text edge and the `2px` inset focus outline |
| R2 Group | No dividers between rows. Groups part with one `1px` `#efeae2` line and `8px` of space on each side. No boxes, fills, or radii, in dialogs and popovers too |
| R3 Heading | Only where one page holds groups of different kinds: `text-xs` `500` `#756c63`, `14px` above and `6px` below, count or text actions on its right |
| R4 Detail line | `text-xs` muted under the label, only for a reason the user can act on (blocked permission, failed install) or a second fact that does not fit the value |
| R5 Text action | `text-minor` `500` `#5f564d`, ink and underlined on hover, `--danger` when destructive, `18px` apart. Replaces outline buttons inside rows |
| R6 Row controls | Sized to the `30px` row: `Switch`; a menu shown as the row's value with `ChevronDown` (Radix `Select`); inputs `h-7.5` `text-minor` with `field-focus`; `24px` ghost icon buttons |
| R7 Sheet chrome | `2.75rem` header, title `text-title` `600` on the `20px` edge, `28px` ghost `Close`; `px-5` body with a centered `max-w-160` column |
| R8 View switch | Underline tabs as in the work panel header (`text-minor` `500`, selected in ink with a `1.5px` underline, `20px` apart) when a choice changes what the page shows |
| R9 Identity | `44px` frameless avatar with the pencil badge on hover, beside the name (`.work-info-id`) |
| R10 States | Loading: `Loader2` and `Loading…`. Empty: one centered muted line. Error: one red line and a `Retry` text action |

### Inventory and changes

Before images are in the contact sheets; the screen IDs are the `pnpm ui:polish` inventory keys.

**Settings, desktop** ([sheet](info-style-rollout/before-settings.webp))

| Surface | Files | Screens | Changes |
| --- | --- | --- | --- |
| Shell | `SettingsDialog.tsx` | `settings.general`, `settings.nav-hover`, `settings.tabs-top` | Categories become PM list rows: `h-6.5`, `text-minor` label in `--list-ink`, `16px` icon in `--list-ink-soft`, `gap-2`, cream band when selected. Sheet gets R7 (title moves from the `24px` to the `20px` edge, `28px` close, centered column). Below `720px` the categories become R8 tabs on top |
| General | `SettingsDialog.tsx`, `UpdateSettings.tsx` | `settings.general`, `settings.button-hover` | `Interface scale` R1 whose value opens a menu of the four scales (D2, decided). `Notifications` R1 with the switch; the blocked reason is R4. The `Updates` heading goes; the version row is its own R2 group: `Bellwood v0.4.0` with the `Source` chip, value `Up to date`, R5 `Check for updates` and `Release notes` with the `12px` external icon. The download row keeps one small primary `Download for macOS` (D1) |
| Providers | `ProvidersSettings.tsx`, `ProviderSheetChrome.tsx`, `VendorSyncSettings.tsx` | `settings.providers`, `-busy`, `-error`, `-sign-in`, `settings.sync-preview` | R3 heading `Providers` with `5 ready` and R5 `Refresh`. One R1 row per provider: status dot, name, version in `text-xs` muted; value is the account or `Not signed in` / `Not installed`; the row opens the existing account or sign-in sheet. `Install` is R5; installing shows a spinner, `Installing…`, and R5 `Show log` opening the log below; a failure shows the reason as R4 in `--danger`. `Vendor sync` and the Git environment rows are R1 with R5 actions. Sign-in sheet: R8 tabs for `Sign in with browser` and `API key`, R5 `Open sign-in page` and `Copy link`, `h-7.5` input, dialog footer rules |
| Capabilities | `CapabilitiesSettings.tsx`, `CapabilitiesPanel.tsx`, `CapabilityScopeSwitch.tsx` | `settings.capabilities` | Scope `Segmented` becomes R8 tabs; the project picker is an R1-style value with `ChevronDown`. Toolbar: `h-8` search and R5 `Refresh`. Section headings R3 with `N of M`. Plugin rows R1 (rotating `ChevronRight`, name, `N of M`, switch), item rows R1 indented `pl-6`, chips unchanged. Empty state R10 |
| Resources | `ResourcesSettings.tsx` | `settings.resources` | R3 headings `Needs review` and `Summary` (R5 `Refresh`, `Clean up`). Held items: R1 label, caution dot, reason as value, sample paths `font-mono text-xs` as R4, R5 `Keep` and danger `Delete…` / `Stop…`. Summary rows R1 with spaced value parts. `Storage breakdown` and `Kept` become R1 expand rows (`ChevronDown`, count) in one R2 group, which removes the double lines. Computer picker R6 |
| Computers | `DeviceSettings.tsx`, `AccountSettings.tsx` | `settings.computers`, `-multi`, `-remove`, `settings.long` | Account R1 (`alice`, `Connected`, R5 `Sign out`); approvals R1 with the code and R5 `Approve` / `Reject`; hub order R1 with `24px` arrow buttons; computer rows R1 with a `16px` platform icon, name, dot, value parts (`macOS`, `Same network`, `Online`), R5 `Rename…` and danger `Remove…`; relay URL R6 input |
| Security & Access | `BrowserSessions.tsx` | `settings.security`, `-open`, `settings.group-hover` | `Sign in on another device` R1 with R5 `Show QR code`; `Signed-in browsers` R1 expand row with the count; browser rows R1 (icon, name, value `This browser` or the time, R5 `Sign out`); danger R5 `Sign out all…` |

**New PM dialog** ([sheet](info-style-rollout/before-new-pm.webp)); files `NewPmDialog.tsx`, `SlimePicker.tsx`, `ModeRows.tsx`, `AgentRows.tsx`; screens `new-pm.default`, `-more`, `-select-open`, `-invalid`, `-devices`, `-row-hover`, `-look-open`, `-device-open`.

- Identity first (R9): the `44px` avatar button opens the look picker and sits beside the `h-8` name input (`Name` placeholder, accessible name `Name`); this replaces the `Name` and `Look` rows. A name error is one red R4 line under the input.
- One R2 group of R1 rows: `Device` (two or more computers, R6 menu), `Main folder` (`h-7.5` input with `Optional`, R5 `Choose…` when the computer has a folder picker), `Mode` (value `Orchestrate` with `ChevronDown`; the menu shows each mode with its one-line consequence).
- `More settings` is an R1 expand row; it reveals `Provider`, `Model`, and `Effort` (R6 menus from `AgentRows`) and the borderless `Persona` field in its own R2 group.
- Dialog chrome per the dialog rules below; `Create` is the one small primary button (D1). On the phone the full-screen sheet keeps its header, rows grow to `44px`, and `Create` stays full width.
- Look picker: `Fruit` and `Color` headings become R3; the chosen cells keep `tile-open`.

**Info drill-down pages** ([sheet](info-style-rollout/before-profile.webp)); files `InfoTab.tsx`, `AgentRows.tsx`, `ModeRows.tsx`, `ScheduleGroup.tsx`, `PmMemoryFilesGroup.tsx`, `ProjectGroups.tsx`, `CapabilitiesPanel.tsx`; screens `profile.*`. The summary (`profile.normal`, `profile.lower`) is the template and does not change.

- `Model`: R1 rows with R6 menus and no box; `Cancel` and `Save` as small buttons on one row when edited.
- `Mode`: two-line rows (label, `text-xs` consequence) with the `16px` radio mark, no box.
- `Folders`: R1 rows, folder name as label, shortened path as value, `Main folder` as the first row's value suffix.
- `Schedules`: schedule rows R1 (name, value `Daily 09:00`, next run as R4, switch, `24px` delete button); the new-schedule form uses R1 rows with `h-7.5` inputs and the small `Cancel` and `Save`.
- `Persona` and `Worktree setup`: the borderless field under an R3 heading with the existing `Clear` / `Cancel` / `Save` actions.
- `Memory files`: R1 rows per file with R5 `Edit` and danger `Delete…`.
- `History`: two-line rows (`actor` and summary, time as R4) with R5 `Undo`.
- `Capabilities`: as Settings → Capabilities. Archived: R1 `Archived` with the small primary `Restore`.

**Phone settings** ([sheet](info-style-rollout/before-m-settings.webp)); files `src/web/mobile/settings/*`; screens `m-settings.*`.

- The page turns white with R2 groups and R3 headings instead of white boxes on `bg-panel`.
- `SettingsNavRow` becomes R1 at `min-h-11` with the `16px` icon, value, and `ChevronRight`.
- Each sub-page follows its desktop section at `44px` rows; drawers keep `h-11` full-width buttons and take `text-minor` body text.
- The `Usage` group at the top matches the quota popover rows.

**Dialogs, popovers, and states** ([sheet](info-style-rollout/before-popovers-states.webp))

| Surface | Files | Screens | Changes |
| --- | --- | --- | --- |
| Dialogs | `ui/dialog.tsx` and every non-page `DialogContent` | `graph.cancel-confirm`, `profile.new-session-confirm`, `profile.archive-confirm`, `settings.computers-remove`, `settings.sync-preview`, `settings.providers-sign-in` | `20px` padding, `28px` ghost close level with the title, confirmation text `text-minor`, footer buttons `size="sm"` with `Cancel` as a ghost button, forms as R1 and R2 rows with no group boxes |
| Usage popover | `QuotaPopover.tsx` | `quota.normal`, `-max`, `-short-window`, `-rail` | Header like the top-bar Router popover (`h-10`, `18px` hourglass, `text-minor` `600`); provider name `text-minor` `600`; model family R3; window rows `text-minor`; bars unchanged |
| Computer switcher | `ComputerSwitcher.tsx` | `sidebar.switcher` | One R1 line per computer (`16px` platform icon, name, status dot, the status in words as the row value, count chip, check); `Manage computers…` as an R5 row |
| Router model picker | `RouterModelPicker.tsx` | `router.model-picker`, `-vendor` | R1 rows (provider, model as value, `16px` radio mark); `Model & effort` as an R1 expand row; `Add provider…` as R5 with a chevron |
| Select menus | `ui/select.tsx` | `new-pm.select-open`, `new-pm.device-open` | Items `text-minor`, `28px` tall on desktop (`44px` on touch) |
| Full-page states | `WorkbenchSurfaces.tsx` (`FullPage`) | `shell.loading`, `shell.signed-out`, `shell.load-error` | Render on the wood frame with one white sheet like `#/router`; centered column with the `text-title` title, `text-minor` muted lines, and at most one small action (`Retry`) |

Checked and left alone (already on the current standard): the work panel tabs and empty states (`rail.empty`), the Worker `⋯` menu (`worker.menu`), the Task Graph dialog, ask and decision cards, the user blocker card (`chat.user-blocker`), Router `All clear` (`router.empty`), file preview (`chat.file-preview`), and the Computer Use and sandbox approval cards (#451).

### Colors

| Where | Color | Why |
| --- | --- | --- |
| Row lines, hover band, values, chevrons, headings, text actions | The Info colors, applied through the shared `.info-*` classes: line `#efeae2`, hover `#f5f1eb`, value `#6f665d`, chevron and heading `#756c63`, text action `#5f564d` turning `#1e1610` on hover (D4) | They are the approved look. Moving the rules into shared classes keeps one source; new tokens would duplicate `--border`, `--hover`, and `--muted-foreground`, which differ from them by less than `0.05` in contrast |
| Status dots (providers, computers, held resources) | `--success` ready or online, `--caution` needs action, reconnecting, or review, `bg-muted-foreground/40` not installed or offline | The same tokens as the rail's computer dots, so a computer reads the same on the rail, in the switcher, and in Settings. The status is also written as the row value, because amber stays under `3:1` on white |
| Attention dot (Resources tab, rail gear, phone rows) | `--danger` | Standard section 4: amber stays under `3:1` on cream and white |
| Destructive text actions (`Delete…`, `Stop…`, `Remove…`, `Sign out all…`) | `text-danger` | The same as Info's `Archive`; the confirmation's final button stays solid `destructive` |
| Primary buttons (D1, decided) | `--send` fill with `--send-ink` text (PM hue inside a PM, honey outside), `--send-disabled` when disabled | The user's 2026-11-25 rule for buttons carrying the PM color; the Info tab has no solid buttons, and a pastel button sits quieter among `30px` rows |
| Switch tracks (D3) | `--brand-ink` everywhere, also inside a PM | A setting's on state should not change color with the PM (a green PM made the Schedules switch olive, `profile.schedule-form`); the PM color stays on avatars and `Send` |
| Selection on white | `tile-open` (`#fff6d6` fill, `#e0b03c` ring) | The standard's selection on white for chosen options, picker cells, and the current computer |
| Chips | `.tool-badge` honey (`Source`, `Custom`, `Recommended`), `bg-panel` muted kind tags, `--brand-ink` count chips | Unchanged; chips stay flat labels |
| Inline links (`Release notes`, `SHA-256`, `Skip this version`) | Text action colors instead of `--brand-ink` | One text-action color per page; `--brand-ink` stays on checks and count chips |
| Usage bars | Unchanged: `--brand-ink`, `--caution`, `--danger` | Already the standard |

## 4. Performance and bounds

None. The change restyles rendering only; no cache, snapshot, or collection is added or grows. Shorter rows make long lists (capabilities, resources, browsers) shorter on screen.

## 5. Cross-vendor and cross-platform unification

No vendor code changes. Provider rows render every vendor registered in `src/shared/vendors.ts` from the same row, so a future vendor implements nothing for this UI. The macOS app renders in WebKit, and the Windows app (WebView2) and Linux browsers render in Chromium, so every before and after screenshot is taken in both engines.

## 6. Deletions

- `GROUP_BOX`, `GROUP_SHELL`, `GROUP_FLAT`, `FlatSettingsGroups`, and the `FlatGroups` context in `SettingsList.tsx`; the `52px` `CollapsibleGroup` trigger; the `min-h-9`, `py-2`, and `py-3` `SettingsRow` variants; the `13.5px` group heading style.
- Outline buttons inside rows (`Check for updates`, `Show QR code`, `Refresh`, `Clean up`, `Keep`, `Install`, `Sign out`, `Scan…`, `Choose…`).
- `Segmented` everywhere it is used (the Interface scale row, the Capabilities scope, the sign-in sheet), so `src/web/ui/segmented.tsx`, the `tile-selected` utility in `src/web/styles.css`, and `segmented` in the `AGENTS.md` list of installed primitives go too.
- The `.work-info-*` class names, replaced by the shared `.info-*` names that the Info tab also uses.
- The `docs/ui-standard.md` text that keeps Settings, dialogs, and the phone at the `15px` body, the group box rules, the `52px` collapsible row, and `SettingsNavRow` `min-h-12`.

## 7. Skeleton files

Per the Project Manager's scope for this plan (inventory, changes per surface, and before screenshots), this step ships no code skeleton. The first implementation step writes the acceptance tests below before it edits production code and records their red run, which `REVIEW.md` allows ("in the planning step or first implementation step's report").

Files the implementation changes: `src/web/styles.css`, `src/web/components/SettingsList.tsx`, `ChoiceRows.tsx`, `ModeRows.tsx`, `AgentRows.tsx`, `SettingsDialog.tsx`, `UpdateSettings.tsx`, `ProvidersSettings.tsx`, `ProviderSheetChrome.tsx`, `VendorSyncSettings.tsx`, `CapabilitiesSettings.tsx`, `CapabilitiesPanel.tsx`, `CapabilityScopeSwitch.tsx`, `ResourcesSettings.tsx`, `DeviceSettings.tsx`, `AccountSettings.tsx`, `BrowserSessions.tsx`, `NewPmDialog.tsx`, `SlimePicker.tsx`, `InfoTab.tsx`, `ScheduleGroup.tsx`, `PmMemoryFilesGroup.tsx`, `ProjectGroups.tsx`, `QuotaPopover.tsx`, `ComputerSwitcher.tsx`, `RouterModelPicker.tsx`, `src/web/WorkbenchSurfaces.tsx`, `src/web/ui/dialog.tsx`, `select.tsx`, `button.tsx` (D1), `switch.tsx` (D3), the deleted `segmented.tsx` (D2), `AGENTS.md`, and `src/web/mobile/settings/*`.

Acceptance tests, in a new `src/web/info-style.test.tsx`:

| Test | Asserts | Before implementation |
| --- | --- | --- |
| T1 | A `SettingsRow` is a `30px` row (`h-7.5`) with a `text-minor` label | Fails |
| T2 | `SettingsGroup` renders no box in a dialog, on the Settings page, or on the phone; rows inside a group have no divider; groups part with `.info-sec` | Fails |
| T3 | Settings category triggers are `h-6.5` `text-minor` | Fails |
| T4 | `Check for updates`, `Refresh`, `Show QR code`, and `Sign out` render as `.info-action` text actions, not `btn-raised` | Fails |
| T5 | The New PM dialog puts the `Change look` avatar button beside the name input, has no group box, and shows `Mode` as a menu trigger with the value `Orchestrate` | Fails |
| T6 | The Capabilities scope is a `tablist`, not a radio group | Fails |
| T7 | `Storage breakdown` and `Kept` sit in one group with one line between groups | Fails |
| T8 | `FullPage` renders inside `.wood` on a `.shell-sheet` | Fails |
| T9 | The phone `SettingsNavRow` is an `.info-row` with `pointer-coarse:min-h-11` | Fails |
| T10 | Regression: `src/web/ui-scale.test.tsx`, `src/web/ui/ui-standard.test.tsx`, `src/web/web-guard.test.ts`, and the behavior assertions in `SettingsDialog.test.tsx`, `ProvidersSettings.test.tsx`, `ResourcesSettings.test.tsx`, `BrowserSessions.test.tsx`, `AccountSettings.test.tsx`, `VendorSyncSettings.test.tsx`, `QuotaPopover.test.tsx`, `ComputerSwitcher.test.tsx`, `mobile-settings.test.tsx`, and `new-pm-dialog-mobile.test.tsx` | Passes before and after |

D5, the split for the next steps: (1) the shared `.info-*` classes and primitives with the Settings page and the New PM dialog; (2) the Info drill-down pages, phone settings, dialogs, popovers, and full-page states. Both push to this branch.

## 8. Verification plan

### Acceptance scenarios

1. **Settings page** (「设置页面」). Open Settings from the rail gear, then each category. Every list is `30px` rows with values on the right, no outline buttons in rows, and one soft line between groups. Hover a category, a row, and a text action: the category takes `--list-hover`, the row the hover band, the action an underline.
2. **Settings sheets and confirmations.** From Providers open `Sign in…` and `Scan…`, from Computers `Remove…`, from Resources `Delete…`. Each sheet uses the dialog rules and its own rows follow R1 and R2.
3. **New PM dialog** (「新建pm页面」). Click `+` in the PM list. The dialog opens with the avatar beside the name field, then `Device` (two computers), `Main folder`, and `Mode`. Hover the avatar to see the pencil, click it to open the look picker, open the `Device`, `Mode`, and `Model` menus, type a 41-character name to see one red line, and enter a valid name to enable `Create` in the D1 color.
4. **Info drill-down pages** (「之前各种没有按规范触及到的小页面」). Open each Info row. Every page uses the same rows as the Info summary, with no boxes.
5. **Phone settings.** On a `390px` touch screen open `#/settings` and each sub-page and drawer. Rows are `44px`, white, grouped by lines.
6. **Popovers and states.** Open the usage popover, the computer switcher, the Router model picker, and the look picker; load the app signed out, during loading, and with the daemon down. Popovers follow R1 to R3; the full-page states sit on the wood frame.
7. **Scales and widths.** Repeat scenario 1 at `Compact` and `XL`, at `860px`, and below `720px` (categories as tabs on top). Nothing clips; rows scale with the root size. At `700px` the XL root size takes the phone shell, so XL there opens the phone settings page and its sub-pages. Screens `settings.w860-sm-*`, `settings.w860-xl-*`, `settings.w700-sm-*` (each category), and `m-settings.w700-xl-*` (each phone page) wait for the layout branch they expect, and `pnpm verify` asserts the branch and no sideways scroll for every category and phone page.
8. **Keyboard.** Tab through Settings → General and the New PM dialog. Each row, text action, menu, switch, and tab shows the `2px` outline. New PM is walked with two computers, a valid name (`Create` enabled), and `More settings` expanded: screens `new-pm.kb-01-look` to `new-pm.kb-12-close` reach each stop by keyboard in Chromium (Tab) and WebKit (Alt+Tab) and fail unless the stop shows a visible mark.

Every scenario produces before and after screenshot sets in Chromium and WebKit with the rest state and the interaction state of each control (hover, open, expanded, focus), including the usage popover. The implementation adds the screens it needs for interaction states that the inventory does not cover yet, such as `settings.scale-menu-open`, `settings.capabilities-tab-hover`, `settings.resources-expanded`, `new-pm.mode-open`, `new-pm.more-hover`, `m-settings.row-press`, and `settings.focus`.

### Category coverage

- **Two consecutive turns:** not applicable; Settings, dialogs, and popovers take no part in conversation turns.
- **Restart mid-operation:** covered by the loading and load-error pages a daemon restart shows (scenario 6); no restart logic changes.
- **State change while queued:** a provider moving from installing to ready re-renders its row (`settings.providers-busy`, then `settings.providers`); no queue logic changes.
- **Existing rules (`REVIEW.md` on `main`):** "Interface changes come with a real-browser render": both engines through `pnpm ui:polish`. "Front-end selectors return stable references": the `App.tsx` edit adds no selector and changes no memo slot. "A rewrite keeps what the old code guaranteed": read-only, archived, offline, and disabled states, error lines, attention dots, `44px` touch targets, and accessible names stay; tests listed in T10 must keep passing. "Stale in-flight queries never overwrite fresh mutations" and "A result is matched to its request by an id both carry": no query, cache, or request code changes. "Tests wait for events, not for time": the new tests are jsdom renders with no timers. "Planned acceptance scenarios cover every requirement and pass real tests": this section and T1 to T10.
- **Large data volume:** the `stress` seed (20+ PMs, long lists) for the switcher and Info pages; the implementation adds `settings.capabilities` on the `stress` seed to check a long capability list.
- **Malformed or dirty data:** very long names, paths, and relay URLs truncate with a `title` (`settings.long`, `profile.long`); unknown vendor labels keep their fallbacks.
- **Cross-vendor:** all eight registered providers render as rows (`settings.providers`). No prompt, message, tool, or MCP definition changes, so prompt caching is unaffected.
- **Cross-platform:** WebKit (macOS app) and Chromium (Windows app, Linux browsers) screenshots for every scenario.
- **Entry points and layouts:** desktop wide (`1440px`), narrow (`860px`), slim (`700px`), and phone (`390px`); two computers (`settings.computers-multi`, `new-pm.devices`, `sidebar.switcher`). Feishu and the `hub` CLI have no part of this UI.

### Commands and visual checks

- `pnpm exec vitest run src/web/info-style.test.tsx` plus the T10 files: red before implementation (T1 to T9), green after.
- `pnpm ui:polish shots --round <id> --only <inventory list above>` and the same with `--engine webkit`, before and after, delivered as paired contact sheets.
- `pnpm verify`, `pnpm lint`, `pnpm typecheck`, and `pnpm test:related` before the final push.
