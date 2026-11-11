// 水果刀 Router 非对话式行动工作台（docs/ui-standard.md 第 21 条、docs/router-design.md 第 4 节）：
// 中性碳黑主调，严禁聊天气泡与拼接分隔符；Needs You -> Recent -> Updates -> Archived 四段按需显隐，底部复用 DraftComposer。
import { useInfiniteQuery } from "@tanstack/react-query";
import { Check, ChevronRight, CircleAlert, ExternalLink, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ROUTER_ARCHIVED_MAX_PAGES,
  ROUTER_ARCHIVED_PAGE_SIZE,
  ROUTER_VISIBLE_RECEIPTS_MAX,
  type ConversationId,
  type RouterCommandId,
  type RouterCommandRecord,
  type RouterItem,
  type RouterReportLink,
} from "../../shared/index.ts";
import { localClient, type HubClient } from "../client.ts";
import type { ComposerSource, MenuItem } from "../composer-suggest.ts";
import { submitDecision } from "../decision-actions.ts";
import { errorLine, errorText, formatTime, newClientId, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import { useHubQueryClient } from "../query-client.ts";
import type {
  FleetDecisionEntry,
  FleetReportEntry,
  FleetRouterView,
  RouterTargetCandidate,
} from "../selectors.ts";
import { Button } from "../ui/button.tsx";
import type { DraftSlot, StagedFiles } from "../upload.ts";
import { Avatar } from "./Avatar.tsx";
import { DraftComposer } from "./Composer.tsx";
import { FileDropZone } from "./FileDropZone.tsx";
import { KnifeAvatar } from "./KnifeAvatar.tsx";
import { RouterDecisionCard } from "./RouterDecisionCard.tsx";
import { RowError } from "./SettingsList.tsx";

const CHIP_REMOVE_CLASS =
  "touch-target flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-sidebar-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50";

interface ReceiptTargetLink {
  key: string;
  deviceKey: string;
  conversationId: ConversationId;
  name: string;
  avatarKey: number;
}

interface LocalReceipt {
  key: string;
  clientId: string;
  createdAt: number;
  inputText: string;
  status: "planning" | "dispatched" | "failed";
  summaryText: string;
  error: ErrorLike | null;
  targets: ReceiptTargetLink[];
  retryAction:
    | { kind: "direct"; target: RouterTargetCandidate; text: string; attachmentIds: string[] }
    | { kind: "command"; commandId: RouterCommandId | null; text: string; attachmentIds: string[] };
}

interface UnifiedReceipt {
  key: string;
  clientId: string;
  createdAt: number;
  inputText: string;
  status: "planning" | "done" | "failed";
  summaryText: string;
  error: ErrorLike | null;
  targets: ReceiptTargetLink[];
  onRetry: (() => void) | null;
}

function parseLinkRoute(
  target: string,
): { kind: "external"; url: string } | { kind: "worker"; id: ConversationId } | { kind: "conversation"; id: ConversationId } | { kind: "raw"; href: string } {
  if (/^https?:\/\//i.test(target)) return { kind: "external", url: target };
  const workerHash = /^#(?:\/d\/[^/]+)?\/w\/([1-9]\d*)$/.exec(target) ?? /^worker:([1-9]\d*)$/i.exec(target);
  if (workerHash) return { kind: "worker", id: Number(workerHash[1]) };
  const convHash = /^#(?:\/d\/[^/]+)?\/c\/([1-9]\d*)$/.exec(target);
  if (convHash) return { kind: "conversation", id: Number(convHash[1]) };
  return { kind: "raw", href: target };
}

function ReportLinkItem({
  link,
  deviceKey,
  onOpenConversation,
  onOpenWorker,
}: {
  link: RouterReportLink;
  deviceKey: string;
  onOpenConversation: (deviceKey: string, id: ConversationId) => void;
  onOpenWorker: (deviceKey: string, id: ConversationId) => void;
}) {
  const parsed = parseLinkRoute(link.target);
  const pillClass =
    "touch-target inline-flex cursor-pointer items-center gap-1 rounded-full bg-sidebar px-2.5 py-1 text-xs font-medium text-foreground transition-colors outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50";
  if (parsed.kind === "external") {
    return (
      <a href={parsed.url} target="_blank" rel="noreferrer" className={pillClass}>
        <span>{link.label}</span>
        <ExternalLink className="size-3 text-muted-foreground" aria-hidden="true" />
      </a>
    );
  }
  if (parsed.kind === "worker") {
    return (
      <button type="button" className={pillClass} onClick={() => onOpenWorker(deviceKey, parsed.id)}>
        <span>{link.label}</span>
      </button>
    );
  }
  if (parsed.kind === "conversation") {
    return (
      <button type="button" className={pillClass} onClick={() => onOpenConversation(deviceKey, parsed.id)}>
        <span>{link.label}</span>
      </button>
    );
  }
  return (
    <a href={parsed.href} target="_blank" rel="noreferrer" className={pillClass}>
      <span>{link.label}</span>
    </a>
  );
}

function ArchivedRow({ item }: { item: RouterItem }) {
  const isDecision = item.kind === "decision";
  const title = isDecision ? item.question : item.summary;
  const sub =
    isDecision && item.resolution
      ? item.resolution.chosenOption ?? item.resolution.note
      : null;
  return (
    <li className="rounded-2xl border border-border bg-sidebar/50 px-4 py-3 text-minor">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatTime(item.updatedAt)}</span>
      </div>
      {sub && <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>}
    </li>
  );
}

export function RouterWorkbench({
  leading,
  notices,
  view,
  draft,
  staging,
  clientForDevice,
  onOpenConversation,
  onOpenWorker,
}: {
  leading?: ReactNode;
  notices: ReactNode;
  view: FleetRouterView;
  draft: DraftSlot;
  staging: StagedFiles;
  clientForDevice: (deviceKey: string) => HubClient;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
  onOpenWorker: (deviceKey: string, conversationId: ConversationId) => void;
}) {
  const qc = useHubQueryClient();

  // 待决卡乐观隐藏、备注草稿保留与错误回滚（随当前活跃 decision 集合自动裁剪，严格有界）
  const [hiddenDecisionKeys, setHiddenDecisionKeys] = useState<ReadonlySet<string>>(new Set());
  const [decisionNotes, setDecisionNotes] = useState<Readonly<Record<string, string>>>({});
  const [decisionErrors, setDecisionErrors] = useState<Readonly<Record<string, ErrorLike>>>({});

  // 未读汇报乐观归档与错误回滚
  const [hiddenReportKeys, setHiddenReportKeys] = useState<ReadonlySet<string>>(new Set());
  const [archiveError, setArchiveError] = useState<ErrorLike | null>(null);

  // Recent 本地回执（直转 A2 与刚发出的 B 轨乐观态，严格截断在 ROUTER_VISIBLE_RECEIPTS_MAX 以内）与已手动关闭的回执键
  const [localReceipts, setLocalReceipts] = useState<readonly LocalReceipt[]>([]);
  const [dismissedReceipts, setDismissedReceipts] = useState<ReadonlySet<string>>(new Set());

  // 底部输入框选中的跨设备 `@` 直达目标
  const [selectedTargetKey, setSelectedTargetKey] = useState<string | null>(null);

  // Archived 折叠开关
  const [archivedOpen, setArchivedOpen] = useState(false);

  // 底层列表变化时清理已不存在的乐观键与草稿，防止长时间驻留泄漏
  useEffect(() => {
    const activeDecKeys = new Set(view.decisions.map((d) => d.decision.key));
    setHiddenDecisionKeys((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((k) => activeDecKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
    setDecisionNotes((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0 || keys.every((k) => activeDecKeys.has(k))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([k]) => activeDecKeys.has(k)));
    });
    setDecisionErrors((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0 || keys.every((k) => activeDecKeys.has(k))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([k]) => activeDecKeys.has(k)));
    });
  }, [view.decisions]);

  useEffect(() => {
    const activeRepKeys = new Set(view.reports.map((r) => r.key));
    setHiddenReportKeys((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((k) => activeRepKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [view.reports]);

  useEffect(() => {
    const activeReceiptKeys = new Set<string>([
      ...view.commands.map((c) => `cmd:${c.id}`),
      ...localReceipts.map((r) => r.key),
    ]);
    setDismissedReceipts((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((k) => activeReceiptKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [view.commands, localReceipts]);

  const prevActiveRefs = useRef({ decisions: view.decisions, reports: view.reports });
  useEffect(() => {
    if (
      prevActiveRefs.current.decisions !== view.decisions ||
      prevActiveRefs.current.reports !== view.reports
    ) {
      prevActiveRefs.current = { decisions: view.decisions, reports: view.reports };
      void qc.invalidateQueries({ queryKey: ["router-archived-items"] });
    }
  }, [view.decisions, view.reports, qc]);

  const selectedTarget = useMemo(
    () => (selectedTargetKey === null ? null : (view.targets.find((t) => t.key === selectedTargetKey) ?? null)),
    [selectedTargetKey, view.targets],
  );

  const handleNoteChange = useCallback((key: string, value: string) => {
    setDecisionNotes((prev) => ({ ...prev, [key]: value }));
    setDecisionErrors((prev) => {
      if (prev[key] === undefined) return prev;
      const { [key]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  // 同一张卡在途时再点（双击、回车与点击同一帧）直接忽略：乐观隐藏要等重画才生效，这里用 ref 同步上锁
  const inflightDecisions = useRef(new Set<string>());
  const handleDecisionSubmit = useCallback(
    async (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => {
      const key = entry.decision.key;
      if (inflightDecisions.current.has(key)) return;
      inflightDecisions.current.add(key);
      setHiddenDecisionKeys((prev) => new Set(prev).add(key));
      setDecisionErrors((prev) => {
        if (prev[key] === undefined) return prev;
        const { [key]: _removed, ...rest } = prev;
        return rest;
      });
      try {
        await submitDecision(clientForDevice(entry.deviceKey), entry.decision, { optionIndex, note });
        setDecisionNotes((prev) => {
          if (prev[key] === undefined) return prev;
          const { [key]: _removed, ...rest } = prev;
          return rest;
        });
        void qc.invalidateQueries({ queryKey: ["router-archived-items"] });
      } catch (err) {
        setHiddenDecisionKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        setDecisionErrors((prev) => ({ ...prev, [key]: errorText(err) }));
      } finally {
        inflightDecisions.current.delete(key);
      }
    },
    [clientForDevice, qc],
  );
  // 传给 memo 的拍板卡：引用稳定，不让每张卡随工作台每次重画都重画
  const submitDecisionCard = useCallback(
    (entry: FleetDecisionEntry, optionIndex: number | null, note: string) => void handleDecisionSubmit(entry, optionIndex, note),
    [handleDecisionSubmit],
  );

  const handleArchiveReport = useCallback(
    async (entry: FleetReportEntry) => {
      setArchiveError(null);
      setHiddenReportKeys((prev) => new Set(prev).add(entry.key));
      try {
        await clientForDevice(entry.deviceKey).postResolveRouterItem(entry.report.id, { action: "archive" });
        void qc.invalidateQueries({ queryKey: ["router-archived-items"] });
      } catch (err) {
        setHiddenReportKeys((prev) => {
          const next = new Set(prev);
          next.delete(entry.key);
          return next;
        });
        setArchiveError(errorText(err));
      }
    },
    [clientForDevice, qc],
  );

  const visibleReports = useMemo(
    () => view.reports.filter((r) => !hiddenReportKeys.has(r.key)),
    [view.reports, hiddenReportKeys],
  );

  const handleArchiveAll = useCallback(async () => {
    setArchiveError(null);
    const onlineDeviceKeys = [...new Set(visibleReports.filter((r) => r.online).map((r) => r.deviceKey))];
    if (onlineDeviceKeys.length === 0) return;
    const optimisticKeys = visibleReports.filter((r) => r.online).map((r) => r.key);
    setHiddenReportKeys((prev) => new Set([...prev, ...optimisticKeys]));
    try {
      await Promise.all(onlineDeviceKeys.map((dk) => clientForDevice(dk).postArchiveAllRouterReports()));
      void qc.invalidateQueries({ queryKey: ["router-archived-items"] });
    } catch (err) {
      setHiddenReportKeys((prev) => {
        const next = new Set(prev);
        for (const k of optimisticKeys) next.delete(k);
        return next;
      });
      setArchiveError(errorText(err));
    }
  }, [visibleReports, clientForDevice, qc]);

  const targetByDeviceAndPm = useMemo(() => {
    const map = new Map<string, RouterTargetCandidate>();
    for (const t of view.targets) {
      map.set(`${t.deviceId}:${t.pmId}`, t);
    }
    return map;
  }, [view.targets]);

  // 服务端回执的重试：在途时按钮换成 Dispatching…（防重复提交）；请求本身失败（断网、超时）就地显示错误，
  // 不等服务端推送。两者都按 view.commands 裁剪，最多 ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX 条。
  const [retryingCommands, setRetryingCommands] = useState<ReadonlySet<RouterCommandId>>(new Set());
  const [commandRetryErrors, setCommandRetryErrors] = useState<Readonly<Record<RouterCommandId, ErrorLike>>>({});
  const retryingCommandsRef = useRef(new Set<RouterCommandId>());
  const retryServerCommand = useCallback(async (commandId: RouterCommandId) => {
    if (retryingCommandsRef.current.has(commandId)) return;
    retryingCommandsRef.current.add(commandId);
    setRetryingCommands(new Set(retryingCommandsRef.current));
    setCommandRetryErrors((prev) => {
      if (prev[commandId] === undefined) return prev;
      const { [commandId]: _removed, ...rest } = prev;
      return rest;
    });
    try {
      await localClient.postRetryRouterCommand(commandId);
    } catch (err) {
      setCommandRetryErrors((prev) => ({ ...prev, [commandId]: errorText(err) }));
    } finally {
      retryingCommandsRef.current.delete(commandId);
      setRetryingCommands(new Set(retryingCommandsRef.current));
    }
  }, []);
  useEffect(() => {
    const ids = new Set(view.commands.map((c) => c.id));
    setCommandRetryErrors((prev) => {
      const keys = Object.keys(prev).map(Number);
      if (keys.every((k) => ids.has(k))) return prev;
      return Object.fromEntries(Object.entries(prev).filter(([k]) => ids.has(Number(k))));
    });
  }, [view.commands]);

  const retryLocalReceipt = useCallback(
    async (receipt: LocalReceipt) => {
      setLocalReceipts((prev) =>
        prev.map((r) => (r.key === receipt.key ? { ...r, status: "planning", error: null } : r)),
      );
      try {
        if (receipt.retryAction.kind === "direct") {
          const { target, text, attachmentIds } = receipt.retryAction;
          await clientForDevice(target.deviceKey).postMessage(target.conversationId, {
            clientId: receipt.clientId,
            text,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          });
          setLocalReceipts((prev) =>
            prev.map((r) => (r.key === receipt.key ? { ...r, status: "dispatched", error: null } : r)),
          );
        } else {
          const { commandId, text, attachmentIds } = receipt.retryAction;
          const res =
            commandId !== null
              ? await localClient.postRetryRouterCommand(commandId)
              : await localClient.postRouterCommand({
                  clientId: receipt.clientId,
                  text,
                  ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
                });
          setLocalReceipts((prev) =>
            prev.map((r) =>
              r.key === receipt.key
                ? {
                    ...r,
                    status: res.command.status === "planning" ? "planning" : "dispatched",
                    summaryText: res.command.plan?.reply ?? r.summaryText,
                  }
                : r,
            ),
          );
        }
      } catch (err) {
        setLocalReceipts((prev) =>
          prev.map((r) => (r.key === receipt.key ? { ...r, status: "failed", error: errorText(err) } : r)),
        );
      }
    },
    [clientForDevice],
  );

  const visibleReceipts = useMemo<UnifiedReceipt[]>(() => {
    const serverClientIds = new Set(view.commands.map((c) => c.clientId));
    const fromServer = view.commands
      .filter((cmd) => cmd.status !== "cancelled")
      .map((cmd: RouterCommandRecord): UnifiedReceipt => {
        const key = `cmd:${cmd.id}`;
        const targets: ReceiptTargetLink[] = [];
        for (const d of cmd.dispatched ?? []) {
          const matched = targetByDeviceAndPm.get(`${d.deviceId}:${d.pmId}`);
          if (matched) {
            targets.push({
              key: `${d.deviceId}:${d.pmId}`,
              deviceKey: matched.deviceKey,
              conversationId: matched.conversationId,
              name: matched.pmName,
              avatarKey: matched.avatarKey,
            });
          }
        }
        if (targets.length === 0 && cmd.plan) {
          for (const action of cmd.plan.actions) {
            if (action.type !== "dispatch") continue;
            const matched = targetByDeviceAndPm.get(`${action.deviceId}:${action.pmId}`);
            if (matched) {
              targets.push({
                key: `${action.deviceId}:${action.pmId}`,
                deviceKey: matched.deviceKey,
                conversationId: matched.conversationId,
                name: matched.pmName,
                avatarKey: matched.avatarKey,
              });
            }
          }
        }
        const summaryText = cmd.plan?.reply ?? cmd.inputText;
        const retrying = retryingCommands.has(cmd.id);
        const failed = cmd.status === "failed" && !retrying;
        return {
          key,
          clientId: cmd.clientId,
          createdAt: cmd.createdAt,
          inputText: cmd.inputText,
          status: cmd.status === "planning" || retrying ? "planning" : failed ? "failed" : "done",
          summaryText,
          error: failed ? (commandRetryErrors[cmd.id] ?? cmd.error ?? "指令派发失败") : null,
          targets,
          onRetry: failed ? () => void retryServerCommand(cmd.id) : null,
        };
      });

    const fromLocal = localReceipts
      .filter((r) => !serverClientIds.has(r.clientId))
      .map(
        (r): UnifiedReceipt => ({
          key: r.key,
          clientId: r.clientId,
          createdAt: r.createdAt,
          inputText: r.inputText,
          status: r.status === "planning" ? "planning" : r.status === "failed" ? "failed" : "done",
          summaryText: r.summaryText,
          error: r.error,
          targets: r.targets,
          onRetry: r.status === "failed" ? () => void retryLocalReceipt(r) : null,
        }),
      );

    return [...fromLocal, ...fromServer]
      .filter((r) => !dismissedReceipts.has(r.key))
      .toSorted((a, b) => b.createdAt - a.createdAt)
      .slice(0, ROUTER_VISIBLE_RECEIPTS_MAX);
  }, [view.commands, localReceipts, dismissedReceipts, targetByDeviceAndPm, retryingCommands, commandRetryErrors, retryServerCommand, retryLocalReceipt]);

  const visibleDecisions = useMemo(
    () => view.decisions.filter((d) => !hiddenDecisionKeys.has(d.decision.key)),
    [view.decisions, hiddenDecisionKeys],
  );

  // Archived 历史流：默认收起不请求，展开后经 @tanstack/react-query 按需游标分页（最多驻留 ROUTER_ARCHIVED_MAX_PAGES 页）
  const archivedQuery = useInfiniteQuery(
    {
      queryKey: ["router-archived-items"] as const,
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }) =>
        localClient.fetchRouterItems({ cursor: pageParam, limit: ROUTER_ARCHIVED_PAGE_SIZE }),
      getNextPageParam: (lastPage) => (lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined),
      getPreviousPageParam: () => undefined,
      maxPages: ROUTER_ARCHIVED_MAX_PAGES,
      enabled: archivedOpen,
    },
    qc,
  );

  const archivedItems = useMemo(
    () => archivedQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [archivedQuery.data],
  );

  // Composer `@` 跨设备项目/PM 候选补全数据源
  const composerSource = useMemo<ComposerSource>(
    () => ({
      commands: async () => [],
      files: async () => ({ entries: [], truncated: false }),
      targets: (rawQuery: string): MenuItem[] => {
        const q = rawQuery.trim().toLowerCase();
        return view.targets
          .filter(
            (t) =>
              q === "" ||
              t.label.toLowerCase().includes(q) ||
              t.pmName.toLowerCase().includes(q) ||
              (t.projectName?.toLowerCase().includes(q) ?? false) ||
              t.deviceName.toLowerCase().includes(q),
          )
          .map((t) => {
            const detailParts: string[] = [];
            if (t.projectName !== null && t.projectName !== t.pmName) detailParts.push(t.pmName);
            if (view.multiDevice || !t.self) detailParts.push(t.deviceName);
            if (!t.online) detailParts.push("Offline");
            return {
              id: `target:${t.key}`,
              label: t.label,
              detail: detailParts.join(" "),
              insert: `@${t.label}`,
              disabled: !t.online,
              avatarKey: t.avatarKey,
              targetKey: t.key,
            };
          });
      },
    }),
    [view.targets, view.multiDevice],
  );

  const handleSelectTarget = useCallback((targetKey: string) => {
    setSelectedTargetKey(targetKey);
  }, []);

  const handleComposerSend = useCallback(
    async (text: string, files: File[]) => {
      const clientId = newClientId();
      const createdAt = Date.now();
      const target = selectedTarget;

      if (target !== null) {
        const targetClient = clientForDevice(target.deviceKey);
        const uploaded = await Promise.all(files.map((f) => targetClient.postUpload(f, f.name)));
        const attachmentIds = uploaded.map((u) => u.id);
        const receiptKey = `direct:${clientId}`;
        const receipt: LocalReceipt = {
          key: receiptKey,
          clientId,
          createdAt,
          inputText: text,
          status: "planning",
          summaryText: text || uploaded.map((u) => u.name).join(", "),
          error: null,
          targets: [
            {
              key: target.key,
              deviceKey: target.deviceKey,
              conversationId: target.conversationId,
              name: target.pmName,
              avatarKey: target.avatarKey,
            },
          ],
          retryAction: { kind: "direct", target, text, attachmentIds },
        };
        setLocalReceipts((prev) => [receipt, ...prev].slice(0, ROUTER_VISIBLE_RECEIPTS_MAX));
        draft.clearIfMatch(text);
        if (files.length > 0) staging.removeSent(files);
        setSelectedTargetKey(null);
        try {
          await targetClient.postMessage(target.conversationId, {
            clientId,
            text,
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
          });
          setLocalReceipts((prev) =>
            prev.map((r) => (r.key === receiptKey ? { ...r, status: "dispatched" } : r)),
          );
        } catch (err) {
          setLocalReceipts((prev) =>
            prev.map((r) => (r.key === receiptKey ? { ...r, status: "failed", error: errorText(err) } : r)),
          );
        }
        return;
      }

      const uploaded = await Promise.all(files.map((f) => localClient.postUpload(f, f.name)));
      const attachmentIds = uploaded.map((u) => u.id);
      const receiptKey = `local-cmd:${clientId}`;
      const optimistic: LocalReceipt = {
        key: receiptKey,
        clientId,
        createdAt,
        inputText: text,
        status: "planning",
        summaryText: text,
        error: null,
        targets: [],
        retryAction: { kind: "command", commandId: null, text, attachmentIds },
      };
      setLocalReceipts((prev) => [optimistic, ...prev].slice(0, ROUTER_VISIBLE_RECEIPTS_MAX));
      draft.clearIfMatch(text);
      if (files.length > 0) staging.removeSent(files);
      try {
        const res = await localClient.postRouterCommand({
          clientId,
          text,
          ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
        });
        setLocalReceipts((prev) =>
          prev.map((r) =>
            r.key === receiptKey
              ? {
                  ...r,
                  status: res.command.status === "planning" ? "planning" : res.command.status === "failed" ? "failed" : "dispatched",
                  summaryText: res.command.plan?.reply ?? r.summaryText,
                  error: res.command.status === "failed" ? (res.command.error ?? "指令派发失败") : null,
                  retryAction: { kind: "command", commandId: res.command.id, text, attachmentIds },
                }
              : r,
          ),
        );
      } catch (err) {
        setLocalReceipts((prev) =>
          prev.map((r) => (r.key === receiptKey ? { ...r, status: "failed", error: errorText(err) } : r)),
        );
      }
    },
    [selectedTarget, clientForDevice, draft, staging],
  );

  const leadingChip = selectedTarget ? (
    <li className="flex max-w-full items-center gap-2 rounded-full bg-muted py-1 pr-1 pl-2.5 text-minor">
      <Avatar colorKey={selectedTarget.avatarKey} size={18} />
      <span className="truncate font-medium">{selectedTarget.label}</span>
      {(view.multiDevice || !selectedTarget.self) && (
        <span className="truncate text-xs text-muted-foreground">{selectedTarget.deviceName}</span>
      )}
      <button
        type="button"
        aria-label={`Remove target ${selectedTarget.label}`}
        className={CHIP_REMOVE_CLASS}
        onClick={() => setSelectedTargetKey(null)}
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </li>
  ) : null;

  const isAllClear =
    visibleDecisions.length === 0 && visibleReceipts.length === 0 && visibleReports.length === 0;

  return (
    <FileDropZone className="flex min-h-0 flex-1 flex-col" aria-label="Router" onFiles={staging.add}>
      <header
        data-window-drag
        className="flex h-16 shrink-0 items-center gap-3 py-3 pr-[var(--header-gutter-end)] pl-[var(--header-gutter-start)]"
      >
        {leading}
        <KnifeAvatar size={28} />
        <div className="min-w-0 flex-1">
          <h1 className="w-fit max-w-full truncate text-title leading-snug font-semibold">Router</h1>
        </div>
        {visibleDecisions.length > 0 && (
          <span className="text-minor text-muted-foreground tabular-nums">{visibleDecisions.length}</span>
        )}
      </header>
      {notices}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
        <div className="chat-column flex min-h-full flex-col gap-6 py-4">
          {isAllClear && !archivedOpen && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12">
              <KnifeAvatar size={36} className="opacity-40" />
              <p className="text-minor text-muted-foreground">All clear</p>
            </div>
          )}

          {visibleDecisions.length > 0 && (
            <section aria-label="Needs You" className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-minor font-medium text-muted-foreground">Needs You</h2>
                <span className="text-xs text-muted-foreground tabular-nums">{visibleDecisions.length}</span>
              </div>
              <div className="space-y-3">
                {visibleDecisions.map((entry) => (
                  <RouterDecisionCard
                    key={entry.decision.key}
                    entry={entry}
                    multiDevice={view.multiDevice}
                    busy={false}
                    note={decisionNotes[entry.decision.key] ?? ""}
                    error={decisionErrors[entry.decision.key] ?? null}
                    onNoteChange={handleNoteChange}
                    onSubmit={submitDecisionCard}
                    onOpenConversation={onOpenConversation}
                  />
                ))}
              </div>
            </section>
          )}

          {visibleReceipts.length > 0 && (
            <section aria-label="Recent" className="space-y-2">
              <h2 className="px-1 text-minor font-medium text-muted-foreground">Recent</h2>
              <ul className="space-y-1.5">
                {visibleReceipts.map((receipt) => (
                  <li
                    key={receipt.key}
                    className="flex items-center gap-2.5 rounded-xl bg-sidebar px-3 py-2 text-minor"
                  >
                    {receipt.status === "planning" ? (
                      <>
                        <span className="status-shimmer shrink-0 font-medium">Dispatching…</span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{receipt.inputText}</span>
                      </>
                    ) : receipt.status === "failed" ? (
                      <>
                        <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {receipt.error ? errorLine(receipt.error) : "指令派发失败"}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          {receipt.onRetry && (
                            <button
                              type="button"
                              className="touch-target cursor-pointer rounded-full px-2 py-0.5 text-xs font-medium text-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-ring/50"
                              onClick={receipt.onRetry}
                            >
                              Retry
                            </button>
                          )}
                          <button
                            type="button"
                            className="touch-target cursor-pointer rounded-full px-2 py-0.5 text-xs text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() => setDismissedReceipts((prev) => new Set(prev).add(receipt.key))}
                          >
                            Dismiss
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                        {receipt.targets.map((target) => (
                          <button
                            key={target.key}
                            type="button"
                            className="touch-target inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full font-medium text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                            onClick={() => onOpenConversation(target.deviceKey, target.conversationId)}
                          >
                            <Avatar colorKey={target.avatarKey} size={20} />
                            <span>{target.name}</span>
                          </button>
                        ))}
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{receipt.summaryText}</span>
                        <button
                          type="button"
                          aria-label="Dismiss"
                          className={CHIP_REMOVE_CLASS}
                          onClick={() => setDismissedReceipts((prev) => new Set(prev).add(receipt.key))}
                        >
                          <X className="size-3.5" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {visibleReports.length > 0 && (
            <section aria-label="Updates" className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-minor font-medium text-muted-foreground">Updates</h2>
                <button
                  type="button"
                  className="touch-target cursor-pointer rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                  onClick={() => void handleArchiveAll()}
                >
                  Archive all
                </button>
              </div>
              {archiveError && (
                <div className="px-1">
                  <RowError error={archiveError} />
                </div>
              )}
              <div className="space-y-2.5">
                {visibleReports.map((entry) => {
                  const showProject = entry.projectName !== null && entry.projectName !== entry.pmName;
                  const showDevice = view.multiDevice || !entry.self;
                  return (
                    <article
                      key={entry.key}
                      className={cn(
                        "rounded-2xl border border-border bg-background p-4 transition-opacity",
                        !entry.online && "opacity-60",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-minor">
                        <button
                          type="button"
                          className="touch-target inline-flex cursor-pointer items-center gap-2 rounded-full text-left font-semibold text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
                          onClick={() => onOpenConversation(entry.deviceKey, entry.report.conversationId)}
                        >
                          <Avatar colorKey={entry.avatarKey} size={24} />
                          <span className="truncate">{entry.pmName}</span>
                        </button>
                        {showProject && <span className="truncate text-muted-foreground">{entry.projectName}</span>}
                        {showDevice && <span className="truncate text-xs text-muted-foreground">{entry.deviceName}</span>}
                        {!entry.online && (
                          <span className="rounded-full bg-sidebar px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Offline
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatTime(entry.report.createdAt)}
                        </span>
                        <button
                          type="button"
                          disabled={!entry.online}
                          className="touch-target ml-auto cursor-pointer rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50"
                          onClick={() => void handleArchiveReport(entry)}
                        >
                          Done
                        </button>
                      </div>
                      <p className="mt-2 text-body leading-relaxed text-foreground">{entry.report.summary}</p>
                      {entry.report.links.length > 0 && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-2">
                          {entry.report.links.map((link, idx) => (
                            <ReportLinkItem
                              key={`${entry.key}-link-${idx}`}
                              link={link}
                              deviceKey={entry.deviceKey}
                              onOpenConversation={onOpenConversation}
                              onOpenWorker={onOpenWorker}
                            />
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <div className="mt-auto pt-2">
            <button
              type="button"
              aria-expanded={archivedOpen}
              className="flex h-9 w-fit cursor-pointer items-center gap-1.5 rounded-xl px-2 text-minor font-medium text-muted-foreground outline-none hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
              onClick={() => setArchivedOpen((v) => !v)}
            >
              <ChevronRight
                className={cn("size-4 shrink-0 transition-transform", archivedOpen && "rotate-90")}
                aria-hidden="true"
              />
              <span>Archived</span>
            </button>
            {archivedOpen && (
              <div className="mt-2 space-y-2.5">
                {archivedQuery.isLoading ? (
                  <div className="flex items-center gap-2 px-2 py-3 text-minor text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    <span>Loading archived items…</span>
                  </div>
                ) : archivedQuery.isError ? (
                  <div className="px-2">
                    <RowError error={errorText(archivedQuery.error)} />
                  </div>
                ) : archivedItems.length === 0 ? (
                  <p className="px-2 py-2 text-minor text-muted-foreground">No archived items yet</p>
                ) : (
                  <>
                    <ul className="space-y-2">
                      {archivedItems.map((item) => (
                        <ArchivedRow key={`arch-${item.id}`} item={item} />
                      ))}
                    </ul>
                    {archivedQuery.hasNextPage && (
                      <div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={archivedQuery.isFetchingNextPage}
                          onClick={() => void archivedQuery.fetchNextPage()}
                        >
                          {archivedQuery.isFetchingNextPage ? "Loading…" : "Load more"}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="composer-dock">
        <div className="chat-column">
          <DraftComposer
            draft={draft}
            staging={staging}
            placeholder="Tell Router, or type @ to pick a project…"
            source={composerSource}
            leadingChip={leadingChip}
            onSelectTarget={handleSelectTarget}
            onSend={handleComposerSend}
            autoFocus
          />
        </div>
      </div>
    </FileDropZone>
  );
}
