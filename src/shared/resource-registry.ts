// Invariant: every persistent table, managed data-directory path, temp root, worktree, branch, log, and child process class appears in RESOURCE_REGISTRY with a named owner, cleaner, and bound.
import {
  ACTIONS_TERMINAL_MAX_ROWS,
  ACTIONS_TERMINAL_RETENTION_DAYS,
  BRANCH_MERGED_RETENTION_DAYS,
  BRANCH_UNMERGED_HOLD_DAYS,
  CHECKLIST_MAX_ITEMS,
  COMPLETED_GRAPHS_MAX_ROWS,
  COMPLETED_GRAPH_RETENTION_DAYS,
  DAEMON_LOG_MAX_BYTES,
  ENDED_WORKER_STEPS_KEEP,
  FEISHU_DECISIONS_MAX_ROWS,
  FEISHU_INBOUND_CURSORS_MAX,
  FEISHU_INBOUND_RECEIPTS_MAX,
  FEISHU_INBOUND_RECEIPTS_TTL_MS,
  FEISHU_INBOUND_STATE_MAX_BYTES,
  FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE,
  FEISHU_OFFLINE_INBOX_TTL_MS,
  FEISHU_POSTS_MAX_ROWS,
  FEISHU_POST_RETENTION_DAYS,
  FEISHU_ROUTER_EVENTS_MAX_ROWS,
  FEISHU_ROUTER_EVENTS_TTL_MS,
  FILE_BYTE_CAP_MIN_AGE_DAYS,
  FILE_RETENTION_DAYS,
  HANDOVERS_MAX_PER_CONV,
  HANDOVERS_RETENTION_DAYS,
  HUB_CALLS_MAX_ROWS,
  HUB_CALLS_RETENTION_DAYS,
  HUB_CALL_RESULT_MAX_BYTES,
  MANAGED_BRANCHES_MERGED_MAX,
  MAX_BROWSER_SESSIONS,
  MAX_DB_BACKUPS,
  MAX_PERSONA_BYTES,
  MAX_PUSH_SUBSCRIPTIONS,
  MAX_VENDOR_SYNC_BACKUPS,
  MESH_MAX_DEVICES_PER_ACCOUNT,
  PERSONA_CHANGES_LIMIT,
  PM_MEMORY_MAX_TOTAL_BYTES,
  PM_TOOL_MESSAGES_MAX_PER_CONV,
  PM_TOOL_MESSAGE_RETENTION_DAYS,
  CHECKLIST_REMINDER_RETENTION_DAYS,
  CHECKLIST_REMINDERS_MAX_ROWS,
  PROCESS_LEDGER_MAX_ENTRIES,
  PROVIDER_SECRETS_FILE_MAX_BYTES,
  RESOURCE_DECISIONS_MAX_ROWS,
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_AUDIT_LOG_RETENTION_DAYS,
  ROUTER_COMMANDS_RETENTION_DAYS,
  ROUTER_COMMANDS_RETENTION_MAX,
  ROUTER_COMMAND_MAX_RETRIES,
  ROUTER_MAX_DISPATCH_TARGETS,
  ROUTER_ITEMS_TERMINAL_MAX_ROWS,
  ROUTER_ITEM_RETENTION_DAYS,
  SANDBOX_APPROVALS_RETENTION_DAYS,
  APP_APPROVALS_RETENTION_DAYS,
  APP_APPROVALS_TERMINAL_MAX_ROWS,
  SANDBOX_APPROVALS_TERMINAL_MAX_ROWS,
  SENT_FILES_DISK_MAX_BYTES,
  SENT_FILES_RETENTION_DAYS,
  SESSION_MAX_AGE_MS,
  SESSION_STEPS_KEEP,
  SESSION_TAG_MAX_DEPTH,
  SESSION_TMP_ORPHAN_RETENTION_MS,
  SETUP_LOGS_MAX_FILES,
  SETUP_LOGS_RETENTION_DAYS,
  SETUP_LOG_MAX_BYTES,
  SKILL_CARRYOVER_RECORDS_MAX,
  TURN_COMPLETION_UNPERSISTED_MAX,
  UPLOADS_DISK_MAX_BYTES,
  USER_BLOCKERS_RESOLVED_KEEP,
  WORKER_RETENTION_DAYS,
  WORKER_RETENTION_MAX_ENDED,
  WORKTREE_CLEANUP_BATCH_LIMIT,
  WORKTREE_RETENTION_DAYS,
} from "./limits.ts";

export type ResourceKind =
  | "sqlite_table"
  | "data_dir"
  | "process"
  | "worktree"
  | "git_branch"
  | "temp_dir"
  | "log_file";

export type ResourceGrowthClass = "growing" | "bounded_config" | "retained_metadata" | "transient";

export type ResourceCleanupMode = "automatic" | "automatic_or_hold" | "on_archive_or_delete" | "overwrite" | "removed_by_creator";

