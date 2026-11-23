# UI standard

Shared interface specification for the Bellwood web workbench (`src/web/`). Colors come from CSS variables in `src/web/styles.css`, and reusable primitives live in `src/web/ui/` and `src/web/components/SettingsList.tsx`. Match every rule below when building or editing screens; if a screen needs a pattern not covered here, update this document first.

## 0. Interface scale

- **Interface scale** (**Settings**, **General**, **Appearance**): `Compact`, `Default`, `Large`, and `XL` (`Segmented`, section 9), saved per browser in `localStorage` (`agent-hub.uiScale`, `src/web/ui-scale.ts`). **`Large` is the default.**
- **Root font size (`<html data-ui-scale>` in `src/web/styles.css`)**: `Compact` `90.625%` (`14.5px`), `Default` `100%` (`16px`), `Large` `109.375%` (`17.5px`), and `XL` `118.75%` (`19px`). Type tokens (`--text-*`), `Avatar` sizes, and Tailwind spacing (`rem`) scale proportionally together.
- **Pixel values in this document reflect the `Default` (`16px`) scale** (`Large` multiplies all `rem` sizes by `1.09375x`).
- **Shell pane and tier geometry (`src/shared/limits.ts`)**: Fixed honey rail (`SHELL_RAIL_REM = 4.5`), collapsed strip (`SHELL_STRIP_REM = 4.5`), PM column (`SHELL_LIST_REM`, min `13.75`, default `16.5`, max `25`), side panel (`SHELL_PANEL_REM`, min `22.5`, default `27.5`, max `45`), conversation minimum (`SHELL_CHAT_MIN_REM = 30`), and `shellTierOf()` responsive breakpoints scale from the active root `rem` (with `SHELL_FRAME_PX = 10` sheet frame overhead and `SHELL_SEAM_PX = 2` column seams in `px`).
- Never hardcode arbitrary pixel font sizes or widths (`text-[15px]`, `w-[240px]`); use the type tokens in section 3 and Tailwind numeric scales (`w-60`, `max-w-110`). Border radii, `1px` borders, viewport breakpoints (`max-[1100px]`, `min-[720px]:`), macOS traffic-light insets, and pixel icons stay in `px` (guarded by `src/web/ui-scale.test.tsx`).

## 1. Spacing scale

Use only these Tailwind `4px`-step tokens:

| Location | Default px | Class or variable |
| --- | --- | --- |
| Honey rail (`AppRail`) width | `72px` (`4.5rem`) | `w-18` (`SHELL_RAIL_REM`) |
| Sheet frame beside the rail | `6px` top, right, bottom inset + `2px` outline | `.shell-sheet` (`SHELL_FRAME_PX = 10`) |
| Column header height (`ProjectList`, `SidePanel`, `Conversation`) | `56px` (`3.5rem`) | `h-14` |
| Desktop PM list row height | `52px` (`3.25rem`) | `h-13` |
| Main pane horizontal padding | `24px` | `px-6` |
| Chat column minimum side gutter | `12px` below `40rem` main width, `48px` at or above `40rem` | `--chat-gutter` on `.chat-column` and `.messages` (section 8) |
| Conversation header inset | `20px` start, `12px` end | `--header-gutter-start` and `--header-gutter-end` |
| Side panel horizontal and group vertical padding | `20px` and `12px` | `px-5` and `py-3` |
| PM column horizontal padding and row gap | `12px` and `4px` | `px-3` and `space-y-1` |
| Gap between groups or dialog sections | `24px` | `gap-6` |
| Gap between a group heading and its box | `8px` | `gap-2` |
| Settings row padding | `16px` horizontal, `10px` vertical | `px-4 py-2.5` (`py-2` for `min-h-9` rows, `py-3` with helper text) |
| Gap between row label and control | `16px` | `gap-4` |
| Gap between adjacent controls | `8px` | `gap-2` |
| Gap between row label and subtext | `0px` to `2px` | none or `mt-0.5` |
| Dialog padding | `24px` | `p-6` on `DialogContent` |
| Popover padding | `16px` | `p-4` on `PopoverContent` |

## 2. Corners and borders

Controls, containers, and cards use **square right-angle corners (`0px`) and plain `2px` (`border-2`) or `1px` solid borders** — zero pill or card roundness and no stepped `clip-path` pixel notches on frame edges. Pixel craft stays on characters, avatars, sprites, and brand illustrations, while controls use crisp straight borders and smooth line icons.

| Element | Rule |
| --- | --- |
| Buttons, inputs, textareas, selects, code blocks, option rows, settings tabs | Square corners (`0px`), `border-2` plain borders (ghost buttons and plain selects are borderless) |
| Sidebar rows, grouped boxes, cards, ask cards, thread cards, dialogs, popovers, drawers | Square corners (`0px`), `border-2` (`--border` for group boxes, `--border-strong` for overlays and composer) |
| Persistent tool slots and counter badges | CSS `border-radius: 4px` with `border: 2px solid var(--slot-line)` and `2px` bottom inset shade |
| Status indicators, attachment chips, thumbnail tiles, radio marks, switch track and thumb | Square (`0px` corners) |

Guard tests in `src/web/web-guard.test.ts` forbid any `rounded-*` Tailwind utility class in `src/web/` and forbid raw `<select` elements outside `src/web/ui/select.tsx`.

## 3. Type scale, weights, and shell copy

Use only three weights: `400` (default), `500` (`font-medium`), and `600` (`font-semibold`).

All panes and dialogs share **four UI type sizes** defined in `src/web/styles.css` (`@theme`) and registered in `FONT_SIZE_TOKENS` (`src/web/lib/utils.ts`):

| Tier | Class | Default px | Typical uses |
| --- | --- | --- | --- |
| Micro metadata and rail headers | `text-xs` | `12` | Timestamps, counts (`tabular-nums`), `Recommended`, `Archived`, `Needs You`, `Task Graph`, `Pieces`, `Completed` (`500` for headers, `400` for metadata) |
| Secondary text and buttons | `text-minor` | `13.5` | Button labels (`500`), segmented controls, group headings outside boxes (`500`), row descriptions (`leading-snug`), sidebar previews, Worker names (`500`), `Show more`, inline errors (`text-danger`) |
| Body copy and row titles | `text-body` | `15` | Message prose, row titles, `ProjectList` PM names (`600`), inputs, selects, ask card questions (`500`), option text (`400`), side-panel row titles |
| Pane and dialog titles | `text-title` | `17` | Conversation header name, side panel header, dialog titles (`600`) |

The sole exception is the profile header name (`text-display`, `22px`, `600`, `tracking-tight`). Never use `13px` or `14px`. Markdown headings and code blocks follow section 15.

### Shell copy rules

