import type { ReactNode } from "react";
import type { ShellContent, ShellModel } from "./components/WorkPanelShell.tsx";
import type { SurfaceSet } from "./surface-set.ts";

export type ShellLayout = "columns" | "single";

/** Props that differ per layout around a surface's content. Changing them rerenders a surface and never remounts it. */
export interface SurfaceChrome {
  /** The one-column Back button in the conversation header. */
  conversationLeading?: ReactNode;
  /** The work panel toggle in the conversation header. */
  conversationToolbar?: ReactNode;
  /** side or stack beside the conversation in columns; page in one column. */
  panelLayout: "side" | "stack" | "page";
  onClosePanel: () => void;
  onBackFromPanel: () => void;
}

export interface WorkbenchSurfacesProps {
  model: ShellModel;
  content: ShellContent;
  set: SurfaceSet;
  /** Passed through as props such as mobile; never decides which surfaces render. */
  layout: ShellLayout;
  chrome: SurfaceChrome;
  notices: ReactNode;
  onManageLocalProviders: () => void;
  onManageCurrentProviders: () => void;
}

/**
 * Precondition: inside the SurfaceScope, after the active layout in tree order.
 * Postcondition: renders one Surface for each entry in set, keyed by the set's keys: list, router, conversation, panel, worker,
 * and the shared settings bodies. Switching layout or chrome rerenders surfaces in place.
 */
export function WorkbenchSurfaces(_props: WorkbenchSurfacesProps): ReactNode {
  throw new Error("Not implemented");
}
