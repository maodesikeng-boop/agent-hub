import type { ConversationId, PmId } from "../shared/index.ts";
import type { InfoPage } from "./info-rows.ts";
import type { Route, ScopedRoute } from "./route.ts";
import type { WorkPanelTab } from "./work-panel-model.ts";

// Invariant: on desktop, Worker and Info live in the route while Active/Completed live in panel open state + remembered tab.

export type WorkPanelContent =
  | { kind: "tab"; tab: Exclude<WorkPanelTab, "info"> }
  | { kind: "info"; pmId: PmId; page: InfoPage | null }
  | { kind: "worker"; workerId: ConversationId };

export interface WorkPanelInput {
  route: Route | null;
  /** The user has the panel open on the conversation route; the toggle and the auto-open rule set it. */
  open: boolean;
  /** Last Active or Completed tab the user picked, persisted per browser. */
  tab: Exclude<WorkPanelTab, "info">;
}

export function workPanelOf({ route, open, tab }: WorkPanelInput): WorkPanelContent | null {
  if (route === null || route.view === "router" || route.view === "settings") return null;
  if (route.view === "worker") return { kind: "worker", workerId: route.id };
  if (route.view === "profile") return { kind: "info", pmId: route.pmId, page: route.page ?? null };
  return open ? { kind: "tab", tab } : null;
}

export interface WorkPanelExits {
  close: ScopedRoute;
  /** Where the back arrow goes, or null when the header shows tabs instead. */
  back: ScopedRoute | null;
}

export function workPanelExitsOf(
  content: WorkPanelContent,
  conversation: Extract<ScopedRoute, { view: "conversation" }>,
): WorkPanelExits {
  const onDevice = conversation.device === undefined ? {} : { device: conversation.device };
  if (content.kind === "worker") {
    return { close: conversation, back: conversation };
  }
  if (content.kind === "info" && content.page !== null) {
    return { close: conversation, back: { view: "profile", pmId: content.pmId, ...onDevice } };
  }
  return { close: conversation, back: null };
}
