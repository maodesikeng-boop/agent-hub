import { memo, useMemo, useState } from "react";
import type * as React from "react";
import type { PmId } from "../../shared/index.ts";
import { conversationKey, type DeviceKey, type DeviceStatus } from "../devices.ts";
import { formatArchiveRemaining, NEEDS_YOU, YOUR_TURN } from "../format.ts";
import { cn } from "../lib/utils.ts";
import type { ConversationRef } from "../notify.ts";
import { filterProjectList, isPinned, projectListOf } from "../project-list.ts";
import type { RailComputer } from "../rail-model.ts";
import type { ConversationEntry } from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import { ChevronDown, ChevronRight, MessageSquare, Pin, PinFilled, Plus } from "../ui/icons.ts";
import { Avatar, AvatarTile } from "./Avatar.tsx";
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
  onOpenComputers: () => void;
  onSelectComputer?: (key: DeviceKey) => void;
}

// Headings start on the list's 8px edge, shared with the search field and the selected band.
const GROUP_HEADING = "flex h-6.5 items-center gap-1.5 pr-2 text-minor font-medium text-list-ink-soft";
const GROUP_ICON = "size-3.5 shrink-0";

function GroupGroove() {
  return <div aria-hidden="true" data-testid="group-groove" className="groove" />;
}

const StripItem = memo(function StripItem({
  deviceKey,
  entry,
  active,
  waiting,
  asking,
  readOnly,
  onSelect,
}: {
  deviceKey: DeviceKey;
  entry: ConversationEntry;
  active: boolean;
  waiting: boolean;
  asking: boolean;
  readOnly: boolean;
  onSelect: (ref: ConversationRef) => void;
}) {
  const stateLabel = asking ? NEEDS_YOU : waiting ? YOUR_TURN : "";
  const ariaLabel = stateLabel ? `${entry.name} (${stateLabel})` : entry.name;
  return (
    <button
      type="button"
      title={entry.name}
      aria-label={ariaLabel}
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect({ device: deviceKey, id: entry.id })}
      className={cn(
        "relative grid size-13 shrink-0 cursor-pointer place-items-center rounded-sm transition-[background-color] duration-150 outline-none focus-visible:outline-2 focus-visible:outline-border-focus motion-reduce:transition-none",
        active ? "row-selected" : "hover:bg-list-hover",
      )}
    >
      <Avatar look={entry.look} size={36} className={readOnly ? "opacity-60" : undefined} />
      {(asking || waiting) && (
        <span
          role="img"
          aria-label={asking ? NEEDS_YOU : YOUR_TURN}
          data-testid={asking ? "asking-indicator" : "waiting-indicator"}
          className={cn("absolute right-1 bottom-1 size-2 rounded-full bg-status-active ring-2", active ? "ring-[var(--row-selected)]" : "ring-list")}
        />
      )}
    </button>
  );
});

