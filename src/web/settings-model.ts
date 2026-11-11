// 桌面弹窗（SettingsDialog）与手机二级钻取设置页（mobile/settings/*）100% 共用的无 UI 设置模型层。
// 集中管理：界面大小、通知受阻原因与摘要、电脑与隧道操作/摘要、登录链接与浏览器会话缓存、公网入口、跨厂商连接器同步及复制反馈。
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  normalizeName,
  type BrowserSessionInfo,
  type DeviceInviteResponse,
  type LoginLinkResponse,
  type PublicEntryStatus,
  type TunnelState,
  type TunnelStatus,
  type VendorSyncApplyResponse,
  type VendorSyncItemVendorStatus,
  type VendorSyncPreviewResponse,
} from "../shared/index.ts";
import {
  ApiError,
  deleteBrowserSession,
  deleteDevice,
  fetchBrowserSessions,
  patchDevice,
  postAddDevice,
  postApproveBrowserSession,
  postDeviceInvite,
  postLoginLink,
  postLogoutAll,
  postTunnelConnect,
  postTunnelRetry,
  putPublicEntry,
} from "./client.ts";
import { COPIED_RESET_MS, copyText } from "./components/CodeBlock.tsx";
import { useClient } from "./device-scope.tsx";
import type { DeviceView } from "./devices.ts";
import { errorText, nameError, type ErrorLike } from "./format.ts";
import type { NotifySettings } from "./notify.ts";
import { useHubQueryClient } from "./query-client.ts";
import {
  DEFAULT_UI_SCALE,
  UI_SCALES,
  UI_SCALE_LABELS,
  readUiScale,
  saveUiScale,
  subscribeUiScale,
  type UiScale,
} from "./ui-scale.ts";

export { COPIED_RESET_MS };

/** 设置模块所需的设备与入口状态：所有设备（入口本机第一）、本机隧道状态、公网入口状态与仓库路径，变更后回调刷新清单。 */
export interface DeviceSettings {
  devices: readonly DeviceView[];
  tunnel?: TunnelStatus | null;
  publicEntry?: PublicEntryStatus;
  repoDir?: string;
  onChanged: () => void;
}

// ---- 1. 界面大小 ----

export const UI_SCALE_OPTIONS: readonly { value: UiScale; label: string }[] = UI_SCALES.map((value) => ({
  value,
  label: UI_SCALE_LABELS[value],
}));

export function useUiScaleSetting() {
  const scale = useSyncExternalStore(subscribeUiScale, readUiScale, () => DEFAULT_UI_SCALE);
  const setScale = useCallback((next: UiScale) => {
    saveUiScale(next);
  }, []);
  return useMemo(
    () => ({
      scale,
      label: UI_SCALE_LABELS[scale],
      options: UI_SCALE_OPTIONS,
      setScale,
    }),
    [scale, setScale],
  );
}

// ---- 2. 推送通知 ----

/** 开关打不开时的具体解除引导；可正常开启的权限态为 undefined。 */
export const NOTIFY_BLOCKED: Partial<Record<NotifySettings["permission"], string>> = {
  denied: "Blocked by the browser. Allow notifications in site settings",
  unsupported: "This browser doesn't support notifications",
  install: "In Safari, tap Add to Home Screen, then open the app from its icon",
};

export function isNotifyBlocked(notify: Pick<NotifySettings, "permission">): boolean {
  return NOTIFY_BLOCKED[notify.permission] !== undefined;
}

export function describeNotifySummary(notify: Pick<NotifySettings, "enabled" | "permission">): "On" | "Off" {
  return notify.enabled && !isNotifyBlocked(notify) ? "On" : "Off";
}

// ---- 3. 电脑与隧道摘要 ----

export const TUNNEL_STATE_SPECS: Readonly<Record<TunnelState, { text: string; canRetry: boolean }>> = {
  connecting: { text: "Connecting…", canRetry: false },
  connected: { text: "Connected", canRetry: false },
  retrying: { text: "Retrying…", canRetry: true },
  auth_failed: { text: "Key rejected", canRetry: true },
  hostkey_mismatch: { text: "Server fingerprint changed", canRetry: true },
};