export interface ResourceLimitRef {
  readonly constantName: string;
  readonly value: number;
  readonly unit: "rows" | "bytes" | "ms" | "days" | "files" | "entries" | "branches" | "workers";
}

export interface ResourceRegistryEntry {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly target: string;
  readonly growth: ResourceGrowthClass;
  readonly owner: string;
  readonly cleaner: string;
  readonly cleanupMode: ResourceCleanupMode;
  readonly limits: readonly ResourceLimitRef[];
}

export interface ResourceRegistryValidationInput {
  readonly sqliteTables: readonly string[];
  readonly hubPathKeys: readonly string[];
  readonly exportedLimitNames: ReadonlySet<string>;
}

export interface ResourceRegistryViolation {
  readonly code:
    | "unregistered_table"
    | "stale_table"
    | "unregistered_path"
    | "duplicate_id"
    | "missing_cleaner"
    | "missing_limit"
    | "unknown_limit_constant"
    | "non_positive_limit";
  readonly target: string;
  readonly detail: string;
}

const limit = (
  constantName: string,
  value: number,
  unit: ResourceLimitRef["unit"],
): ResourceLimitRef => ({ constantName, value, unit });

const table = (
  target: string,
  growth: ResourceGrowthClass,
  owner: string,
  cleaner: string,
  cleanupMode: ResourceCleanupMode,
  limits: readonly ResourceLimitRef[] = [],
): ResourceRegistryEntry => ({
  id: `table:${target}`,
  kind: "sqlite_table",
  target,
  growth,
  owner,
  cleaner,
  cleanupMode,
  limits,
});

const pathEntry = (
  target: string,
  kind: "data_dir" | "worktree" | "log_file",
  growth: ResourceGrowthClass,
  owner: string,
  cleaner: string,
  cleanupMode: ResourceCleanupMode,
  limits: readonly ResourceLimitRef[] = [],
): ResourceRegistryEntry => ({
  id: `path:${target}`,
  kind,
  target,
  growth,
  owner,
  cleaner,
  cleanupMode,
  limits,
});

const WORKER_RETENTION_LIMITS: readonly ResourceLimitRef[] = [
  limit("WORKER_RETENTION_DAYS", WORKER_RETENTION_DAYS, "days"),
  limit("WORKER_RETENTION_MAX_ENDED", WORKER_RETENTION_MAX_ENDED, "workers"),
];

const GRAPH_RETENTION_LIMITS: readonly ResourceLimitRef[] = [
  limit("COMPLETED_GRAPH_RETENTION_DAYS", COMPLETED_GRAPH_RETENTION_DAYS, "days"),
  limit("COMPLETED_GRAPHS_MAX_ROWS", COMPLETED_GRAPHS_MAX_ROWS, "rows"),
];

const ROUTER_ITEM_LIMITS: readonly ResourceLimitRef[] = [
  limit("ROUTER_ITEM_RETENTION_DAYS", ROUTER_ITEM_RETENTION_DAYS, "days"),
  limit("ROUTER_ITEMS_TERMINAL_MAX_ROWS", ROUTER_ITEMS_TERMINAL_MAX_ROWS, "rows"),
];

const USER_BLOCKER_LIMITS: readonly ResourceLimitRef[] = [
  limit("USER_BLOCKERS_RESOLVED_KEEP", USER_BLOCKERS_RESOLVED_KEEP, "rows"),
];

const SANDBOX_APPROVAL_LIMITS: readonly ResourceLimitRef[] = [
  limit("SANDBOX_APPROVALS_RETENTION_DAYS", SANDBOX_APPROVALS_RETENTION_DAYS, "days"),
  limit("SANDBOX_APPROVALS_TERMINAL_MAX_ROWS", SANDBOX_APPROVALS_TERMINAL_MAX_ROWS, "rows"),
];

const APP_APPROVAL_LIMITS: readonly ResourceLimitRef[] = [
  limit("APP_APPROVALS_RETENTION_DAYS", APP_APPROVALS_RETENTION_DAYS, "days"),
  limit("APP_APPROVALS_TERMINAL_MAX_ROWS", APP_APPROVALS_TERMINAL_MAX_ROWS, "rows"),
];

