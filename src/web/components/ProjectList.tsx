import { memo, useMemo, useState } from "react";
import type * as React from "react";
import type { PmId } from "../../shared/index.ts";
import { conversationKey, type DeviceKey, type DeviceStatus } from "../devices.ts";
import { formatArchiveRemaining, formatTime, NEEDS_YOU, YOUR_TURN } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { ConversationRef } from "../notify.ts";
import { filterProjectList, isPinned, projectListOf } from "../project-list.ts";
import type { RailComputer } from "../rail-model.ts";
import { previewText, type ConversationEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { ChevronDown, ChevronRight, Pin, PinFilled, Plus, Settings } from "../ui/icons.ts";
import { Avatar } from "./Avatar.tsx";
import { ComputerSwitcher } from "./ComputerSwitcher.tsx";
import { SearchField } from "./SearchField.tsx";

/** column: the resizable desktop column; strip: the 4.5rem avatar strip; page: the phone's Projects tab. */
export type ProjectListLayout = "column" | "strip" | "page";

export interface ProjectListComputer {
  key: DeviceKey;
  name: string;
  status: DeviceStatus;
}

export interface ProjectListProps {
  layout: ProjectListLayout;
  computer: ProjectListComputer;
  /** Two or more computers are linked, so the header opens the computer list. */
  switchable: boolean;
  entries: readonly ConversationEntry[];
  active: ConversationRef | null;
  waiting: ReadonlySet<string>;
  asking: ReadonlySet<string>;
  /** The computer is offline: avatars dim and pin toggles are disabled. */
  readOnly: boolean;
  /** Optional list of linked computers to display inline in ComputerSwitcher. */
  computers?: readonly RailComputer[];
  onSelect: (ref: ConversationRef) => void;
  onNewPm: () => void;
  onTogglePin: (pmId: PmId, pinned: boolean) => void;
  /** Row shortcut to the PM's settings in the side panel. */
  onOpenPmSettings: (pmId: PmId) => void;
  onOpenComputers: () => void;
  onSelectComputer?: (key: DeviceKey) => void;
}

const SECTION_HEADING = "flex h-8 items-center gap-1.5 px-4 text-minor font-medium text-list-ink-soft";

function StripItem({
  entry,
  active,
  waiting,
  asking,
  readOnly,
  onSelect,
}: {
  entry: ConversationEntry;
  active: boolean;
  waiting: boolean;
  asking: boolean;
  readOnly: boolean;
  onSelect: () => void;
}) {
  const stateLabel = asking ? NEEDS_YOU : waiting ? YOUR_TURN : "";
  const ariaLabel = stateLabel ? `${entry.name} (${stateLabel})` : entry.name;
  return (
    <button
      type="button"
      title={entry.name}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "relative grid size-13 shrink-0 cursor-pointer place-items-center border-2 transition-colors outline-none focus-visible:outline-2 focus-visible:outline-border-focus",
        active ? "border-select-line bg-background" : "border-transparent hover:bg-list-hover",
      )}
    >
      <Avatar look={entry.look} size={36} className={readOnly ? "opacity-60" : undefined} />
      {(asking || waiting) && (
        <span
          role="img"
          aria-label={asking ? NEEDS_YOU : YOUR_TURN}
          data-testid={asking ? "asking-indicator" : "waiting-indicator"}
          className={cn("absolute right-1 bottom-1 size-2 bg-status-active ring-2", active ? "ring-background" : "ring-list")}
        />
      )}
    </button>
  );
}

