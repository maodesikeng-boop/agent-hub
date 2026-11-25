import type * as React from "react";
import type { Pm, Project, ProjectFolder, ScheduleRecord } from "../../shared/index.ts";
import type { InfoPage } from "../info-rows.ts";

export interface InfoTabProps {
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  rev: number;
  renewing: boolean;
  /** null shows the summary rows. */
  page: InfoPage | null;
  /** The PM's computer is offline: every edit is disabled. */
  readOnly: boolean;
  onNavigate: (page: InfoPage | null) => void;
  /** After Archive succeeds. */
  onArchived: () => void;
  onManageProviders?: () => void;
  onEditDefaults?: () => void;
}

/**
 * Postcondition: the summary shows the 44px avatar with no frame (hover shows a pencil badge; clicking opens the look
 * picker), the 16px name and the muted project name, the two row groups from infoRowsOf, and the `New session` and red
 * `Archive` text actions; an archived PM shows the existing archive status group instead of Archive. A page renders the
 * existing editor for that page (AgentRows, ModeRows, folders list, ScheduleGroup, CapabilitiesPanel, persona editor,
 * PmMemoryFilesGroup, WorktreeSetupGroup, history list).
 */
export function InfoTab(_props: InfoTabProps): React.ReactElement {
  throw new Error("Not implemented");
}
