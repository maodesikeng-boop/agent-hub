# Baseline style brief

Baseline screenshot: `docs/ui-polish/baseline/baseline.png` (`chat.normal@desktop`, `1440x900` desktop viewport at 2x device pixel ratio, default `Large` interface scale).

This brief defines rules `S1` through `S6` for visual evaluation in `pnpm ui:polish`.

## What the baseline governs

- **Visual DNA only.** Keep pale neutral or subtly fruit-tinted backgrounds, small focal areas of solid accent color, 10% translucent jelly fills for selected rows and active gate cards, three main radius tiers, flat surfaces without gradients or frosted glass, a single soft shadow on the chat composer, 1px hairline dividers without nested bordered boxes, concise English shell copy without separator characters, and folded process details by default.
- **Not a 9-point ceiling.** The baseline screen itself scores around 6 to 7 points and needs the same polish pass as every other screen. Matching its flaws is not the goal. Rubric guard tests in `test/ui-polish/rubric.test.ts` assert the literal tokens 风格基因 and 6, 7 分.
- **No locked pixel dimensions.** Column widths, padding, row heights, and whitespace ratios do not need to match the baseline image pixel-for-pixel; cleaner proportions and breathing room within the tokens of `docs/ui-standard.md` are improvements.

## S1 Color

- **Pale neutral or fruit-tinted canvas.** The left sidebar sits half a step darker (`#f6f6f7` mixed with 3% of the active PM fruit color) than the center chat and right rail (`#ffffff` mixed with 2.5% fruit color). Unscoped views such as Router, global settings, and creation dialogs use pure `#ffffff` and `#f6f6f7`.
- **White cards and inputs.** Ask cards, the chat composer, secondary option buttons, and grouped settings boxes use `#ffffff`. Worker speech bubbles use `#f2f2f4`, and the sidebar search box uses `#e9e9ec`.
- **Sparse solid accent.** Solid `--primary` appears only on focal controls: the single primary button on screen, the recommended gate option, completed Task Graph pipes and beads, and active gate titles. Without a PM scope, `--primary` falls back to `#18181b`.
- **10% jelly highlight.** Selected PM rows and active gate cards use a 10% translucent fruit tint (`bg-jelly`) with dark foreground text rather than inverted white text on a solid block.
- **Semantic status colors.** Unread and waiting indicators in the sidebar use an 8px `#16a34a` green dot with no text pill. Text uses two neutral tiers: `#18181b` for primary copy and `#5f5f69` for secondary metadata (>= 4.5:1 contrast over sidebar and jelly surfaces).
- **Consistent pixel art avatars.** Project Managers use fruit slime sprites, Pieces use curled note sprites in the PM color, and Router uses the sprout bell sprite.

## S2 Type scale

Values below reflect the `Default` 16px root scale (`Large` scales all `rem` tokens by `1.09375x`):

1. `17px` (`600`): Conversation header name, sidebar PM name, and dialog titles (`text-title`). The profile page display name at `22px` (`text-display`) is the sole exception.
2. `15px`: Body copy, row titles, ask card questions (`500`), option text (`400`), and form inputs (`text-body`).
3. `13.5px`: Sidebar previews, Worker names (`500`), buttons (`500`), secondary descriptions, and `Show more` (`text-minor`).
4. `12px`: Timestamps, section headers (`Needs You`, `Task Graph`, `Pieces`, `Completed`, `Archived`), `Recommended`, and step numbers (`text-xs`).

- **Three weights only**: `400`, `500`, and `600`. Selected rows change background only, never font weight.
- **Tabular numerals**: Timestamps, counts, percentages, and step IDs use `tabular-nums`.

## S3 Spacing rhythm

- Use the spacing scale in `docs/ui-standard.md` consistently across sibling containers and rows.
- Keep navigation rails compact and center the chat column with symmetric horizontal gutters. Group messages within one turn tightly and separate distinct speakers clearly.
- Compressing padding or row height to less than half of comparable regions so text crowds together counts as `P1`.

## S4 Shape and borders

- **Radius tiers**: `rounded-full` for pills, switches, and status dots; `rounded-2xl` (`16px`) for sidebar rows, cards, popovers, and dialogs (`22px` on chat bubbles); `rounded-xl` (`12px`) for inputs, selects, code blocks, and option rows; `4px` on `slot` buttons and `.tool-badge` counters; stepped pixel corners on Task Graph dialog nodes.
- **Flat surfaces**: No gradients, no backdrop blur, and no drop shadows except `.composer-frame`.
- **1px dividers**: Separate panes and rail groups with 1px `border-line` (`#ececef` mixed with 8% fruit color). Do not nest bordered cards inside bordered cards, and draw no bottom border under conversation headers.

## S5 Information density

- Navigation rows hold at most two text lines and truncate overflow with `truncate` and `title`.
- Fold completed tool steps into `Worked for Xs`, collapse long upstream or downstream Task Graph chains into `N done` and `N next`, and keep `Archived` and `Completed` collapsed by default.
- Cramped regions compressed by more than half count as `P1`; unexplained empty voids count as `P2`.

## S6 Copy and tone

- Shell labels, buttons, placeholders, and status words use concise sentence-case English (`Search`, `Router`, `Archived`, `Task Graph`, `Recommended`, `Add note`). User messages, PM names, and Piece titles keep the user's language.
- Separate metadata items on one row with spacing (`gap-2` or `gap-3`), never middle dots, pipes, or slashes.
- Omit explanatory helper captions above or below controls when position and verb labels already state the action.
