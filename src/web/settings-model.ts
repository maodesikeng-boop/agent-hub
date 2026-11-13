// 桌面弹窗（SettingsDialog）与手机二级钻取设置页（mobile/settings/*）100% 共用的无 UI 设置模型层。
// 集中管理：界面大小、通知受阻原因与摘要、电脑与隧道操作/摘要、登录链接与浏览器会话缓存、公网入口、跨厂商连接器同步及复制反馈。
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  PROVIDER_ACTIVE_POLL_MS,
  isSelectable,
  normalizeName,
  type AgentVendor,
  type BrowserSessionInfo,
  type DeviceInviteResponse,
  type LoginLinkResponse,
  type ModelCatalog,
  type ProviderAuthFlowPhase,
  type ProviderAuthMethodDescriptor,
  type ProviderAuthTarget,
  type ProviderCancelAuthRequest,
  type ProviderCancelJobRequest,
  type ProviderLogoutRequest,
  type ProviderSaveApiKeyRequest,
  type ProviderStartAuthRequest,
  type ProviderStatusItem,
  type ProviderSubmitAuthRequest,
  type ProvidersStatusResponse,
  type PublicEntryStatus,
  type TunnelState,
  type TunnelStatus,
  type VendorAvailability,
  type VendorSyncApplyResponse,
  type VendorSyncItemVendorStatus,
  type VendorSyncPreviewResponse,
} from "../shared/index.ts";
import {
  ApiError,
  createClient,
  deleteBrowserSession,
  deleteDevice,
  fetchBrowserSessions,
  localClient,
  patchDevice,
  postAddDevice,
  postApproveBrowserSession,
  postDeviceInvite,
  postLoginLink,
  postLogoutAll,
  postTunnelConnect,
  postTunnelRetry,
  putPublicEntry,
  type HubClient,
} from "./client.ts";
import { COPIED_RESET_MS, copyText } from "./components/CodeBlock.tsx";
import { useClient } from "./device-scope.tsx";
import { LOCAL_DEVICE, isReadOnly, type DeviceKey, type DeviceView } from "./devices.ts";
import { errorText, nameError, type ErrorLike } from "./format.ts";
import { modelsQueryKey, refreshDeviceModels } from "./models.tsx";
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

