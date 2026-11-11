// Router（总助）共用契约与数据形状（docs/router-design.md §3.3、§6.3）。

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
  createdAt: number;
  updatedAt: number;
}

export type RouterItem = RouterDecisionItem | RouterReportItem;

export interface RouterPmNote {
  pmId: PmId;
  text: string;
  updatedAt: number;
}

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

export interface RouterAgentPlan {
  intent: "dispatch" | "answer" | "ambiguous";
  reply: string;
  actions: RouterAction[];
}

export interface RouterCommandDispatchedTarget {
  deviceId: string;
  pmId: PmId;
  messageId: MessageId;
  ok: boolean;
  error?: string;
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
  /** 当前活跃项（pending + unread），按 createdAt DESC, id DESC，上限 ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX。 */
  items: RouterItem[];
  notes: RouterPmNote[];
  /** 本机最近 ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX 条；经 deviceToken 跨机访问时为空数组。 */
  commands: RouterCommandRecord[];
}

export interface PmDigestActiveWorker {
  id: WorkerId;
  title: string;
  activity: SessionActivity;
  lastSummary: string | null;
}

export interface PmDigestEntry {
  pmId: PmId;
  name: string;
  mode: PmMode;
  vendor: AgentVendor;
  model: string | null;
  activity: SessionActivity;
  project: {
    id: ProjectId;
    name: string;
    description: string | null;
    mainFolder: string;
    otherFolders: string[];
  } | null;
  personaSummary: string;
  pmNote: string | null;
  activeWorkers: PmDigestActiveWorker[];
  activeWorkerTotal: number;
  pendingDecisionCount: number;
  recentBrief: string | null;
  lastActiveAt: number | null;
}

export interface DeviceRouterDigest {
  generatedAt: number;
  pms: PmDigestEntry[];
}

export function defaultRouterSettings(): RouterSettings {
  return { vendor: null, model: null, effort: null, updatedAt: 0 };
}

export function emptyRouterSlice(): RouterSlice {
  return {
    settings: defaultRouterSettings(),
    items: [],
    notes: [],
    commands: [],
  };
}