function ProjectRow({
  entry,
  pageLayout,
  active,
  waiting,
  asking,
  readOnly,
  onSelect,
  onTogglePin,
  onOpenPmSettings,
}: {
  entry: ConversationEntry;
  pageLayout: boolean;
  active: boolean;
  waiting: boolean;
  asking: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onTogglePin: (pmId: PmId, pinned: boolean) => void;
  onOpenPmSettings: (pmId: PmId) => void;
}) {
  const pm = entry.pm;
  const pinned = isPinned(entry);
  const preview = previewText(entry);
  const archivedAt = pm?.archivedAt ?? null;
  const meta =
    archivedAt !== null ? (
      <span className="text-xs text-list-ink-soft tabular-nums">{formatArchiveRemaining(archivedAt)}</span>
    ) : asking ? (
      <span role="img" aria-label={NEEDS_YOU} title={NEEDS_YOU} data-testid="asking-indicator" className="size-2 shrink-0 bg-status-active" />
    ) : waiting ? (
      <span role="img" aria-label={YOUR_TURN} title={YOUR_TURN} data-testid="waiting-indicator" className="size-2 shrink-0 bg-status-active" />
    ) : entry.lastMessage ? (
      <span className="text-xs text-list-ink-soft tabular-nums">{formatTime(entry.lastMessage.createdAt)}</span>
    ) : null;

  return (
    <div
      className={cn(
        "project-row flex min-w-0 items-center gap-1 border-2 transition-colors",
        pageLayout ? "min-h-15 pr-3 pl-2" : "h-13 pr-2 pl-2",
        active ? "border-select-line bg-background" : "border-transparent hover:bg-list-hover",
      )}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-border-focus"
      >
        <Avatar look={entry.look} size={36} className={cn("shrink-0", readOnly && "opacity-60")} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span title={entry.name} className="min-w-0 flex-1 truncate text-body font-semibold text-list-ink">
              {entry.name}
            </span>{" "}
            {meta && <span className="project-row-meta shrink-0">{meta}</span>}
          </div>{" "}
          <p title={preview || undefined} className="truncate text-minor leading-snug text-list-ink-soft">
            {preview || "\u00a0"}
          </p>
        </div>
      </button>

      {!pageLayout && pm !== null && (
        <div className="row-shortcuts shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
            title={pinned ? "Unpin" : "Pin"}
            disabled={readOnly || archivedAt !== null}
            onClick={() => onTogglePin(pm.id, !pinned)}
            className="grid size-7 cursor-pointer place-items-center text-list-ink-soft transition-colors outline-none hover:bg-list-hover hover:text-list-ink focus-visible:outline-2 focus-visible:outline-border-focus disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pinned ? <PinFilled className="size-pixel-sm" /> : <Pin className="size-pixel-sm" />}
          </button>
          <button
            type="button"
            aria-label={`${entry.name} settings`}
            title="Project manager settings"
            onClick={() => onOpenPmSettings(pm.id)}
            className="grid size-7 cursor-pointer place-items-center text-list-ink-soft transition-colors outline-none hover:bg-list-hover hover:text-list-ink focus-visible:outline-2 focus-visible:outline-border-focus"
          >
            <Settings className="size-pixel-sm" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Postcondition: renders the header, search, and the Pinned, Project managers, and collapsed Archived groups from
 * projectListOf; the strip shows avatars only, pinned ones above a divider; row shortcuts appear on hover and keyboard
 * focus on hover-capable pointers and never on touch screens.
 */
export const ProjectList = memo(function ProjectList({
  layout,
  computer,
  switchable,
  entries,
  active,
  waiting,
  asking,
  readOnly,
  computers,
  onSelect,
  onNewPm,
  onTogglePin,
  onOpenPmSettings,
  onOpenComputers,
  onSelectComputer,
}: ProjectListProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const sections = useMemo(() => projectListOf(entries), [entries]);
  const filtered = useMemo(() => filterProjectList(sections, query), [sections, query]);

  const isPage = layout === "page";
  const isSelected = (entry: ConversationEntry) => !isPage && active !== null && active.device === computer.key && active.id === entry.id;
  const activeInArchived = filtered.archived.some(isSelected);
  const showArchived = archivedOpen || query.trim() !== "" || activeInArchived;

  if (layout === "strip") {
    const stripExtras = filtered.archived.filter(isSelected);
    return (
      <section aria-label={computer.name} className="flex h-full w-18 shrink-0 flex-col bg-list text-list-ink">
        <div className="flex h-14 shrink-0 items-center justify-center border-b-2 border-list-edge">
          <Button variant="slot" size="icon-lg" aria-label="New project manager" title="New project manager" onClick={onNewPm}>
            <Plus aria-hidden="true" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 py-2.5">
          {sections.pinned.map((entry) => {
            const key = conversationKey(computer.key, entry.id);
            return (
              <StripItem
                key={entry.id}
                entry={entry}
                active={isSelected(entry)}
                waiting={waiting.has(key)}
                asking={asking.has(key)}
                readOnly={readOnly}
                onSelect={() => onSelect({ device: computer.key, id: entry.id })}
              />
            );
          })}
          {sections.pinned.length > 0 && (sections.active.length > 0 || stripExtras.length > 0) && (
            <div aria-hidden="true" data-testid="strip-pin-divider" className="my-0.5 w-8 shrink-0 border-b-2 border-list-edge" />
          )}
          {[...sections.active, ...stripExtras].map((entry) => {
            const key = conversationKey(computer.key, entry.id);
            return (
              <StripItem
                key={entry.id}
                entry={entry}
                active={isSelected(entry)}
                waiting={waiting.has(key)}
                asking={asking.has(key)}
                readOnly={readOnly}
                onSelect={() => onSelect({ device: computer.key, id: entry.id })}
              />
            );
          })}
        </div>
      </section>
    );
  }

  const headerTrigger = (
    <button
      type="button"
      aria-label={`Switch computer (${computer.name})`}
      onClick={computers === undefined ? onOpenComputers : undefined}
      className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-title font-semibold text-list-ink transition-colors outline-none hover:text-rail-ink focus-visible:outline-2 focus-visible:outline-border-focus"
    >
      <span title={computer.name} className="min-w-0 truncate">
        {computer.name}
      </span>
      <ChevronDown className="size-pixel-sm shrink-0 text-list-ink-soft" aria-hidden="true" />
    </button>
  );

  const hasMatches = filtered.pinned.length + filtered.active.length + filtered.archived.length > 0;

  return (
    <section
      aria-label={computer.name}
      className={cn("flex min-h-0 min-w-0 flex-col bg-list text-list-ink", isPage ? "flex-1 pt-[var(--safe-top)]" : "h-full")}
    >
      <header data-window-drag className="flex h-14 shrink-0 items-center justify-between gap-2 border-b-2 border-list-edge pr-2.5 pl-4">
        <div className="min-w-0 flex-1">
          {switchable ? (
            computers !== undefined && onSelectComputer !== undefined ? (
              <ComputerSwitcher
                variant={isPage ? "drawer" : "popover"}
                open={switcherOpen}
                computers={computers}
                selected={computer.key}
                trigger={headerTrigger}
                onOpenChange={setSwitcherOpen}
                onSelect={onSelectComputer}
                onManage={onOpenComputers}
              />
            ) : (
              headerTrigger
            )
          ) : (
            <h1 title={computer.name} className="truncate text-title font-semibold text-list-ink">
              {computer.name}
            </h1>
          )}
        </div>
        <Button variant="slot" size="icon-lg" aria-label="New project manager" title="New project manager" onClick={onNewPm}>
          <Plus aria-hidden="true" />
        </Button>
      </header>

      <div className="shrink-0 px-3 pt-3 pb-1">
        <SearchField label="Search conversations" tone="cream" value={query} onChange={setQuery} />
      </div>

      <div className="page-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pt-2 pb-4">
        {!hasMatches ? (
          <p className="px-4 py-6 text-center text-minor text-list-ink-soft">
            {query.trim() === "" ? "No project managers yet" : "No matching conversations"}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filtered.pinned.length > 0 && (
              <section aria-label="Pinned" className="min-w-0">
                <h2 className={SECTION_HEADING}>Pinned</h2>
                <div className="grid grid-cols-1 gap-0.5">
                  {filtered.pinned.map((entry) => {
                    const key = conversationKey(computer.key, entry.id);
                    return (
                      <ProjectRow
                        key={entry.id}
                        entry={entry}
                        pageLayout={isPage}
                        active={isSelected(entry)}
                        waiting={waiting.has(key)}
                        asking={asking.has(key)}
                        readOnly={readOnly}
                        onSelect={() => onSelect({ device: computer.key, id: entry.id })}
                        onTogglePin={onTogglePin}
                        onOpenPmSettings={onOpenPmSettings}
                      />
                    );
                  })}
                </div>
              </section>
            )}

            {filtered.active.length > 0 && (
              <section aria-label="Project managers" className="min-w-0">
                <h2 className={SECTION_HEADING}>Project managers</h2>
                <div className="grid grid-cols-1 gap-0.5">
                  {filtered.active.map((entry) => {
                    const key = conversationKey(computer.key, entry.id);
                    return (
                      <ProjectRow
                        key={entry.id}
                        entry={entry}
                        pageLayout={isPage}
                        active={isSelected(entry)}
                        waiting={waiting.has(key)}
                        asking={asking.has(key)}
                        readOnly={readOnly}
                        onSelect={() => onSelect({ device: computer.key, id: entry.id })}
                        onTogglePin={onTogglePin}
                        onOpenPmSettings={onOpenPmSettings}
                      />
                    );
                  })}
                </div>
              </section>
            )}

            {filtered.archived.length > 0 && (
              <section aria-label="Archived" className="min-w-0">
                <button
                  type="button"
                  aria-expanded={showArchived}
                  onClick={() => setArchivedOpen((open) => !open)}
                  className={cn(SECTION_HEADING, "pointer-coarse:min-h-11 w-full cursor-pointer text-left outline-none hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-border-focus")}
                >
                  <ChevronRight className={cn("size-pixel-sm shrink-0 transition-transform", showArchived && "rotate-90")} aria-hidden="true" />
                  <span>Archived</span>
                  <span className="ml-auto text-xs tabular-nums">{filtered.archived.length}</span>
                </button>
                {showArchived && (
                  <div className="mt-0.5 grid grid-cols-1 gap-0.5">
                    {filtered.archived.map((entry) => {
                      const key = conversationKey(computer.key, entry.id);
                      return (
                        <ProjectRow
                          key={entry.id}
                          entry={entry}
                          pageLayout={isPage}
                          active={isSelected(entry)}
                          waiting={waiting.has(key)}
                          asking={asking.has(key)}
                          readOnly={readOnly}
                          onSelect={() => onSelect({ device: computer.key, id: entry.id })}
                          onTogglePin={onTogglePin}
                          onOpenPmSettings={onOpenPmSettings}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </section>
  );
});
