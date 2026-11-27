import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  PROVIDER_ACTIVE_POLL_MS,
  normalizeName,
  type AgentVendor,
  type AccountStatusView,
  type BrowserSessionInfo,
  type DeviceId,
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
  type VendorAvailability,
  type VendorSyncApplyRequest,
  type VendorSyncApplyResponse,
  type VendorSyncItemVendorStatus,
  type VendorSyncMcpPreviewItem,
  type VendorSyncPreviewResponse,
  type VendorSyncVendorBadge,
} from "../shared/index.ts";
import {
  ApiError,
  cancelAccountLogin,
  createClient,
  deleteBrowserSession,
  deleteDevice,
  fetchAccount,
  fetchBrowserSessions,
  localClient,
  patchDevice,
  postAccountLogin,
  postAccountLogout,
  postApprovalAnswer,
  postApprovalBegin,
  postLoginLink,
  postLogoutAll,
  putCenterPriority,
  type HubClient,
} from "./client.ts";
import { COPIED_RESET_MS, copyText } from "./components/CodeBlock.tsx";
import { useClient } from "./device-scope.tsx";
import { LOCAL_DEVICE, isReadOnly, type DeviceKey, type DeviceView } from "./devices.ts";
import { errorText, nameError, type ErrorLike } from "./format.ts";
import { SECOND_TICK_MS } from "./limits.ts";
import { modelsQueryKey } from "./models.tsx";
import type { NotifySettings } from "./notify.ts";
import { ACCOUNT_QUERY_KEY, accountQueryFn, claimAccountTicket, commitAccountStatus, useHubQueryClient } from "./query-client.ts";
import { refreshProviderData } from "./quota.ts";

export { ACCOUNT_QUERY_KEY };
import {
  DEFAULT_UI_SCALE,
  UI_SCALES,
  UI_SCALE_LABELS,
  readUiScale,
  saveUiScale,
  subscribeUiScale,
  type UiScale,
} from "./ui-scale.ts";
import { useNow } from "./useNow.ts";

export { COPIED_RESET_MS };

export interface DeviceSettings {
  devices: readonly DeviceView[];
  onChanged: () => void;
}

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

export type ComputersSummaryInput = { devices: readonly Pick<DeviceView, "info" | "status">[] } | readonly Pick<DeviceView, "info" | "status">[];

const computersSummaryCache = new WeakMap<object, { devices: readonly Pick<DeviceView, "info" | "status">[]; summary: string }>();