export type ComputersSummaryInput =
  | { devices: readonly Pick<DeviceView, "info" | "status">[]; tunnel?: TunnelStatus | null }
  | readonly Pick<DeviceView, "info" | "status">[];

interface CachedComputersSummary {
  devices: readonly Pick<DeviceView, "info" | "status">[];
  tunnel: TunnelStatus | null | undefined;
  summary: string;
}

const computersSummaryCache = new WeakMap<object, CachedComputersSummary>();

function computeComputersSummary(
  list: readonly Pick<DeviceView, "info" | "status">[],
  tunnel?: TunnelStatus | null,
): string {
  if (tunnel != null && TUNNEL_STATE_SPECS[tunnel.state].canRetry) return "Attention";
  const others = list.filter((d) => !d.info.self);
  if (others.length === 0) {
    if (list.some((d) => d.status === "offline" || d.status === "unreachable")) return "Offline";
    if (list.some((d) => d.status === "reconnecting")) return "Attention";
    return "This computer";
  }
  const onlineOthers = others.filter((d) => d.status === "online").length;
  if (onlineOthers > 0) {
    const onlineTotal = list.filter((d) => d.status === "online").length;
    return `${onlineTotal} online`;
  }
  if (others.some((d) => d.status === "reconnecting")) return "Attention";
  if (others.some((d) => d.status === "offline" || d.status === "unreachable")) return "Offline";
  return "This computer";
}

/** 计算电脑分组的一级单一摘要（严禁用 · / | / / 拼接），并按输入引用缓存。 */
export function describeComputersSummary(input: ComputersSummaryInput): string {
  const hasDevices = "devices" in input;
  const list = hasDevices ? input.devices : input;
  const tunnel = hasDevices ? input.tunnel : undefined;
  const cached = computersSummaryCache.get(input);
  if (cached !== undefined && cached.devices === list && cached.tunnel === tunnel) {
    return cached.summary;
  }
  const summary = computeComputersSummary(list, tunnel);
  computersSummaryCache.set(input, { devices: list, tunnel, summary });
  return summary;
}

// ---- 4. 复制反馈 ----

export function useCopyFeedback(resetMs: number = COPIED_RESET_MS): {
  copied: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
    };
  }, []);
  const copy = useCallback(
    (text: string) => {
      void copyText(text).then(() => {
        if (!mountedRef.current) return;
        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) setCopied(false);
        }, resetMs);
      });
    },
    [resetMs],
  );
  return useMemo(() => ({ copied, copy }), [copied, copy]);
}

// ---- 5. 设备改名、移除、邀请、添加、隧道与公网入口 ----

export function useDeviceRename(device: Pick<DeviceView, "info">, onChanged?: () => void) {
  const [name, setName] = useState(device.info.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const prevIdRef = useRef(device.info.id);
  if (prevIdRef.current !== device.info.id) {
    prevIdRef.current = device.info.id;
    setName(device.info.name);
    setBusy(false);
    setError(null);
  }
  const clean = normalizeName(name);
  const problem = nameError(name);
  const reset = useCallback(() => {
    setName(device.info.name);
    setBusy(false);
    setError(null);
  }, [device.info.name]);
  const save = useCallback(async (): Promise<"saved" | "unchanged" | false> => {
    if (clean === null || busy) return false;
    if (clean === device.info.name) return "unchanged";
    setBusy(true);
    setError(null);
    try {
      await patchDevice(device.info.id, { name: clean });
      setBusy(false);
      onChanged?.();
      return "saved";
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return false;
    }
  }, [busy, clean, device.info.id, device.info.name, onChanged]);
  return { name, setName, clean, problem, busy, error, save, reset };
}

export function useDeviceRemove(device: Pick<DeviceView, "info">, onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const clearError = useCallback(() => setError(null), []);
  const remove = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await deleteDevice(device.info.id);
      setBusy(false);
      onChanged?.();
      return true;
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      return false;
    }
  }, [busy, device.info.id, onChanged]);
  return { busy, error, remove, clearError };
}