const SQLITE_TABLE_ENTRIES: readonly ResourceRegistryEntry[] = [
  table("messages", "growing", "src/daemon/ledger/messages.ts, src/daemon/ledger/checklist-reminders.ts", "src/daemon/ledger/worker-retention.ts, src/daemon/ledger/db-table-retention.ts", "automatic", [
    ...WORKER_RETENTION_LIMITS,
    limit("PM_TOOL_MESSAGE_RETENTION_DAYS", PM_TOOL_MESSAGE_RETENTION_DAYS, "days"),
    limit("PM_TOOL_MESSAGES_MAX_PER_CONV", PM_TOOL_MESSAGES_MAX_PER_CONV, "rows"),
    limit("CHECKLIST_REMINDER_RETENTION_DAYS", CHECKLIST_REMINDER_RETENTION_DAYS, "days"),
    limit("CHECKLIST_REMINDERS_MAX_ROWS", CHECKLIST_REMINDERS_MAX_ROWS, "rows"),
  ]),
  table("session_steps", "growing", "src/daemon/ledger/steps.ts", "src/daemon/ledger/steps.ts, src/daemon/ledger/worker-retention.ts, src/daemon/ledger/db-table-retention.ts", "automatic", [
    limit("SESSION_STEPS_KEEP", SESSION_STEPS_KEEP, "rows"),
    limit("ENDED_WORKER_STEPS_KEEP", ENDED_WORKER_STEPS_KEEP, "rows"),
    ...WORKER_RETENTION_LIMITS,
  ]),
  table("actions", "growing", "src/daemon/actions/store.ts", "src/daemon/ledger/worker-retention.ts, src/daemon/ledger/db-table-retention.ts", "automatic", [
    limit("ACTIONS_TERMINAL_RETENTION_DAYS", ACTIONS_TERMINAL_RETENTION_DAYS, "days"),
    limit("ACTIONS_TERMINAL_MAX_ROWS", ACTIONS_TERMINAL_MAX_ROWS, "rows"),
  ]),
  table("hub_calls", "growing", "src/daemon/ledger/hub-commands.ts", "src/daemon/ledger/worker-retention.ts, src/daemon/ledger/db-table-retention.ts", "automatic", [
    limit("HUB_CALLS_RETENTION_DAYS", HUB_CALLS_RETENTION_DAYS, "days"),
    limit("HUB_CALLS_MAX_ROWS", HUB_CALLS_MAX_ROWS, "rows"),
    limit("HUB_CALL_RESULT_MAX_BYTES", HUB_CALL_RESULT_MAX_BYTES, "bytes"),
  ]),
  table("handovers", "growing", "src/daemon/ledger/handover.ts", "src/daemon/ledger/db-table-retention.ts, src/daemon/ledger/worker-retention.ts", "automatic", [
    limit("HANDOVERS_RETENTION_DAYS", HANDOVERS_RETENTION_DAYS, "days"),
    limit("HANDOVERS_MAX_PER_CONV", HANDOVERS_MAX_PER_CONV, "rows"),
  ]),
  table("persona_changes", "growing", "src/daemon/ledger/persona.ts", "src/daemon/ledger/db-table-retention.ts", "automatic", [
    limit("PERSONA_CHANGES_LIMIT", PERSONA_CHANGES_LIMIT, "rows"),
  ]),
  table("router_items", "growing", "src/daemon/ledger/router.ts", "src/daemon/ledger/router.ts", "automatic", ROUTER_ITEM_LIMITS),
  table("router_item_deliverables", "growing", "src/daemon/ledger/router.ts", "src/daemon/ledger/router.ts", "automatic", ROUTER_ITEM_LIMITS),
  table("router_commands", "growing", "src/daemon/ledger/router.ts", "src/daemon/ledger/router.ts", "automatic", [
    limit("ROUTER_COMMANDS_RETENTION_DAYS", ROUTER_COMMANDS_RETENTION_DAYS, "days"),
    limit("ROUTER_COMMANDS_RETENTION_MAX", ROUTER_COMMANDS_RETENTION_MAX, "rows"),
    limit("ROUTER_COMMAND_MAX_RETRIES", ROUTER_COMMAND_MAX_RETRIES, "entries"),
    limit("ROUTER_MAX_DISPATCH_TARGETS", ROUTER_MAX_DISPATCH_TARGETS, "entries"),
  ]),
  table("router_audit_log", "growing", "src/daemon/ledger/router.ts", "src/daemon/ledger/router.ts", "automatic", [
    limit("ROUTER_AUDIT_LOG_RETENTION_DAYS", ROUTER_AUDIT_LOG_RETENTION_DAYS, "days"),
    limit("ROUTER_AUDIT_LOG_MAX_ROWS", ROUTER_AUDIT_LOG_MAX_ROWS, "rows"),
  ]),
  table("task_graphs", "growing", "src/daemon/ledger/task-graphs.ts", "src/daemon/ledger/task-graphs/overview.ts", "automatic", GRAPH_RETENTION_LIMITS),
  table("task_graph_steps", "growing", "src/daemon/ledger/task-graphs.ts", "src/daemon/ledger/task-graphs/overview.ts", "automatic", GRAPH_RETENTION_LIMITS),
  table("task_graph_step_states", "growing", "migrations/0057_pm_agenda.sql", "src/daemon/ledger/task-graphs/overview.ts", "automatic", GRAPH_RETENTION_LIMITS),
  table("task_graph_edges", "growing", "src/daemon/ledger/task-graphs.ts", "src/daemon/ledger/task-graphs/overview.ts", "automatic", GRAPH_RETENTION_LIMITS),
  table("task_graph_step_capabilities", "growing", "src/daemon/ledger/task-graphs.ts", "src/daemon/ledger/task-graphs/overview.ts", "automatic", GRAPH_RETENTION_LIMITS),
  table("task_graph_step_sandbox", "growing", "src/daemon/ledger/task-graphs.ts", "src/daemon/ledger/task-graphs/overview.ts", "automatic", GRAPH_RETENTION_LIMITS),
  table("feishu_posts", "growing", "src/daemon/feishu/store.ts", "src/daemon/feishu/store.ts", "automatic", [
    limit("FEISHU_POST_RETENTION_DAYS", FEISHU_POST_RETENTION_DAYS, "days"),
    limit("FEISHU_POSTS_MAX_ROWS", FEISHU_POSTS_MAX_ROWS, "rows"),
  ]),
  table("feishu_decisions", "growing", "src/daemon/feishu/store.ts", "src/daemon/feishu/store.ts", "automatic", [
    limit("FEISHU_POST_RETENTION_DAYS", FEISHU_POST_RETENTION_DAYS, "days"),
    limit("FEISHU_DECISIONS_MAX_ROWS", FEISHU_DECISIONS_MAX_ROWS, "rows"),
  ]),
  table("feishu_router_events", "growing", "src/daemon/feishu/store.ts", "src/daemon/feishu/store.ts", "automatic", [
    limit("FEISHU_ROUTER_EVENTS_TTL_MS", FEISHU_ROUTER_EVENTS_TTL_MS, "ms"),
    limit("FEISHU_ROUTER_EVENTS_MAX_ROWS", FEISHU_ROUTER_EVENTS_MAX_ROWS, "rows"),
  ]),
  table("feishu_offline_inbox", "growing", "src/daemon/feishu/account-bot.ts", "src/daemon/feishu/account-bot.ts", "automatic", [
    limit("FEISHU_OFFLINE_INBOX_TTL_MS", FEISHU_OFFLINE_INBOX_TTL_MS, "ms"),
    limit("FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE", FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE, "rows"),
  ]),
  table("browser_sessions", "growing", "src/daemon/ui-server/sessions.ts", "src/daemon/ui-server/sessions.ts", "automatic", [
    limit("MAX_BROWSER_SESSIONS", MAX_BROWSER_SESSIONS, "rows"),
    limit("SESSION_MAX_AGE_MS", SESSION_MAX_AGE_MS, "ms"),
  ]),
  table("user_blockers", "growing", "src/daemon/ledger/user-blockers.ts", "src/daemon/ledger/user-blockers.ts", "automatic", USER_BLOCKER_LIMITS),
  table("user_blocker_cards", "growing", "src/daemon/ledger/user-blockers.ts", "src/daemon/ledger/user-blockers.ts", "automatic", USER_BLOCKER_LIMITS),
  table("user_blocker_steps", "growing", "src/daemon/ledger/user-blockers.ts", "src/daemon/ledger/user-blockers.ts", "automatic", USER_BLOCKER_LIMITS),
  table("user_blocker_workers", "growing", "src/daemon/ledger/user-blockers.ts", "src/daemon/ledger/user-blockers.ts", "automatic", USER_BLOCKER_LIMITS),
  table("worker_sandbox_approvals", "growing", "src/daemon/ledger/sandbox-approvals.ts", "src/daemon/ledger/sandbox-approvals.ts, src/daemon/ledger/db-table-retention.ts", "automatic", SANDBOX_APPROVAL_LIMITS),
  table("worker_app_approvals", "growing", "src/daemon/ledger/app-approvals.ts", "src/daemon/ledger/app-approvals.ts", "automatic", APP_APPROVAL_LIMITS),
  table("loaded_skills", "growing", "src/daemon/ledger/loaded-skills.ts", "src/daemon/ledger/loaded-skills.ts", "automatic", [
    limit("SKILL_CARRYOVER_RECORDS_MAX", SKILL_CARRYOVER_RECORDS_MAX, "rows"),
  ]),
  table("resource_decisions", "growing", "src/daemon/resources/decisions.ts", "src/daemon/resources/decisions.ts", "automatic", [
    limit("RESOURCE_DECISIONS_MAX_ROWS", RESOURCE_DECISIONS_MAX_ROWS, "rows"),
  ]),
  table("worker_background_waits", "growing", "src/daemon/ledger/workers.ts", "src/daemon/ledger/worker-retention.ts", "automatic", WORKER_RETENTION_LIMITS),
  table("worker_background_wait_details", "growing", "src/daemon/ledger/workers/ctx.ts", "src/daemon/ledger/worker-retention.ts", "automatic", WORKER_RETENTION_LIMITS),
  table("worker_turn_timeouts", "growing", "src/daemon/ledger/workers.ts", "src/daemon/ledger/worker-retention.ts", "automatic", WORKER_RETENTION_LIMITS),
  table("session_persona_seen", "growing", "src/daemon/ledger/persona.ts", "src/daemon/ledger/worker-retention.ts, src/daemon/ledger/router.ts", "automatic", WORKER_RETENTION_LIMITS),
  table("session_preamble_seen", "growing", "src/daemon/ledger/handover.ts", "src/daemon/ledger/worker-retention.ts", "automatic", WORKER_RETENTION_LIMITS),
  table("pm_agenda_cursors", "growing", "src/daemon/ledger/pm-agenda.ts", "src/daemon/ledger/worker-retention.ts", "automatic", WORKER_RETENTION_LIMITS),
  table("turn_completions", "growing", "src/daemon/ledger/turn-completions.ts", "src/daemon/ledger/turn-completions.ts", "automatic", [
    limit("TURN_COMPLETION_UNPERSISTED_MAX", TURN_COMPLETION_UNPERSISTED_MAX, "rows"),
  ]),
  table("turn_completion_watermarks", "retained_metadata", "src/daemon/ledger/turn-completions.ts", "src/daemon/ledger/persona.ts, src/daemon/ledger/router.ts", "on_archive_or_delete"),
  table("pms", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("pm_archives", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("pm_looks", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("pm_pins", "retained_metadata", "src/daemon/ledger/pm-pins.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("projects", "retained_metadata", "src/daemon/ledger/projects.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("project_folders", "retained_metadata", "src/daemon/ledger/projects.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("project_catalogs", "retained_metadata", "src/daemon/ledger/project-catalog.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("conversations", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("conversation_purges", "retained_metadata", "src/daemon/ledger/worker-retention.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("agent_sessions", "retained_metadata", "src/daemon/ledger/sessions.ts", "src/daemon/ledger/persona.ts, src/daemon/ledger/router.ts", "on_archive_or_delete"),
  table("session_checklists", "retained_metadata", "src/daemon/ledger/checklist.ts", "migrations/0052_session_checklists.sql", "automatic", [
    limit("CHECKLIST_MAX_ITEMS", CHECKLIST_MAX_ITEMS, "entries"),
  ]),
  table("session_checklist_turns", "retained_metadata", "src/daemon/ledger/checklist.ts", "migrations/0054_system_wakeups.sql", "automatic", [
    limit("CHECKLIST_MAX_ITEMS", CHECKLIST_MAX_ITEMS, "entries"),
  ]),
  table("workers", "retained_metadata", "src/daemon/ledger/workers.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("worker_endings", "retained_metadata", "src/daemon/ledger/completed-work.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("worker_direct_chat_receipts", "retained_metadata", "src/daemon/ledger/workers/direct-chat.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("worker_capabilities", "retained_metadata", "src/daemon/ledger/workers.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("router_worker_origins", "retained_metadata", "src/daemon/ledger/router.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("schedules", "retained_metadata", "src/daemon/ledger/schedules.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("handoffs", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("health", "bounded_config", "src/daemon/ledger/context.ts", "src/daemon/ledger/context.ts", "overwrite"),
  table("router_settings", "bounded_config", "src/daemon/ledger/router.ts", "src/daemon/ledger/router.ts", "overwrite"),
  table("default_capability_policies", "bounded_config", "src/daemon/ledger/pm-capabilities.ts", "src/daemon/ledger/pm-capabilities.ts", "overwrite"),
  table("default_capability_overrides", "bounded_config", "src/daemon/ledger/pm-capabilities.ts", "src/daemon/ledger/pm-capabilities.ts", "overwrite"),
  table("pm_capability_policies", "bounded_config", "src/daemon/ledger/pm-capabilities.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("project_review_status", "bounded_config", "migrations/0048_project_review_status.sql", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("pm_capability_overrides", "bounded_config", "src/daemon/ledger/pm-capabilities.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  table("router_capability_policies", "bounded_config", "src/daemon/ledger/pm-capabilities.ts", "src/daemon/ledger/pm-capabilities.ts", "overwrite"),
  table("router_capability_overrides", "bounded_config", "src/daemon/ledger/pm-capabilities.ts", "src/daemon/ledger/pm-capabilities.ts", "overwrite"),
  table("feishu_app", "bounded_config", "src/daemon/feishu/store.ts", "src/daemon/feishu/store.ts", "overwrite"),
  table("feishu_chats", "bounded_config", "src/daemon/feishu/store.ts", "src/daemon/feishu/store.ts", "on_archive_or_delete"),
  table("feishu_inbound_cursors", "bounded_config", "migrations/0041_feishu_router_asks_and_inbound_cursor.sql", "src/daemon/feishu/store.ts", "on_archive_or_delete"),
  table("feishu_avatars", "bounded_config", "src/daemon/feishu/store.ts", "src/daemon/feishu/store.ts", "overwrite"),
];

const HUB_PATH_ENTRIES: readonly ResourceRegistryEntry[] = [
  pathEntry("home", "data_dir", "bounded_config", "src/daemon/daemon.ts", "src/daemon/daemon.ts", "overwrite"),
  pathEntry("stateDir", "data_dir", "bounded_config", "src/daemon/daemon.ts", "src/daemon/daemon.ts", "overwrite"),
  pathEntry("dbFile", "data_dir", "growing", "src/daemon/store/index.ts", "src/daemon/db-retention.ts, src/daemon/store/backup.ts", "automatic", [
    limit("MAX_DB_BACKUPS", MAX_DB_BACKUPS, "files"),
  ]),
  pathEntry("lockFile", "data_dir", "bounded_config", "src/daemon/store/lock.ts", "src/daemon/store/lock.ts", "overwrite"),
  pathEntry("childProcessesFile", "data_dir", "bounded_config", "src/daemon/process-ledger.ts", "src/daemon/process-ledger.ts", "overwrite", [
    limit("PROCESS_LEDGER_MAX_ENTRIES", PROCESS_LEDGER_MAX_ENTRIES, "entries"),
  ]),
  pathEntry("sessionTmpFile", "data_dir", "bounded_config", "src/daemon/session-tmp.ts", "src/daemon/session-tmp.ts", "overwrite", [
    limit("SESSION_TMP_ORPHAN_RETENTION_MS", SESSION_TMP_ORPHAN_RETENTION_MS, "ms"),
  ]),
  pathEntry("uiTokenFile", "data_dir", "bounded_config", "src/daemon/ui-server/token.ts", "src/daemon/ui-server/token.ts", "overwrite"),
  pathEntry("providerSecretsFile", "data_dir", "bounded_config", "src/daemon/provider-manager/secrets.ts", "src/daemon/provider-manager/secrets.ts", "overwrite", [
    limit("PROVIDER_SECRETS_FILE_MAX_BYTES", PROVIDER_SECRETS_FILE_MAX_BYTES, "bytes"),
  ]),
  pathEntry("feishuSecretsFile", "data_dir", "bounded_config", "src/daemon/feishu/secrets.ts", "src/daemon/feishu/secrets.ts", "overwrite"),
  pathEntry("feishuInboundFile", "data_dir", "growing", "src/daemon/feishu/inbound-checkpoint.ts", "src/daemon/feishu/inbound-checkpoint.ts", "automatic", [
    limit("FEISHU_INBOUND_RECEIPTS_TTL_MS", FEISHU_INBOUND_RECEIPTS_TTL_MS, "ms"),
    limit("FEISHU_INBOUND_RECEIPTS_MAX", FEISHU_INBOUND_RECEIPTS_MAX, "entries"),
    limit("FEISHU_INBOUND_CURSORS_MAX", FEISHU_INBOUND_CURSORS_MAX, "entries"),
    limit("FEISHU_INBOUND_STATE_MAX_BYTES", FEISHU_INBOUND_STATE_MAX_BYTES, "bytes"),
  ]),
  pathEntry("deviceFile", "data_dir", "bounded_config", "src/daemon/device.ts", "src/daemon/device.ts", "overwrite"),
  pathEntry("pushVapidFile", "data_dir", "bounded_config", "src/daemon/push/vapid.ts", "src/daemon/push/vapid.ts", "overwrite"),
  pathEntry("pushSubscriptionsFile", "data_dir", "bounded_config", "src/daemon/push/subscriptions.ts", "src/daemon/push/subscriptions.ts", "overwrite", [
    limit("MAX_PUSH_SUBSCRIPTIONS", MAX_PUSH_SUBSCRIPTIONS, "entries"),
  ]),
  pathEntry("peersFile", "data_dir", "bounded_config", "src/daemon/mesh/trust.ts", "src/daemon/mesh/trust.ts", "overwrite", [
    limit("MESH_MAX_DEVICES_PER_ACCOUNT", MESH_MAX_DEVICES_PER_ACCOUNT, "entries"),
  ]),
  pathEntry("accountFile", "data_dir", "bounded_config", "src/daemon/mesh/account.ts", "src/daemon/mesh/account.ts", "overwrite"),
  pathEntry("meshDir", "data_dir", "bounded_config", "src/daemon/mesh/identity.ts", "src/daemon/mesh/identity.ts", "overwrite"),
  pathEntry("adminSock", "data_dir", "bounded_config", "src/daemon/admin/socket.ts", "src/daemon/admin/socket.ts", "overwrite"),
  pathEntry("launchDir", "data_dir", "growing", "src/daemon/launch.ts", "src/daemon/ledger/worker-retention.ts", "automatic", WORKER_RETENTION_LIMITS),
  pathEntry("logsDir", "log_file", "growing", "src/daemon/main.ts", "src/daemon/main.ts", "automatic", [
    limit("DAEMON_LOG_MAX_BYTES", DAEMON_LOG_MAX_BYTES, "bytes"),
  ]),
  pathEntry("setupLogsDir", "log_file", "growing", "src/daemon/setup/setup.ts", "src/daemon/file-cleanup.ts, src/daemon/ledger/worker-retention.ts", "automatic", [
    limit("SETUP_LOGS_RETENTION_DAYS", SETUP_LOGS_RETENTION_DAYS, "days"),
    limit("SETUP_LOGS_MAX_FILES", SETUP_LOGS_MAX_FILES, "files"),
    limit("SETUP_LOG_MAX_BYTES", SETUP_LOG_MAX_BYTES, "bytes"),
  ]),
  pathEntry("pmHomeDir", "data_dir", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete"),
  pathEntry("personasDir", "data_dir", "retained_metadata", "src/daemon/ledger/persona.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete", [
    limit("MAX_PERSONA_BYTES", MAX_PERSONA_BYTES, "bytes"),
  ]),
  pathEntry("pmMemoryDir", "data_dir", "retained_metadata", "src/daemon/pm-memory.ts", "src/daemon/ledger/persona.ts", "on_archive_or_delete", [
    limit("PM_MEMORY_MAX_TOTAL_BYTES", PM_MEMORY_MAX_TOTAL_BYTES, "bytes"),
  ]),
  pathEntry("runDir", "data_dir", "bounded_config", "src/daemon/daemon.ts", "src/daemon/daemon.ts", "overwrite"),
  pathEntry("hubSock", "data_dir", "bounded_config", "src/daemon/agent-api/server.ts", "src/daemon/agent-api/server.ts", "overwrite"),
  pathEntry("hubBinDir", "data_dir", "bounded_config", "src/daemon/agent-api/shim.ts", "src/daemon/agent-api/shim.ts", "overwrite"),
  pathEntry("worktreesDir", "worktree", "growing", "src/daemon/handlers.ts", "src/daemon/worktree-cleanup.ts", "automatic_or_hold", [
    limit("WORKTREE_RETENTION_DAYS", WORKTREE_RETENTION_DAYS, "days"),
    limit("WORKTREE_CLEANUP_BATCH_LIMIT", WORKTREE_CLEANUP_BATCH_LIMIT, "entries"),
  ]),
  pathEntry("uploadsDir", "data_dir", "growing", "src/daemon/uploads.ts", "src/daemon/file-cleanup.ts", "automatic", [
    limit("FILE_RETENTION_DAYS", FILE_RETENTION_DAYS, "days"),
    limit("UPLOADS_DISK_MAX_BYTES", UPLOADS_DISK_MAX_BYTES, "bytes"),
    limit("FILE_BYTE_CAP_MIN_AGE_DAYS", FILE_BYTE_CAP_MIN_AGE_DAYS, "days"),
  ]),
  pathEntry("sentFilesDir", "data_dir", "growing", "src/daemon/sent-files.ts", "src/daemon/file-cleanup.ts", "automatic", [
    limit("SENT_FILES_RETENTION_DAYS", SENT_FILES_RETENTION_DAYS, "days"),
    limit("SENT_FILES_DISK_MAX_BYTES", SENT_FILES_DISK_MAX_BYTES, "bytes"),
    limit("FILE_BYTE_CAP_MIN_AGE_DAYS", FILE_BYTE_CAP_MIN_AGE_DAYS, "days"),
  ]),
  pathEntry("syncBackupsDir", "data_dir", "growing", "src/daemon/vendor-sync/backup.ts", "src/daemon/vendor-sync/backup.ts", "automatic", [
    limit("MAX_VENDOR_SYNC_BACKUPS", MAX_VENDOR_SYNC_BACKUPS, "entries"),
  ]),
  pathEntry("toolsNpmDir", "data_dir", "bounded_config", "src/daemon/provider-manager/manager.ts", "src/daemon/provider-manager/manager.ts", "overwrite"),
  pathEntry("toolsNpmBinDir", "data_dir", "bounded_config", "src/daemon/provider-manager/manager.ts", "src/daemon/provider-manager/manager.ts", "overwrite"),
];

const RUNTIME_RESOURCE_ENTRIES: readonly ResourceRegistryEntry[] = [
  {
    id: "process:worker_process_tree",
    kind: "process",
    target: "worker_process_tree",
    growth: "growing",
    owner: "src/daemon/driver/base-driver.ts, src/daemon/setup/setup.ts",
    cleaner: "src/daemon/resources/session-processes.ts, src/daemon/platform/process-tag.ts, src/daemon/process-ledger.ts",
    cleanupMode: "automatic_or_hold",
    limits: [
      limit("PROCESS_LEDGER_MAX_ENTRIES", PROCESS_LEDGER_MAX_ENTRIES, "entries"),
      limit("SESSION_TAG_MAX_DEPTH", SESSION_TAG_MAX_DEPTH, "entries"),
    ],
  },
  {
    id: "git_branch:managed_hub_branches",
    kind: "git_branch",
    target: "managed_hub_branches",
    growth: "growing",
    owner: "src/daemon/git/git.ts",
    cleaner: "src/daemon/resources/branch-cleanup.ts",
    cleanupMode: "automatic_or_hold",
    limits: [
      limit("BRANCH_MERGED_RETENTION_DAYS", BRANCH_MERGED_RETENTION_DAYS, "days"),
      limit("BRANCH_UNMERGED_HOLD_DAYS", BRANCH_UNMERGED_HOLD_DAYS, "days"),
      limit("MANAGED_BRANCHES_MERGED_MAX", MANAGED_BRANCHES_MERGED_MAX, "branches"),
    ],
  },
  {
    id: "temp_dir:session_tmp_dirs",
    kind: "temp_dir",
    target: "session_tmp_dirs",
    growth: "growing",
    owner: "src/daemon/session-tmp.ts",
    cleaner: "src/daemon/session-tmp.ts",
    cleanupMode: "automatic",
    limits: [
      limit("SESSION_TMP_ORPHAN_RETENTION_MS", SESSION_TMP_ORPHAN_RETENTION_MS, "ms"),
    ],
  },
  {
    id: "temp_dir:scratch_dirs",
    kind: "temp_dir",
    target: "scratch_dirs",
    growth: "transient",
    owner:
      "src/daemon/git/git.ts, src/daemon/provider-manager/recipes.ts, src/daemon/worktree-cleanup.ts, src/vendors/agy/connectors.ts, src/vendors/_common/setup/browser-capture.ts",
    cleaner: "the creating call removes its directory in a finally block before it returns",
    cleanupMode: "removed_by_creator",
    limits: [],
  },
];

/** Canonical catalog of every accumulating or managed resource in Bellwood. */
export const RESOURCE_REGISTRY: readonly ResourceRegistryEntry[] = [
  ...SQLITE_TABLE_ENTRIES,
  ...HUB_PATH_ENTRIES,
  ...RUNTIME_RESOURCE_ENTRIES,
];

const PATH_RESOURCE_KINDS: ReadonlySet<ResourceKind> = new Set(["data_dir", "worktree", "log_file"]);

/**
 * Precondition: sqliteTables contains all non-internal tables from migrated schema; hubPathKeys contains all data-dir keys from resolveHubPaths; exportedLimitNames contains every numeric export from src/shared/limits.ts.
 * Postcondition: returns an empty array when every table and path is registered, every growing entry declares a cleaner and valid positive limits, and no stale table entries exist.
 */
export function validateResourceRegistry(
  registry: readonly ResourceRegistryEntry[],
  input: ResourceRegistryValidationInput,
): ResourceRegistryViolation[] {
  const violations: ResourceRegistryViolation[] = [];
  const seenIds = new Set<string>();
  const registeredTables = new Set<string>();
  const registeredPaths = new Set<string>();
  const schemaTables = new Set(input.sqliteTables);

  for (const entry of registry) {
    if (seenIds.has(entry.id)) {
      violations.push({ code: "duplicate_id", target: entry.id, detail: `duplicate resource registry id: ${entry.id}` });
    } else {
      seenIds.add(entry.id);
    }

    if (entry.kind === "sqlite_table") {
      registeredTables.add(entry.target);
      if (!schemaTables.has(entry.target)) {
        violations.push({
          code: "stale_table",
          target: entry.target,
          detail: `sqlite_table entry ${entry.target} does not exist in migrated schema`,
        });
      }
    } else if (PATH_RESOURCE_KINDS.has(entry.kind)) {
      registeredPaths.add(entry.target);
    }

    if (entry.growth === "growing") {
      if (entry.cleaner.trim() === "") {
        violations.push({
          code: "missing_cleaner",
          target: entry.id,
          detail: `growing resource ${entry.id} must declare a cleaner`,
        });
      }
      if (entry.limits.length === 0) {
        violations.push({
          code: "missing_limit",
          target: entry.id,
          detail: `growing resource ${entry.id} must declare at least one limit from src/shared/limits.ts`,
        });
      }
    }

    for (const ref of entry.limits) {
      if (!input.exportedLimitNames.has(ref.constantName)) {
        violations.push({
          code: "unknown_limit_constant",
          target: entry.id,
          detail: `resource ${entry.id} references unknown limit constant ${ref.constantName}`,
        });
      }
      if (!Number.isFinite(ref.value) || ref.value <= 0) {
        violations.push({
          code: "non_positive_limit",
          target: entry.id,
          detail: `resource ${entry.id} limit ${ref.constantName} must be positive, got ${ref.value}`,
        });
      }
    }
  }

  for (const tableName of input.sqliteTables) {
    if (!registeredTables.has(tableName)) {
      violations.push({
        code: "unregistered_table",
        target: tableName,
        detail: `SQLite table ${tableName} is missing from RESOURCE_REGISTRY`,
      });
    }
  }

  for (const key of input.hubPathKeys) {
    if (!registeredPaths.has(key)) {
      violations.push({
        code: "unregistered_path",
        target: key,
        detail: `HubPaths key ${key} is missing from RESOURCE_REGISTRY`,
      });
    }
  }

  return violations;
}

/**
 * Precondition: kind and target identify a resource entry.
 * Postcondition: returns the matching ResourceRegistryEntry or null when absent.
 */
export function findResourceEntry(
  kind: ResourceKind,
  target: string,
  registry: readonly ResourceRegistryEntry[] = RESOURCE_REGISTRY,
): ResourceRegistryEntry | null {
  return registry.find((entry) => entry.kind === kind && entry.target === target) ?? null;
}