function computeComputersSummary(list: readonly Pick<DeviceView, "info" | "status">[]): string {
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

export function describeComputersSummary(input: ComputersSummaryInput): string {
  const list = "devices" in input ? input.devices : input;
  const cached = computersSummaryCache.get(input);
  if (cached !== undefined && cached.devices === list) return cached.summary;
  const summary = computeComputersSummary(list);
  computersSummaryCache.set(input, { devices: list, summary });
  return summary;
}

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

export function useDeviceRename(device: Pick<DeviceView, "info">, onChanged?: () => void, draft?: { name: string; setName: (name: string) => void }) {
  const [localName, setLocalName] = useState(device.info.name);
  const { name = localName, setName = setLocalName } = draft ?? {};
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
  return { name, setName, clean, problem, busy, error, save };
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

export function useAccount() {
  const qc = useHubQueryClient();
  const query = useQuery({ queryKey: ACCOUNT_QUERY_KEY, queryFn: accountQueryFn(qc, fetchAccount), staleTime: Infinity }, qc);
  const [error, setError] = useState<ErrorLike | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const run = useCallback(
    async (key: string, action: () => Promise<AccountStatusView | void>): Promise<boolean> => {
      if (busy !== null) return false;
      const ticket = claimAccountTicket(qc);
      setBusy(key);
      setError(null);
      try {
        const next = await action();
        if (mountedRef.current && next !== undefined) commitAccountStatus(qc, ticket, next);
        return true;
      } catch (err) {
        if (mountedRef.current) setError(errorText(err));
        return false;
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [busy, qc],
  );
  return {
    status: query.data ?? null,
    loadError: query.error ? errorText(query.error) : null,
    error,
    busy,
    signIn: (relayUrl?: string) => run("login", () => postAccountLogin(relayUrl ? { relayUrl } : {})),
    cancelSignIn: () => run("cancel", cancelAccountLogin),
    signOut: () => run("logout", postAccountLogout),
    beginApproval: (requestId: string) => run(`begin:${requestId}`, () => postApprovalBegin(requestId)),
    answerApproval: (requestId: string, match: boolean) => run(`answer:${requestId}`, () => postApprovalAnswer(requestId, match)),
    setPriority: (priority: DeviceId[]) => run("priority", () => putCenterPriority(priority)),
  };
}

export function movePriority(priority: readonly DeviceId[], id: DeviceId, delta: -1 | 1): DeviceId[] {
  const from = priority.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= priority.length) return [...priority];
  const next = [...priority];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export const SESSIONS_POLL_MS = 3000;
export const CONFIRM_TIMEOUT_MS = 5000;

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
  const now = useNow(SECOND_TICK_MS, link?.expiresAt ?? null);
  const { copied, copy } = useCopyFeedback();

  const expired = link !== null && now >= link.expiresAt;
  const polling = link !== null && !expired;

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
      onSuccess: (created) => setLink(created),
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

  const sessions = !enabled || rawSessions === undefined ? null : rawSessions;
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

  const exitAllMutation = useMutation(
    {
      mutationFn: () => postLogoutAll(),
      onSuccess: () => onSignedOut(),
      onError: () => setConfirmingAll(false),
    },
    qc,
  );

  const busy = exitMutation.isPending ? `exit:${exitMutation.variables.id}` : exitAllMutation.isPending ? "all" : null;
  const allError: ErrorLike | null = exitAllMutation.error ? errorText(exitAllMutation.error) : null;

  const signOut = useCallback((session: BrowserSessionInfo) => exitMutation.mutate(session), [exitMutation]);
  const signOutAsync = useCallback((session: BrowserSessionInfo) => exitMutation.mutateAsync(session), [exitMutation]);
  const signOutAll = useCallback(() => exitAllMutation.mutate(), [exitAllMutation]);
  const signOutAllAsync = useCallback(() => exitAllMutation.mutateAsync(), [exitAllMutation]);

  return {
    sessions,
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
    signOutAll,
    signOutAllAsync,
  };
}

export interface BrowserSessionsSummary {
  count: number | null;
  summary: string | undefined;
}

const EMPTY_BROWSER_SESSIONS_SUMMARY: BrowserSessionsSummary = {
  count: null,
  summary: undefined,
};

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
    return { count: data.length, summary: String(data.length) };
  }, [data]);
}

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

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();
const uncheckedHostBoundBadgesCache = new WeakMap<readonly VendorSyncVendorBadge[], readonly VendorSyncVendorBadge[]>();

export function visibleMcpVendorBadges(
  item: VendorSyncMcpPreviewItem,
  checked: boolean,
): readonly VendorSyncVendorBadge[] {
  if (!item.hostBound || checked) return item.vendors;
  const cached = uncheckedHostBoundBadgesCache.get(item.vendors);
  if (cached !== undefined) return cached;
  const filtered = item.vendors.filter((badge) => badge.status !== "will_add" && badge.status !== "mcp_remote");
  uncheckedHostBoundBadgesCache.set(item.vendors, filtered);
  return filtered;
}

function toggledSet(prev: ReadonlySet<string>, key: string, nextChecked: boolean): ReadonlySet<string> {
  const next = new Set(prev);
  if (nextChecked) next.add(key);
  else next.delete(key);
  return next;
}

interface VendorSyncSession {
  readonly device: DeviceKey;
  readonly preview: VendorSyncPreviewResponse;
  readonly checkedMcp: ReadonlySet<string>;
  readonly checkedSkills: ReadonlySet<string>;
}

interface VendorSyncSummary {
  readonly device: DeviceKey;
  readonly text: string;
}

const VENDOR_SYNC_MUTATION_KEY = (step: "scan" | "apply", device: DeviceKey) => ["vendor-sync", step, device] as const;

