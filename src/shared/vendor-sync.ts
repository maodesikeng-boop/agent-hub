import type { AgentVendor } from "./vendors.ts";

export type McpTransportKind = "stdio" | "http" | "sse";

export type VendorSyncItemVendorStatus =
  | "present"
  | "will_add"
  | "kept"
  | "mcp_remote"
  | "native"
  | "symlink"
  | "will_link"
  | "conflict";

export interface VendorSyncVendorBadge {
  vendor: AgentVendor;
  label: string;
  status: VendorSyncItemVendorStatus;
}

export interface VendorSyncHostBound {
  app?: string;
  sources: Array<{ vendor: AgentVendor; label: string }>;
  reason: string;
}

export interface VendorSyncMcpPreviewItem {
  key: string;
  name: string;
  transport: McpTransportKind;
  maskedTarget: string;
  maskedAuth: string[];
  usesMcpRemoteBridge: boolean;
  hostBound?: VendorSyncHostBound;
  vendors: VendorSyncVendorBadge[];
}

export interface VendorSyncSkillPreviewItem {
  key: string;
  name: string;
  scope: "global" | "project";
  projectLabel?: string;
  sourcePath: string;
  vendors: VendorSyncVendorBadge[];
}

export interface VendorSyncNonSyncableItem {
  key: string;
  name: string;
  vendor: AgentVendor;
  vendorLabel: string;
  kind: "cloud_connector" | "oauth_mcp";
  reason: string;
}

export interface VendorSyncPreviewResponse {
  scannedAt: number;
  mcpServers: VendorSyncMcpPreviewItem[];
  skills: VendorSyncSkillPreviewItem[];
  nonSyncable: VendorSyncNonSyncableItem[];
  truncated: boolean;
  hostBoundConfirmSupported?: boolean;
}

export interface VendorSyncApplyRequest {
  selectedMcpKeys: string[];
  removeMcpKeys: string[];
  selectedSkillKeys: string[];
  removeSkillKeys: string[];
  confirmedHostBoundMcpKeys?: string[];
}

export interface VendorSyncApplyResponse {
  backupId: string | null;
  syncedMcpCount: number;
  removedMcpCount: number;
  linkedSkillCount: number;
  unlinkedSkillCount: number;
  preservedPrivateSkillCount: number;
  updatedFiles: number;
}