export function useVendorSyncSetting(explicitClient?: HubClient) {
  const qc = useHubQueryClient();
  const contextClient = useClient();
  const client = explicitClient ?? contextClient;
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

// ---- 8. Providers 一键安装、更新与界面内直接登录 ----

export const PROVIDERS_QUERY_KEY = (deviceKey: string) => ["providers", deviceKey] as const;

export interface ProvidersSummary {
  /** 一级导航行右侧直接展示的单一摘要文案（未拉取为 undefined，0 家可用为 "Attention"，否则为 "N ready"）。 */
  readonly summary: string | undefined;
  /** 是否需要亮起琥珀色关注点（0 家就绪时为 true）。 */
  readonly attention: boolean;
}

const EMPTY_PROVIDERS_SUMMARY: ProvidersSummary = {
  summary: undefined,
  attention: false,
};

const providersSummaryCache = new WeakMap<readonly { readonly availability: VendorAvailability }[], ProvidersSummary>();

/** 计算手机一级设置页 Providers 导航行摘要（严禁用 · / | / / 拼接），按输入数组引用 WeakMap 缓存。 */
export function describeProvidersSummary(
  items: readonly { readonly availability: VendorAvailability }[] | null | undefined,
): ProvidersSummary {
  if (!items || items.length === 0) return EMPTY_PROVIDERS_SUMMARY;
  const cached = providersSummaryCache.get(items);
  if (cached !== undefined) return cached;
  const readyCount = items.filter((item) => isSelectable(item.availability)).length;
  const computed: ProvidersSummary =
    readyCount === 0
      ? { summary: "Attention", attention: true }
      : { summary: `${readyCount} ready`, attention: false };
  providersSummaryCache.set(items, computed);
  return computed;
}

/** 只读 queryClient 中已有的本机 providers / models 缓存（enabled: false，严格 0 次网络请求）。 */
export function useCachedProvidersSummary(): ProvidersSummary {
  const qc = useHubQueryClient();
  const { data: cachedProviders } = useQuery(
    {
      queryKey: PROVIDERS_QUERY_KEY(LOCAL_DEVICE),
      queryFn: () => localClient.fetchProviders(),
      enabled: false,
    },
    qc,
  );
  const { data: cachedModels } = useQuery(
    {
      queryKey: modelsQueryKey(LOCAL_DEVICE),
      queryFn: () => Promise.resolve<ModelCatalog[]>([]),
      enabled: false,
    },
    qc,
  );
  const providersUpdatedAt = qc.getQueryState(PROVIDERS_QUERY_KEY(LOCAL_DEVICE))?.dataUpdatedAt ?? 0;
  const modelsUpdatedAt = qc.getQueryState(modelsQueryKey(LOCAL_DEVICE))?.dataUpdatedAt ?? 0;

  return useMemo(() => {
    if (cachedProviders !== undefined && cachedProviders.providers.length > 0 && providersUpdatedAt >= modelsUpdatedAt) {
      return describeProvidersSummary(cachedProviders.providers);
    }
    if (cachedModels !== undefined && cachedModels.length > 0) {
      return describeProvidersSummary(cachedModels);
    }
    if (cachedProviders !== undefined && cachedProviders.providers.length > 0) {
      return describeProvidersSummary(cachedProviders.providers);
    }
    return EMPTY_PROVIDERS_SUMMARY;
  }, [cachedModels, cachedProviders, modelsUpdatedAt, providersUpdatedAt]);
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

export function isProviderAuthFlowActive(phase: ProviderAuthFlowPhase): boolean {
  return (
    phase === "starting" ||
    phase === "waiting_browser" ||
    phase === "waiting_device_code" ||
    phase === "verifying"
  );
}

export function hasActiveProviderWork(status: ProvidersStatusResponse | null | undefined): boolean {
  if (!status) return false;
  if (status.gitJob?.phase === "running") return true;
  return status.providers.some(
    (item) => item.job?.phase === "running" || (item.authFlow !== null && isProviderAuthFlowActive(item.authFlow.phase)),
  );
}

/** 提取多子模型商聚合目标列表；单厂商返回 null。 */
export function extractProviderAuthTargets(
  methods: readonly ProviderAuthMethodDescriptor[],
): readonly ProviderAuthTarget[] | null {
  for (const method of methods) {
    if (method.kind === "api_key" && method.targets && method.targets.length > 0) {
      return method.targets;
    }
  }
  return null;
}

/** 按当前选中的子模型商 targetId 过滤可用登录方法。 */
export function visibleAuthMethodsForTarget(
  methods: readonly ProviderAuthMethodDescriptor[],
  targetId: string | undefined,
): readonly ProviderAuthMethodDescriptor[] {
  return methods.filter(
    (method) =>
      method.kind === "api_key" ||
      method.targetIds === undefined ||
      (targetId !== undefined && method.targetIds.includes(targetId)),
  );
}

/** 根据当前目标是否为远端无头访问，选出默认推荐的登录方法 ID。 */
export function defaultProviderAuthMethodId(
  methods: readonly ProviderAuthMethodDescriptor[],
  isRemoteTarget: boolean,
): string | null {
  if (methods.length === 0) return null;
  const first = methods[0]!;
  if (isRemoteTarget && first.kind === "browser_oauth" && first.preferDeviceCodeWhenRemote) {
    const deviceCode = methods.find((m) => m.kind === "device_code");
    if (deviceCode) return deviceCode.id;
  }
  return first.id;
}

/** 当存在 >= 2 台在线设备时返回可选的电脑列表；否则返回空数组（单机模式隐藏 Computer 选择行）。 */
export function resolveSelectableProviderComputers(
  devices: readonly DeviceView[] | null | undefined,
): readonly DeviceView[] {
  if (!devices || devices.length < 2) return [];
  const online = devices.filter((d) => d.key === LOCAL_DEVICE || !isReadOnly(d.status));
  return online.length >= 2 ? online : [];
}

function subscribePageVisibility(onStoreChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

function getPageVisibilitySnapshot(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export interface UseProvidersSettingOptions {
  enabled?: boolean;
  devices?: readonly DeviceView[] | null;
  defaultDeviceKey?: DeviceKey;
}

export function useProvidersSetting({
  enabled = true,
  devices = null,
  defaultDeviceKey = LOCAL_DEVICE,
}: UseProvidersSettingOptions = {}) {
  const qc = useHubQueryClient();
  const contextClient = useClient();
  const selectableComputers = useMemo(() => resolveSelectableProviderComputers(devices), [devices]);

  const pickValidDeviceKey = useCallback(
    (candidate: DeviceKey): DeviceKey => {
      if (selectableComputers.length === 0) {
        return contextClient.device ?? LOCAL_DEVICE;
      }
      return selectableComputers.some((d) => d.key === candidate) ? candidate : LOCAL_DEVICE;
    },
    [contextClient.device, selectableComputers],
  );

  const [selectedDeviceKey, setSelectedDeviceKey] = useState<DeviceKey>(() => pickValidDeviceKey(defaultDeviceKey));
  const prevDefaultRef = useRef(defaultDeviceKey);
  if (prevDefaultRef.current !== defaultDeviceKey) {
    prevDefaultRef.current = defaultDeviceKey;
    const nextKey = pickValidDeviceKey(defaultDeviceKey);
    if (nextKey !== selectedDeviceKey) {
      setSelectedDeviceKey(nextKey);
    }
  }

  const effectiveDeviceKey: DeviceKey =
    selectableComputers.length > 0
      ? selectableComputers.some((d) => d.key === selectedDeviceKey)
        ? selectedDeviceKey
        : LOCAL_DEVICE
      : (contextClient.device ?? LOCAL_DEVICE);

  const targetClient = useMemo<HubClient>(() => {
    if (selectableComputers.length === 0) return contextClient;
    return effectiveDeviceKey === LOCAL_DEVICE ? localClient : createClient(effectiveDeviceKey);
  }, [contextClient, effectiveDeviceKey, selectableComputers.length]);

  const isRemoteTarget =
    effectiveDeviceKey !== LOCAL_DEVICE ||
    (typeof window !== "undefined" && !isLoopbackHostname(window.location.hostname));

  const pageVisible = useSyncExternalStore(subscribePageVisibility, getPageVisibilitySnapshot, () => true);

  const [rowErrors, setRowErrors] = useState<Partial<Record<AgentVendor, ErrorLike>>>({});
  const [gitError, setGitError] = useState<ErrorLike | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const queryKey = useMemo(() => PROVIDERS_QUERY_KEY(effectiveDeviceKey), [effectiveDeviceKey]);

  const {
    data: status,
    error: queryError,
    isFetching,
  } = useQuery(
    {
      queryKey,
      queryFn: () => targetClient.fetchProviders(),
      enabled,
      staleTime: 0,
      refetchInterval: (query) =>
        enabled && pageVisible && hasActiveProviderWork(query.state.data) ? PROVIDER_ACTIVE_POLL_MS : false,
    },
    qc,
  );

  // 追踪后台异步任务与登录流从“进行中”跨入“成功”的瞬间，自动联动刷新对应设备的 ["models", deviceKey] 缓存
  const trackedActiveRef = useRef<{ jobs: Set<string>; flows: Set<string> }>({
    jobs: new Set(),
    flows: new Set(),
  });
  useEffect(() => {
    if (!status) return;
    let anyJustSucceeded = false;
    const nextJobs = new Set<string>();
    const nextFlows = new Set<string>();
    for (const item of status.providers) {
      if (item.job) {
        if (item.job.phase === "running") {
          nextJobs.add(item.job.jobId);
        } else if (item.job.phase === "succeeded" && trackedActiveRef.current.jobs.has(item.job.jobId)) {
          anyJustSucceeded = true;
        }
      }
      if (item.authFlow) {
        if (isProviderAuthFlowActive(item.authFlow.phase)) {
          nextFlows.add(item.authFlow.flowId);
        } else if (item.authFlow.phase === "succeeded" && trackedActiveRef.current.flows.has(item.authFlow.flowId)) {
          anyJustSucceeded = true;
        }
      }
    }
    trackedActiveRef.current = { jobs: nextJobs, flows: nextFlows };
    if (anyJustSucceeded) {
      refreshDeviceModels(qc, targetClient);
    }
  }, [qc, status, targetClient]);

  const clearVendorError = useCallback((vendor: AgentVendor) => {
    setRowErrors((prev) => {
      if (prev[vendor] === undefined) return prev;
      const { [vendor]: _removed, ...rest } = prev;
      return rest;
    });
  }, []);

  const upsertItem = useCallback(
    (item: ProviderStatusItem) => {
      qc.setQueryData<ProvidersStatusResponse>(queryKey, (prev) =>
        prev === undefined
          ? undefined
          : {
              ...prev,
              providers: prev.providers.map((existing) => (existing.vendor === item.vendor ? item : existing)),
            },
      );
    },
    [qc, queryKey],
  );

  const refresh = useCallback(async (): Promise<void> => {
    setBusyKey("refresh");
    try {
      const next = await targetClient.fetchProviders({ refresh: true });
      qc.setQueryData<ProvidersStatusResponse>(queryKey, next);
      refreshDeviceModels(qc, targetClient);
    } catch {
      // 刷新失败保留已有缓存或交由 queryError 展示
    } finally {
      setBusyKey((cur) => (cur === "refresh" ? null : cur));
    }
  }, [qc, queryKey, targetClient]);

  const runVendorAction = useCallback(
    async (
      vendor: AgentVendor,
      actionName: string,
      fn: () => Promise<ProviderStatusItem>,
      options: { syncModelsImmediately?: boolean; rethrow?: boolean } = {},
    ): Promise<ProviderStatusItem | null> => {
      const token = `${actionName}:${vendor}`;
      setBusyKey(token);
      clearVendorError(vendor);
      try {
        const item = await fn();
        upsertItem(item);
        if (options.syncModelsImmediately) {
          refreshDeviceModels(qc, targetClient);
        }
        return item;
      } catch (err) {
        if (options.rethrow) throw err;
        setRowErrors((prev) => ({ ...prev, [vendor]: errorText(err) }));
        return null;
      } finally {
        setBusyKey((cur) => (cur === token ? null : cur));
      }
    },
    [clearVendorError, qc, targetClient, upsertItem],
  );

  const install = useCallback(
    (vendor: AgentVendor) => runVendorAction(vendor, "install", () => targetClient.postProviderInstall(vendor)),
    [runVendorAction, targetClient],
  );

  const update = useCallback(
    (vendor: AgentVendor) => runVendorAction(vendor, "update", () => targetClient.postProviderUpdate(vendor)),
    [runVendorAction, targetClient],
  );

  const cancelJob = useCallback(
    (vendor: AgentVendor, body: ProviderCancelJobRequest) =>
      runVendorAction(vendor, "cancel-job", () => targetClient.postProviderJobCancel(vendor, body)),
    [runVendorAction, targetClient],
  );

  const installGit = useCallback(async (): Promise<ProvidersStatusResponse | null> => {
    setBusyKey("git");
    setGitError(null);
    try {
      const next = await targetClient.postProviderGitInstall();
      qc.setQueryData<ProvidersStatusResponse>(queryKey, next);
      return next;
    } catch (err) {
      setGitError(errorText(err));
      return null;
    } finally {
      setBusyKey((cur) => (cur === "git" ? null : cur));
    }
  }, [qc, queryKey, targetClient]);

  const startAuth = useCallback(
    (vendor: AgentVendor, body: ProviderStartAuthRequest) =>
      runVendorAction(vendor, "auth-start", () => targetClient.postProviderAuthStart(vendor, body), { rethrow: true }),
    [runVendorAction, targetClient],
  );

  const submitAuth = useCallback(
    (vendor: AgentVendor, body: ProviderSubmitAuthRequest) =>
      runVendorAction(
        vendor,
        "auth-submit",
        () => targetClient.postProviderAuthSubmit(vendor, body),
        { syncModelsImmediately: true, rethrow: true },
      ),
    [runVendorAction, targetClient],
  );

  const cancelAuth = useCallback(
    (vendor: AgentVendor, body: ProviderCancelAuthRequest) =>
      runVendorAction(vendor, "auth-cancel", () => targetClient.postProviderAuthCancel(vendor, body)),
    [runVendorAction, targetClient],
  );

  const saveApiKey = useCallback(
    (vendor: AgentVendor, body: ProviderSaveApiKeyRequest) =>
      runVendorAction(
        vendor,
        "auth-api-key",
        () => targetClient.postProviderAuthApiKey(vendor, body),
        { syncModelsImmediately: true, rethrow: true },
      ),
    [runVendorAction, targetClient],
  );

  const logout = useCallback(
    (vendor: AgentVendor, body: ProviderLogoutRequest = {}) =>
      runVendorAction(
        vendor,
        "auth-logout",
        () => targetClient.postProviderAuthLogout(vendor, body),
        { syncModelsImmediately: true, rethrow: true },
      ),
    [runVendorAction, targetClient],
  );

  const selectDevice = useCallback((nextKey: DeviceKey) => {
    setRowErrors({});
    setGitError(null);
    setSelectedDeviceKey(nextKey);
  }, []);

  const loadError: ErrorLike | null = enabled && queryError && !status ? errorText(queryError) : null;

  return useMemo(
    () => ({
      status: status ?? null,
      loading: enabled && status === undefined && isFetching,
      refreshing: busyKey === "refresh",
      busyKey,
      loadError,
      rowErrors,
      gitError,
      selectableComputers,
      deviceKey: effectiveDeviceKey,
      selectDevice,
      targetClient,
      isRemoteTarget,
      refresh,
      install,
      update,
      cancelJob,
      installGit,
      startAuth,
      submitAuth,
      cancelAuth,
      saveApiKey,
      logout,
    }),
    [
      busyKey,
      cancelAuth,
      cancelJob,
      effectiveDeviceKey,
      enabled,
      gitError,
      install,
      installGit,
      isFetching,
      isRemoteTarget,
      loadError,
      logout,
      refresh,
      rowErrors,
      saveApiKey,
      selectDevice,
      selectableComputers,
      startAuth,
      status,
      submitAuth,
      targetClient,
      update,
    ],
  );
}

export type ProvidersSettingModel = ReturnType<typeof useProvidersSetting>;