- All hardcoded UI copy in `src/web/` (headings, row labels, buttons, placeholders, empty states, status words, `aria-label` strings, and tooltips) uses concise **sentence-case English** (`New session`, `Interface scale`, `Sign out all browsers...`), keeping Title Case only for named product surfaces (`Needs You`, `Task Graph`, `Router`). User chat messages, PM names, and Piece titles preserve user input, and user-facing error descriptions come from `src/shared/errors.ts`.
- Write group headings and row titles as short noun phrases (`Mode`, `Effort`) without parenthetical explanations.
- Keep row descriptions to one short sentence stating the consequence, with no trailing period and no editorial nudges (`recommended`, `best for...`).
- Do not repeat the row title on its action button: `New session` pairs with `Start...` (trailing `...` indicates a confirmation step).
- Put `Optional` in the input placeholder rather than appending `(optional)` to the row label.
- Format relative times as `3m ago` or `just now`, archive countdowns as `Deletes in 7d`, and counts as bare numerals (`tabular-nums`).

## 4. Colors and avatars

- **Warm zone palette (`src/web/styles.css`)**:
  - Neutral chrome uses warm paper and sand tokens instead of cool zinc grays or fruit-tinted surface mixes: `--background` (`#ffffff`) for the conversation and cards, `--panel` (`#f7f4ed`) for secondary panels, `--foreground` (`#1c1917`), `--muted-foreground` (`#6f6862`), `--border` (`#eee8dc`), `--border-strong` (`#ddd4c2`), `--border-focus` (`#4a4038`), and `--hover` (`#f6f2e9`).
  - Rail and list tokens (`--rail` `#ffcb3d`, `--rail-shade` `#e9a417`, `--rail-hover` `#ffd966`, `--rail-ink` `#4a2e00`, `--rail-ink-soft` `#6e4a00`, `--rail-outline` `#8a5300`, `--rail-warn` `#7c4100`, `--rail-danger` `#991b1b`, `--list` `#fff4cc`, `--list-edge` `#efd27d`, `--list-hover` `#ffedb0`, `--list-field` `#fffbeb`, `--list-ink` `#3b2600`, `--list-ink-soft` `#75561b`, `--select-line` `#e0b03c`) tint navigation zones, settings tabs, and selection outlines.
  - Selected items on white or warm gray use `--open` (`#fff6d6`) with a `2px` `--open-line` (`#e9c25a`) border; selected items on cream (`--list`) use `bg-background` with `--select-line`. Neutral hover uses `bg-hover`. Selection never changes font weight.
