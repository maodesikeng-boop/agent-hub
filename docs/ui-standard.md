# UI standard

Shared interface specification for the Bellwood web workbench (`src/web/`). Colors come from CSS variables in `src/web/styles.css`, and reusable primitives live in `src/web/ui/` and `src/web/components/SettingsList.tsx`. Match every rule below when building or editing screens; if a screen needs a pattern not covered here, update this document first.

## 0. Interface scale

- **Interface scale** (**Settings**, **General**, **Appearance**): `Compact`, `Default`, `Large`, and `XL` (`Segmented`, section 9), saved per browser in `localStorage` (`agent-hub.uiScale`, `src/web/ui-scale.ts`). **`Default` is the default**: a browser that never picked a scale gets it, and a saved choice stays.
- **Root font size (`<html data-ui-scale>` in `src/web/styles.css`)**: `Compact` `90.625%` (`14.5px`), `Default` `100%` (`16px`), `Large` `109.375%` (`17.5px`), and `XL` `118.75%` (`19px`). A bare `html` renders at the `Default` size, so the first paint matches before the app sets the attribute. Type tokens (`--text-*`), `Avatar` sizes, and Tailwind spacing (`rem`) scale proportionally together.
- **Pixel values in this document reflect the `Default` (`16px`) scale** (`Large` multiplies all `rem` sizes by `1.09375x`).
- **Shell pane and tier geometry (`src/web/limits.ts`)**: Fixed honey rail (`SHELL_RAIL_REM = 4.5`), collapsed strip (`SHELL_STRIP_REM = 4.5`), PM column (`SHELL_LIST_REM`, min `13.75`, default `16.5`, max `25`), side panel (`SHELL_PANEL_REM`, min `22.5`, default `27.5`, max `45`), conversation minimum (`SHELL_CHAT_MIN_REM = 30`), and `shellTierOf()` responsive breakpoints scale from the active root `rem` (with the `SHELL_FRAME_PX = 6` frame inset and `SHELL_SEAM_PX = 6` gaps between columns in `px`).
- Never hardcode arbitrary pixel font sizes or widths (`text-[15px]`, `w-[240px]`); use the type tokens in section 3 and Tailwind numeric scales (`w-60`, `max-w-110`). Border radii (`rounded-xs` `2px`, `rounded-sm` `4px`), `1px` lines, viewport breakpoints (`max-[1100px]`, `min-[720px]:`), macOS traffic-light insets, and pixel icons stay in `px` (guarded by `src/web/ui-scale.test.tsx`).

## 1. Spacing scale

Use only these Tailwind `4px`-step tokens:

| Location | Default px | Class or variable |
| --- | --- | --- |
| Honey rail (`AppRail`) width | `72px` (`4.5rem`) | `w-18` (`SHELL_RAIL_REM`) |
| Frame and sheets beside the rail | The PM list sits on the cream frame; the conversation and side panel are white sheets `6px` in from the frame's top, right, and bottom edges and `6px` apart | `.shell-frame`, `.shell-sheet` (`SHELL_FRAME_PX = 6`, `SHELL_SEAM_PX = 6`) |
| Column header height (`ProjectList`, `Conversation`, `SidePanel`, the Router page, the Settings page, and the `FullPage` placeholder) | `44px` (`2.75rem`), so every header line across the window sits on one level | `h-11` |
| Desktop PM list row height | `26px` (`1.625rem`) | `h-6.5` |
| Main pane horizontal padding | `24px` | `px-6` |
| Chat column minimum side gutter | `12px` below `40rem` main width, `48px` at or above `40rem` | `--chat-gutter` on `.chat-column` and `.messages` (section 8) |
| Conversation header inset | `20px` start, `12px` end | `--header-gutter-start` and `--header-gutter-end` |
| Side panel horizontal and group vertical padding | `20px` and `12px` | `px-5` and `py-3` |
| PM column inset and row padding | `8px` list inset (search field, group headings, and the selected band start here), `8px` row padding (avatars and the header title share one `16px` left edge), no gap between rows | `px-2` and `pl-2` |
| Gap between groups or dialog sections | `24px` | `gap-6` |
| Gap between a group heading and its box | `8px` | `gap-2` |
| Settings row padding | `16px` horizontal, `10px` vertical | `px-4 py-2.5` (`py-2` for `min-h-9` rows, `py-3` with helper text) |
| Gap between row label and control | `16px` | `gap-4` |
| Gap between adjacent controls | `8px` | `gap-2` |
| Gap between row label and subtext | `0px` to `2px` | none or `mt-0.5` |
| Dialog padding | `24px` | `p-6` on `DialogContent` |
| Popover padding | `16px` | `p-4` on `PopoverContent` |

## 2. Corners, lines, and depth

### 2.1 Corners

One small radius everywhere: **`4px` (`rounded-sm`, `--radius-sm`)**, the corner the tool slots already used. `src/web/styles.css` resets the Tailwind radius scale to two tokens (`--radius-xs: 2px`, `--radius-sm: 4px`), so `rounded-md` and larger do not exist.

| Element | Rule |
| --- | --- |
| Buttons, inputs, textareas, selects | `4px` by default: the base layer gives every `button`, `input`, `textarea`, and `select` `--radius-sm`, so new controls inherit it |
| Cards, group boxes, ask cards, thread cards, event strips, code blocks, chips, badges, thumbnails, popovers, menus, dialogs, the composer, the workspace sheet | `rounded-sm` (`4px`) |
| Rows and selection tiles (list rows, rail tiles, settings tabs, side-panel rows, menu items) | `rounded-sm`; menu items inside a padded menu use `rounded-xs` |
| Elements nested inside a padded `4px` parent (segmented cells, switch thumb, progress bars) | `rounded-xs` (`2px`), so inner corners stay smaller than outer ones |
| Full-bleed rows inside a group box or a card (`ChoiceRows`, `CollapsibleGroup` triggers, `SettingsNavRow`, event triggers, decision-card `OptionRow` and reply rows) | `rounded-none`: the box or card clips them (`overflow-hidden`), and a rounded hover inside a divided list would notch the divider |
| Status dots, attention dots, radio marks, scrollbar thumbs | Circles (`rounded-full`); a dot is what the `4px` radius becomes at `8px` |

Pixel craft stays on characters, avatars, sprites, Task Graph beads and pipes, and brand illustrations. `src/web/web-guard.test.ts` allows only `rounded-xs`, `rounded-sm`, `rounded-t-sm`, `rounded-full`, and `rounded-none`.

### 2.2 Lines

Every line is **`1px`** and comes from one warm-ink family, defined as alpha so the same token reads as the same line on white, paper, cream, and honey:

| Token | Value | Used for |
| --- | --- | --- |
| `--border` (`border-border`, `divide-border`, `bg-border`) | `rgb(110 74 0 / 0.14)` | Structure: header bottoms, dividers, group boxes, cards, popovers, menus, dialogs, media thumbnails, rail and strip dividers, progress-bar tracks |
| `--border-strong` | `rgb(110 74 0 / 0.26)` | Interactive outlines only: inputs, selects, search fields, raised buttons, switch track, radio ring, the composer and the framed reply field |
| `--select-line` | `#e0b03c` | The one selection line (section 4), drawn as a `1px` inset ring |
| `--border-focus` | `#4a4038` | Focus (section 7) |

- The only strokes wider than `1px` are the `2px` keyboard focus outline, the `2px` dashed file-drop target, the `3px` Markdown blockquote bar, and the `2px` halos that separate dots and badges from the surface behind them.
- Columns part by tone and space, not lines: the PM list sits on the cream frame, and the conversation and side panel are white sheets `6px` apart (section 16).
- Containers get the hairline (`--border`); controls get `--border-strong`. A container never takes `--border-strong` to look heavier.
- Chips, tags, and badges are flat fills with no outline (`bg-panel`, or `.tool-badge` honey), as are inline code and log blocks inside a box.
- Do not put a bordered box inside another bordered box. Inside a card, separate parts with spacing or one hairline divider; options and fields inside cards are controls, not boxes.
- `pnpm ui:polish shots` measures these rules on every screen: `machine:thick-line` (a solid line wider than `1.5px`), `machine:box-in-box` (a framed box whose nearest framed ancestor is not a dialog, popover, drawer, or the frame), and `machine:ragged-edge` (row starts in the PM list, side panel, or settings tabs that miss each other by `1.5` to `8px`).