export function useDeviceInvite() {
  const [invite, setInvite] = useState<DeviceInviteResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const codeCopy = useCopyFeedback();
  const urlCopy = useCopyFeedback();

  const generate = useCallback(async (): Promise<DeviceInviteResponse | null> => {
    if (busy) return null;
    setBusy(true);
    setError(null);
    try {
      const created = await postDeviceInvite();
      setInvite(created);
      return created;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const copyCode = useCallback(() => {
    if (invite !== null) codeCopy.copy(invite.code);
  }, [codeCopy, invite]);

  const copyUrl = useCallback(() => {
    if (invite?.url) urlCopy.copy(invite.url);
  }, [invite, urlCopy]);

  return {
    invite,
    busy,
    error,
    generate,
    codeCopied: codeCopy.copied,
    copyCode,
    urlCopied: urlCopy.copied,
    copyUrl,
  };
}

export function useAddDevice(onAdded?: () => void) {
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const ready = url.trim() !== "" && code.trim() !== "" && !busy;
  const submit = useCallback(async (): Promise<boolean> => {
    if (url.trim() === "" || code.trim() === "" || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await postAddDevice({ url: url.trim(), code: code.trim() });
      setUrl("");
      setCode("");
      onAdded?.();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, code, onAdded, url]);
  return { url, setUrl, code, setCode, ready, busy, error, submit };
}

export function buildTunnelJoinCommand(repoDir?: string): string {
  return `node ${repoDir ?? "~/agent-hub"}/src/tunnel/main.ts join -i ~/.ssh/<key> ubuntu@<server-ip>`;
}

export function useTunnelConnect(repoDir?: string, onConnected?: () => void) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const { copied, copy } = useCopyFeedback();
  const command = buildTunnelJoinCommand(repoDir);
  const ready = code.trim() !== "" && !busy;
  const copyCommand = useCallback(() => copy(command), [command, copy]);
  const submit = useCallback(async (): Promise<boolean> => {
    if (code.trim() === "" || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await postTunnelConnect(code.trim());
      setCode("");
      onConnected?.();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, code, onConnected]);
  return { command, code, setCode, ready, busy, error, copied, copyCommand, submit };
}

export function useTunnelRetry(onChanged?: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const retry = useCallback(async (): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await postTunnelRetry();
      onChanged?.();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy, onChanged]);
  return { busy, error, retry };
}

export const DEFAULT_PUBLIC_ENTRY: PublicEntryStatus = {
  enabled: false,
  hostname: null,
  funnelCommand: "sudo tailscale funnel --bg unix:/home/ubuntu/.agent-hub/run/public.sock",
};

export function describePublicEntrySummary(publicEntry?: Pick<PublicEntryStatus, "enabled"> | null): "On" | "Off" {
  return publicEntry?.enabled ? "On" : "Off";
}

export function usePublicEntrySetting(publicEntry?: PublicEntryStatus, onChanged?: () => void) {
  const initial = publicEntry ?? DEFAULT_PUBLIC_ENTRY;
  const [entry, setEntry] = useState<PublicEntryStatus>(initial);
  const [hostname, setHostname] = useState(initial.hostname ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorLike | null>(null);
  const { copied, copy } = useCopyFeedback();

  useEffect(() => {
    if (publicEntry !== undefined) {
      setEntry(publicEntry);
      setHostname(publicEntry.hostname ?? "");
    }
  }, [publicEntry]);

  const apply = useCallback(
    async (nextEnabled: boolean): Promise<boolean> => {
      if (busy) return false;
      const trimmed = hostname.trim();
      setBusy(true);
      setError(null);
      try {
        const next = await putPublicEntry({
          enabled: nextEnabled,
          ...(trimmed !== "" ? { hostname: trimmed } : {}),
        });
        setEntry(next);
        if (next.hostname !== null) setHostname(next.hostname);
        onChanged?.();
        return true;
      } catch (err) {
        setError(errorText(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, hostname, onChanged],
  );

  const toggle = useCallback(() => apply(!entry.enabled), [apply, entry.enabled]);
  const setEnabled = useCallback((nextEnabled: boolean) => apply(nextEnabled), [apply]);
  const saveHostname = useCallback(() => apply(entry.enabled), [apply, entry.enabled]);
  const copyCommand = useCallback(() => copy(entry.funnelCommand), [copy, entry.funnelCommand]);
  const trimmedHostname = hostname.trim();
  const hostnameDirty = trimmedHostname !== "" && trimmedHostname !== (entry.hostname ?? "");
  const summary: "On" | "Off" = describePublicEntrySummary(entry);

  return {
    entry,
    summary,
    hostname,
    setHostname,
    hostnameDirty,
    busy,
    error,
    copied,
    toggle,
    setEnabled,
    saveHostname,
    copyCommand,
  };
}

// ---- 6. 一次性登录链接与已登录浏览器会话 ----

/** 二维码显示期间，每隔多久刷新一次列表（另一台设备扫码登录上了，二维码就收起来）。 */
export const SESSIONS_POLL_MS = 3000;
/** “确认退出”等多久没再点就自动退回。 */
export const CONFIRM_TIMEOUT_MS = 5000;
/** 倒计时每秒走一次。 */
export const COUNTDOWN_TICK_MS = 1000;

export const BROWSER_SESSIONS_QUERY_KEY = ["browser-sessions"] as const;

const reloadPage = () => location.reload();

export function useSignInLink(sessions?: readonly BrowserSessionInfo[] | null) {
  const qc = useHubQueryClient();
  const { data: cachedSessions } = useQuery(
    {
      queryKey: BROWSER_SESSIONS_QUERY_KEY,
      queryFn: async () => (await fetchBrowserSessions()).sessions,
      enabled: false,
    },
    qc,
  );
  const effectiveSessions = sessions !== undefined ? sessions : (cachedSessions ?? null);
  const sessionsRef = useRef(effectiveSessions);
  sessionsRef.current = effectiveSessions;

  const [link, setLink] = useState<LoginLinkResponse | null>(null);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const minUpdateCountRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const { copied, copy } = useCopyFeedback();

  const expired = link !== null && now >= link.expiresAt;
  const polling = link !== null && !expired;

  useEffect(() => {
    if (link === null || expired) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), COUNTDOWN_TICK_MS);
    return () => clearInterval(tick);
  }, [link, expired]);

  const updateCount = qc.getQueryState(BROWSER_SESSIONS_QUERY_KEY)?.dataUpdateCount ?? 0;

  useEffect(() => {
    if (link === null || effectiveSessions === null) return;
    if (baseline === null) {
      if (sessions === undefined && updateCount < minUpdateCountRef.current) return;
      setBaseline(new Set(effectiveSessions.map((s) => s.id)));
      return;
    }
    if (effectiveSessions.some((s) => !baseline.has(s.id))) {
      setLink(null);
    }
  }, [baseline, effectiveSessions, link, sessions, updateCount]);

  const linkMutation = useMutation(
    {
      mutationFn: () => postLoginLink(),
      onMutate: () => {
        if (sessions !== undefined) {
          const current = sessionsRef.current;
          minUpdateCountRef.current = 0;
          setBaseline(current === null ? null : new Set(current.map((s) => s.id)));
          return;
        }
        const query = qc.getQueryCache().find({ queryKey: BROWSER_SESSIONS_QUERY_KEY });
        const hasLiveObserver = query?.observers.some((obs) => obs.options.enabled !== false) ?? false;
        const currentUpdateCount = qc.getQueryState(BROWSER_SESSIONS_QUERY_KEY)?.dataUpdateCount ?? 0;
        if (hasLiveObserver && sessionsRef.current !== null) {
          minUpdateCountRef.current = 0;
          setBaseline(new Set(sessionsRef.current.map((s) => s.id)));
        } else {
          minUpdateCountRef.current = currentUpdateCount + 1;
          setBaseline(null);
        }
      },
      onSuccess: (created) => {
        setNow(Date.now());
        setLink(created);
      },
    },
    qc,
  );

  const generate = useCallback(() => linkMutation.mutate(), [linkMutation]);
  const hide = useCallback(() => setLink(null), []);
  const copyLink = useCallback(() => {
    if (link !== null) copy(link.url);
  }, [copy, link]);

  return {
    link,
    now,
    expired,
    polling,
    remainingMs: link === null ? 0 : link.expiresAt - now,
    busy: linkMutation.isPending,
    error: linkMutation.error ? errorText(linkMutation.error) : null,
    copied,
    generate,
    hide,
    copyLink,
  };
}

export interface UseBrowserSessionsOptions {
  enabled?: boolean;
  pollWhileActive?: boolean;
  onSignedOut?: () => void;
}

export function useBrowserSessions({
  enabled = true,
  pollWhileActive = false,
  onSignedOut = reloadPage,
}: UseBrowserSessionsOptions = {}) {
  const qc = useHubQueryClient();
  const [rowErrors, setRowErrors] = useState<Record<string, ErrorLike>>({});
  const [confirmingSelf, setConfirmingSelf] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);

  const { data: rawSessions, error: queryError } = useQuery(
    {
      queryKey: BROWSER_SESSIONS_QUERY_KEY,
      queryFn: async () => (await fetchBrowserSessions()).sessions,
      enabled,
      staleTime: 0,
      refetchInterval: enabled && pollWhileActive ? SESSIONS_POLL_MS : false,
    },
    qc,
  );

  const sessions = useMemo(
    () =>
      !enabled || rawSessions === undefined
        ? null
        : rawSessions.toSorted((a, b) => (a.status === "pending_approval" ? 0 : 1) - (b.status === "pending_approval" ? 0 : 1)),
    [enabled, rawSessions],
  );
  const hasPending = useMemo(() => sessions?.some((s) => s.status === "pending_approval") ?? false, [sessions]);
  const loadError: ErrorLike | null = enabled && queryError ? errorText(queryError) : null;

  useEffect(() => {
    if (!confirmingSelf) return;
    const timer = setTimeout(() => setConfirmingSelf(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmingSelf]);

  useEffect(() => {
    if (!confirmingAll) return;
    const timer = setTimeout(() => setConfirmingAll(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [confirmingAll]);

  const exitMutation = useMutation(
    {
      mutationFn: async (session: BrowserSessionInfo) => {
        try {
          await deleteBrowserSession(session.id);
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
      },
      onMutate: (session) => {
        setRowErrors(({ [session.id]: _gone, ...rest }) => rest);
      },
      onSuccess: (_data, session) => {
        if (session.current) {
          onSignedOut();
          return;
        }
        qc.setQueryData<BrowserSessionInfo[]>(BROWSER_SESSIONS_QUERY_KEY, (list) => list?.filter((s) => s.id !== session.id));
      },
      onError: (err, session) => {
        setRowErrors((errors) => ({ ...errors, [session.id]: errorText(err) }));
        if (session.current) setConfirmingSelf(false);
      },
    },
    qc,
  );

  const approveMutation = useMutation(
    {
      mutationFn: (session: BrowserSessionInfo) => postApproveBrowserSession(session.id),
      onMutate: (session) => {
        setRowErrors(({ [session.id]: _gone, ...rest }) => rest);
      },
      onSuccess: (_data, session) => {
        qc.setQueryData<BrowserSessionInfo[]>(BROWSER_SESSIONS_QUERY_KEY, (list) =>
          list?.map((s) => (s.id === session.id ? { ...s, status: "active" } : s)),
        );
      },
      onError: (err, session) => {
        setRowErrors((errors) => ({ ...errors, [session.id]: errorText(err) }));
      },
    },
    qc,
  );

  const exitAllMutation = useMutation(
    {
      mutationFn: () => postLogoutAll(),
      onSuccess: () => onSignedOut(),
      onError: () => setConfirmingAll(false),
    },
    qc,
  );

  const busy = exitMutation.isPending
    ? `exit:${exitMutation.variables.id}`
    : approveMutation.isPending
      ? `approve:${approveMutation.variables.id}`
      : exitAllMutation.isPending
        ? "all"
        : null;
  const allError: ErrorLike | null = exitAllMutation.error ? errorText(exitAllMutation.error) : null;

  const signOut = useCallback((session: BrowserSessionInfo) => exitMutation.mutate(session), [exitMutation]);
  const signOutAsync = useCallback((session: BrowserSessionInfo) => exitMutation.mutateAsync(session), [exitMutation]);
  const approve = useCallback((session: BrowserSessionInfo) => approveMutation.mutate(session), [approveMutation]);
  const approveAsync = useCallback((session: BrowserSessionInfo) => approveMutation.mutateAsync(session), [approveMutation]);
  const signOutAll = useCallback(() => exitAllMutation.mutate(), [exitAllMutation]);
  const signOutAllAsync = useCallback(() => exitAllMutation.mutateAsync(), [exitAllMutation]);

  return {
    sessions,
    hasPending,
    loadError,
    rowErrors,
    allError,
    busy,
    confirmingSelf,
    setConfirmingSelf,
    confirmingAll,
    setConfirmingAll,
    signOut,
    signOutAsync,
    approve,
    approveAsync,
    signOutAll,
    signOutAllAsync,
  };
}

export interface BrowserSessionsSummary {
  /** 已缓存的会话数；尚未拉取过时为 null。 */
  count: number | null;
  /** 是否存在待批准（pending_approval）的公网会话。 */
  hasPending: boolean;
  /** 一级导航行右侧直接展示的单一摘要文案（未拉取为 undefined，有待批为 "Pending"，否则为数量字符串）。 */
  summary: string | undefined;
}

const EMPTY_BROWSER_SESSIONS_SUMMARY: BrowserSessionsSummary = {
  count: null,
  hasPending: false,
  summary: undefined,
};

/** 只读 queryClient 中已有的 ["browser-sessions"] 缓存（enabled: false，0 网络请求）。 */
export function useCachedBrowserSessionsSummary(): BrowserSessionsSummary {
  const qc = useHubQueryClient();
  const { data } = useQuery(
    {
      queryKey: BROWSER_SESSIONS_QUERY_KEY,
      queryFn: async () => (await fetchBrowserSessions()).sessions,
      enabled: false,
    },
    qc,
  );
  return useMemo(() => {
    if (data === undefined) return EMPTY_BROWSER_SESSIONS_SUMMARY;
    const hasPending = data.some((s) => s.status === "pending_approval");
    return {
      count: data.length,
      hasPending,
      summary: hasPending ? "Pending" : String(data.length),
    };
  }, [data]);
}

// ---- 7. 跨厂商 MCP 与技能并集同步 ----

export const VENDOR_STATUS_LABELS: Readonly<Record<VendorSyncItemVendorStatus, string>> = {
  present: "Synced",
  will_add: "Add",
  kept: "Kept existing",
  mcp_remote: "mcp-remote",
  native: "Native",
  symlink: "Linked",
  will_link: "Link",
  conflict: "Private preserved",
};

export const DEFAULT_VENDOR_SYNC_DETAIL = "Merge MCP servers and skills across installed providers";

export function formatVendorSyncSummary(result: VendorSyncApplyResponse): string {
  const parts: string[] = [];
  if (result.syncedMcpCount > 0) parts.push(`${result.syncedMcpCount} MCP synced`);
  if (result.removedMcpCount > 0) parts.push(`${result.removedMcpCount} MCP removed`);
  if (result.linkedSkillCount > 0) parts.push(`${result.linkedSkillCount} skills linked`);
  if (result.unlinkedSkillCount > 0) parts.push(`${result.unlinkedSkillCount} skills unlinked`);
  if (result.preservedPrivateSkillCount > 0) parts.push(`${result.preservedPrivateSkillCount} private skills kept`);
  if (parts.length === 0) return "All providers are already up to date";
  return parts.join(", ");
}

export function useVendorSyncSetting() {
  const qc = useHubQueryClient();
  const client = useClient();
  const [preview, setPreview] = useState<VendorSyncPreviewResponse | null>(null);
  const [checkedMcp, setCheckedMcp] = useState<ReadonlySet<string>>(() => new Set());
  const [checkedSkills, setCheckedSkills] = useState<ReadonlySet<string>>(() => new Set());
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const applyMutation = useMutation(
    {
      mutationFn: () => {
        if (!preview) throw new Error("No preview loaded");
        const selectedMcpKeys: string[] = [];
        const removeMcpKeys: string[] = [];
        for (const item of preview.mcpServers) {
          if (checkedMcp.has(item.key)) {
            selectedMcpKeys.push(item.key);
          } else {
            removeMcpKeys.push(item.key);
          }
        }
        const selectedSkillKeys: string[] = [];
        const removeSkillKeys: string[] = [];
        for (const item of preview.skills) {
          if (checkedSkills.has(item.key)) {
            selectedSkillKeys.push(item.key);
          } else {
            removeSkillKeys.push(item.key);
          }
        }
        return client.postVendorSyncApply({
          selectedMcpKeys,
          removeMcpKeys,
          selectedSkillKeys,
          removeSkillKeys,
        });
      },
      onSuccess: (result) => {
        setLastSummary(formatVendorSyncSummary(result));
        setPreview(null);
      },
    },
    qc,
  );

  const scanMutation = useMutation(
    {
      mutationFn: () => client.fetchVendorSyncPreview(),
      onSuccess: (data) => {
        setCheckedMcp(new Set(data.mcpServers.map((item) => item.key)));
        setCheckedSkills(new Set(data.skills.map((item) => item.key)));
        applyMutation.reset();
        setPreview(data);
      },
    },
    qc,
  );

  const toggleMcp = useCallback((key: string, nextChecked: boolean) => {
    setCheckedMcp((prev) => {
      const next = new Set(prev);
      if (nextChecked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const toggleSkill = useCallback((key: string, nextChecked: boolean) => {
    setCheckedSkills((prev) => {
      const next = new Set(prev);
      if (nextChecked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const previewVendorSync = useCallback(() => scanMutation.mutate(), [scanMutation]);
  const applyVendorSync = useCallback(() => applyMutation.mutate(), [applyMutation]);
  const closePreview = useCallback(() => {
    if (!applyMutation.isPending) setPreview(null);
  }, [applyMutation.isPending]);

  const scanError: ErrorLike | null = scanMutation.error ? errorText(scanMutation.error) : null;
  const applyError: ErrorLike | null = applyMutation.error ? errorText(applyMutation.error) : null;
  const hasSyncableItems = preview !== null && (preview.mcpServers.length > 0 || preview.skills.length > 0);
  const isEmptyPreview =
    preview !== null &&
    preview.mcpServers.length === 0 &&
    preview.skills.length === 0 &&
    preview.nonSyncable.length === 0;

  return {
    preview,
    checkedMcp,
    checkedSkills,
    lastSummary,
    summary: lastSummary ?? DEFAULT_VENDOR_SYNC_DETAIL,
    scanning: scanMutation.isPending,
    applying: applyMutation.isPending,
    scanError,
    applyError,
    hasSyncableItems,
    isEmptyPreview,
    previewVendorSync,
    applyVendorSync,
    toggleMcp,
    toggleSkill,
    closePreview,
  };
}