function buildApplyRequest(session: VendorSyncSession): VendorSyncApplyRequest {
  const { preview, checkedMcp, checkedSkills } = session;
  const selectedMcpKeys: string[] = [];
  const removeMcpKeys: string[] = [];
  const confirmedHostBoundMcpKeys: string[] = [];
  for (const item of preview.mcpServers) {
    if (checkedMcp.has(item.key)) {
      selectedMcpKeys.push(item.key);
      if (item.hostBound) confirmedHostBoundMcpKeys.push(item.key);
    } else if (!item.hostBound) {
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
  return {
    selectedMcpKeys,
    removeMcpKeys,
    selectedSkillKeys,
    removeSkillKeys,
    ...(preview.hostBoundConfirmSupported ? { confirmedHostBoundMcpKeys } : {}),
  };
}

export function useVendorSyncSetting(explicitClient?: HubClient) {
  const qc = useHubQueryClient();
  const contextClient = useClient();
  const client = explicitClient ?? contextClient;
  const targetDevice = client.device ?? LOCAL_DEVICE;
  const [session, setSession] = useState<VendorSyncSession | null>(null);
  const [summary, setSummary] = useState<VendorSyncSummary | null>(null);
  if (session !== null && session.device !== targetDevice) setSession(null);
  if (summary !== null && summary.device !== targetDevice) setSummary(null);
  const current = session?.device === targetDevice ? session : null;
  const preview = current?.preview ?? null;
  const checkedMcp = current?.checkedMcp ?? EMPTY_STRING_SET;
  const checkedSkills = current?.checkedSkills ?? EMPTY_STRING_SET;
  const lastSummary = summary?.device === targetDevice ? summary.text : null;

  const applyMutation = useMutation(
    {
      mutationKey: VENDOR_SYNC_MUTATION_KEY("apply", targetDevice),
      mutationFn: (scanned: VendorSyncSession | null) => {
        if (!scanned) throw new Error("No preview loaded");
        return client.postVendorSyncApply(buildApplyRequest(scanned));
      },
    },
    qc,
  );

  const scanMutation = useMutation(
    {
      mutationKey: VENDOR_SYNC_MUTATION_KEY("scan", targetDevice),
      mutationFn: () => client.fetchVendorSyncPreview(),
    },
    qc,
  );
  const { mutate: mutateScan } = scanMutation;
  const { mutate: mutateApply, reset: resetApply } = applyMutation;

  const previewVendorSync = useCallback(() => {
    const device = targetDevice;
    mutateScan(undefined, {
      onSuccess: (data) => {
        resetApply();
        setSession({
          device,
          preview: data,
          checkedMcp: new Set(data.mcpServers.filter((item) => !item.hostBound).map((item) => item.key)),
          checkedSkills: new Set(data.skills.map((item) => item.key)),
        });
      },
    });
  }, [mutateScan, resetApply, targetDevice]);

  const applyVendorSync = useCallback(() => {
    mutateApply(current, {
      onSuccess: (result, scanned) => {
        if (!scanned) return;
        setSummary({ device: scanned.device, text: formatVendorSyncSummary(result) });
        setSession((prev) => (prev?.preview === scanned.preview ? null : prev));
      },
    });
  }, [current, mutateApply]);

  const toggleMcp = useCallback((key: string, nextChecked: boolean) => {
    setSession((prev) => (prev ? { ...prev, checkedMcp: toggledSet(prev.checkedMcp, key, nextChecked) } : prev));
  }, []);

  const toggleSkill = useCallback((key: string, nextChecked: boolean) => {
    setSession((prev) => (prev ? { ...prev, checkedSkills: toggledSet(prev.checkedSkills, key, nextChecked) } : prev));
  }, []);

  const closePreview = useCallback(() => {
    if (!applyMutation.isPending) setSession(null);
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

export type VendorSyncModel = ReturnType<typeof useVendorSyncSetting>;

export const PROVIDERS_QUERY_KEY = (deviceKey: string) => ["providers", deviceKey] as const;

export interface ProvidersSummary {
  readonly summary: string | undefined;
  readonly attention: boolean;
}

const EMPTY_PROVIDERS_SUMMARY: ProvidersSummary = {
  summary: undefined,
  attention: false,
};

type ProvidersSummarySourceItem = { readonly availability: VendorAvailability };

const providersSummaryCache = new WeakMap<readonly ProvidersSummarySourceItem[], ProvidersSummary>();

export function describeProvidersSummary(
  items: readonly ProvidersSummarySourceItem[] | null | undefined,
): ProvidersSummary {
  if (!items || items.length === 0) return EMPTY_PROVIDERS_SUMMARY;
  const cached = providersSummaryCache.get(items);
  if (cached !== undefined) return cached;
  const readyCount = items.filter((item) => item.availability === "available").length;
  const computed: ProvidersSummary =
    readyCount === 0
      ? { summary: "Attention", attention: true }
      : { summary: `${readyCount} ready`, attention: false };
  providersSummaryCache.set(items, computed);
  return computed;
}

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
  selectionPage?: "providers" | "vendor-sync";
}

function useProviderTarget(devices: readonly DeviceView[] | null, defaultDeviceKey: DeviceKey, selectionPage: UseProvidersSettingOptions["selectionPage"]) {
  const contextClient = useClient();
  const selectableComputers = useMemo(() => resolveSelectableProviderComputers(devices), [devices]);

  const pickValidDeviceKey = useCallback(
    (candidate: DeviceKey): DeviceKey => {
      if (selectableComputers.length === 0) return contextClient.device ?? LOCAL_DEVICE;
      return selectableComputers.some((d) => d.key === candidate) ? candidate : LOCAL_DEVICE;
    },
    [contextClient.device, selectableComputers],
  );

  const [selectedDeviceKey, setSelectedDeviceKey] = useState<DeviceKey>(() => pickValidDeviceKey(defaultDeviceKey));
  const [selectionDefault, setSelectionDefault] = useState({ defaultDeviceKey, selectionPage });
  if (selectionDefault.defaultDeviceKey !== defaultDeviceKey || selectionDefault.selectionPage !== selectionPage) {
    setSelectionDefault({ defaultDeviceKey, selectionPage });
    const nextKey = pickValidDeviceKey(defaultDeviceKey);
    if (nextKey !== selectedDeviceKey) setSelectedDeviceKey(nextKey);
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
    effectiveDeviceKey !== LOCAL_DEVICE || (typeof window !== "undefined" && !isLoopbackHostname(window.location.hostname));

  return { selectableComputers, effectiveDeviceKey, setSelectedDeviceKey, targetClient, isRemoteTarget };
}

interface ActiveProviderWork {
  jobs: Set<string>;
  flows: Set<string>;
}

function scanProviderWork(status: ProvidersStatusResponse, previous: ActiveProviderWork) {
  let justSucceeded = false;
  const next: ActiveProviderWork = { jobs: new Set(), flows: new Set() };
  for (const item of status.providers) {
    if (item.job?.phase === "running") next.jobs.add(item.job.jobId);
    else if (item.job?.phase === "succeeded" && previous.jobs.has(item.job.jobId)) justSucceeded = true;
    if (item.authFlow && isProviderAuthFlowActive(item.authFlow.phase)) next.flows.add(item.authFlow.flowId);
    else if (item.authFlow?.phase === "succeeded" && previous.flows.has(item.authFlow.flowId)) justSucceeded = true;
  }
  return { next, justSucceeded };
}

function useRefreshProviderDataWhenWorkFinishes(qc: QueryClient, status: ProvidersStatusResponse | undefined, targetClient: HubClient) {
  const trackedActiveRef = useRef<ActiveProviderWork>({ jobs: new Set(), flows: new Set() });
  useEffect(() => {
    if (!status) return;
    const { next, justSucceeded } = scanProviderWork(status, trackedActiveRef.current);
    trackedActiveRef.current = next;
    if (justSucceeded) refreshProviderData(qc, targetClient);
  }, [qc, status, targetClient]);
}

type SetBusyKey = React.Dispatch<React.SetStateAction<string | null>>;
type VendorActionOptions = { syncModelsImmediately?: boolean; rethrow?: boolean };
type RunVendorAction = (
  vendor: AgentVendor,
  actionName: string,
  fn: () => Promise<ProviderStatusItem>,
  options?: VendorActionOptions,
) => Promise<ProviderStatusItem | null>;

function useVendorActionRunner(qc: QueryClient, queryKey: readonly unknown[], targetClient: HubClient, setBusyKey: SetBusyKey) {
  const [rowErrors, setRowErrors] = useState<Partial<Record<AgentVendor, ErrorLike>>>({});

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
          : { ...prev, providers: prev.providers.map((existing) => (existing.vendor === item.vendor ? item : existing)) },
      );
    },
    [qc, queryKey],
  );

  const run = useCallback<RunVendorAction>(
    async (vendor, actionName, fn, options = {}) => {
      const token = `${actionName}:${vendor}`;
      setBusyKey(token);
      clearVendorError(vendor);
      try {
        const item = await fn();
        upsertItem(item);
        if (options.syncModelsImmediately || item.authFlow?.phase === "succeeded") refreshProviderData(qc, targetClient);
        return item;
      } catch (err) {
        if (options.rethrow) throw err;
        setRowErrors((prev) => ({ ...prev, [vendor]: errorText(err) }));
        return null;
      } finally {
        setBusyKey((cur) => (cur === token ? null : cur));
      }
    },
    [clearVendorError, qc, setBusyKey, targetClient, upsertItem],
  );

  return { rowErrors, setRowErrors, run };
}

function useVendorActions(run: RunVendorAction, client: HubClient) {
  return useMemo(() => {
    const synced: VendorActionOptions = { syncModelsImmediately: true, rethrow: true };
    return {
      install: (vendor: AgentVendor) => run(vendor, "install", () => client.postProviderInstall(vendor)),
      update: (vendor: AgentVendor) => run(vendor, "update", () => client.postProviderUpdate(vendor)),
      cancelJob: (vendor: AgentVendor, body: ProviderCancelJobRequest) =>
        run(vendor, "cancel-job", () => client.postProviderJobCancel(vendor, body)),
      startAuth: (vendor: AgentVendor, body: ProviderStartAuthRequest) =>
        run(vendor, "auth-start", () => client.postProviderAuthStart(vendor, body), { rethrow: true }),
      submitAuth: (vendor: AgentVendor, body: ProviderSubmitAuthRequest) =>
        run(vendor, "auth-submit", () => client.postProviderAuthSubmit(vendor, body), synced),
      cancelAuth: (vendor: AgentVendor, body: ProviderCancelAuthRequest) =>
        run(vendor, "auth-cancel", () => client.postProviderAuthCancel(vendor, body)),
      saveApiKey: (vendor: AgentVendor, body: ProviderSaveApiKeyRequest) =>
        run(vendor, "auth-api-key", () => client.postProviderAuthApiKey(vendor, body), synced),
      logout: (vendor: AgentVendor, body: ProviderLogoutRequest = {}) =>
        run(vendor, "auth-logout", () => client.postProviderAuthLogout(vendor, body), synced),
    };
  }, [run, client]);
}

function useStatusActions(qc: QueryClient, queryKey: readonly unknown[], targetClient: HubClient, setBusyKey: SetBusyKey) {
  const [gitError, setGitError] = useState<ErrorLike | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setBusyKey("refresh");
    try {
      const next = await targetClient.fetchProviders({ refresh: true });
      qc.setQueryData<ProvidersStatusResponse>(queryKey, next);
      refreshProviderData(qc, targetClient);
    } catch {
      // A failed manual refresh keeps the last status.
    } finally {
      setBusyKey((cur) => (cur === "refresh" ? null : cur));
    }
  }, [qc, queryKey, setBusyKey, targetClient]);

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
  }, [qc, queryKey, setBusyKey, targetClient]);

  return { gitError, setGitError, refresh, installGit };
}