const ProjectRow = memo(function ProjectRow({
  deviceKey,
  entry,
  pageLayout,
  active,
  waiting,
  asking,
  readOnly,
  onSelect,
  onTogglePin,
}: {
  deviceKey: DeviceKey;
  entry: ConversationEntry;
  pageLayout: boolean;
  active: boolean;
  waiting: boolean;
  asking: boolean;
  readOnly: boolean;
  onSelect: (ref: ConversationRef) => void;
  onTogglePin: (pmId: PmId, pinned: boolean) => void;
}) {
  const pm = entry.pm;
  const pinned = isPinned(entry);
  const archivedAt = pm?.archivedAt ?? null;
  const waitsOnYou = asking ? NEEDS_YOU : waiting ? YOUR_TURN : null;

  return (
    <div
      className={cn(
        "project-row flex min-w-0 items-center gap-1 rounded-sm transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none",
        pageLayout ? "min-h-11 pr-3 pl-2" : "pointer-coarse:h-11 h-6.5 pr-2 pl-2",
        active ? "row-selected" : "hover:bg-list-hover",
      )}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onSelect({ device: deviceKey, id: entry.id })}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch text-left outline-none focus-visible:outline-2 focus-visible:outline-border-focus"
      >
        <AvatarTile look={entry.look} className={readOnly ? "opacity-60" : undefined} />
        <span
          title={entry.name}
          className={cn("min-w-0 flex-1 truncate text-list-ink", pageLayout ? "text-body" : "text-minor")}
        >
          {entry.name}
        </span>{" "}
        {waitsOnYou !== null && <span className="sr-only">{waitsOnYou}</span>}
        {archivedAt !== null && (
          <span className="project-row-meta shrink-0 text-xs text-list-ink-soft tabular-nums">{formatArchiveRemaining(archivedAt)}</span>
        )}
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
        </div>
      )}
    </div>
  );
});

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
      <section aria-label={computer.name} className="wood-rings shell-list flex h-full w-18 shrink-0 flex-col text-list-ink">
        <div className="groove-bottom flex h-11 shrink-0 items-center justify-center">
          <Button variant="slot" size="icon" className="size-7" aria-label="New project manager" title="New project manager" onClick={onNewPm}>
            <Plus aria-hidden="true" />
          </Button>
        </div>
        <div className="sidebar-list flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 py-2.5">
          {sections.pinned.map((entry) => {
            const key = conversationKey(computer.key, entry.id);
            return (
              <StripItem
                key={entry.id}
                deviceKey={computer.key}
                entry={entry}
                active={isSelected(entry)}
                waiting={waiting.has(key)}
                asking={asking.has(key)}
                readOnly={readOnly}
                onSelect={onSelect}
              />
            );
          })}
          {sections.pinned.length > 0 && (sections.active.length > 0 || stripExtras.length > 0) && (
            <div aria-hidden="true" data-testid="strip-pin-divider" className="groove my-0.5 w-8 shrink-0" />
          )}
          {[...sections.active, ...stripExtras].map((entry) => {
            const key = conversationKey(computer.key, entry.id);
            return (
              <StripItem
                key={entry.id}
                deviceKey={computer.key}
                entry={entry}
                active={isSelected(entry)}
                waiting={waiting.has(key)}
                asking={asking.has(key)}
                readOnly={readOnly}
                onSelect={onSelect}
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
      className="touch-target flex h-7 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-title font-semibold text-list-ink transition-colors outline-none hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-border-focus"
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
      className={cn("wood-rings flex min-h-0 min-w-0 flex-col text-list-ink", isPage ? "flex-1 pt-[var(--safe-top)]" : "shell-list h-full")}
    >
      <header data-window-drag className="groove-bottom flex h-11 min-w-0 shrink-0 items-center justify-between gap-3 pr-3 pl-4">
        <div className={cn("flex min-w-0 flex-1 items-center", switchable && "-ml-1.5")}>
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
            <h1 title={computer.name} className="min-w-0 truncate text-title font-semibold text-list-ink">
              {computer.name}
            </h1>
          )}
        </div>
        <Button variant="slot" size="icon" className="size-7 shrink-0" aria-label="New project manager" title="New project manager" onClick={onNewPm}>
          <Plus aria-hidden="true" />
        </Button>
      </header>

      <div className="shrink-0 px-2 pt-3 pb-1">
        <SearchField label="Search conversations" tone="list" value={query} onChange={setQuery} />
      </div>

      <div className="sidebar-list page-fade min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-2 pt-2 pb-4">
        {!hasMatches ? (
          <p className="px-4 py-6 text-center text-minor text-list-ink-soft">
            {query.trim() === "" ? "No project managers yet" : "No matching conversations"}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filtered.pinned.length > 0 && (
              <section aria-label="Pinned" className="min-w-0">
                <h2 className={GROUP_HEADING}>
                  <Pin className={GROUP_ICON} aria-hidden="true" />
                  <span className="trim-cap">Pinned</span>
                </h2>
                <div className="grid grid-cols-1">
                  {filtered.pinned.map((entry) => {
                    const key = conversationKey(computer.key, entry.id);
                    return (
                      <ProjectRow
                        key={entry.id}
                        deviceKey={computer.key}
                        entry={entry}
                        pageLayout={isPage}
                        active={isSelected(entry)}
                        waiting={waiting.has(key)}
                        asking={asking.has(key)}
                        readOnly={readOnly}
                        onSelect={onSelect}
                        onTogglePin={onTogglePin}
                      />
                    );
                  })}
                </div>
              </section>
            )}

            {filtered.active.length > 0 && filtered.pinned.length > 0 && <GroupGroove />}
            {filtered.active.length > 0 && (
              <section aria-label="Project managers" className="min-w-0">
                <h2 className={GROUP_HEADING}>
                  <MessageSquare className={GROUP_ICON} aria-hidden="true" />
                  <span className="trim-cap">Project managers</span>
                </h2>
                <div className="grid grid-cols-1">
                  {filtered.active.map((entry) => {
                    const key = conversationKey(computer.key, entry.id);
                    return (
                      <ProjectRow
                        key={entry.id}
                        deviceKey={computer.key}
                        entry={entry}
                        pageLayout={isPage}
                        active={isSelected(entry)}
                        waiting={waiting.has(key)}
                        asking={asking.has(key)}
                        readOnly={readOnly}
                        onSelect={onSelect}
                        onTogglePin={onTogglePin}
                      />
                    );
                  })}
                </div>
              </section>
            )}

            {filtered.archived.length > 0 && filtered.pinned.length + filtered.active.length > 0 && <GroupGroove />}
            {filtered.archived.length > 0 && (
              <section aria-label="Archived" className="min-w-0">
                <button
                  type="button"
                  aria-expanded={showArchived}
                  onClick={() => setArchivedOpen((open) => !open)}
                  className={cn(GROUP_HEADING, "pointer-coarse:min-h-11 w-full cursor-pointer rounded-sm text-left outline-none hover:bg-list-hover focus-visible:outline-2 focus-visible:outline-border-focus")}
                >
                  <ChevronRight className={cn(GROUP_ICON, "transition-transform", showArchived && "rotate-90")} aria-hidden="true" />
                  <span className="trim-cap">Archived</span>
                  <span className="trim-cap ml-auto text-xs tabular-nums">{filtered.archived.length}</span>
                </button>
                {showArchived && (
                  <div className="grid grid-cols-1">
                    {filtered.archived.map((entry) => {
                      const key = conversationKey(computer.key, entry.id);
                      return (
                        <ProjectRow
                          key={entry.id}
                          deviceKey={computer.key}
                          entry={entry}
                          pageLayout={isPage}
                          active={isSelected(entry)}
                          waiting={waiting.has(key)}
                          asking={asking.has(key)}
                          readOnly={readOnly}
                          onSelect={onSelect}
                          onTogglePin={onTogglePin}
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