### 2.3 Depth

Depth is reserved for things that are raised or float, and each has one recipe in `src/web/styles.css`:

| Recipe | Where |
| --- | --- |
| `btn-raised`, `btn-honey`, `btn-solid` | Buttons (section 6): `1px` line, a top-lit fill, an inner top highlight, and a `1px` soft drop that sinks into an inset shade when pressed or open |
| `row-selected` | Selected row in a sidebar list (PM rows and settings categories): the sheet white (`--background`) as a flat band, with no ring or shadow |
| `tile-selected` | Selected item on a tinted surface: lighter fill (`--tile-fill`, white by default, cream on the honey rail), `1px` `--select-line` inset ring, `--shadow-tile` (`0 1px 2px rgb(74 46 0 / 0.12)`) |
| `tile-open` | Selected item on white or paper: `--open` fill and the `1px` `--select-line` inset ring, no drop |
| `--shadow-overlay` | Popovers, select menus, the composer menu |
| `--shadow-dialog` | Dialogs (section 10) |
| `.shell-frame`, `.shell-sheet` | The cream frame (`--list`) beside the rail and the white sheets on it: tone and a `6px` gap, no line and no shadow |

Cards, group boxes, and event strips stay flat. No gradients outside the button recipes, no frosted glass, no glow.

## 3. Type scale, weights, and shell copy

Use only three weights: `400` (default), `500` (`font-medium`), and `600` (`font-semibold`).

All panes and dialogs share **four UI type sizes** defined in `src/web/styles.css` (`@theme`) and registered in `FONT_SIZE_TOKENS` (`src/web/lib/utils.ts`):

| Tier | Class | Default px | Typical uses |
| --- | --- | --- | --- |
| Micro metadata | `text-xs` | `12` | Timestamps, counts (`tabular-nums`), `Recommended`, rail labels (`500`), badge numerals |
| Secondary text, buttons, and every section heading | `text-minor` | `13.5` | Button labels (`500`), segmented controls, all section and group headings (`500` muted: `Pinned`, `Project managers`, `Archived`, `Needs You`, `Task Graph`, `Pieces`, `Completed`, settings groups), row descriptions (`leading-snug`), sidebar previews, event strips, `Show more`, inline errors (`text-danger`) |
| Body copy and row titles | `text-body` | `15` | Message prose, row titles, `ProjectList` PM names (`400`), inputs, selects, ask card questions (`500`), option text (`400`), side-panel row titles |
| Pane and dialog titles | `text-title` | `16` | Conversation header name, side panel header, dialog titles (`600`), one step above body text |

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
  - Neutral chrome uses warm paper and sand tokens instead of cool zinc grays or fruit-tinted surface mixes: `--background` (`#ffffff`) for the sheets, cards, and group boxes, `--panel` (`#f7f4ed`) for secondary surfaces inside a sheet (event strips, chips, the settings pane), `--foreground` (`#1c1917`), `--muted-foreground` (`#6f6862`), `--hover` (`#f6f2e9`), and the line tokens in section 2.2.
  - Rail and list tokens (`--rail` `#f9bd01`, `--rail-shade` `#e39600`, `--rail-hover` `#f9cb4b`, `--rail-ink` `#4a2e00`, `--rail-ink-soft` `#6e4a00`, `--rail-warn` `#7c4100`, `--rail-danger` `#991b1b`, `--sand` `#a35f00`, `--list` `#fcd771`, `--list-hover` `#f9ce55`, `--list-field` `#fffbeb`, `--list-ink` `#3b2600`, `--list-ink-soft` `#725317`, `--select-line` `#e0b03c`) tint the rail, the cream frame and PM list, the settings tabs, and the selection line. Secondary text on `--list` and `--list-hover` uses `--list-ink-soft`. `--muted-foreground` stays on white, paper, and field surfaces.
  - **Selection** has three recipes and never changes font weight: `row-selected` for sidebar list rows (PM rows and settings categories), a flat white band with no ring; `tile-selected` on tinted surfaces (a lighter fill, white by default and cream on the honey rail, with the `1px` `--select-line` inset ring and `--shadow-tile`) for rail tiles and segmented cells; `tile-open` on white or paper (`--open` `#fff6d6` fill with the same ring) for open side-panel rows, chosen options, and picker grids. Neutral hover uses `bg-hover`.
