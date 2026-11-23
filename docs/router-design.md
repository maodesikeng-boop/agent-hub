# Router architecture

> Snapshot: 2026-11-20 (commit `58dd656f`)

**Router** sits at the top of the Bellwood sidebar (`#/router`) and 1-on-1 Feishu bot chat as a single control center across all projects and linked computers. It combines zero-LLM card routing with a stateless, read-only single-turn dispatcher so cross-project triage stays fast regardless of how many months a workspace runs.

## Two-track architecture

1. **Track A: Zero-LLM card aggregation and settlement**:
   - Pending `hub ask` cards, Task Graph gates (`waitingFor: "user"`), `UserBlocker` cards, and `hub router ask` / `hub router report` items flow directly from local and mesh-connected ledgers into Router's `Needs You` tray and timeline without invoking a model.
   - Answering a card in `#/router` (or 1-on-1 Feishu chat) routes straight back to the owning computer and PM (`src/web/decision-actions.ts`), settling the card in one click.
2. **Track B: Stateless single-turn dispatch (`src/daemon/router/`)**:
   - Natural-language prompts in `#/router` run in a fresh, isolated one-shot session rooted at `state/router-home` (`src/daemon/router/single-turn.ts` and `sandbox.ts`), wrapped in Bellwood's read-only OS sandbox (`DataDirReadScope` allowing `state/router-home`, `run/bin`, and `run/hub.sock`, while denying the rest of `state/`).
   - Router carries no unbounded multi-turn transcript of its own. Each prompt receives compact device and project cards, resolves targets, calls `hub router` dispatch commands, and exits.
   - `--verbatim` forwarding (`hub router send --pm <target> --verbatim`) copies the user's exact message text and attachments to the target PM at the ledger layer without re-serializing through the model, preventing paraphrasing loss and saving output tokens.

## Two-tier project catalog (`src/daemon/project-catalog/`)

To let Router match everyday project nicknames and answer cross-project status questions without reading raw conversation histories:

- **Background incremental maintenance**: As PM conversations progress (or cold-start from top-level `README.md`, `AGENTS.md`, and `CLAUDE.md` bounded by `PROJECT_CATALOG_FILE_MAX_CHARS`), `src/daemon/project-catalog/runner.ts` updates a structured `ProjectCatalog` record per project in SQLite (`src/shared/project-catalog.ts`).
- **Tier 1 (always in Router's prompt)**: One-line project identity, nicknames, tech stack tags, active focus, and live Task Graph / Piece counts (`PROJECT_CATALOG_CARD_MAX_BYTES`).
- **Tier 2 (on demand)**: Full stage brief fetched via `TargetPort` (`hub router catalog --pm <target>`) only when a user asks a deeper cross-project status question, without counting toward dispatch target caps.

## Workbench layout and `ForwardReply`

Instead of turning every message into a dismissible card, `#/router` (`src/web/components/RouterWorkbench.tsx`, `RouterDecisionCard.tsx`, `RouterStream.tsx`, and `ForwardReply.tsx`) separates actionable decisions from history (`docs/ui-standard.md` section 21):

- **`Needs You` tray**: Displays only unsettled decisions (`RouterDecisionCard`), supporting one-click preset choice, preset choice + note, or custom text submission. Collapses automatically when all items are settled.
- **Timeline**: Chronological stream of user commands, Router target links, incoming PM milestone reports (`hub router report`), and inline **`ForwardReply`** blocks (`src/shared/turn-reply.ts`). When Router forwards a prompt to one or more PMs, the ledger links the resulting PM turn reply (`meta.replyId`) back to the originating Router command so the PM's live `Working...` state, `Stopped` state, or finished Markdown answer renders directly beneath the Router turn.

## Vendor-neutral fast model selection (`src/shared/router-model.ts`)

- Every vendor declares its fast Router preset (`routerDefault`: model and effort) in `src/vendors/<vendor>/spec.ts` (guarded by `src/vendors/vendor-registry.test.ts`).
- `Auto` picks the highest-priority ready vendor on the local machine; users can also pin a specific vendor, model, and effort from `RouterModelPicker` in the `#/router` header or `/settings` in Feishu direct chat. Switching takes effect on the very next prompt.

## Bounds and caching

All Router tables, queues, and prompt inputs are bounded in `src/shared/limits.ts` (`ROUTER_*` and `PROJECT_CATALOG_*` constants), compressed over HTTP, and memoized in `src/web/selectors.ts` via `WeakMap` selectors.