export function useProvidersSetting({
  enabled = true,
  devices = null,
  defaultDeviceKey = LOCAL_DEVICE,
  selectionPage,
}: UseProvidersSettingOptions = {}) {
  const qc = useHubQueryClient();
  const { selectableComputers, effectiveDeviceKey, setSelectedDeviceKey, targetClient, isRemoteTarget } =
    useProviderTarget(devices, defaultDeviceKey, selectionPage);
  const pageVisible = useSyncExternalStore(subscribePageVisibility, getPageVisibilitySnapshot, () => true);
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
  useRefreshProviderDataWhenWorkFinishes(qc, status, targetClient);

  const { rowErrors, setRowErrors, run } = useVendorActionRunner(qc, queryKey, targetClient, setBusyKey);
  const vendorActions = useVendorActions(run, targetClient);
  const { gitError, setGitError, refresh, installGit } = useStatusActions(qc, queryKey, targetClient, setBusyKey);

  const selectDevice = useCallback(
    (nextKey: DeviceKey) => {
      setRowErrors({});
      setGitError(null);
      setSelectedDeviceKey(nextKey);
    },
    [setGitError, setRowErrors, setSelectedDeviceKey],
  );

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
      installGit,
      ...vendorActions,
    }),
    [
      busyKey,
      effectiveDeviceKey,
      enabled,
      gitError,
      installGit,
      isFetching,
      isRemoteTarget,
      loadError,
      refresh,
      rowErrors,
      selectDevice,
      selectableComputers,
      status,
      targetClient,
      vendorActions,
    ],
  );
}

export type ProvidersSettingModel = ReturnType<typeof useProvidersSetting>;
