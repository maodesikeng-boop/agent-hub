import type { ConversationId, PmId } from "../shared/index.ts";
import type { ProfilePage, Route, ScopedRoute } from "./route.ts";

// Invariant: on the desktop the route alone decides Worker and Profile content; Pieces is the only content held outside the route.

export type SidePanelContent =
  | { kind: "pieces" }
  | { kind: "worker"; workerId: ConversationId }
  | { kind: "profile"; pmId: PmId; page: ProfilePage | null };

export interface SidePanelInput {
  route: Route | null;
  /** Pieces is open for the active PM, by itself while something needs you or by the user's toggle. */
  piecesOpen: boolean;
  /** The active PM has asks, Task Graphs, or Pieces to list. */
  piecesHasContent: boolean;
}

export interface PanelExits {
  /** Where the close button goes. */
  close: ScopedRoute;
  /** Where the back arrow goes, or null when the header has no back arrow. */
  back: ScopedRoute | null;
  /** Going back also opens Pieces. */
  backOpensPieces: boolean;
}

/**
 * Postcondition: a worker route gives that Worker, a profile route gives that PM's page or summary, a conversation route
 * gives Pieces only when piecesOpen and piecesHasContent, and the Router, settings, or no route give null.
 */
export function sidePanelOf({ route, piecesOpen, piecesHasContent }: SidePanelInput): SidePanelContent | null {
  if (route === null || route.view === "router" || route.view === "settings") return null;
  if (route.view === "worker") return { kind: "worker", workerId: route.id };
  if (route.view === "profile") return { kind: "profile", pmId: route.pmId, page: route.page ?? null };
  return piecesOpen && piecesHasContent ? { kind: "pieces" } : null;
}

/**
 * Precondition: conversation is the active PM conversation on the same computer as the panel content.
 * Postcondition: close is the conversation route. back is the conversation route with backOpensPieces for a Worker,
 * the profile summary for a profile page, and null for Pieces and for the summary.
 */
export function panelExitsOf(
  content: SidePanelContent,
  conversation: Extract<ScopedRoute, { view: "conversation" }>,
): PanelExits {
  const onDevice = conversation.device === undefined ? {} : { device: conversation.device };
  if (content.kind === "worker") {
    return { close: conversation, back: conversation, backOpensPieces: true };
  }
  if (content.kind === "profile" && content.page !== null) {
    return { close: conversation, back: { view: "profile", pmId: content.pmId, ...onDevice }, backOpensPieces: false };
  }
  return { close: conversation, back: null, backOpensPieces: false };
}
