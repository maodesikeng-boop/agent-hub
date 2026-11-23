import type * as React from "react";
import type { PmId } from "../../shared/index.ts";
import type { DeviceKey, DeviceStatus } from "../devices.ts";
import type { ConversationRef } from "../notify.ts";
import type { ConversationEntry } from "../selectors.ts";

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
  onSelect: (ref: ConversationRef) => void;
  onNewPm: () => void;
  onTogglePin: (pmId: PmId, pinned: boolean) => void;
  /** Row shortcut to the PM's settings in the side panel. */
  onOpenPmSettings: (pmId: PmId) => void;
  onOpenComputers: () => void;
}

/**
 * Postcondition: renders the header, search, and the Pinned, Project managers, and collapsed Archived groups from
 * projectListOf; the strip shows avatars only, pinned ones above a divider; row shortcuts appear on hover and keyboard
 * focus on hover-capable pointers and never on touch screens.
 */
export function ProjectList(_props: ProjectListProps): React.ReactElement {
  throw new Error("Not implemented");
}
