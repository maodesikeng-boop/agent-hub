# Baseline style brief

Baseline screenshot: `docs/ui-polish/baseline/baseline.png` (`chat.normal@desktop`, `1440x900` desktop viewport at 2x device pixel ratio, default `Default` interface scale).

This brief defines rules `S1` through `S6` for visual evaluation in `pnpm ui:polish`. It restates `docs/ui-standard.md` sections 1 to 4; when the two disagree, the standard wins.

## What the baseline governs

- **Visual DNA only.** A window of dark frame wood with a `40px` top bar, a rail on the wood, the PM list on lighter year-ring wood joined to the white conversation sheet, a `4px` gap of wood before the white side panel, one inlay rim around the panels, grooves instead of lines on the wood, `12/11/8/4px` radii, `1px` warm-ink lines on white, a cream selected band, flat buttons and a pastel send button, flat chips and cards, concise English shell copy without separator characters, and folded process details by default.
- **Not a 9-point ceiling.** The baseline screen itself scores around 6 to 7 points and needs the same polish pass as every other screen. Matching its flaws is not the goal. Rubric guard tests in `test/ui-polish/rubric.test.ts` match the literal test strings `风格基因` and `6, 7 分`.
- **No locked pixel dimensions.** Column widths, padding, row heights, and whitespace ratios do not need to match the baseline image pixel-for-pixel; cleaner proportions and breathing room within the tokens of `docs/ui-standard.md` are improvements.

## S1 Color

- **Three zones by tone.** The frame wood (`#5f3302` to `#542d00` with sparse vertical grain) holds the top bar, the rail, the panel rims, and the gap before the side panel. The year-ring wood (`#774511` to `#6f3d05`) carries the PM list, the strip, and the Settings categories, with light text on it. Content sits on white sheets (`#ffffff`); paper (`#f7f4ed`) marks secondary surfaces inside a sheet: event strips and chips. Settings opens as a page of the workbench, its categories on the year rings joined to the open category's white sheet, never as a framed window over a scrim.
- **Sparse solid accent.** Solid `--primary` (the PM's fruit accent, `#4a2e00` outside a PM) appears only on the single primary button on screen, checked switches and radios, completed Task Graph pipes and beads, active gate titles, and the small dots beside `Needs You`. The send button is the PM's color made pastel, with a dark arrow of the same hue.
- **Selection is a fill.** On the year rings the selected row is a flat cream band (`#fffaf2`) with dark text. On the rail a selected tile takes a warm white fill and a selected computer's icon turns solid; hover is a lighter fill only. On white or paper, `tile-open` uses the pale `#fff6d6` fill with a `1px` gold `#e0b03c` ring. Text weight never changes.
- **Semantic dots.** Waiting and asking rows show an `8px` green dot with no text pill. The one attention dot for something to review in Settings is red on every surface. Dots on tiles and icons carry a `2px` halo in the surface color.
- **Consistent pixel art avatars.** Project Managers use fruit slime sprites, Pieces use curled note sprites in the PM color, and Router uses the sprout bell sprite. Controls and icons are smooth line art; pixels stay on characters, avatars, beads and pipes, and brand art.

## S2 Type scale

Values below reflect the `Default` 16px root scale, the default (`Large` scales all `rem` tokens by `1.09375x`):

1. `16px` (`600`): Conversation header name, side panel header, and dialog titles (`text-title`). The profile page display name at `22px` (`text-display`) is the sole exception.
2. `15px`: Body copy and row titles outside a conversation (settings and side-panel rows, form inputs), and PM names and chat on the phone (`text-body`).
3. `13.5px`: Every section heading (`500` muted: `Pinned`, `Project managers`, `Needs You`, `Task Graph`, `Pieces`, `Completed`, settings groups), PM names in the desktop list (`400`), Worker report rows, buttons (`500`), event strips, and `Show more` (`text-minor`). On the desktop a conversation reads at this size too: the messages, ask card questions (`500`) and options (`400`), and the composer of a PM's conversation, the Router, and a Worker thread (`text-body` inside `.chat-text`).
4. `12px`: Timestamps, counts, `Recommended`, rail labels, and step numbers (`text-xs`).

- **One typeface**: Lato for Latin text and digits in its true Regular, Medium, and Semibold, with PingFang SC and the other system fonts for Chinese; code blocks use the system monospace.
- **Three weights only**: `400`, `500`, and `600`. Selected rows change background only, never font weight.
- **Tabular numerals**: Timestamps, counts, percentages, and step IDs use `tabular-nums`.

## S3 Spacing rhythm

- Use the spacing scale in `docs/ui-standard.md` consistently across sibling containers and rows.
- Headings, icons, avatars, and row text in one column start on one left edge; an indent is a deliberate step of `12px` or more, never a `2px` to `8px` near miss.
- Keep navigation columns compact and center the chat column with symmetric gutters. Group messages within one turn tightly and separate distinct speakers clearly.
- Compressing padding or row height to less than half of comparable regions so text crowds together counts as `P1`.

## S4 Shape, lines, and depth

- **Four radii**: `12px` on the panels of the shell, `11px` on rail tiles, `8px` (`rounded-sm`) on controls, cards, group boxes, popovers, dialogs, the composer, and rows, and `4px` (`rounded-xs`) on chips, tags, badges, and parts nested in an `8px` control; circles only for dots, radio marks, and scrollbar thumbs. Where two panels join, the inner corners are square.
- **One line weight**: every line on white is `1px`: `rgb(110 74 0 / 0.14)` for structure (dividers, header bottoms, cards, group boxes, dialogs) and `rgb(110 74 0 / 0.26)` for controls (inputs, selects, raised buttons). On the wood, lines are grooves: a `1px` dark line over a `1px` light one. The only wider strokes are the `2px` focus outline, the dashed file-drop target, the Markdown quote bar, and dot halos.
- **No lines between columns and no box in a box.** Panels part by tone and depth: the PM list and the conversation join with square corners, and the side panel sits after a `4px` gap of wood. A framed box never sits inside another framed box; inside a card, parts separate by space or one divider, and chips, tags, and inline code are flat fills. Decision cards list their options and the reply as full-bleed rows parted by hairlines, with plain `A`/`B` letters, and the Settings page lays its groups flat as headings over divided rows.
- **Depth only for the inlay and what floats**: the dark rim where the panels sink into the wood (as deep in the gap as around the outside) and the conversation's shade on the PM list, the composer's soft drop, popovers and menus, and dialogs. Buttons are flat. Cards, strips, and group boxes stay flat. No frosted glass, no glow, no gradients outside the wood.

## S5 Information density

- Navigation rows hold at most two text lines and truncate overflow with `truncate` and `title`.
- Fold completed tool steps into `Worked for Xs`, collapse long upstream or downstream Task Graph chains into `N done` and `N next`, and keep `Archived` and `Completed` collapsed by default.
- Cramped regions compressed by more than half count as `P1`; unexplained empty voids count as `P2`.

## S6 Copy and tone

- Shell labels, buttons, placeholders, and status words use concise sentence-case English (`Search`, `Router`, `Archived`, `Task Graph`, `Recommended`, `Reply or add a note…`). User messages, PM names, and Piece titles keep the user's language.
- Separate metadata items on one row with spacing (`gap-2` or `gap-3`), never middle dots, pipes, or slashes.
- Omit explanatory helper captions above or below controls when position and verb labels already state the action.