- **Dynamic PM accent (`--primary` and `--primary-foreground`)**:
  - `src/shared/slimes.ts` decouples 20 fruit slime shapes from 24 palette entries (`blob` for sprite fills, `accent` darkened to >= 4.5:1 WCAG AA contrast against white, verified in `src/web/lib/palette.test.ts`).
  - `AccentScope` (`src/web/lib/accent-scope.tsx`, `display: contents`) wraps each PM conversation, its Piece conversations, its profile page, the right rail, and in-session dialogs. Outside `AccentScope` (the left sidebar, `#/router`, global settings, and New PM dialog), `:root` sets `--primary` to `--rail-ink` (`#4a2e00`).
  - **Solid accent (`bg-primary text-primary-foreground`) appears only on**: the single primary button on screen (`Create`, `Save`, `Send` inside a PM, `Stop`, or the recommended gate option; `btn-solid`, section 6), checked switch tracks, checked radio marks, the `6px` dot beside the `Needs You` heading, and the file-drop dashed border. Outside `AccentScope` (Router's composer), `Send` uses honey `--rail` with `--rail-ink` foreground.
  - **User message bubbles (`bg-bubble-me text-bubble-me-foreground`)**: Mix `--primary` at `12%` (`--mix-bubble-me`) into `#ffffff` with warm dark foreground text (>= 4.5:1 contrast across all 24 colors).
  - **Text links outside Markdown**: Inline secondary text actions use `text-rail-ink` (`#4a2e00`) or `text-muted-foreground hover:text-foreground`. Colored lines appear only on the file-drop target and `--select-line` selections.
  - **Dots**: Status and attention dots are `8px` circles (`size-2 rounded-full`; `10px` on rail tiles) with a `2px` halo in the color of the surface behind them where they sit on a tile, icon, or button. Unanswered asks and waiting turns are green (`bg-status-active`) with no text pill; screen-reader text lives on `aria-label` and `title`. Rail computer dots sit on the device icon's lower-right corner, so they stay beside the icon whether or not the tile is raised. The one attention dot for something to review in Settings (the rail gear, the `Resources` tab, the mobile `Settings` tab and rows) is red (`bg-danger`) on every surface, because amber stays below `3:1` against honey, cream, and white.
  - **Chips, tags, and badges** (`.tool-badge` for `Recommended`, `Source`, `Custom`, and `Read-only`; capability kind tags; `Closed` and `Offline`; attachment and `Worker model` chips): flat fills with no outline and no depth, `rounded-sm`, so they read as labels and never as buttons.
- **Avatars (`src/shared/slimes.ts`)**:
  - Inline transparent-background pixel SVGs with no frame.
  - **Project Managers**: 20 fruit slimes paired with any of 24 colors via `SlimePicker` (`Fruit` and `Color` grids).
  - **Pieces**: Curled note sprite (`Avatar neutral`) tinted with the owning PM's color.
  - **Router**: Sprout bell (`RouterAvatar`), unscoped warm chrome, preserving source PM avatars on incoming cards and reports.

## 5. Icons

Import all UI icons from `src/web/ui/icons.ts` (`lucide-react` smooth-line 24-grid icons alongside matching smooth-line custom SVGs for `PinFilled` and the five mainstream device types: macOS, Windows, Linux, iPhone, and Android; the usage meter draws `QuotaHourglass` on `HOURGLASS_GLASS_PATH` (section 11); composer uses `Plus`, `Send` paper plane, `Square`, `FileText`, `Video`, `X`, and `Bot`). Icons inherit text color (`text-muted-foreground` for secondary actions), use `stroke="currentColor"` (`data-icon="line"`), and size via `size-pixel` (`24px` in `Large`), `size-pixel-md` (`18px`), or `size-pixel-sm` (`12px`). In list group headings and navigation rows, the label after an icon carries `trim-cap` (`text-box: trim-both cap alphabetic`), so flex centering puts the icon on the label's capitals. Never nudge an icon with `translate-y`. Never use emoji as UI icons.

## 6. Control dimensions and tool slots

Controls use two heights: **`36px` default** (`h-9`) and **`32px` small** (`h-8`, reserved for inline row actions and corner controls). On touch devices (`pointer: coarse`), `Input` and `Select` grow to `44px` (`pointer-coarse:h-11`).

| Control | Default | Small | Component |
| --- | --- | --- | --- |
| Button | `h-9 px-4` | `h-8 px-3` (`size="sm"`) | `Button` |
| Icon button | `size-9` (`size="icon"`) | `size-8` (`size="icon-sm"`) | `Button` |
| Text input | `h-9 px-3 border` (`w-60` inside desktop settings rows) | none | `Input` |
| Select | `h-9`, max `260px` (`variant="plain"` for auto-saving rows; Radix UI `Select`) | none | `Select` |
| Textarea | `min-h-24` (borderless auto-sizing inside grouped boxes) | none | `Textarea` |
| Switch | `h-5.5 w-10 border` (`size-4` `rounded-xs` thumb) | none | `Switch` |

- **Button recipes (`src/web/styles.css`, section 2.3)**: `default` and `destructive` use `btn-solid` (solid `--primary` or `--danger`), `outline` uses `btn-raised` (white), and `slot` uses `btn-honey`. Each is a `1px` line, a top-lit fill, an inner top highlight, and a `1px` soft drop; pressing, and `aria-expanded="true"` or `data-state="open"` on raised and honey buttons, swaps the drop for an inset shade and sinks the button `0.5px` in `120ms`. `ghost` has no fill or line (`hover:bg-hover`). Disabled primary buttons use `--send-disabled`.
- **Custom dropdowns (`src/web/ui/select.tsx`)**: All dropdowns use the custom `@radix-ui/react-select` component (zero browser-native `<select>`). Triggers show a smooth `ChevronDown`; the open `SelectContent` portal is `rounded-sm border border-border bg-background shadow-[var(--shadow-overlay)]` with `rounded-xs` items and a smooth `Check` on the selected option.
- **Non-prose touch inputs**: URLs, domains, and pairing codes set `autoCapitalize="none" autoCorrect="off" spellCheck={false}` (plus `inputMode="url"` on URLs), and stretch full width (`h-11 w-full`) in mobile settings pages and drawers.
- **Tool slots (`Button variant="slot"`, `btn-honey`)**:
  - Header actions (New PM, the `Pieces` toggle, the Router model picker) use `size="icon"` or `size="icon-lg"` for icons, or `h-8 px-3` for text labels.
  - Honey recipe: `--slot-bg` `#ffefb5` fill, `1px` `--slot-line`, `--slot-ink` `#4a2e00` foreground (`10.9:1`), `--slot-hover` on hover, and `--slot-press` with the inset shade while pressed or open. `.tool-badge` shares the honey fill as a flat chip (section 4).
  - The rail footer (`Update`, usage, `Settings`, `Account`) uses rail tiles (section 16), not slots. The `Update` tile (`Download` icon, accessible name `Update to vX.Y.Z`) sits directly above `Settings` and appears only for a bundled install with a newer release that was not skipped (section 24).

## 7. Focus states and chat composer

- **Crisp keyboard outline**: Buttons and interactive rows show a crisp `2px` `--border-focus` (`#4a4038`) outline (`focus-visible:outline-2 focus-visible:outline-border-focus`, `1px` outside buttons, inset `-2px` on rows inside clipping boxes) on keyboard focus only, never a soft fuzzy ring.
- **Standard inputs (`Input`, `Textarea`, `Select`, `SearchField`)**: A `1px` `--border-strong` line; focus, or an open `Select`, applies `field-focus`: the line turns `--border-focus` and gains a `1px` `--border-focus` spread, a crisp `2px` edge with no blur (`variant="plain"` hovers and focuses to `bg-hover`).
- **Chat composer (`.composer-frame` in `src/web/styles.css`)**:
  - Resting state: `4px` radius, `1px` `--border-strong`, `bg-background`, and `--shadow-tile`, the one field that floats over the stream.
  - `:focus-within`: the same crisp `field-focus` edge as other inputs, with no blur.
  - **Single-line vs multiline layout (`Composer.tsx` and `composer-layout.ts`)**: When empty or single-line without attachments, `+`, the textarea, and `Send`/`Stop` share one `48px` row. When text wraps, contains a newline, or has attachments, the textarea spans the top row while `+` and `Send`/`Stop` move to the bottom row within the same CSS grid so the DOM node, caret, and focus never reset.
  - The textarea has a fixed single row. In multiline mode the browser sizes it up to `180px`, after which it scrolls. Browsers without native sizing use a hidden copy of the draft. The row keeps its size and layout during text composition.
  - **Attachment chips and `FileCard`**: Pending composer chips (`rounded-sm bg-panel py-1 pr-1 pl-3 text-minor`, flat) pair `Video` or `FileText` (`16px`) with filename, size, and `X`. Sent `FileCard` items (`rounded-sm border border-border bg-panel`) render a `40px` (`size-10 rounded-sm`, no inner line) thumbnail, first video frame with centered `Play` overlay, or file icon, opening `FilePreview` on click.
  - **Send button**: `36px` (`size-9`) icon button with the `Send` paper plane (`Stop` square while streaming): the `btn-solid` `--primary` recipe inside a PM (`btn-honey` with the `--rail-ink` plane on Router), the disabled `--send-disabled` fill and `#a8a29e` plane when empty, plus a one-shot `150ms` `composer-send-bounce` when content becomes non-empty.

## 8. Alignment and chat column width

- **Left baseline**: Group boxes, external group headings, collapsible toggles, and row errors align on `px-4` (`16px`).
- **Rows**: Label left, control right, vertically centered; subtext aligns with the label. Folder rows place the folder name (`15px`) above the truncated path (`13.5px` muted, `~` shortened, full path in `title`).
- **Conversation header**: Left side renders one interactive `32px` button (`Avatar look size={24}`, `gap-2`, `16px` `600` name, and `12px` `ChevronDown`) that opens PM settings in the side panel (`#/pm/<id>`); the Router header pairs a `24px` `RouterAvatar` with its title the same way. The Pieces toggle on the right shows only the PM's tinted note sprite (`Avatar neutral size={22}`) in a `32px` (`icon-sm`) `ghost` button. Its tooltip and accessible label describe the action. Piece thread headers render inside the side panel (desktop) or full-screen header (mobile) with `PieceMeta` (`12px` muted model, effort, and context length, hidden below `720px`).
- **Container-responsive chat column (`.chat-main`, `.chat-column`, and `.messages`)**:
  - `.chat-main` declares `container: chat / inline-size` and scales `--chat-max` by main-pane width: `46rem` default, `52rem` at `>= 64rem`, `58rem` at `>= 80rem`, and `64rem` at `>= 112rem`.
  - `.chat-column` and `.messages` center via `padding-inline: max(var(--chat-gutter), calc((100% - var(--chat-max)) / 2))` (`0.75rem` below `40rem`, `3rem` at or above `40rem`). Conversation headers stay full-width (`--header-gutter-start: 20px`, `--header-gutter-end: 12px`).

## 9. Grouped settings lists and form validation

Use `SettingsGroup`, `SettingsRow`, `CollapsibleGroup`, `ChoiceRows`, and `ModeRows` (`src/web/components/SettingsList.tsx`):

- **Group box (`GROUP_BOX`)**: `rounded-sm border border-border bg-background` with `1px` `divide-border` between `rounded-none` full-bleed rows, no gray fill, and no shadow. External headings use `13.5px` `500` `text-muted-foreground` `px-4` `min-h-8 items-center`, `8px` above the box. Side panels, dialogs, and phone pages use the box.
- **Flat sections on a page (`FlatSettingsGroups`)**: The Settings page lays every group flat on its white sheet: the heading and the rows parted by `divide-border` hairlines, no box, fill, or radius (`CollapsibleGroup` keeps one hairline above and below). The sheet body is inset `8px`, so the rows' own `16px` padding puts every row title on the page title's `24px` edge, and the content column stops at `max-w-180`.
- **Icon rows** (computers and browser sessions): `size-pixel text-muted-foreground` + `gap-3` + title, with a round `8px` status dot (`bg-success`, `bg-caution`, or `bg-muted-foreground/40`) before spaced metadata (`gap-3`, never middle dots).
- **`CollapsibleGroup`**: Collapses low-frequency lists (signed-in browsers, edit history, `Memory files`) into one `52px` button row inside `h2` (`aria-expanded`, summary count + `16px` `ChevronDown` rotating `180deg`). Auto-expands on load only when action is required.
- **Controls inside rows**: Auto-saving dropdowns use Radix `Select variant="plain"` (`ChevronDown`); short inline choices use `Segmented` (`h-9 rounded-sm border border-border bg-panel p-0.5` track, `rounded-xs` `touch-target` cells, checked cell `tile-selected`); multi-row single-choice lists use `ChoiceRows` (`18px` round `RadioMark` on a `--border-strong` ring, checked filled with `--primary` around a `6px` white center); drill-down entries (mobile settings and the profile `Capabilities` row) use `SettingsNavRow` (`min-h-12 px-4 py-3` with status summary and `ChevronRight`).
- **Search fields (`SearchField`, `src/web/components/SearchField.tsx`)**: `h-9 rounded-sm border border-border-strong` field (`bg-list-field` inside cream sidebars, `bg-background` in dialogs and settings, `field-focus` on focus) with a `12px` `Search` icon, `Search` placeholder, and an `icon-sm` `Clear search` button once the query is non-blank.
- **Provider, model, and effort rows (`AgentRows`)**: Driven entirely from `useModelCatalogs` and `pickableVendorCatalogs` (`src/shared/vendors.ts`). All vendor pickers (`AgentRows`, `RouterModelPicker`, and `/hub:worker`) list only currently available (`isSelectable`) providers and append a fixed `Add provider…` entry at the end that opens Settings → Providers. Unavailable providers are omitted rather than shown grayed out, except when an existing PM or Router already uses an unavailable provider, in which case that provider stays visible with its unavailable label (`Not signed in` / `Not installed`) without switching silently. Single-tier effort rows hide automatically.

### Form validation

- **Empty required field**: Primary button stays disabled without showing an error.
- **Invalid non-empty input**: Marks the field `aria-invalid` (red border), disables the primary button, and renders one specific reason below that row (`SettingsRow` `error`).
- **Server rejection**: Maps field errors to the matching row and general errors above `DialogFooter` (`px-4 text-danger`) while preserving user input.
- **Soft quota hints and `Memory files`**: Hide routine quota denominators (`200` lines, `25 KB`, `50` files) until usage reaches `>= 80%` or the cap (`50 max`).

## 10. Dialogs and bottom drawers

- **`DialogContent` (`src/web/ui/dialog.tsx`)**: A sheet lifted off the page: `rounded-sm border border-border bg-background p-6 shadow-[var(--shadow-dialog)]` over a `30%` warm scrim (`bg-[rgb(28_25_23_/_0.3)]`), entering once in `160ms`. No outer frame or second outline. Width tiers: `520px` default (`NewPmDialog`, with `w-72` right-aligned field column) and `max-w-110` for confirmations. The `page` variant is not a floating sheet: it covers the workspace beside the rail (`left-18`) as the cream `.shell-frame` with a transparent overlay, no outline, radius, or shadow, fades in over `160ms`, and draws its own close button; it stays modal, so focus, `Escape`, and an outside click behave as in any dialog.
- **Desktop `SettingsDialog`**: A page of the workbench (`DialogContent page`), laid out like the PM list beside a sheet. The categories sit on the cream frame in a `w-66` column with the PM list's `6px` top inset and a `2.75rem` `Settings` header whose hairline stays level with the sheet's; vertical Radix `Tabs` rows use the PM rows' `16px` text edge, `--list-hover` on hover, and `row-selected` with `text-list-ink` for the open category, collapsing into a horizontal tab bar below `720px`. The open category is a white `.shell-sheet` `6px` from the categories with a `2.75rem` header (title and a ghost `Close` icon button) above its scrolling body, and the rail's Settings tile stays raised while the page is open. Categories: `General` (`Interface scale`, `Notifications`, and the `Updates` group from section 24), `Providers` (including `Vendor sync` and its `Sync preview` dialog), `Capabilities` (section 23), `Resources` (section 25), `Computers`, and `Security & Access`; the sheet body scrolls independently with `min-w-0` and a `grid-cols-1` `max-w-180` content column so long paths or URLs never clip right-hand buttons. Right-aligned row actions stay flush with row padding (`px-4`), with uniform button widths (`min-w-24`) across provider rows and `outline` `size="sm"` styling on standalone row actions (`Check for updates`, `Show QR code`, `Clean up`).
- **Fixed header and footer**: Only `DialogBody` scrolls, fading over its bottom `16px` (`.dialog-body-fade`).
- **Zoom and preview dialogs (`ZOOM_DIALOG` and `FilePreview`)**: Size to content up to `min(96vw, 1400px)` by `90vh` for diagrams, Task Graphs, tables, Markdown, code, and audio; expand to `90vw` by `90vh` for PDFs, HTML pages, videos, and full-size images.
- **Bottom `Drawer` (`src/web/ui/drawer.tsx`, wrapping `vaul`)**: Used on mobile for Pieces, destructive confirmations, and short form wizards (`rounded-t-sm border-t border-border bg-background` with a soft upward shadow, `max-h-[85dvh]`, `36x4` round drag bar in `bg-border-strong`, bottom inset `max(var(--safe-bottom), var(--kb-inset))`).

## 11. Popovers and usage bars

- **`PopoverContent`**: `rounded-sm border border-border bg-background p-4 shadow-[var(--shadow-overlay)]`, entering once in `160ms`, content-sized between `280px` (`min-w-70`) and `min(22.5rem, var(--radix-popover-content-available-width))`, height-capped by `--radix-popover-content-available-height` with internal `grid-cols-1` truncation.
- **Usage hourglass (`QuotaHourglass`, `quotaMeterOf` in `src/web/rail-model.ts`)**: `AppRail` shows the single fullest provider window as a `22px` line-art hourglass drawn with the gear's `2px` stroke and no number under it: the sand shows the share, and the percent lives in the accessible name, the hover title, and the popover. While usage is fetchable but unknown it shows the empty glass alone. Sand in the lower bulb is the used share by area (`sandLevelOf`), so the sand that left the upper bulb is exactly the sand below. It pours once (`700ms`) on mount and when the value changes, and tilts once (`520ms`) on hover; nothing loops, and reduced motion shows the final state. Sand is `--sand`, `--rail-warn` at `>= 80%` or `allowed_warning`, and `--rail-danger` at `100%` or `rejected`. The meter opens `QuotaPopover` (`side="right"`).
- **`QuotaPopover`**: A compact header (`Hourglass` + `Usage`) above provider sections parted by `1px` `divide-border` lines (no nested boxes). Each window (`5h`, `7d`, `30d`, or model families) renders on two lines: window label, inline `Resets HH:MM` (`text-xs text-muted-foreground tabular-nums`), and right-aligned `percent%` (`font-semibold tabular-nums`), over a `6px` `rounded-xs` bar on a `bg-border` track that fills once in `480ms` when the popover opens (`bg-rail-ink` normal, `bg-caution` at `>= 80%` or `allowed_warning`, `bg-danger` with a `text-danger` percentage at `100%` or `rejected`). Mobile `UsageGroup` uses the same bar colors and inline reset time.

## 12. Side panel

`SidePanel` (`src/web/components/SidePanel.tsx`) renders beside chat on desktop as the second white sheet (`22.5rem` min, `27.5rem` default, `45rem` max, `6px` from the conversation sheet, `px-5`, `2.75rem` header with optional `Back` arrow, title, and `Close` `X`, becoming `flex-1` over hidden chat in `stack` tier, and becoming the bottom Pieces `Drawer` on mobile):

- **Three panel views (`sidePanelOf`)**: `Pieces` (`RailGroups`, at `#/c/<id>` when `piecesOpen` and items exist), a `Worker` thread (`WorkerConversation`, at `#/w/<id>`), or `Profile` (`ProfilePanel`, at `#/pm/<id>` and `#/pm/<id>/<page>`).
- **Navigation and exits (`panelExitsOf`)**: Closing always returns to `#/c/<id>` (preserving whether Pieces was opened manually); clicking `Back` inside a Worker returns to `#/c/<id>` and opens `Pieces`; clicking `Back` on a Profile drill-down page returns to `#/pm/<id>`. `Escape` inside a Worker composer interrupts/rewinds per section 18 without closing `SidePanel`. In `stack` tier, the underlying conversation stays mounted inside React `<Activity mode="hidden">` so draft text and scroll position survive.
- **Four collapsible Pieces sections (`divide-y divide-border`)**:
  1. `Task Graph`: Active DAGs (`status === "active"`), rendered with `PeelTrack`. This section starts just below the panel header.
  2. `Needs You`: Standalone `hub ask` items not bound to a Task Graph (`6px` `--primary` dot when non-empty, max 3 visible before `Show more`).
  3. `Pieces`: Unbound active Workers (`isBusy` titles animate with `.status-shimmer`, max 3 visible before `Show more`; metadata lives in `title` and `PieceMeta`, and mechanical prefixes are stripped by `cleanPieceTitle`).
  4. `Completed`: Collapsed and unmounted by default; lazily fetches `GET /api/projects/:id/task-graphs?status=history` (`GRAPH_HISTORY_PAGE_SIZE`, `Load more` up to `MAX_COMPLETED_GRAPH_PAGES`) alongside finished standalone Pieces (`opacity-65`).
- **Auto-open and persistence**: Renders beside chat automatically only when active work or unanswered asks exist; remembers manual rail collapse and per-section collapse (`agent-hub.rightRail.collapsed`) in `localStorage`.
- **Jump-only ask rows**: Answering happens on the full card in the chat stream (or `TaskGraphDialog`), never duplicated inside the narrow rail; clicking a rail ask row scrolls the conversation to that card and highlights it for `2s`.

### 12.1 Task Graph: peel track, sprout progress, and gate bell

- **Multi-graph accordion**: Select the graph title to expand or collapse its steps. A trailing `ChevronRight` shows whether the graph is open. Show a muted `Ready to finish` label when all nodes are `done`. A text `Zoom` action below the expanded steps opens the full graph. Graphs waiting on the user or PM sort first and expand by default.
- **`PeelTrack` vertical lanes**: Orthogonal pixel jelly pipes and beads (`pixel-path.ts`) scaled by `--peel-u` (`2.5rem` for 1 to 2 lanes, `+0.875rem` per extra parallel lane up to `6rem`), partitioned into connected components, transitive-reduced, and ordered with chain-first topological sort so every drawn segment represents a real dependency. Consecutive completed prefixes (`>= 2`) roll into `N done`, and trailing locked chains (`>= 2` depth) fold into `N next`. Every row (gate, Worker, plain, and fold rows) shares one box (`PEEL_BOX`) with no border, so each row's pipe meets the next with no gap or sideways step (guarded in `src/web/task-graph-rail.test.tsx`).
- **Decision gates (`waiting` + `waitingFor: "user"`) and `UserBlockerCard`**:
  - Show a `GateMark` pixel bell in the rail row (`text-body font-semibold text-primary`) that scrolls to the chat card or opens `TaskGraphDialog`.
  - Inside `TaskGraphDialog` (and chat for `UserBlockerCard`), cards use `rounded-sm border border-select-line bg-open px-3.5 py-3`, showing the full body without collapsing and contextual deliverable files next to relevant text. The gate card (`GateDecisionCard`) is one frame like a `hub ask` card: `overflow-hidden`, a `grid-cols-1` option list of full-bleed `13.5px` `500` rows parted by hairlines (`--list-hover` on hover, a flat `Recommended` chip, no raised or solid buttons), and the always-visible reply row (`CardNoteForm variant="row" buttonSize="sm"`; `Enter` sends, `Shift+Enter` adds a newline, shared bounded draft store across surfaces with read-only copyable `Unsent reply` preservation if closed remotely), supporting one-click option selection, option + note, or custom reply submission (`POST /api/task-graphs/:graphId/nodes/:nodeKey/decide`). `UserBlockerCard` offers a `Done` (`Checking...`) re-probe button.
- **`TaskGraphDialog` full view**: Left-to-right `@dagrejs/dagre` layout on a `16px` dot-grid canvas with raised step cards (`.pixel-card`: `1px` `--border-strong`, `rounded-sm`, `--shadow-tile`), re-laid out once from `ResizeObserver` measured heights without locking card `min-height`. `Cancel graph` opens a `max-w-110` destructive confirmation dialog (`Keep going` vs `Cancel graph`), while `Skip step` executes directly. All requests go through `DeviceScope` (`useClient()`).

## 13. Fonts, numbers, and list rows

- **Font stacks (`--font-ui` and `--font-code` in `src/web/styles.css`)**: Bundled `Geist Variable` with system CJK fallbacks (`font-sans`), and `"SF Mono"`, `ui-monospace`, `Menlo`, `Consolas` (`font-mono`).
- **English units and compact counts (`src/shared/count-format.ts`)**: Format tokens and sizes with `K`, `M`, `KB`, and `MB` (`820 tokens`, `291K tokens`, `158K context`), using `—` (never `0`) when historical metrics were not recorded.
- **Tabular numerals and spacing**: Apply `tabular-nums` to all counts, times, percentages, and token totals. Separate items on a row with `gap-3` and size hierarchy (`15px` `500` primary vs `12px` muted secondary), never `·`, `|`, or `/`.
- **`ProjectList` rows**: One line with an `AvatarTile`, a rounded tile filled with `avatarTileFillOf` (the PM color's hue at OKLCH lightness `0.85`, about `0.04` below `--list`, so every color reads equally strong on the honey list and the white selected row) and holding the animal centered on its whole silhouette, ears and leaves included, so every fruit shows the same square shape. The animal (`0.8125rem`) and the padding (`0.21875rem`) each round to whole pixels (`14px` and `4px` at Large), which keeps the snapped tile and sprite edges in step. The tile sits beside a `13.5px` (`text-minor`) name, with no message preview or time. Desktop rows and group headings are `1.625rem` (`26px`, `h-6.5`) tall and grow to `44px` under `pointer: coarse`; the phone page uses `min-h-11` and keeps `text-body` names. Every name is `400` `--list-ink`, selected or not, so no row stands out by weight or color. The rail and Router badges count PMs that wait on you, and screen readers hear that state after the name. Archived rows keep a right-aligned `Deletes in Nd`. The active row uses `row-selected`, the rest `hover:bg-list-hover`, and desktop rows show a hover and focus `.row-shortcuts` `Pin` button (PM settings open from the conversation header).

## 14. Interaction states and motion

- **Full-page states (`FullPage` in `App.tsx`)**: Centered `22rem` column (`20px` `Loader2` + `13.5px` muted label while loading, or `16px` `600` title + `13.5px` description + at most one primary button).
- **Motion budget (`--motion-*` in `src/web/styles.css`)**: Motion only answers something the user did or something that changed, runs once in CSS (no timers, no per-frame JavaScript, no React state), and stays `<= 700ms`: `120ms` button press (`--motion-press`), `150ms` rail collapse and send bounce, `160ms` dialog, popover, and select entry (`--motion-surface`, `surface-in` and `overlay-in`), `200ms` chevron turn, `120ms` `.message-enter` on newly appended tail messages, `240ms` `.badge-pop` when a count changes (keyed remount), `480ms` usage bar fill when `QuotaPopover` opens, and the hourglass's `700ms` pour (`--motion-pour`) and `520ms` hover tilt (section 11). Conversation switches are instant. Only two loops run, and only while work is active: `.status-shimmer` (`2.2s` `currentColor` sweep on `Working...` / `Thinking...` and busy Piece titles) and the working hop of `.slime-pet` and `.bell-swing` (`520ms` every `1.8s`). `prefers-reduced-motion: reduce` disables every animation and shows final states.

## 15. Markdown, code blocks, and charts

`src/web/components/Markdown.tsx` and `.markdown` (`15px`, `1.65` line height, `remark-gfm`, `remark-breaks`, `remark-cjk-friendly`, `remark-cjk-friendly-gfm-strikethrough`):

- **Headings, code, links, and tables**: Headings use weight `600` (`20px` `h1`, `17px` `h2`, `15px` `h3`, `15px` `500` muted `h4` to `h6`). Inline code uses `--muted` fill with `box-decoration-break: clone`. Links use `#2563eb` (`--link`, >= 4.5:1 on white). Inline code is a flat `--muted` fill with the small radius and no outline. Fenced code blocks (`rounded-sm border border-border`, `--panel` / `--muted`, `13.5px` mono) highlight lazily with Shiki (`github-light`, `120ms` streaming debounce) and provide a raw-copy icon button. Tables scroll horizontally inside a wrapper when needed, follow Markdown column alignment (left by default), and apply `tabular-nums`.
- **Inline media and file links**: Saved `![]()` images reserve a fixed `240px` height (`h-60 max-w-xs rounded-sm border border-border object-contain`) so streams never jump on load, switching to an expired-file card on HTTP 404. Local `[label](path)` links render inline as `[data-file-link]` opening `FilePreview` (or plain text if unsaved).
- **Charts (`mermaid` and `vega-lite` in `src/web/charts/`)**: Render after the fence closes inside a `.md-code` shell (`160px` min loading height, `480px` max inline height, scaling down no further than `12px` `CHART_MIN_INLINE_FONT_PX` before scrolling horizontally, sanitized with `dompurify`), with toolbar toggles for source, `Zoom` (`ZOOM_DIALOG` up to `2.5x`), and copy, styled from CSS variables and `CHART_CATEGORY_COLORS`.

## 16. Shell layout, tiers, routes, and native macOS frame

- **Fixed honey rail (`AppRail`, `4.5rem`, `bg-rail`), cream frame (`.shell-frame`), and white sheets (`.shell-sheet`)**: The rail holds the `Router` tile with its pending badge, one tile per computer (`PlatformIcon` with a round status dot on the icon's corner, also on single-computer setups), and the footer: `Update` (when due), the usage hourglass, `Settings`, and `Account`. Every rail item is one tile recipe: `rounded-sm`, honey hover (`--rail-hover`), and a raised cream `tile-selected` while it is the current page or its popover is open; labels are `12px` `500`. Beside the rail, the cream frame (`--list`) carries the PM list directly, and the conversation and side panel are white sheets with the small radius, `6px` in from the frame's top, right, and bottom edges and `6px` apart. Regions part by tone and that gap, never by a line or a shadow; the PM list keeps the sheets' `6px` top inset so header lines stay level across columns.
- **Resizable columns (`ui/resizable.tsx`)**: `ProjectList` (`13.75rem`–`25rem`, default `16.5rem`) | conversation sheet (`>= 30rem`) | optional side panel sheet (`22.5rem`–`45rem`, default `27.5rem`), parted by `6px` gaps (`SHELL_SEAM_PX`). Hovering, focusing, or dragging a gap shows a `2px` honey bar down its middle and an `11x32` honey grip; double-clicking resets the pane to its default, and widths persist per browser in `localStorage` (`agent-hub.paneWidths`).
- **Responsive desktop tiers (`shellTierOf()` in `src/web/shell-layout.ts`)**: Evaluated in `rem` from container width and active scale (`1150px` / `1002px` / `784px` at `Default`): `wide` (full `ProjectList` + `Conversation` + optional `SidePanel`), `strip` (collapses `ProjectList` to a fixed `4.5rem` avatar strip on the frame with New PM `+` and pinned avatars above a divider), and `stack` (`SidePanel` replaces chat width while conversation stays mounted inside `<Activity mode="hidden">`).
- **`ProjectList` groups, edge fades, and trackless scrollbars**: `2.75rem` (`h-11`) header (`ComputerSwitcher` trigger + a `28px` (`size-7`) New PM `slot`), cream `SearchField`, optional `Pinned` group (section 26), `Project managers` group, and default-collapsed `Archived` group (`Deletes in Nd`, auto-expanding on search or active archived selection). Group headings use the section heading type (`text-minor` `500` `--list-ink-soft`) led by a `14px` icon (`Pin`, `MessageSquare`, or the `Archived` chevron) `6px` (`gap-1.5`) from a `trim-cap` label, starting on the list's `8px` edge with the search field and the selected band. Scrollable containers define `--fade-top` and `--fade-bottom` with matching padding so items never clip abruptly, and shell vertical scroll containers (`.messages`, `.sidebar-list`, `.right-rail-scroll`, `.router-tray-scroll`, `.router-timeline`, `.page-fade`, `.dialog-body-fade`) render transparent trackless scrollbars (`scrollbar-width: thin`, `scrollbar-color: transparent transparent`) that reveal a subtle rounded thumb only while scrolling (`[data-scrolling]`) or hovering/dragging and fade out after idle (`SCROLLBAR_IDLE_HIDE_MS`).
- **Hash routes (`src/web/route.ts`)**: `#/router` (one white sheet fills the frame with `ProjectList` and `SidePanel` closed), `#/c/<id>`, `#/w/<id>`, `#/pm/<id>`, `#/pm/<id>/<page>` (`capabilities`, `persona`, `memory`, `worktree`, `history`), and `#/d/<deviceId>/...` for remote mesh computers.
- **Native macOS app (`html[data-macos-app="true"]`)**: Reserves `--macos-traffic-lights-height: 28px` at the top of `AppRail` and marks empty rail chrome with `data-window-drag`.

## 17. Message stream

`MessageList.tsx` and `Messages.tsx` hide process noise by default:

- **One avatar per agent turn**: Renders `26px` avatar + `13.5px` `500` muted name once at the top of the turn, folds all tool calls, Worker dispatches, and schedule edits into `Worked for 23s >` (`Thinking...`, `Calling Linear: list issues`, `Loading skill verify`, etc. from `src/shared/step-labels.ts`, held at least `450ms` via `MIN_TOOL_STEP_VISIBLE_MS`), streams live Markdown in place without duplicate flash on commit, and ends with copy and timestamp.
- **`hub ask` cards**: One frame and nothing framed inside it. The card is `overflow-hidden rounded-sm border border-border bg-background p-4` showing the full body without collapsing, with contextual deliverables embedded directly below the paragraph or list item that mentions them. The choices are one list (`OPTION_LIST`: `-mx-4` full-bleed, a hairline above and `divide-border` between rows): each `OptionRow` is a `rounded-none` `min-h-11` row with a plain `13.5px` `600` muted letter (`A`, `B`) in a `16px` column, the option text, and a flat `Recommended` chip, with `--hover` on hover and no outline, fill, or shadow at rest. Every unanswered card ends in the list's last row, the reply row (`CardNoteForm variant="row"`): a `PencilLine` in the letter column, a `Reply or add a note…` placeholder, a multi-line auto-sizing textarea where `Enter` sends and `Shift+Enter` adds a newline, and the `Send` icon button at the end, with a `1px` `--border-focus` inset ring on focus and the shared bounded draft store behind it. The row carries a screen-reader `Your reply` label and no visible label. Cards settle in place to read-only: the chosen row takes the `--open` fill, a dark letter, and a trailing `Check` (`data-chosen`), a note shows as an `--open` `PencilLine` row, `Closed` marks a card the PM closed, and a copyable read-only `Unsent reply` banner keeps a non-empty local draft after remote settlement.
- **Worker thread cards (`ThreadCard`, replacing `WorkerSpeech`)**: A pressable summary card (`rounded-sm border border-border bg-background px-3.5 py-3`, `hover:border-border-strong hover:bg-hover`, or `border-select-line bg-open` while its Worker is open) with the curled-note sprite in the PM's color and a round tone dot on its corner, report title, report timestamp, a muted latest status or preview line, and an open indicator. Inside a Piece thread, long PM briefs clamp to `8` lines (`LongBrief`), and ended threads show a `Completed` bar.
- **System events, handover divider, and message status**: System events (`persona.changed`, `schedule.created`/`removed`, `project.created`, `folder.attached`/`detached`, `schedule.failed`, `handover.failed`) and standalone Worker lifecycle notices (`started`, `ended`, `user_message`) render as event strips on one grid: a bare `16px` icon aligned to the first line, an inline `500` label followed by the muted body (wrapped lines return to the body's start, never under the label), and a text action (`Undo`, or the Worker chevron) on the first line at the end. Strips are `rounded-sm bg-panel` with no outline (`bg-danger-soft` for failures); consecutive standalone events of one family share a strip with `divide-y divide-border` rows. Worker lifecycle rows show the bold title and a muted status word with no `Worker` chip. Session renewal (`session.renewed`) and scheduled task triggers (`schedule.run`) render as collapsible strips (`Handed off to a new session` / scheduled task title) with expandable content. `/hub:worker` picks show a flat `Worker model` chip above the user bubble; user messages show no status text unless delivery failed (`size-5 bg-danger` `!` retry button on the left) or a turn failed with zero reply (`Retry` link below).
- **Stick-to-bottom**: `ResizeObserver` keeps bottom-pinned views anchored while `.chat-column` overlaps `26px` (`-mt-6.5`) and shows a centered `32px` raised scroll-to-end icon button once scrolled `> 80px` up.

## 18. Composer suggestion menu and Escape shortcuts

- **`ComposerMenu` (`/` at start of message, `@` at start or after whitespace)**: Sits `8px` above the composer in document flow (`rounded-sm border border-border bg-background p-1.5 shadow-[var(--shadow-overlay)]`, `rounded-xs` rows, up to 8 rows of `36px` on desktop or `44px` on touch), preserves input focus via `preventDefault` on pointer down, blocks `Send` on `Enter` while open, debounces `@` file queries by `120ms`, and supports multi-stage `/hub:worker <vendor> <model> <effort>` completion (listing only available providers from `pickableVendorCatalogs` plus a fixed `Add provider…` action row at the bottom that opens Settings → Providers) that collapses into a removable `Worker model` chip.
- **Two-step `Escape` in chat**: Ignored during IME composition, modifier/repeat keys, open modals/popovers/drawers, or non-chat inputs (closes `ComposerMenu` first if open). First `Escape` interrupts an active or queued turn without touching the draft; second `Escape` rewinds the just-stopped user message text and `workerPick` back into the draft box once (`meta.rewound`).

## 19. Touch screens and safe areas

- **Viewport and scroll locking**: `viewport-fit=cover` and `interactive-widget=resizes-content`, `100dvh` on `#root`, `overflow: hidden; overscroll-behavior: none` on `html, body, #root`, and `overflow-x: hidden; overscroll-behavior-y: contain` on internal scroll panes, padded with `--safe-top` and `--safe-bottom`.
- **`>= 16px` inputs and `>= 44px` hit targets**: Under `(pointer: coarse)`, all `input`, `textarea`, and `select` elements use `16px` font size (preventing iOS zoom), standalone controls expand hit areas via `.touch-target::after`, and stacked list rows enforce `min-h-11` (`44px`). Never gate an exclusive action behind hover, and never allow horizontal page overflow at `390px`. Only `.row-shortcuts` (`src/web/styles.css`), the hover and `:focus-within` `Pin` button on desktop `ProjectList` rows (also reachable in `ProfilePanel`), may reveal on `@media (hover: hover)` devices, and it stays absent on touch screens.

## 20. Mobile shell

- Activated solely by `MOBILE_SHELL_QUERY` (`(pointer: coarse)` and short viewport edge `< 600px`).
- Bottom navigation + full-screen navigation stack: `TabBar` (`src/web/mobile/TabBar.tsx`, `4rem` honey bottom bar padded by `--safe-bottom`) switches between `Router` (`#/router`, with pending badge), `Projects` (`#/`), and `Settings` (`#/settings`, with attention dot), hiding automatically when the soft keyboard is open or on pushed views (`#/c/<id>`, `#/w/<id>`, `#/pm/<id>`, `#/pm/<id>/<page>`, `#/settings/<section>`).
- Kept-warm views and drawers: `#/` `ProjectList layout="page"` (with `ComputerSwitcher` bottom `Drawer` in its header) stays warm inside React 19 `<Activity mode="hidden">` while viewing chat; `Conversation` pushes `#/c/<id>` with a bottom Pieces `Drawer`, `#/w/<id>` pushes `WorkerConversation`, and `#/pm/<id>` pushes `ProfilePanel variant="page"` (drilling down to `#/pm/<id>/capabilities`, `persona`, `memory`, `worktree`, `history`). Full-screen `#/settings` puts the `Usage` meter group at the top (reading query cache with zero extra network requests) above `General`, `Providers`, `Capabilities`, `Resources`, `Computers`, and `Security & Access` using deterministic `mobileBack` history handling.

## 21. Router workbench: decision tray and timeline

`#/router` (`RouterWorkbench.tsx`, [Router architecture](router-design.md)) is one white `.shell-sheet` filling the frame (both `ProjectList` and `SidePanel` closed) and has three stacked regions inside `.chat-column`:

1. **`Needs You` tray**: Hidden when empty (unless preserving an unsent reply from a remotely closed card); capped at `50dvh` on desktop and `45dvh` on mobile with top/bottom scroll fades. Expands the active `RouterDecisionCard` (keyed per decision so focus never carries across cards; focusing or editing `Your reply` pins the active card against newly arriving cards; `overflow-hidden rounded-sm border border-border bg-background`, full uncollapsed `Markdown` body with contextual deliverable files next to relevant text, the same option list and reply row as `hub ask` cards supporting one-click choice, choice + note, or custom text reply; dims and shows a flat `Offline` chip when its remote computer disconnects; preserves any non-empty unsent draft in a read-only copyable closed card if settled remotely) and lists remaining cards as compact rows (`Show more` past 3).
2. **Borderless timeline (`RouterStream.tsx`)**: Stick-to-bottom stream of command turns (right-aligned user bubble, left-aligned `RouterAvatar` + clickable target rows + Router Markdown + inline `ForwardReply` showing the target PM's live `Working...`, `Stopped`, or full `AgentText` reply) and incoming PM milestone reports (grouped by consecutive PM, with an unread `New` divider). Empty state centers a `36px` `40%`-opacity `RouterAvatar` and `All clear`.
3. **Header `RouterModelPicker` and composer**: Top-right `slot` button opens a `Popover` (desktop) or `Drawer` (mobile) with `Auto`, available provider radio rows from `pickableVendorCatalogs`, collapsible `Model & effort` plain selects, and a fixed `Add provider…` entry at the bottom. Bottom `<DraftComposer>` uses `Tell Router, or type @ to pick a project...` (`Tell Router...` on mobile) and honey (`--rail`) send button styling.

## 22. Deliverables

`<CardBody>` and `<DeliverableFiles>` (`src/web/components/Deliverables.tsx`) render across chat ask cards, `TaskGraphDialog` gate cards, and Router cards/reports:

- **Full body and contextual placement (`layoutCardDeliverables`)**: Card bodies are always shown in full (never collapsed behind `Show more` / `Show less` or clamped). Files whose `href` already appears as an inline Markdown link in the card title or body are not repeated below. Remaining deliverables are matched against individual Markdown paragraphs and list items by filename, stem, or label and rendered directly underneath the matching block, with any unplaced deliverables appearing right after the body (before options).
- **Two file rows (`groupDeliverables`)**:
  - **Documents** (`.md`, `.pdf`, `.html`, `.csv`, source files): Wrapping inline `[data-file-link]` links with `FileText` smooth icon (`gap-x-3 gap-y-1`, no pills or file sizes).
  - **Media** (images and videos): Wrapping row (`flex-wrap gap-2`) of `96px`-tall (`--deliverable-media-height`, `max-w-40 rounded-sm border border-border bg-panel object-cover`) thumbnails; videos render `preload="metadata"` first frames with a centered `36px` `Play` overlay. Clicking any item opens `FilePreview`; expired copies degrade cleanly to the expired-file card.

## 23. Capabilities and worktree setup

`CapabilitiesPanel` (`src/web/components/CapabilitiesPanel.tsx`) renders one capability scope ([External capabilities](pm-capabilities-design.md)): Project defaults, the Router, or one project. `CapabilitiesSettings` hosts it in the desktop `Capabilities` tab and the mobile `#/settings/capabilities` page, and `ProfilePanel` (`src/web/components/ProfilePanel.tsx`) hosts project-level `Capabilities`, `Persona`, `Memory files`, `Worktree setup`, and `History` as drill-down pages at `#/pm/<id>/<page>` (returning to `#/pm/<id>` via the panel or page `Back` button):

- **Scope switch (settings only)**: A `Segmented` control (`aria-label="Scope"`) with `Project defaults` (selected on open), `Router`, and `Project` (hidden when no unarchived PM exists). `Project` adds a picker trigger beside it (`h-9 rounded-sm border border-border-strong bg-background`, `20px` slime, name, `12px` `ChevronDown`) that opens a `Popover` (`aria-label="Projects"`, `p-1.5`) of radio rows with a `20px` slime, the name, a `Custom` chip for projects with their own choices, and a round `RadioMark`.
- **Drill-down pages**: On `#/pm/<id>/<page>`, the panel (`SidePanel` on desktop) or page (`variant="page"` on mobile) header shows `Back` (`onBack` to `#/pm/<id>`) and the section title (`Capabilities`, `Persona`, `Memory files`, `Worktree setup`, or `History`); `Capabilities` opens with no scope switch.
- **Inheritance group (project scope)**: A `SettingsNavRow` `Project defaults` with the summary `Inherited` or `N custom` opens the Project defaults editor (Settings on desktop, `#/settings/capabilities` on mobile, the `Project defaults` segment inside Settings). While the project has its own choices, a chevron-less `Reset to Project defaults` row clears them in one click.
- **Search and `Refresh`**: `SearchField` (`Search capabilities`) filters by name, key, description, or plugin name; matching plugin rows expand, collapsed provider groups open, and an empty result shows `No matches`. The `outline` `Refresh` button sits aligned inside the toolbar row and rescans the inventory.
- **Sections answer who can use an item**: `This project` (skills from the project's main folder, project scope only), `Shared` (items two or more providers load), then one section per provider in `AGENT_VENDORS` order for items only that provider loads (its plugins, `Built-in` skills, and `Apps`). In a project the PM's provider section follows `Shared`, and the other provider sections are default-collapsed `CollapsibleGroup`s with an `N of M` summary. A section header shows `N of M` (`13.5px` muted, `tabular-nums`) unless its only row already shows the count.
- **Plugin and source rows**: A plugin package (its MCP servers and skills together) or a source list (`Skills`, `Built-in`, `Apps`) is one default-collapsed `min-h-12` row with a rotating `12px` `ChevronRight`, the name, `N of M`, and a `Switch` for every item in it. A standalone MCP server is a plain row with its own switch, its name aligned with the plugin names (`pl-10`).
- **Item rows**: Indented to the plugin name (`pl-10`, `min-h-11`) with the name (description in `title`), a kind tag (`MCP`, `Skill`, or `App`: a flat `rounded-sm bg-panel px-2 text-xs` `500` muted chip), and a `Switch`. MCP servers list before skills. In `Shared` and `This project`, a `13.5px` muted provider list (`Codex, DeepSeek`) follows the tags when not every provider loads the item. A project's own choice shows a `Custom` chip (`.tool-badge`) on the item and its plugin row. On narrow rows the tags and badges wrap below the name instead of truncating it.
- **Saving**: Toggles apply optimistically, queue in order per scope, and fall back to the server state with a `px-4` row error when a save fails; a rescan that finishes after a toggle refetches instead of overwriting it.

The profile page links and edits project-level settings next to `Folders`:

- **`Capabilities` row**: Shown for unarchived PMs on this computer; one `SettingsNavRow` (`Plugins, skills, and MCP servers`, `N of M` summary) that opens the project page `#/pm/<id>/capabilities`.
- **`Worktree setup`**: A borderless auto-sizing `Textarea` (`font-mono text-minor` once non-empty, `No setup command` placeholder). The group header shows a ghost `Clear` when a command is saved and `Cancel` plus a small primary `Save` while edited; `Clear` only empties the draft, and saving blank text clears the command. Drafts survive incoming `project.updated` changes, over-limit or NUL input renders one `RowError` reason and disables `Save`, and archived PMs see the field read-only.

## 24. Updates

`UpdateSettings` (`src/web/components/UpdateSettings.tsx`) renders the `Updates` group under `General` on desktop and the mobile `#/settings/updates` page, reading `GET /api/update` through `src/web/update-model.ts` (one fetch per page load, then hourly through React Query, or every `UPDATE_CHECK_RETRY_MS` while the check fails):

- **Heading**: `Updates` on desktop; mobile shows only the page title.
- **Version row**: `Bellwood vX.Y.Z`, a flat `Source` chip (`.tool-badge`) for source checkouts, and an `outline` `size="sm"` `Check for updates` row action (`Loader2` while checking) aligned with row padding that posts `POST /api/update/check`. The detail line holds the status (`Up to date`, `vX.Y.Z available`, or `Couldn't check for updates`) and a `Release notes` link with a `12px` `ExternalLink` icon.
- **Download row**: Only for bundled installs with a newer release. `vX.Y.Z available` with a small primary `Download for macOS` or `Download for Windows` link (`Download` icon); its detail line moves `Release notes` here and adds `SHA-256` and `Skip this version`. Source checkouts get the status line only, never a download button.
- **Inline actions**: `Release notes`, `SHA-256`, and `Skip this version` use the `Undo` text-action style (`font-medium text-muted-foreground`, `hover:text-foreground hover:underline`, `touch-target`) with `gap-x-3` between them. Downloads and release links open in the system browser (`target="_blank"`).
- **Skip this version**: Stored per version in `localStorage` (`agent-hub.update.dismissed`); it hides the rail `Update` slot (section 6) and the mobile attention dot until a newer release appears, while the download row stays available.
- **Mobile entry**: An `Updates` `SettingsNavRow` in the `General` group with the cached `vX.Y.Z` summary and the red attention dot (section 4) while the rail reminder would show; it reads only the query cache, so `#/settings` still makes no requests.

## 25. Resources

`ResourcesSettings` (`src/web/components/ResourcesSettings.tsx`) renders the `Resources` tab in desktop `SettingsDialog` and the mobile `#/settings/resources` page (`src/web/mobile/settings/ResourcesPage.tsx`), reading `GET /api/resources` through `src/web/resources-model.ts`:

- **Attention indicator**: The red attention dot (section 4) marks the rail `Settings` tile, the desktop `Resources` tab, and the mobile `Resources` `SettingsNavRow` whenever at least one held resource has `keptAt === null`. The mobile `#/settings` home reads only the React Query cache (`useCachedResourcesSummary`), so it issues zero network requests.
- **Computer scope**: When two or more computers are online, a top `SettingsGroup` offers a borderless `Select variant="plain"` computer picker so each computer's disk, branches, and processes can be inspected through device proxy routes.
- **Needs review**: Shown above `Summary` only when unacknowledged held items exist. Each row shows the item label, an `8px` round `bg-caution` status dot, spaced plain-language metadata (`gap-x-3`, never middle dots) with reason (`Unsaved file edits`, `Untracked files`, `Unmerged branch`, `Leftover temp folder`, `Leftover background process`, etc.), project name, size (`tabular-nums`), and up to 5 sample paths (`font-mono text-xs`), paired with `outline` `Keep` and danger-tinted `Delete…` (or `Stop…` for processes) actions.
- **Summary**: A `SettingsGroup` (`Refresh` and `Clean up` actions aligned cleanly in its header) with four plain-language rows: `Chat & app data`, `Files & workspaces`, `Worker workspaces` (`N active`, `N ready to clean`, `N to review`), and `Background processes` (`N running`, `N leftover`). Routine quota denominators stay hidden below `RESOURCES_WARN_RATIO` (`80%`); items at or above `80%` display the cap and a caution indicator. A default-collapsed `CollapsibleGroup` (`Storage breakdown`) lists per-directory and humanized database category totals on demand (never raw SQLite table names).
- **Kept**: A default-collapsed `CollapsibleGroup` holding items the user marked `Keep`, with `Allow cleanup` and `Delete…` / `Stop…` actions.
- **Delete/Stop confirmation**: Clicking `Delete…` or `Stop…` always opens a `max-w-110` `DialogContent` showing the item path or branch, reason, size, sample paths, an optional `Also delete branch` switch for held worktrees, `Cancel` (`outline`), and one destructive `Delete` / `Stop process` (`variant="destructive"`) button.

## 26. Pins

`PUT /api/pms/:id/pin` persists per-PM pins per computer (`pm_pins` SQLite table, `pinnedAt` epoch ms):

- **`Pinned` group (`ProjectList` and `projectListOf`)**: Renders above `Project managers` in both `column` and `strip` layouts only when at least one unarchived PM on the selected computer has `pinnedAt !== null`. Order follows `pinnedAt` ascending (oldest pin first, tie-broken by `pm.id` ascending).
- **Where pins toggle**: On desktop `ProjectList` rows via the `.row-shortcuts` `Pin` / `PinFilled` button, and inside `ProfilePanel` (`Pinned` header action) for all form factors. Archiving preserves `pinnedAt` (so unarchiving restores the pin) without displaying archived PMs in `Pinned`; offline/read-only remote views disable pin toggling.
