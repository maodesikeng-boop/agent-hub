import type * as React from "react";
import type { Pm, Project, ProjectFolder, ScheduleRecord } from "../../shared/index.ts";
import type { ProfilePage } from "../route.ts";

export interface ProfilePanelProps {
  /** panel: inside the desktop side panel; page: a full-screen phone page. */
  variant: "panel" | "page";
  pm: Pm;
  project: Project | null;
  folders: ProjectFolder[];
  schedules: ScheduleRecord[];
  rev: number;
  renewing: boolean;
  /** null shows the summary. */
  page: ProfilePage | null;
  /** The PM's computer is offline: every edit and the pin toggle are disabled. */
  readOnly: boolean;
  onNavigate: (page: ProfilePage | null) => void;
  onClose: () => void;
  onTogglePin: (pinned: boolean) => void;
  onManageProviders?: () => void;
  /** Opens the Project defaults editor from the Capabilities page. */
  onEditDefaults?: () => void;
}

/**
 * Postcondition: the summary shows the PM's tile, name, and project with Pinned, New session..., and the ... menu holding
 * Archive..., then Model, Mode, Folders, and Schedules sections whose Edit or New swaps in the existing editor in place,
 * then rows that open the capabilities, persona, memory, worktree, and history pages; a page shows a back arrow to the
 * summary. Archived PMs show the restore group and no Pinned button.
 */
export function ProfilePanel(_props: ProfilePanelProps): React.ReactElement {
  throw new Error("Not implemented");
}
