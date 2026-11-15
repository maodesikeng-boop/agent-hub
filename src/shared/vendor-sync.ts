// 跨厂商（连接器 / MCP / Skill）扫描预览与一键并集同步的共享接口类型。
// 纯类型定义，网页与守护进程共用，绝不写死任何具体厂商 ID。
import type { AgentVendor } from "./vendors.ts";

export type McpTransportKind = "stdio" | "http" | "sse";

export type VendorSyncItemVendorStatus =
  | "present"
  | "will_add"
  /** 这家已有同名配置但内容不同（或是本家私有 OAuth 项）：并集只增补，原样保留不覆盖。 */
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

/** 别家应用自带的 MCP：离开所在应用就起不来，默认不勾选、不往别家补（用户可手动勾上）。 */
export interface VendorSyncHostBound {
  /** 命令所在的应用名（如 `ChatGPT`）；只靠宿主透传环境变量判断时没有。 */
  app?: string;
  /** 持有这条配置的厂商（来源）。 */
  sources: Array<{ vendor: AgentVendor; label: string }>;
  /** 面向界面的清晰英文原因。 */
  reason: string;
}

export interface VendorSyncMcpPreviewItem {
  /** 稳定键名（即 MCP server 名称）。 */
  key: string;
  name: string;
  transport: McpTransportKind;
  /** 已脱敏的命令或远程地址摘要（环境变量、Header 与 URL 查询参数中的密钥均已打码）。 */
  maskedTarget: string;
  /** 已脱敏的环境变量或 Header 条目摘要（如 `API_KEY=••••`）。 */
  maskedAuth: string[];
  /** 是否存在仅支持 HTTP/stdio 的目标厂商需要自动包一层 `npx -y mcp-remote <url>`。 */
  usesMcpRemoteBridge: boolean;
  /** 有值表示这是别家应用自带的 MCP：默认不勾选；不勾选只表示「不往别家补」，绝不会从源头删掉。 */
  hostBound?: VendorSyncHostBound;
  /** 各厂商当前状态与同步计划（纯数据驱动渲染）。 */
  vendors: VendorSyncVendorBadge[];
}

export interface VendorSyncSkillPreviewItem {
  /** 稳定键名：`global:<name>` 或 `project:<folderPath>:<name>`。 */
  key: string;
  name: string;
  scope: "global" | "project";
  /** `scope === "project"` 时所属项目显示名或目录名。 */
  projectLabel?: string;
  /** 基准源目录（`~/.agents/skills/<name>` 或 `<project>/.agents/skills/<name>`）。 */
  sourcePath: string;
  /** 各厂商读取或软链状态（纯数据驱动渲染）。 */
  vendors: VendorSyncVendorBadge[];
}

export interface VendorSyncNonSyncableItem {
  key: string;
  name: string;
  vendor: AgentVendor;
  vendorLabel: string;
  kind: "cloud_connector" | "oauth_mcp";
  /** 面向界面的清晰英文说明（为何不可跨厂同步、不复制私密 OAuth 令牌）。 */
  reason: string;
}

export interface VendorSyncPreviewResponse {
  scannedAt: number;
  mcpServers: VendorSyncMcpPreviewItem[];
  skills: VendorSyncSkillPreviewItem[];
  nonSyncable: VendorSyncNonSyncableItem[];
  truncated: boolean;
  /** 新版守护进程标记支持 `confirmedHostBoundMcpKeys` 二次确认校验（兼容未升级的远端守护进程 `.strict()` 请求体）。 */
  hostBoundConfirmSupported?: boolean;
}

export interface VendorSyncApplyRequest {
  /** 勾选要并集同步到各家的 MCP 键名列表。 */
  selectedMcpKeys: string[];
  /** 在预览窗手动取消勾选、需主动从各家全局移除的 MCP 键名列表。别家应用自带的 MCP（`hostBound`）永远不会被移除，传了也忽略。 */
  removeMcpKeys: string[];
  /** 勾选要建立逐项软链的基准 Skill 键名列表。 */
  selectedSkillKeys: string[];
  /** 在预览窗手动取消勾选、需清理受管软链（保留用户私有技能）的 Skill 键名列表。 */
  removeSkillKeys: string[];
  /** 用户在预览里已看到 `hostBound` 标注并显式打开开关同意同步的 MCP 键名列表；防止预览后普通项半途变成 `hostBound` 被盲目同步。 */
  confirmedHostBoundMcpKeys?: string[];
}

export interface VendorSyncApplyResponse {
  /** 本次产生落盘变更时生成的轮转备份目录名（无文件改动时为 null）。 */
  backupId: string | null;
  syncedMcpCount: number;
  removedMcpCount: number;
  linkedSkillCount: number;
  unlinkedSkillCount: number;
  preservedPrivateSkillCount: number;
  updatedFiles: number;
}
