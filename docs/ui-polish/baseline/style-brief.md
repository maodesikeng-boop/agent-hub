# Baseline style brief

Baseline screenshot: `docs/ui-polish/baseline/baseline.png` (`chat.normal@desktop`, `1440x900` desktop viewport at 2x device pixel ratio, default `Large` interface scale).

This brief defines rules `S1` through `S6` for visual evaluation in `pnpm ui:polish`. It restates `docs/ui-standard.md` sections 1 to 4; when the two disagree, the standard wins.

## What the baseline governs

- **Visual DNA only.** A honey rail, a cream frame that carries the PM list, white sheets for the conversation and side panel parted by tone and a `6px` gap rather than lines, one `4px` radius, `1px` warm-ink lines, a gold `1px` selection ring, soft raised buttons, flat chips and cards, concise English shell copy without separator characters, and folded process details by default.
- **Not a 9-point ceiling.** The baseline screen itself scores around 6 to 7 points and needs the same polish pass as every other screen. Matching its flaws is not the goal. Rubric guard tests in `test/ui-polish/rubric.test.ts` match the literal test strings `风格基因` and `6, 7 分`.
- **No locked pixel dimensions.** Column widths, padding, row heights, and whitespace ratios do not need to match the baseline image pixel-for-pixel; cleaner proportions and breathing room within the tokens of `docs/ui-standard.md` are improvements.

## S1 Color

- **Three zones by tone.** The honey rail (`#ffcb3d`) is the only saturated surface. The cream frame (`#fff4cc`) carries the PM list, the strip, and the gaps between sheets. Content sits on white sheets (`#ffffff`); paper (`#f7f4ed`) marks secondary surfaces inside a sheet: event strips and chips. Settings opens as a page of the workbench, its categories on the cream frame and the open category on a white sheet, never as a framed window over a scrim.
- **Sparse solid accent.** Solid `--primary` (the PM's fruit accent, `#4a2e00` outside a PM) appears only on the single primary button on screen, checked switches and radios, completed Task Graph pipes and beads, active gate titles, and the small dots beside `Needs You`.
- **Selection is a ring, not a fill.** On cream or honey, the selected row or tile lifts into a lighter `tile-selected` (white, or cream on the rail) with a `1px` gold `#e0b03c` inset ring and a soft `1px` drop. On white or paper, `tile-open` uses the pale `#fff6d6` fill with the same ring. Text weight never changes.
- **Semantic dots.** Waiting and asking rows show an `8px` green dot with no text pill. The one attention dot for something to review in Settings is red on every surface. Dots on tiles and icons carry a `2px` halo in the surface color.
- **Consistent pixel art avatars.** Project Managers use fruit slime sprites, Pieces use curled note sprites in the PM color, and Router uses the sprout bell sprite. Controls and icons are smooth line art; pixels stay on characters, avatars, beads and pipes, and brand art.

## S2 Type scale

Values below reflect the `Default` 16px root scale (`Large` scales all `rem` tokens by `1.09375x`):

1. `17px` (`600`): Conversation header name, side panel header, and dialog titles (`text-title`). The profile page display name at `22px` (`text-display`) is the sole exception.
2. `15px`: Body copy, row titles, PM names (`600`), ask card questions (`500`), option text (`400`), and form inputs (`text-body`).
3. `13.5px`: Every section heading (`500` muted: `Pinned`, `Project managers`, `Needs You`, `Task Graph`, `Pieces`, `Completed`, settings groups), sidebar previews, buttons (`500`), event strips, and `Show more` (`text-minor`).
4. `12px`: Timestamps, counts, `Recommended`, rail labels, and step numbers (`text-xs`).

- **Three weights only**: `400`, `500`, and `600`. Selected rows change background only, never font weight.
- **Tabular numerals**: Timestamps, counts, percentages, and step IDs use `tabular-nums`.

## S3 Spacing rhythm

- Use the spacing scale in `docs/ui-standard.md` consistently across sibling containers and rows.
- Headings, icons, avatars, and row text in one column start on one left edge; an indent is a deliberate step of `12px` or more, never a `2px` to `8px` near miss.
- Keep navigation columns compact and center the chat column with symmetric gutters. Group messages within one turn tightly and separate distinct speakers clearly.
- Compressing padding or row height to less than half of comparable regions so text crowds together counts as `P1`.

## S4 Shape, lines, and depth

- **One radius**: `4px` (`rounded-sm`) on controls, cards, group boxes, chips, popovers, dialogs, sheets, and rows; `2px` (`rounded-xs`) only for parts nested in a `4px` control; circles only for dots, radio marks, and scrollbar thumbs. Nothing larger, nothing square.
- **One line weight**: every line is `1px`: `rgb(110 74 0 / 0.14)` for structure (dividers, header bottoms, cards, group boxes, dialogs) and `rgb(110 74 0 / 0.26)` for controls (inputs, selects, raised buttons, the composer). The only wider strokes are the `2px` focus outline, the dashed file-drop target, the Markdown quote bar, and dot halos.
- **No lines between columns and no box in a box.** Columns part by tone and a `6px` gap. A framed box never sits inside another framed box; inside a card, parts separate by space or one divider, and chips, tags, and inline code are flat fills. Decision cards list their options and the reply as full-bleed rows parted by hairlines, with plain `A`/`B` letters, and the Settings page lays its groups flat as headings over divided rows.
- **Depth only where something is raised or floats**: buttons (a top-lit fill, an inner highlight, and a `1px` soft drop that sinks into an inset shade when pressed), selected tiles, the composer, popovers and menus, and dialogs. Cards, strips, and group boxes stay flat. No frosted glass, no glow, no gradients outside button fills.

## S5 Information density

- Navigation rows hold at most two text lines and truncate overflow with `truncate` and `title`.
- Fold completed tool steps into `Worked for Xs`, collapse long upstream or downstream Task Graph chains into `N done` and `N next`, and keep `Archived` and `Completed` collapsed by default.
- Cramped regions compressed by more than half count as `P1`; unexplained empty voids count as `P2`.

## S6 Copy and tone

- Shell labels, buttons, placeholders, and status words use concise sentence-case English (`Search`, `Router`, `Archived`, `Task Graph`, `Recommended`, `Reply or add a note…`). User messages, PM names, and Piece titles keep the user's language.
- Separate metadata items on one row with spacing (`gap-2` or `gap-3`), never middle dots, pipes, or slashes.
- Omit explanatory helper captions above or below controls when position and verb labels already state the action.
