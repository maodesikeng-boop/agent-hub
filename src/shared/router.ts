import type {
  ConversationId,
  MessageId,
  PmId,
  PmMode,
  ProjectId,
  RouterCommandId,
  RouterItemId,
  SessionActivity,
  WorkerId,
} from "./domain.ts";
import type { Deliverable } from "./deliverables.ts";
import type { ProjectCatalogCard } from "./project-catalog.ts";
import type { AgentVendor } from "./vendors.ts";

export interface RouterSettings {
  vendor: AgentVendor | null;
  model: string | null;
  effort: string | null;
  updatedAt: number;
}

export const ROUTER_RESOLUTION_ACTORS = ["router", "conversation"] as const;
export type RouterResolutionActor = (typeof ROUTER_RESOLUTION_ACTORS)[number];

export interface RouterResolution {
  chosenIndex: number | null;
  chosenOption: string | null;
  note: string;
  actor: RouterResolutionActor;
  resolvedAt: number;
  clientId?: string;
}

export interface RouterReportLink {
  label: string;
  target: string;
}

export const ROUTER_DECISION_STATUSES = ["pending", "resolved", "superseded"] as const;
export type RouterDecisionStatus = (typeof ROUTER_DECISION_STATUSES)[number];

export const ROUTER_REPORT_STATUSES = ["unread", "archived"] as const;
export type RouterReportStatus = (typeof ROUTER_REPORT_STATUSES)[number];

export interface RouterDecisionItem {
  id: RouterItemId;
  kind: "decision";
  status: RouterDecisionStatus;
  pmId: PmId;
  projectId: ProjectId | null;
  conversationId: ConversationId;
  question: string;
  context: string;
  options: string[];
  askMessageId: MessageId | null;
  resolution: RouterResolution | null;
  deliverables?: Deliverable[];
  createdAt: number;
  updatedAt: number;
}

export interface RouterReportItem {
  id: RouterItemId;
  kind: "report";
  status: RouterReportStatus;
  pmId: PmId;
  projectId: ProjectId | null;
  conversationId: ConversationId;
  summary: string;
  links: RouterReportLink[];
  deliverables?: Deliverable[];
  createdAt: number;
  updatedAt: number;
}

export type RouterItem = RouterDecisionItem | RouterReportItem;

export type RouterAction =
  | {
      type: "dispatch";
      deviceId: string;
      pmId: PmId;
      message: string;
      summary: string;
      risk: "low" | "high";
      riskReason?: string;
    }
  | {
      type: "answer";
      markdown: string;
    };

export interface PostRouterCommandTarget {
  deviceId?: string;
  pmId?: PmId;
  projectId?: ProjectId;
}

export interface RouterCommandAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface RouterAgentPlan {
  intent: "dispatch" | "answer" | "ambiguous";
  reply: string;
  actions: RouterAction[];
  track?: "A" | "B";
  attachmentIds?: string[];
  retryOps?: Array<{ deviceId: string; op: unknown }>;
  attachments?: RouterCommandAttachment[];
  target?: PostRouterCommandTarget;
  /** Kept so a retry also skips the leading-`@` direct forward. */
  routerOnly?: true;
  replyTruncated?: true;
  errorRaw?: string;
}

export type RouterDispatchedOpKind =
  | "pm.forward"
  | "worker.start"
  | "worker.send"
  | "worker.stop"
  | "worker.end"
  | "worker.list"
  | "project.create";

export interface RouterCommandDispatchedTarget {
  deviceId: string;
  pmId: PmId;
  messageId: MessageId;
  ok: boolean;
  error?: string;
  op?: RouterDispatchedOpKind;
  deviceName?: string;
  pmName?: string;
  projectId?: ProjectId | null;
  projectName?: string | null;
  conversationId?: ConversationId;
  workerId?: WorkerId;
  workerConversationId?: ConversationId;
  title?: string;
  readonly?: boolean;
  verbatim?: boolean;
}

export const ROUTER_COMMAND_STATUSES = [
  "planning",
  "needs_confirm",
  "dispatched",
  "answered",
  "failed",
  "cancelled",
] as const;
export type RouterCommandStatus = (typeof ROUTER_COMMAND_STATUSES)[number];

export interface RouterCommandRecord {
  id: RouterCommandId;
  clientId: string;
  inputText: string;
  vendor: AgentVendor;
  model: string | null;
  effort: string | null;
  status: RouterCommandStatus;
  plan: RouterAgentPlan | null;
  dispatched: RouterCommandDispatchedTarget[] | null;
  error: string | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RouterSlice {
  settings: RouterSettings;
  items: RouterItem[];
  briefingsHasMore: boolean;
  commands: RouterCommandRecord[];
  commandsHasMore: boolean;
}

export interface PmDigestActiveWorker {
  id: WorkerId;
  title: string;
  activity: SessionActivity;
  lastSummary: string | null;
  readonly?: boolean;
}

export interface PmDigestEntry {
  pmId: PmId;
  name: string;
  mode: PmMode;
  vendor: AgentVendor;
  model: string | null;
  conversationId?: ConversationId;
  activity: SessionActivity;
  project: {
    id: ProjectId;
    name: string;
    description: string | null;
    mainFolder: string;
    otherFolders: string[];
    catalog?: ProjectCatalogCard | null;
  } | null;
  activeWorkers: PmDigestActiveWorker[];
  activeWorkerTotal: number;
  pendingDecisionCount: number;
  recentBrief: string | null;
  lastActiveAt: number | null;
}

export interface DeviceRouterDigest {
  generatedAt: number;
  pms: PmDigestEntry[];
  omittedPms?: number;
}

export function defaultRouterSettings(): RouterSettings {
  return { vendor: null, model: null, effort: null, updatedAt: 0 };
}

export function emptyRouterSlice(): RouterSlice {
  return {
    settings: defaultRouterSettings(),
    items: [],
    briefingsHasMore: false,
    commands: [],
    commandsHasMore: false,
  };
}

export const ROUTER_DISPATCH_AGENT_PATH = "/v1/router.dispatch";

export type RouterAgentDispatchInput =
  | {
      op: "pm";
      device: string;
      pmId?: PmId;
      projectId?: ProjectId;
      verbatim?: boolean;
      text?: string;
    }
  | {
      op: "worker-start";
      device: string;
      projectId: ProjectId;
      title: string;
      vendor?: AgentVendor;
      model?: string;
      effort?: string;
      readonly?: boolean;
      noWorktree?: boolean;
      verbatim?: boolean;
      task?: string;
    }
  | {
      op: "worker-stop";
      device: string;
      workerId: WorkerId;
    }
  | {
      op: "worker-send";
      device: string;
      workerId: WorkerId;
      verbatim?: boolean;
      text?: string;
    }
  | {
      op: "worker-end";
      device: string;
      workerId: WorkerId;
    }
  | {
      op: "worker-list";
      device: string;
      projectId?: ProjectId;
    }
  | {
      op: "project-show";
      device: string;
      projectId: ProjectId;
    }
  | {
      op: "project-create";
      device: string;
      folder: string;
      name?: string;
      pmName?: string;
      vendor?: AgentVendor;
      mode?: PmMode;
    };