- **Dynamic PM accent (`--primary` and `--primary-foreground`)**:
  - `src/shared/slimes.ts` decouples 20 fruit slime shapes from 24 palette entries (`blob` for sprite fills, `accent` darkened to >= 4.5:1 WCAG AA contrast against white, verified in `src/web/lib/palette.test.ts`).
  - `AccentScope` (`src/web/lib/accent-scope.tsx`, `display: contents`) wraps each PM conversation, its Piece conversations, its profile page, the right rail, and in-session dialogs. Outside `AccentScope` (the left sidebar, `#/router`, global settings, and New PM dialog), `:root` sets `--primary` to `--rail-ink` (`#4a2e00`).
  - **Solid accent (`bg-primary text-primary-foreground`) appears only on**: the single primary button on screen (`Create`, `Save`, `Send` inside a PM, `Stop`, or the recommended gate option; hover darkens with `hover:brightness-90`), checked switch tracks, checked radio marks, `6px` attention dots on `Needs You` and the collapsed right-rail toggle, and the file-drop dashed border. Outside `AccentScope` (Router's composer), `Send` uses honey `--rail` with `--rail-ink` foreground.
  - **User message bubbles (`bg-bubble-me text-bubble-me-foreground`)**: Mix `--primary` at `12%` (`--mix-bubble-me`) into `#ffffff` with warm dark foreground text (>= 4.5:1 contrast across all 24 colors).
  - **Text links outside Markdown**: Inline secondary text actions use `text-rail-ink` (`#4a2e00`) or `text-muted-foreground hover:text-foreground`. Colored borders appear only on the file-drop target, active `Waiting on you` items (`border-open-line`), and `--select-line` / `--open-line` selections.
  - **Sidebar attention dot**: Unanswered asks and waiting turns show an `8px` square (`size-2 bg-status-active`, with `ring-2 ring-list` on compact strips and `border-2 border-rail` on rail computer dots) with no text pill; screen-reader text lives on `aria-label` and `title`.
- **Avatars (`src/shared/slimes.ts`)**:
  - Inline transparent-background pixel SVGs with no frame.
  - **Project Managers**: 20 fruit slimes paired with any of 24 colors via `SlimePicker` (`Fruit` and `Color` grids).
  - **Pieces**: Curled note sprite (`Avatar neutral`) tinted with the owning PM's color.
  - **Router**: Sprout bell (`RouterAvatar`), unscoped warm chrome, preserving source PM avatars on incoming cards and reports.

## 5. Icons

Import all UI icons from `src/web/ui/icons.ts` (`lucide-react` smooth-line 24-grid icons alongside matching smooth-line custom SVGs for `PinFilled` and the five mainstream device types: macOS, Windows, Linux, iPhone, and Android; usage renders `Hourglass`; composer uses `Plus`, `Send` paper plane, `Square`, `FileText`, `Video`, `X`, and `Bot`). Icons inherit text color (`text-muted-foreground` for secondary actions), use `stroke="currentColor"` (`data-icon="line"`), and size via `size-pixel` (`24px` in `Large`), `size-pixel-md` (`18px`), or `size-pixel-sm` (`12px`). Never use emoji as UI icons.

## 6. Control dimensions and tool slots

Controls use two heights: **`36px` default** (`h-9`) and **`32px` small** (`h-8`, reserved for inline row actions and corner controls). On touch devices (`pointer: coarse`), `Input` and `Select` grow to `44px` (`pointer-coarse:h-11`).

| Control | Default | Small | Component |
| --- | --- | --- | --- |
| Button | `h-9 px-4 border-2` | `h-8 px-3 border-2` (`size="sm"`) | `Button` |
| Icon button | `size-9 border-2` (`size="icon"`) | `size-8` (`size="icon-sm"`) | `Button` |
| Text input | `h-9 px-3 border-2` (`w-60` inside desktop settings rows) | none | `Input` |
| Select | `h-9`, max `260px` (`variant="plain"` for auto-saving rows; Radix UI `Select`) | none | `Select` |
| Textarea | `min-h-24` (borderless auto-sizing inside grouped boxes) | none | `Textarea` |
| Switch | `h-5.5 w-10 border-2` (`size-3.5` square thumb) | none | `Switch` |

- **Primary and destructive buttons (`Button`)**: Solid `--primary` (`default`) or `--danger` (`destructive`) fill with a `2px` border, `2px` bottom inset shade (`shadow-[inset_0_-2px_0_rgb(0_0_0_/_0.22)]`), `hover:brightness-90`, and `1px` active press. `outline` uses `bg-background border-2 border-border-strong hover:bg-hover`; `ghost` is borderless with `hover:bg-hover`.
- **Custom dropdowns (`src/web/ui/select.tsx`)**: All dropdowns use the custom `@radix-ui/react-select` component (zero browser-native `<select>`). Triggers show a smooth `ChevronDown`; the open `SelectContent` portal uses `border-2 border-border-strong bg-background` with smooth `Check` indicators on the selected option.
- **Non-prose touch inputs**: URLs, domains, and pairing codes set `autoCapitalize="none" autoCorrect="off" spellCheck={false}` (plus `inputMode="url"` on URLs), and stretch full width (`h-11 w-full`) in mobile settings pages and drawers.
- **Tool slots (`Button variant="slot"`) and `.tool-badge`**:
  - Persistent shell actions (Settings, New PM, Usage, Back, Right-rail toggle) use `size="icon"` (`30px`, `size-7.5`, `18px` icon) or `size="icon-lg"` (`36px`); the Router model picker uses `h-7.5 px-3`; inline header slots (Task Graph `Zoom`) use `size="icon-sm"` (`24px`, `12px` icon).
  - The sidebar `Update` slot (`h-7.5 px-3`, `Download` icon + `Update`, icon-only on the `72px` rail, accessible name `Update to vX.Y.Z`) sits directly before Settings, which keeps its corner position, and appears only for a bundled install with a newer release that was not skipped (section 24).
  - Styled from `--slot-*` tokens derived from the Router sprout bell: `#ffefb5` fill, `2px` `#d9a336` border, `4px` CSS radius, `2px` `#e8bf55` bottom inset shadow, `#4a2e00` foreground (`10.9:1`), `#ffe48f` hover, and `1px` press depression. `.tool-badge` shares the static warm-yellow badge for Router counts, `Read-only` Piece badges, and `Custom` capability choices (section 23).

## 7. Focus states and chat composer

- **Crisp keyboard outline**: Buttons and interactive rows show a crisp `2px` `--border-focus` (`#4a4038`) outline (`focus-visible:outline-2 focus-visible:outline-border-focus`, inset `-2px` inside clipped boxes) on keyboard focus only — never soft fuzzy rings.
- **Standard inputs (`Input`, `Textarea`, `Select`)**: Use a `2px` `--border-strong` (`#ddd4c2`) plain border that darkens cleanly to `--border-focus` (`#4a4038`) on focus or when `Select` is open (`variant="plain"` hovers/focuses to `bg-hover`).
- **Chat composer (`.composer-frame` in `src/web/styles.css`)**:
  - Resting state: square corners, `2px` `border-border-strong`, `bg-background`, zero box shadow.
  - `:focus-within`: Border darkens immediately to `2px` `--border-focus` (`#4a4038`), with no shadow halo or blur ring.
  - **Single-line vs multiline layout (`Composer.tsx` and `composer-layout.ts`)**: When empty or single-line without attachments, `+`, the textarea, and `Send`/`Stop` share one `48px` row. When text wraps, contains a newline, or has attachments, the textarea spans the top row while `+` and `Send`/`Stop` move to the bottom row within the same CSS grid so the DOM node, caret, and focus never reset.
  - **Attachment chips and `FileCard`**: Pending composer chips (`border border-border-strong bg-panel py-1 pr-1 pl-3 text-minor`) pair `Video` or `FileText` (`16px`) with filename, size, and `X`. Sent `FileCard` items render a crisp square `40px` (`size-10 border border-border`) thumbnail, first video frame with centered `Play` overlay, or file icon, opening `FilePreview` on click.
  - **Send button**: `36px` (`size-9`) square button with the `Send` paper plane (`Stop` square while streaming): `--primary` fill + bottom shade inside a PM (`--rail` honey + `--rail-ink` plane on Router), disabled `#f3efe6` fill with `--border-strong` border and `#a8a29e` plane when empty, plus a one-shot `150ms` `composer-send-bounce` when content becomes non-empty.

## 8. Alignment and chat column width

- **Left baseline**: Group boxes, external group headings, collapsible toggles, and row errors align on `px-4` (`16px`).
- **Rows**: Label left, control right, vertically centered; subtext aligns with the label. Folder rows place the folder name (`15px`) above the truncated path (`13.5px` muted, `~` shortened, full path in `title`).
- **Conversation header**: Left side renders one interactive button (`Avatar look size={36}`, `17px` `600` name, and `12px` `ChevronDown`) that opens PM settings in the side panel (`#/pm/<id>`); right side holds the `Pieces` `slot` button (`Avatar neutral`, `Pieces`, and a `.tool-badge` count when active asks, items, or Task Graphs exist). Piece thread headers render inside the side panel (desktop) or full-screen header (mobile) with `PieceMeta` (`12px` muted model, effort, and context length, hidden below `720px`).
- **Container-responsive chat column (`.chat-main`, `.chat-column`, and `.messages`)**:
  - `.chat-main` declares `container: chat / inline-size` and scales `--chat-max` by main-pane width: `46rem` default, `52rem` at `>= 64rem`, `58rem` at `>= 80rem`, and `64rem` at `>= 112rem`.
  - `.chat-column` and `.messages` center via `padding-inline: max(var(--chat-gutter), calc((100% - var(--chat-max)) / 2))` (`0.75rem` below `40rem`, `3rem` at or above `40rem`). Conversation headers stay full-width (`--header-gutter-start: 20px`, `--header-gutter-end: 12px`).

## 9. Grouped settings lists and form validation

Use `SettingsGroup`, `SettingsRow`, `CollapsibleGroup`, `ChoiceRows`, and `ModeRows` (`src/web/components/SettingsList.tsx`):

- **Group box (`GROUP_BOX`)**: `border-2 border-border bg-background` with `1px` `divide-border` between rows, square corners, no gray fill, and no shadow. External headings use `13.5px` `500` `text-muted-foreground` `px-4` `min-h-8 items-center`, `8px` above the box.
- **Icon rows** (computers and browser sessions): `size-pixel text-muted-foreground` + `gap-3` + title, with a square `8px` status dot (`bg-success`, `bg-caution`, or `bg-muted-foreground/40`) before spaced metadata (`gap-3`, never middle dots).
- **`CollapsibleGroup`**: Collapses low-frequency lists (signed-in browsers, edit history, `Memory files`) into one `52px` button row inside `h2` (`aria-expanded`, summary count + `16px` `ChevronDown` rotating `180deg`). Auto-expands on load only when action is required.
- **Controls inside rows**: Auto-saving dropdowns use Radix `Select variant="plain"` (`ChevronDown`); short inline choices use `Segmented` (`h-9 border-2 border-border-strong bg-panel p-0.5`, square cells with active cell in slot colors, `touch-target` items); multi-row single-choice lists use `ChoiceRows` (`18px` square `RadioMark` with `8px` inner square); drill-down entries (mobile settings and the profile `Capabilities` row) use `SettingsNavRow` (`min-h-12 px-4 py-3` with status summary and `ChevronRight`).
- **Search fields (`SearchField`, `src/web/components/SearchField.tsx`)**: Square `h-9 border-2` field (`border-list-edge bg-list-field` inside cream sidebars or `border-border-strong bg-background` in dialogs/settings, darkening on focus) with a `12px` `Search` icon, `Search` placeholder, and an `icon-sm` `Clear search` button once the query is non-blank.
- **Provider, model, and effort rows (`AgentRows`)**: Driven entirely from `useModelCatalogs` and `pickableVendorCatalogs` (`src/shared/vendors.ts`). All vendor pickers (`AgentRows`, `RouterModelPicker`, and `/hub:worker`) list only currently available (`isSelectable`) providers and append a fixed `Add provider…` entry at the end that opens Settings → Providers. Unavailable providers are omitted rather than shown grayed out, except when an existing PM or Router already uses an unavailable provider, in which case that provider stays visible with its unavailable label (`Not signed in` / `Not installed`) without switching silently. Single-tier effort rows hide automatically.

### Form validation

- **Empty required field**: Primary button stays disabled without showing an error.
- **Invalid non-empty input**: Marks the field `aria-invalid` (red border), disables the primary button, and renders one specific reason below that row (`SettingsRow` `error`).
- **Server rejection**: Maps field errors to the matching row and general errors above `DialogFooter` (`px-4 text-danger`) while preserving user input.
- **Soft quota hints and `Memory files`**: Hide routine quota denominators (`200` lines, `25 KB`, `50` files) until usage reaches `>= 80%` or the cap (`50 max`).

## 10. Dialogs and bottom drawers

- **`DialogContent` (`src/web/ui/dialog.tsx`)**: Square corners, `border-2 border-border-strong bg-background p-6` over `bg-[rgb(28_25_23_/_0.34)]`. Width tiers: `520px` default (`NewPmDialog`, with `w-72` right-aligned field column), `max-w-110` for confirmations, and `840px` (`max-w-210`, fixed height `h-[min(35rem,calc(100%-3rem))]`, `p-0`) for desktop `SettingsDialog`.
- **Desktop `SettingsDialog`**: Left vertical Radix `Tabs` (`w-56 bg-list border-r-2 border-list-edge`, active tab styled with `bg-background border-2 border-select-line text-list-ink`, collapsing into a horizontal top tab bar below `720px`) for `General` (`Interface scale`, `Notifications`, and the `Updates` group from section 24), `Providers` (including `Vendor sync` and its `Sync preview` dialog), `Capabilities` (section 23), `Resources` (section 25), `Computers`, and `Security & Access`; right pane (`bg-panel`) scrolls independently with `min-w-0` and `grid-cols-1` so long paths or URLs never clip right-hand buttons. Right-aligned row actions stay flush with row padding (`px-4`), with uniform button widths (`min-w-24`) across provider rows and `outline` `size="sm"` styling on standalone row actions (`Check for updates`, `Show QR code`, `Clean up`).
- **Fixed header and footer**: Only `DialogBody` scrolls, fading over its bottom `16px` (`.dialog-body-fade`).
- **Zoom and preview dialogs (`ZOOM_DIALOG` and `FilePreview`)**: Size to content up to `min(96vw, 1400px)` by `90vh` for diagrams, Task Graphs, tables, Markdown, code, and audio; expand to `90vw` by `90vh` for PDFs, HTML pages, videos, and full-size images.
- **Bottom `Drawer` (`src/web/ui/drawer.tsx`, wrapping `vaul`)**: Used on mobile for Pieces, destructive confirmations, and short form wizards (`border-t-2 border-border-strong bg-background`, `max-h-[85dvh]`, `36x4` drag bar in `bg-border-strong`, bottom inset `max(var(--safe-bottom), var(--kb-inset))`).

## 11. Popovers and usage bars

- **`PopoverContent`**: Square corners, `border-2 border-border-strong bg-background p-4`, content-sized between `280px` (`min-w-70`) and `min(22.5rem, var(--radix-popover-content-available-width))`, height-capped by `--radix-popover-content-available-height` with internal `grid-cols-1` truncation.
- **`QuotaPopover` and usage meters (`quotaMeterOf` in `src/web/rail-model.ts`)**: `AppRail` (desktop footer) always pairs `<Hourglass>` with the single fullest provider window (`5` vertical cells, filled count `ceil(percent / 20)`, and `percent%` in `tabular-nums`, or `<Hourglass>` alone when fetchable), opening `QuotaPopover` (`side="right"`). Inside `QuotaPopover`, a compact header (`Hourglass` + `Usage`) sits above `divide-y-2 divide-border` provider sections (no nested inner boxes). Each window (`5h`, `7d`, `30d`, or model families) renders on two compact lines: window label + inline `Resets HH:MM` (`text-xs text-muted-foreground tabular-nums`) + right-aligned `percent%` (`font-semibold tabular-nums`), over an `8px` (`h-2`) square progress bar colored via warm Bellwood tokens (`bg-rail-ink` normal, `bg-caution` at `>= 80%` or `allowed_warning`, and `bg-danger` with `text-danger` percentage at `100%` or `rejected`). Mobile `UsageGroup` uses the same bar colors and inline reset timestamp.

## 12. Side panel

`SidePanel` (`src/web/components/SidePanel.tsx`) renders beside chat on desktop (`22.5rem` min, `27.5rem` default, `45rem` max, `border-l-2 border-border bg-panel`, `px-5`, `3.5rem` header with optional `Back` arrow, title, and `Close` `X`, becoming `flex-1` over hidden chat in `stack` tier, and becoming the bottom Pieces `Drawer` on mobile):

- **Three panel views (`sidePanelOf`)**: `Pieces` (`RailGroups`, at `#/c/<id>` when `piecesOpen` and items exist), a `Worker` thread (`WorkerConversation`, at `#/w/<id>`), or `Profile` (`ProfilePanel`, at `#/pm/<id>` and `#/pm/<id>/<page>`).
- **Navigation and exits (`panelExitsOf`)**: Closing always returns to `#/c/<id>` (preserving whether Pieces was opened manually); clicking `Back` inside a Worker returns to `#/c/<id>` and opens `Pieces`; clicking `Back` on a Profile drill-down page returns to `#/pm/<id>`. `Escape` inside a Worker composer interrupts/rewinds per section 18 without closing `SidePanel`. In `stack` tier, the underlying conversation stays mounted inside React `<Activity mode="hidden">` so draft text and scroll position survive.
- **Four collapsible Pieces sections (`divide-y divide-border py-3`)**:
  1. `Needs You`: Standalone `hub ask` items not bound to a Task Graph (`6px` `--primary` dot when non-empty, max 3 visible before `Show more`).
  2. `Task Graph`: Active DAGs (`status === "active"`), rendered with `PeelTrack` and `TaskProgressIcon`.
  3. `Pieces`: Unbound active Workers (`isBusy` titles animate with `.status-shimmer`, max 3 visible before `Show more`; metadata lives in `title` and `PieceMeta`, and mechanical prefixes are stripped by `cleanPieceTitle`).
  4. `Completed`: Collapsed and unmounted by default; lazily fetches `GET /api/projects/:id/task-graphs?status=history` (`GRAPH_HISTORY_PAGE_SIZE`, `Load more` up to `MAX_COMPLETED_GRAPH_PAGES`) alongside finished standalone Pieces (`opacity-65`).
- **Auto-open and persistence**: Renders beside chat automatically only when active work or unanswered asks exist; remembers manual rail collapse and per-section collapse (`agent-hub.rightRail.collapsed`) in `localStorage`.
- **Jump-only ask rows**: Answering happens on the full card in the chat stream (or `TaskGraphDialog`), never duplicated inside the narrow rail; clicking a rail ask row scrolls the conversation to that card and highlights it for `2s`.

### 12.1 Task Graph: peel track, sprout progress, and gate bell

- **`TaskProgressIcon` and multi-graph accordion**: `20px` `10x10` pixel sprout icon colored by step states, paired with `Ready to finish` (`12px` muted) when all nodes are `done`, `Zoom` (`Maximize2`), and accordion `ChevronRight` (graphs waiting on user or PM sort first and expand by default).
- **`PeelTrack` vertical lanes**: Orthogonal pixel jelly pipes and beads (`pixel-path.ts`) scaled by `--peel-u` (`2.5rem` for 1 to 2 lanes, `+0.875rem` per extra parallel lane up to `6rem`), partitioned into connected components, transitive-reduced, and ordered with chain-first topological sort so every drawn segment represents a real dependency. Consecutive completed prefixes (`>= 2`) roll into `N done`, and trailing locked chains (`>= 2` depth) fold into `N next`.
- **Decision gates (`waiting` + `waitingFor: "user"`) and `UserBlockerCard`**:
  - Show a `GateMark` pixel bell in the rail row (`text-body font-semibold text-primary`) that scrolls to the chat card or opens `TaskGraphDialog`.
  - Inside `TaskGraphDialog` (and chat for `UserBlockerCard`), cards use square corners with `border-2 border-open-line bg-open px-3.5 py-3` and `grid-cols-1` wrapping options, showing the full body without collapsing, contextual deliverable files next to relevant text, and a always-visible framed `Your reply` input (`CardNoteForm`, no `Add note` toggle), supporting one-click option selection, option + note, or custom reply submission (`POST /api/task-graphs/:graphId/nodes/:nodeKey/decide`). `UserBlockerCard` offers a `Done` (`Checking...`) re-probe button.
- **`TaskGraphDialog` full view**: Left-to-right `@dagrejs/dagre` layout on a `16px` dot-grid canvas with plain 2px bordered square-corner cards (`.pixel-card`), re-laid out once from `ResizeObserver` measured heights without locking card `min-height`. `Cancel graph` opens a `max-w-110` destructive confirmation dialog (`Keep going` vs `Cancel graph`), while `Skip step` executes directly. All requests go through `DeviceScope` (`useClient()`).

## 13. Fonts, numbers, and list rows

- **Font stacks (`--font-ui` and `--font-code` in `src/web/styles.css`)**: Bundled `Geist Variable` with system CJK fallbacks (`font-sans`), and `"SF Mono"`, `ui-monospace`, `Menlo`, `Consolas` (`font-mono`).
- **English units and compact counts (`src/shared/count-format.ts`)**: Format tokens and sizes with `K`, `M`, `KB`, and `MB` (`820 tokens`, `291K tokens`, `158K context`), using `—` (never `0`) when historical metrics were not recorded.
- **Tabular numerals and spacing**: Apply `tabular-nums` to all counts, times, percentages, and token totals. Separate items on a row with `gap-3` and size hierarchy (`15px` `500` primary vs `12px` muted secondary), never `·`, `|`, or `/`.
- **Desktop `ProjectList` rows**: `3.25rem` (`52px`) row height (`h-13`), `2.25rem` (`36px`) avatar, `15px` `600` (`text-body font-semibold`) name (unchanged when selected), `13.5px` (`text-minor`) muted preview, right-aligned relative time or waiting dot, and hover/focus `.row-shortcuts` (`Pin` and `Settings`).

## 14. Interaction states and motion

- **Full-page states (`FullPage` in `App.tsx`)**: Centered `22rem` column (`20px` `Loader2` + `13.5px` muted label while loading, or `17px` `600` title + `13.5px` description + at most one primary button).
- **Motion budget (`--motion-*` in `src/web/styles.css`)**: One-shot state transitions stay `<= 400ms` (`150ms` rail collapse, `200ms` chevron turn, `120ms` `.message-enter` on newly appended tail messages, `0ms` instant conversation switch). Only two loops are permitted while work is active: `.status-shimmer` (`2.2s` `currentColor` sweep on `Working...` / `Thinking...` and busy Piece titles) and `.slime-pet` (`520ms` hop every `1.8s`). `prefers-reduced-motion: reduce` disables every animation.

## 15. Markdown, code blocks, and charts

`src/web/components/Markdown.tsx` and `.markdown` (`15px`, `1.65` line height, `remark-gfm`, `remark-breaks`, `remark-cjk-friendly`, `remark-cjk-friendly-gfm-strikethrough`):

- **Headings, code, links, and tables**: Headings use weight `600` (`20px` `h1`, `17px` `h2`, `15px` `h3`, `15px` `500` muted `h4` to `h6`). Inline code uses `--muted` fill with `box-decoration-break: clone`. Links use `#2563eb` (`--link`, >= 4.5:1 on white). Fenced code blocks (square corners, `border-2 border-border`, `--panel` / `--muted`, `13.5px` mono) highlight lazily with Shiki (`github-light`, `120ms` streaming debounce) and provide a raw-copy icon button. Tables scroll horizontally inside a wrapper when needed, follow Markdown column alignment (left by default), and apply `tabular-nums`.
- **Inline media and file links**: Saved `![]()` images reserve a fixed `240px` height (`h-60 max-w-xs border-2 border-border object-contain`) so streams never jump on load, switching to an expired-file card on HTTP 404. Local `[label](path)` links render inline as `[data-file-link]` opening `FilePreview` (or plain text if unsaved).
- **Charts (`mermaid` and `vega-lite` in `src/web/charts/`)**: Render after the fence closes inside a `.md-code` shell (`160px` min loading height, `480px` max inline height, scaling down no further than `12px` `CHART_MIN_INLINE_FONT_PX` before scrolling horizontally, sanitized with `dompurify`), with toolbar toggles for source, `Zoom` (`ZOOM_DIALOG` up to `2.5x`), and copy, styled from CSS variables and `CHART_CATEGORY_COLORS`.

## 16. Shell layout, tiers, routes, and native macOS frame

- **Fixed honey rail (`AppRail`, `4.5rem`, `bg-rail`) + framed workspace sheet (`.shell-sheet`)**: Desktop pairs `AppRail` (`Router` button with pending badge, per-computer cells with `PlatformIcon` and square status dot including single-computer setups, bottom `Update` slot, quota `meter`, `Settings` icon slot, and `Account` slot) on honey `--rail` (`#ffcb3d`) with `.shell-sheet` (`margin: 6px 6px 6px 0; border: 2px solid var(--rail-shade); bg-background`). Zero drop shadows.
- **Resizable sheet columns (`ui/resizable.tsx`)**: Inside `.shell-sheet`, `ProjectList` (`bg-list`, `13.75rem`–`25rem`, default `16.5rem`) | `Conversation` (`bg-background`, `>= 30rem`) | optional `SidePanel` (`bg-panel`, `22.5rem`–`45rem`, default `27.5rem`), separated by `2px` seams (`--list-edge` / `--border`). Dragging handles widens the active seam (`4px` + `12x32` honey pixel grip), double-clicking a handle resets its pane to default, and widths persist per browser in `localStorage` (`agent-hub.paneWidths`).
- **Responsive desktop tiers (`shellTierOf()` in `src/web/shell-layout.ts`)**: Evaluated in `rem` from container width and active scale (`1146px` / `998px` / `784px` at `Default`): `wide` (full `ProjectList` + `Conversation` + optional `SidePanel`), `strip` (collapses `ProjectList` to a fixed `4.5rem` avatar strip with New PM `+` and pinned avatars above a divider), and `stack` (`SidePanel` replaces chat width while conversation stays mounted inside `<Activity mode="hidden">`).
- **`ProjectList` groups, edge fades, and trackless scrollbars**: `3.5rem` (`h-14`) header (`ComputerSwitcher` trigger + New PM `slot`), cream `SearchField`, optional `Pinned` group (section 26), `Project managers` group, and default-collapsed `Archived` group (`Deletes in Nd`, auto-expanding on search or active archived selection). Scrollable containers define `--fade-top` and `--fade-bottom` with matching padding so items never clip abruptly, and shell vertical scroll containers (`.messages`, `.sidebar-list`, `.right-rail-scroll`, `.router-tray-scroll`, `.router-timeline`, `.page-fade`, `.dialog-body-fade`) render transparent trackless scrollbars (`scrollbar-width: thin`, `scrollbar-color: transparent transparent`) that reveal a subtle rounded thumb only while scrolling (`[data-scrolling]`) or hovering/dragging and fade out after idle (`SCROLLBAR_IDLE_HIDE_MS`).
- **Hash routes (`src/web/route.ts`)**: `#/router` (fills the entire desktop sheet with `ProjectList` and `SidePanel` closed), `#/c/<id>`, `#/w/<id>`, `#/pm/<id>`, `#/pm/<id>/<page>` (`capabilities`, `persona`, `memory`, `worktree`, `history`), and `#/d/<deviceId>/...` for remote mesh computers.
- **Native macOS app (`html[data-macos-app="true"]`)**: Reserves `--macos-traffic-lights-height: 28px` at the top of `AppRail` and marks empty rail chrome with `data-window-drag`.

## 17. Message stream

`MessageList.tsx` and `Messages.tsx` hide process noise by default:

- **One avatar per agent turn**: Renders `26px` avatar + `13.5px` `500` muted name once at the top of the turn, folds all tool calls, Worker dispatches, and schedule edits into `Worked for 23s >` (`Thinking...`, `Calling Linear: list issues`, `Loading skill verify`, etc. from `src/shared/step-labels.ts`, held at least `450ms` via `MIN_TOOL_STEP_VISIBLE_MS`), streams live Markdown in place without duplicate flash on commit, and ends with copy and timestamp.
- **`hub ask` cards**: Square corners (`border-2 border-border-strong bg-background p-4`) displaying the full body without collapsing, contextual deliverables embedded directly below the paragraph or list item that mentions them, `OptionRow` (`A`/`B` square keycaps + `.tool-badge` `Recommended` inline), and an always-visible framed `Your reply` section (`CardNoteForm` with `Your reply` label, multi-line auto-sizing textarea, and primary `Send` button) on every unanswered card, settling in place to read-only (`bg-open` on chosen option, `PencilLine` row for note, or `Closed`).
- **Worker thread cards (`ThreadCard`, replacing `WorkerSpeech`)**: Bordered square summary card (`border-2 border-border-strong bg-background px-3.5 py-2.5`, or `border-open-line bg-open` when open) with curled-note sprite in the PM's color, report title, report timestamp, muted latest status/preview line, and open indicator. Inside a Piece thread, long PM briefs clamp to `8` lines (`LongBrief`), and ended threads show a `Completed` bar.
- **System events, handover divider, and message status**: System events (`persona.changed`, `schedule.created`/`removed`, `project.created`, `folder.attached`/`detached`, `schedule.failed`, `handover.failed`) and standalone Worker lifecycle notices (`started`, `ended`, `user_message`) render as structured activity strips (`border-2 border-border bg-panel`, or `border-danger/40 bg-danger/5` for failures) with a square icon badge, event label, subject/actor, detail line, and right-aligned action (`Undo` outline button or clickable Worker chevron); consecutive standalone events of the same family merge into a single `divide-y divide-border` grouped card. Session renewal (`session.renewed`) and scheduled task triggers (`schedule.run`) render as collapsible structured activity strips (`Handed off to a new session` / scheduled task title) with expandable content inside. `/hub:worker` picks show a `Worker model` tag above the user bubble; user messages show no status text unless delivery failed (`size-5 bg-danger` square `!` retry button on the left) or a turn failed with zero reply (`Retry` link below).
- **Stick-to-bottom**: `ResizeObserver` keeps bottom-pinned views anchored while `.chat-column` overlaps `26px` (`-mt-6.5`) and shows a centered `32px` scroll-to-end square icon button once scrolled `> 80px` up.

## 18. Composer suggestion menu and Escape shortcuts

- **`ComposerMenu` (`/` at start of message, `@` at start or after whitespace)**: Sits `8px` above the composer in document flow (square corners, `border-2 border-border-strong bg-background p-1.5`, up to 8 rows of `36px` on desktop or `44px` on touch), preserves input focus via `preventDefault` on pointer down, blocks `Send` on `Enter` while open, debounces `@` file queries by `120ms`, and supports multi-stage `/hub:worker <vendor> <model> <effort>` completion (listing only available providers from `pickableVendorCatalogs` plus a fixed `Add provider…` action row at the bottom that opens Settings → Providers) that collapses into a removable `Worker model` chip.
- **Two-step `Escape` in chat**: Ignored during IME composition, modifier/repeat keys, open modals/popovers/drawers, or non-chat inputs (closes `ComposerMenu` first if open). First `Escape` interrupts an active or queued turn without touching the draft; second `Escape` rewinds the just-stopped user message text and `workerPick` back into the draft box once (`meta.rewound`).

## 19. Touch screens and safe areas

- **Viewport and scroll locking**: `viewport-fit=cover` and `interactive-widget=resizes-content`, `100dvh` on `#root`, `overflow: hidden; overscroll-behavior: none` on `html, body, #root`, and `overflow-x: hidden; overscroll-behavior-y: contain` on internal scroll panes, padded with `--safe-top` and `--safe-bottom`.
- **`>= 16px` inputs and `>= 44px` hit targets**: Under `(pointer: coarse)`, all `input`, `textarea`, and `select` elements use `16px` font size (preventing iOS zoom), standalone controls expand hit areas via `.touch-target::after`, and stacked list rows enforce `min-h-11` (`44px`). Never gate an exclusive action behind hover, and never allow horizontal page overflow at `390px`. Only `.row-shortcuts` (`src/web/styles.css`) — hover and `:focus-within` shortcuts on desktop `ProjectList` rows for Pin and PM settings, both independently reachable in `ProfilePanel` and the conversation header — may reveal on `@media (hover: hover)` devices (and remain absent on touch screens).

## 20. Mobile shell

- Activated solely by `MOBILE_SHELL_QUERY` (`(pointer: coarse)` and short viewport edge `< 600px`).
- Bottom navigation + full-screen navigation stack: `TabBar` (`src/web/mobile/TabBar.tsx`, `4rem` honey bottom bar padded by `--safe-bottom`) switches between `Router` (`#/router`, with pending badge), `Projects` (`#/`), and `Settings` (`#/settings`, with attention dot), hiding automatically when the soft keyboard is open or on pushed views (`#/c/<id>`, `#/w/<id>`, `#/pm/<id>`, `#/pm/<id>/<page>`, `#/settings/<section>`).
- Kept-warm views and drawers: `#/` `ProjectList layout="page"` (with `ComputerSwitcher` bottom `Drawer` in its header) stays warm inside React 19 `<Activity mode="hidden">` while viewing chat; `Conversation` pushes `#/c/<id>` with a bottom Pieces `Drawer`, `#/w/<id>` pushes `WorkerConversation`, and `#/pm/<id>` pushes `ProfilePanel variant="page"` (drilling down to `#/pm/<id>/capabilities`, `persona`, `memory`, `worktree`, `history`). Full-screen `#/settings` puts the `Usage` meter group at the top (reading query cache with zero extra network requests) above `General`, `Providers`, `Capabilities`, `Resources`, `Computers`, and `Security & Access` using deterministic `mobileBack` history handling.

## 21. Router workbench: decision tray and timeline

`#/router` (`RouterWorkbench.tsx`, [Router architecture](router-design.md)) fills the entire desktop `.shell-sheet` (both `ProjectList` and `SidePanel` closed) and has three stacked regions inside `.chat-column`:

1. **`Needs You` tray**: Hidden when empty; capped at `50dvh` on desktop and `45dvh` on mobile with top/bottom scroll fades. Expands the first `RouterDecisionCard` (square corners, `border-2 border-border-strong bg-background`, full uncollapsed `Markdown` body with contextual deliverable files next to relevant text, shared `OptionRow` A/B buttons, and the persistent framed `Your reply` textarea + `Send` button supporting one-click choice, choice + note, or custom text reply; dims to `Offline` when its remote computer disconnects) and lists remaining cards as compact rows (`Show more` past 3).
2. **Borderless timeline (`RouterStream.tsx`)**: Stick-to-bottom stream of command turns (right-aligned user bubble, left-aligned `RouterAvatar` + clickable target rows + Router Markdown + inline `ForwardReply` showing the target PM's live `Working...`, `Stopped`, or full `AgentText` reply) and incoming PM milestone reports (grouped by consecutive PM, with an unread `New` divider). Empty state centers a `36px` `40%`-opacity `RouterAvatar` and `All clear`.
3. **Header `RouterModelPicker` and composer**: Top-right `slot` button opens a `Popover` (desktop) or `Drawer` (mobile) with `Auto`, available provider radio rows from `pickableVendorCatalogs`, collapsible `Model & effort` plain selects, and a fixed `Add provider…` entry at the bottom. Bottom `<DraftComposer>` uses `Tell Router, or type @ to pick a project...` (`Tell Router...` on mobile) and honey (`--rail`) send button styling.

## 22. Deliverables

`<CardBody>` and `<DeliverableFiles>` (`src/web/components/Deliverables.tsx`) render across chat ask cards, `TaskGraphDialog` gate cards, and Router cards/reports:

- **Full body and contextual placement (`layoutCardDeliverables`)**: Card bodies are always shown in full (never collapsed behind `Show more` / `Show less` or clamped). Files whose `href` already appears as an inline Markdown link in the card title or body are not repeated below. Remaining deliverables are matched against individual Markdown paragraphs and list items by filename, stem, or label and rendered directly underneath the matching block, with any unplaced deliverables appearing right after the body (before options).
- **Two file rows (`groupDeliverables`)**:
  - **Documents** (`.md`, `.pdf`, `.html`, `.csv`, source files): Wrapping inline `[data-file-link]` links with `FileText` smooth icon (`gap-x-3 gap-y-1`, no pills or file sizes).
  - **Media** (images and videos): Wrapping row (`flex-wrap gap-2`) of `96px`-tall (`--deliverable-media-height`, `max-w-40 border-2 border-border-strong bg-panel object-cover`) thumbnails; videos render `preload="metadata"` first frames with a centered `36px` `Play` overlay. Clicking any item opens `FilePreview`; expired copies degrade cleanly to the expired-file card.

## 23. Capabilities and worktree setup

`CapabilitiesPanel` (`src/web/components/CapabilitiesPanel.tsx`) renders one capability scope ([External capabilities](pm-capabilities-design.md)): Project defaults, the Router, or one project. `CapabilitiesSettings` hosts it in the desktop `Capabilities` tab and the mobile `#/settings/capabilities` page, and `ProfilePanel` (`src/web/components/ProfilePanel.tsx`) hosts project-level `Capabilities`, `Persona`, `Memory files`, `Worktree setup`, and `History` as drill-down pages at `#/pm/<id>/<page>` (returning to `#/pm/<id>` via the panel or page `Back` button):

- **Scope switch (settings only)**: A `Segmented` control (`aria-label="Scope"`) with `Project defaults` (selected on open), `Router`, and `Project` (hidden when no unarchived PM exists). `Project` adds a square picker trigger beside it (`h-9 border-2 border-border-strong bg-background`, `20px` slime, name, `12px` `ChevronDown`) that opens a `Popover` (`aria-label="Projects"`, `p-1.5`) of radio rows with a `20px` slime, the name, a `Custom` badge for projects with their own choices, and a square `RadioMark`.
- **Drill-down pages**: On `#/pm/<id>/<page>`, the panel (`SidePanel` on desktop) or page (`variant="page"` on mobile) header shows `Back` (`onBack` to `#/pm/<id>`) and the section title (`Capabilities`, `Persona`, `Memory files`, `Worktree setup`, or `History`); `Capabilities` opens with no scope switch.
- **Inheritance group (project scope)**: A `SettingsNavRow` `Project defaults` with the summary `Inherited` or `N custom` opens the Project defaults editor (Settings on desktop, `#/settings/capabilities` on mobile, the `Project defaults` segment inside Settings). While the project has its own choices, a chevron-less `Reset to Project defaults` row clears them in one click.
- **Search and `Refresh`**: `SearchField` (`Search capabilities`) filters by name, key, description, or plugin name; matching plugin rows expand, collapsed provider groups open, and an empty result shows `No matches`. The `outline` `Refresh` button sits aligned inside the toolbar row and rescans the inventory.
- **Sections answer who can use an item**: `This project` (skills from the project's main folder, project scope only), `Shared` (items two or more providers load), then one section per provider in `AGENT_VENDORS` order for items only that provider loads (its plugins, `Built-in` skills, and `Apps`). In a project the PM's provider section follows `Shared`, and the other provider sections are default-collapsed `CollapsibleGroup`s with an `N of M` summary. A section header shows `N of M` (`13.5px` muted, `tabular-nums`) unless its only row already shows the count.
- **Plugin and source rows**: A plugin package (its MCP servers and skills together) or a source list (`Skills`, `Built-in`, `Apps`) is one default-collapsed `min-h-12` row with a rotating `12px` `ChevronRight`, the name, `N of M`, and a `Switch` for every item in it. A standalone MCP server is a plain row with its own switch, its name aligned with the plugin names (`pl-10`).
- **Item rows**: Indented to the plugin name (`pl-10`, `min-h-11`) with the name (description in `title`), a kind tag (`MCP`, `Skill`, or `App`: square `bg-muted border border-border px-2 text-xs` `500` muted), and a `Switch`. MCP servers list before skills. In `Shared` and `This project`, a `13.5px` muted provider list (`Codex, DeepSeek`) follows the tags when not every provider loads the item. A project's own choice shows a `Custom` `.tool-badge` on the item and its plugin row. On narrow rows the tags and badges wrap below the name instead of truncating it.
- **Saving**: Toggles apply optimistically, queue in order per scope, and fall back to the server state with a `px-4` row error when a save fails; a rescan that finishes after a toggle refetches instead of overwriting it.

The profile page links and edits project-level settings next to `Folders`:

- **`Capabilities` row**: Shown for unarchived PMs on this computer; one `SettingsNavRow` (`Plugins, skills, and MCP servers`, `N of M` summary) that opens the project page `#/pm/<id>/capabilities`.
- **`Worktree setup`**: A borderless auto-sizing `Textarea` (`font-mono text-minor` once non-empty, `No setup command` placeholder). The group header shows a ghost `Clear` when a command is saved and `Cancel` plus a small primary `Save` while edited; `Clear` only empties the draft, and saving blank text clears the command. Drafts survive incoming `project.updated` changes, over-limit or NUL input renders one `RowError` reason and disables `Save`, and archived PMs see the field read-only.

## 24. Updates

`UpdateSettings` (`src/web/components/UpdateSettings.tsx`) renders the `Updates` group under `General` on desktop and the mobile `#/settings/updates` page, reading `GET /api/update` through `src/web/update-model.ts` (one fetch per page load, then hourly through React Query, or every `UPDATE_CHECK_RETRY_MS` while the check fails):

- **Heading**: `Updates` on desktop; mobile shows only the page title.
- **Version row**: `Bellwood vX.Y.Z`, a `Source` `.tool-badge` for source checkouts, and an `outline` `size="sm"` `Check for updates` row action (`Loader2` while checking) aligned with row padding that posts `POST /api/update/check`. The detail line holds the status (`Up to date`, `vX.Y.Z available`, or `Couldn't check for updates`) and a `Release notes` link with a `12px` `ExternalLink` icon.
- **Download row**: Only for bundled installs with a newer release. `vX.Y.Z available` with a small primary `Download for macOS` or `Download for Windows` link (`Download` icon); its detail line moves `Release notes` here and adds `SHA-256` and `Skip this version`. Source checkouts get the status line only, never a download button.
- **Inline actions**: `Release notes`, `SHA-256`, and `Skip this version` use the `Undo` text-action style (`font-medium text-muted-foreground`, `hover:text-foreground hover:underline`, `touch-target`) with `gap-x-3` between them. Downloads and release links open in the system browser (`target="_blank"`).
- **Skip this version**: Stored per version in `localStorage` (`agent-hub.update.dismissed`); it hides the rail `Update` slot (section 6) and the mobile attention dot until a newer release appears, while the download row stays available.
- **Mobile entry**: An `Updates` `SettingsNavRow` in the `General` group with the cached `vX.Y.Z` summary and the amber attention dot while the rail reminder would show; it reads only the query cache, so `#/settings` still makes no requests.

## 25. Resources

`ResourcesSettings` (`src/web/components/ResourcesSettings.tsx`) renders the `Resources` tab in desktop `SettingsDialog` and the mobile `#/settings/resources` page (`src/web/mobile/settings/ResourcesPage.tsx`), reading `GET /api/resources` through `src/web/resources-model.ts`:

- **Attention indicator**: An `8px` amber square (`size-2 bg-caution`) marks the rail `Settings` slot, the desktop `Resources` tab, and the mobile `Resources` `SettingsNavRow` whenever at least one held resource has `keptAt === null`. The mobile `#/settings` home reads only the React Query cache (`useCachedResourcesSummary`), so it issues zero network requests.
- **Computer scope**: When two or more computers are online, a top `SettingsGroup` offers a borderless `Select variant="plain"` computer picker so each computer's disk, branches, and processes can be inspected through device proxy routes.
- **Needs review**: Shown above `Summary` only when unacknowledged held items exist. Each row shows the item label, an `8px` `bg-caution` square status dot, spaced plain-language metadata (`gap-x-3`, never middle dots) with reason (`Unsaved file edits`, `Untracked files`, `Unmerged branch`, `Leftover temp folder`, `Leftover background process`, etc.), project name, size (`tabular-nums`), and up to 5 sample paths (`font-mono text-xs`), paired with `outline` `Keep` and danger-tinted `Delete…` (or `Stop…` for processes) actions.
- **Summary**: A `SettingsGroup` (`Refresh` and `Clean up` actions aligned cleanly in its header) with four plain-language rows: `Chat & app data`, `Files & workspaces`, `Worker workspaces` (`N active`, `N ready to clean`, `N to review`), and `Background processes` (`N running`, `N leftover`). Routine quota denominators stay hidden below `RESOURCES_WARN_RATIO` (`80%`); items at or above `80%` display the cap and a caution indicator. A default-collapsed `CollapsibleGroup` (`Storage breakdown`) lists per-directory and humanized database category totals on demand (never raw SQLite table names).
- **Kept**: A default-collapsed `CollapsibleGroup` holding items the user marked `Keep`, with `Allow cleanup` and `Delete…` / `Stop…` actions.
- **Delete/Stop confirmation**: Clicking `Delete…` or `Stop…` always opens a `max-w-110` `DialogContent` showing the item path or branch, reason, size, sample paths, an optional `Also delete branch` switch for held worktrees, `Cancel` (`outline`), and one destructive `Delete` / `Stop process` (`variant="destructive"`) button.

## 26. Pins

`PUT /api/pms/:id/pin` persists per-PM pins per computer (`pm_pins` SQLite table, `pinnedAt` epoch ms):

- **`Pinned` group (`ProjectList` and `projectListOf`)**: Renders above `Project managers` in both `column` and `strip` layouts only when at least one unarchived PM on the selected computer has `pinnedAt !== null`. Order follows `pinnedAt` ascending (oldest pin first, tie-broken by `pm.id` ascending).
- **Where pins toggle**: On desktop `ProjectList` rows via `.row-shortcuts` (`Pin` / `PinFilled`), and inside `ProfilePanel` (`Pinned` header action) for all form factors. Archiving preserves `pinnedAt` (so unarchiving restores the pin) without displaying archived PMs in `Pinned`; offline/read-only remote views disable pin toggling.
