// Settings → Providers 一键安装、更新与界面内直接登录（docs/providers-install-login-design.md）。
// 严格由服务端 ProviderStatusItem.authMethods 数据驱动渲染，零单家厂商字面量、零符号拼接（不用 · / | / /）、错误日志默认收起。
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isSelectable,
  type AgentVendor,
  type ProviderJobSnapshot,
  type ProviderStatusItem,
} from "../../shared/index.ts";
import { LOCAL_DEVICE, type DeviceKey } from "../devices.ts";
import { errorText, type ErrorLike } from "../format.ts";
import { cn } from "../lib/utils.ts";
import {
  FieldBlock,
  NO_AUTOCORRECT,
  TOUCH_INPUT,
} from "../mobile/settings/SettingsNavRow.tsx";
import { DRAWER_BUTTON } from "../mobile/settings/SettingsDrawer.tsx";
import {
  defaultProviderAuthMethodId,
  extractProviderAuthTargets,
  isProviderAuthFlowActive,
  useCopyFeedback,
  useProvidersSetting,
  visibleAuthMethodsForTarget,
  type DeviceSettings,
  type ProvidersSettingModel,
} from "../settings-model.ts";
import { Button } from "../ui/button.tsx";
import { Dialog, DialogContent, DialogFooter } from "../ui/dialog.tsx";
import { Input, Select } from "../ui/input.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";
import { VendorSyncSettings } from "./VendorSyncSettings.tsx";

function openExternalBrowserPage(url: string): void {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // 测试或受限环境忽略
  }
}

type DotTone = "ready" | "caution" | "muted";

export function isProviderAuthenticated(item: ProviderStatusItem): boolean {
  return item.installed && (item.availability === "available" || item.accountSummary !== null);
}

function resolveItemTone(item: ProviderStatusItem): DotTone {
  if (item.job?.phase === "running") return "caution";
  if (!item.installed) return "muted";
  if (isProviderAuthenticated(item)) return "ready";
  return "caution";
}

const DOT_CLASS: Readonly<Record<DotTone, string>> = {
  ready: "bg-success",
  caution: "bg-caution",
  muted: "bg-muted-foreground/40",
};

function JobLogDisclosure({ job, open }: { job: ProviderJobSnapshot | null; open: boolean }) {
  if (!open || !job || !job.logTail.trim()) return null;
  return (
    <pre
      data-testid="provider-job-log"
      className="mt-2.5 max-h-48 overflow-auto rounded-xl bg-sidebar p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all"
    >
      {job.logTail}
    </pre>
  );
}

function GitEnvironmentGroup({ model }: { model: ProvidersSettingModel }) {
  const status = model.status;
  const [logOpen, setLogOpen] = useState(false);
  if (!status) return null;
  const gitJob = status.gitJob;
  const running = gitJob?.phase === "running";
  const failed = gitJob?.phase === "failed";
  const visible = (!status.gitInstalled && status.canInstallGit) || running || (failed && !status.gitInstalled);
  if (!visible) return null;

  const hasLog = failed && Boolean(gitJob?.logTail.trim());
  const combinedError: ErrorLike | null =
    model.gitError ?? (failed && gitJob?.error ? gitJob.error : null);

  return (
    <SettingsGroup title="Environment">
      <div data-slot="settings-row" className="px-4 py-3">
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-32 flex-1 items-start gap-3">
            <span
              aria-hidden="true"
              className={cn(
                "mt-2 size-2 shrink-0 rounded-full",
                running ? "bg-caution" : "bg-muted-foreground/40",
              )}
            />
            <div className="min-w-0 flex-1 break-words">
              <div className="line-clamp-2 text-body">Git</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-minor leading-snug text-muted-foreground">
                {running ? (
                  <span className="status-shimmer">{gitJob.progressLine ?? "Installing…"}</span>
                ) : (
                  <span>Not installed</span>
                )}
              </div>
            </div>
          </div>
          <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">
            {hasLog && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded={logOpen}
                onClick={() => setLogOpen((v) => !v)}
              >
                {logOpen ? "Hide log" : "Show log"}
              </Button>
            )}
            {running ? (
              <Button type="button" variant="outline" size="sm" disabled>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Installing…
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!status.canInstallGit || model.busyKey === "git"}
                onClick={() => void model.installGit()}
              >
                {failed ? "Retry" : "Install"}
              </Button>
            )}
          </div>
        </div>
        {combinedError !== null && <RowError error={combinedError} />}
        <JobLogDisclosure job={gitJob} open={logOpen} />
      </div>
    </SettingsGroup>
  );
}

function ProviderItemRow({
  item,
  rowError,
  busyKey,
  onInstall,
  onUpdate,
  onCancelJob,
  onOpenSignIn,
  onOpenAccount,
}: {
  item: ProviderStatusItem;
  rowError?: ErrorLike;
  busyKey: string | null;
  onInstall: () => void;
  onUpdate: () => void;
  onCancelJob: (jobId: string) => void;
  onOpenSignIn: () => void;
  onOpenAccount: () => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const job = item.job;
  const jobRunning = job?.phase === "running";
  const jobFailed = job?.phase === "failed";
  const hasLog = jobFailed && Boolean(job?.logTail.trim());
  const tone = resolveItemTone(item);
  const authenticated = isProviderAuthenticated(item);
  const ready = authenticated || (item.installed && item.canSignOut);
  const combinedError: ErrorLike | null =
    rowError ?? (jobFailed && job?.error ? job.error : null);

  return (
    <div
      data-slot="settings-row"
      data-testid={`provider-row-${item.vendor}`}
      className="min-h-12 px-4 py-3"
    >
      <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-32 flex-1 items-start gap-3">
          <span
            aria-hidden="true"
            data-tone={tone}
            className={cn("mt-2 size-2 shrink-0 rounded-full", DOT_CLASS[tone])}
          />
          <div className="min-w-0 flex-1 break-words">
            <div title={item.label} className="line-clamp-2 text-body">
              {item.label}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-minor leading-snug text-muted-foreground">
              {jobRunning ? (
                <span className="status-shimmer">
                  {job.progressLine ?? (job.kind === "update" ? "Updating…" : "Installing…")}
                </span>
              ) : !item.installed ? (
                <span>Not installed</span>
              ) : authenticated ? (
                <>
                  <span>{item.accountSummary ?? "Signed in"}</span>
                  {item.version && <span className="tabular-nums">{item.version}</span>}
                </>
              ) : (
                <>
                  <span>Not signed in</span>
                  {item.version && <span className="tabular-nums">{item.version}</span>}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="ml-auto flex max-w-full shrink-0 items-center gap-2">
          {hasLog && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${logOpen ? "Hide log" : "Show log"} for ${item.label}`}
              aria-expanded={logOpen}
              onClick={() => setLogOpen((v) => !v)}
            >
              {logOpen ? "Hide log" : "Show log"}
            </Button>
          )}

          {jobRunning ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Cancel ${item.label}`}
                disabled={busyKey === `cancel-job:${item.vendor}`}
                onClick={() => onCancelJob(job.jobId)}
              >
                Cancel
              </Button>
              <Button type="button" variant="outline" size="sm" disabled>
                <Loader2 className="animate-spin" aria-hidden="true" />
                {job.kind === "update" ? "Updating…" : "Installing…"}
              </Button>
            </>
          ) : !item.installed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`${jobFailed ? "Retry" : "Install"} ${item.label}`}
              disabled={!item.canInstall || busyKey === `install:${item.vendor}`}
              onClick={onInstall}
            >
              {busyKey === `install:${item.vendor}` && <Loader2 className="animate-spin" aria-hidden="true" />}
              {jobFailed ? "Retry" : "Install"}
            </Button>
          ) : ready ? (
            <>
              {jobFailed && job?.kind === "update" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Retry ${item.label}`}
                  disabled={busyKey === `update:${item.vendor}`}
                  onClick={onUpdate}
                >
                  Retry
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Account for ${item.label}`}
                onClick={onOpenAccount}
              >
                Account…
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Sign in to ${item.label}`}
              onClick={onOpenSignIn}
            >
              Sign in…
            </Button>
          )}
        </div>
      </div>
      {combinedError !== null && <RowError error={combinedError} />}
      <JobLogDisclosure job={job} open={logOpen} />
    </div>
  );
}

/** 桌面窄弹窗与手机底部 SettingsDrawer 共用的登录表单内芯。 */
export function ProviderSignInBody({
  item,
  model,
  mobile = false,
  onDone,
  onCancel,
}: {
  item: ProviderStatusItem;
  model: ProvidersSettingModel;
  mobile?: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const targets = useMemo(() => extractProviderAuthTargets(item.authMethods), [item.authMethods]);
  const [targetId, setTargetId] = useState<string | undefined>(() => targets?.[0]?.id);

  const visibleMethods = useMemo(
    () => visibleAuthMethodsForTarget(item.authMethods, targetId),
    [item.authMethods, targetId],
  );

  const [methodId, setMethodId] = useState<string | null>(() => {
    if (
      item.authFlow &&
      isProviderAuthFlowActive(item.authFlow.phase) &&
      visibleMethods.some((m) => m.id === item.authFlow?.methodId)
    ) {
      return item.authFlow.methodId;
    }
    return defaultProviderAuthMethodId(visibleMethods, model.isRemoteTarget);
  });

  const selectedMethod = useMemo(
    () => visibleMethods.find((m) => m.id === methodId) ?? visibleMethods[0] ?? null,
    [methodId, visibleMethods],
  );

  const [variantId, setVariantId] = useState<string | undefined>(() =>
    selectedMethod?.kind === "browser_oauth" ? selectedMethod.variants?.[0]?.id : undefined,
  );
  useEffect(() => {
    if (selectedMethod?.kind === "browser_oauth") {
      const variants = selectedMethod.variants;
      if (variants && variants.length > 0 && !variants.some((v) => v.id === variantId)) {
        setVariantId(variants[0]!.id);
      }
    }
  }, [selectedMethod, variantId]);

  const [apiKey, setApiKey] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<ErrorLike | null>(null);
  const watchedFlowIdRef = useRef<string | null>(
    item.authFlow && isProviderAuthFlowActive(item.authFlow.phase) && !item.authFlow.ownedByOtherClient
      ? item.authFlow.flowId
      : null,
  );
  const autoOpenedFlowRef = useRef<string | null>(null);
  const linkCopy = useCopyFeedback();
  const codeCopy = useCopyFeedback();

  // 监听本窗口发起的登录流自动落盘成功并收起弹窗/抽屉
  useEffect(() => {
    const flow = item.authFlow;
    if (!flow) return;
    if (watchedFlowIdRef.current === flow.flowId && flow.phase === "succeeded") {
      onDone();
      return;
    }
    // 本机模式下首次捕获到 authorizeUrl 时自动拉起默认浏览器（若已被点击直接打开过则跳过重复打开）
    if (
      !model.isRemoteTarget &&
      watchedFlowIdRef.current === flow.flowId &&
      flow.phase === "waiting_browser" &&
      flow.authorizeUrl &&
      autoOpenedFlowRef.current !== flow.flowId
    ) {
      autoOpenedFlowRef.current = flow.flowId;
      openExternalBrowserPage(flow.authorizeUrl);
    }
  }, [item.authFlow, model.isRemoteTarget, onDone]);

  const activeFlow =
    selectedMethod &&
    item.authFlow &&
    item.authFlow.methodId === selectedMethod.id &&
    isProviderAuthFlowActive(item.authFlow.phase)
      ? item.authFlow
      : null;

  const terminalFlowError =
    selectedMethod &&
    item.authFlow &&
    item.authFlow.methodId === selectedMethod.id &&
    (item.authFlow.phase === "failed" || item.authFlow.phase === "expired") &&
    item.authFlow.error
      ? item.authFlow.error
      : null;

  const cancelCurrentFlowIfOwned = useCallback(async () => {
    const flow = item.authFlow;
    if (flow && isProviderAuthFlowActive(flow.phase) && !flow.ownedByOtherClient) {
      await model.cancelAuth(item.vendor, { flowId: flow.flowId }).catch(() => null);
    }
  }, [item.authFlow, item.vendor, model]);

  const handleCancelClick = async () => {
    await cancelCurrentFlowIfOwned();
    onCancel();
  };

  const handleTargetChange = (nextTargetId: string) => {
    setTargetId(nextTargetId);
    setLocalError(null);
    setApiKey("");
    const nextVisible = visibleAuthMethodsForTarget(item.authMethods, nextTargetId);
    if (!nextVisible.some((m) => m.id === methodId)) {
      setMethodId(defaultProviderAuthMethodId(nextVisible, model.isRemoteTarget));
    }
  };

  const handleMethodChange = (nextMethodId: string) => {
    if (nextMethodId === selectedMethod?.id) return;
    setLocalError(null);
    setManualInput("");
    setMethodId(nextMethodId);
    void cancelCurrentFlowIfOwned();
  };

  const handleStartInteractive = async () => {
    if (!selectedMethod || selectedMethod.kind === "api_key" || submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      const updated = await model.startAuth(item.vendor, {
        methodId: selectedMethod.id,
        ...(selectedMethod.kind === "browser_oauth" && variantId !== undefined ? { variantId } : {}),
        ...(targetId !== undefined ? { targetId } : {}),
        remoteHint: model.isRemoteTarget,
      });
      const nextFlow = updated?.authFlow ?? null;
      if (nextFlow) {
        watchedFlowIdRef.current = nextFlow.flowId;
        if (nextFlow.phase === "succeeded") {
          onDone();
          return;
        }
        if (!model.isRemoteTarget && nextFlow.authorizeUrl) {
          autoOpenedFlowRef.current = nextFlow.flowId;
          openExternalBrowserPage(nextFlow.authorizeUrl);
        }
      }
    } catch (err) {
      setLocalError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeFlow || !manualInput.trim() || submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      const updated = await model.submitAuth(item.vendor, {
        flowId: activeFlow.flowId,
        input: manualInput.trim(),
      });
      setManualInput("");
      if (updated?.authFlow?.phase === "succeeded" || (updated && isSelectable(updated.availability))) {
        onDone();
      }
    } catch (err) {
      setLocalError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || submitting) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await model.saveApiKey(item.vendor, {
        ...(targetId !== undefined ? { targetId } : {}),
        apiKey: apiKey.trim(),
      });
      onDone();
    } catch (err) {
      setLocalError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const displayedError = localError ?? terminalFlowError;

  return (
    <div className="grid grid-cols-1 gap-4">
      {targets !== null && (
        mobile ? (
          <FieldBlock label="Model provider" bare>
            {(id) => (
              <Select
                id={id}
                className={TOUCH_INPUT}
                value={targetId}
                disabled={activeFlow !== null || submitting}
                onChange={(e) => handleTargetChange(e.target.value)}
              >
                {targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.configured ? `${t.label} (Configured)` : t.label}
                  </option>
                ))}
              </Select>
            )}
          </FieldBlock>
        ) : (
          <SettingsGroup label="Model provider">
            <SettingsRow label="Model provider">
              {(id) => (
                <Select
                  id={id}
                  variant="plain"
                  value={targetId}
                  disabled={activeFlow !== null || submitting}
                  onChange={(e) => handleTargetChange(e.target.value)}
                >
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.configured ? `${t.label} (Configured)` : t.label}
                    </option>
                  ))}
                </Select>
              )}
            </SettingsRow>
          </SettingsGroup>
        )
      )}

      {visibleMethods.length > 1 && selectedMethod && (
        <Segmented
          label="Sign-in method"
          value={selectedMethod.id}
          options={visibleMethods.map((m) => ({ value: m.id, label: m.label }))}
          onChange={handleMethodChange}
          className="flex w-full [&>*]:flex-auto [&>*]:justify-center [&>*]:truncate"
        />
      )}

      {selectedMethod?.kind === "browser_oauth" &&
        selectedMethod.variants &&
        selectedMethod.variants.length > 1 &&
        variantId !== undefined && (
          <Segmented
            label="Account type"
            value={variantId}
            options={selectedMethod.variants.map((v) => ({ value: v.id, label: v.label }))}
            onChange={(next) => {
              if (activeFlow === null) setVariantId(next);
            }}
            className="flex w-full [&>*]:flex-auto [&>*]:justify-center [&>*]:truncate"
          />
        )}

      {selectedMethod?.kind === "api_key" && (
        <form className="grid grid-cols-1 gap-4" onSubmit={(e) => void handleSaveApiKey(e)}>
          <Input
            type="password"
            aria-label={selectedMethod.label}
            placeholder={selectedMethod.placeholder}
            value={apiKey}
            autoFocus={!mobile}
            disabled={submitting}
            {...NO_AUTOCORRECT}
            className={mobile ? TOUCH_INPUT : "w-full"}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {displayedError !== null && <RowError error={displayedError} />}
          {mobile ? (
            <div className="grid grid-cols-1 gap-2">
              <Button type="submit" className={DRAWER_BUTTON} disabled={!apiKey.trim() || submitting}>
                {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                Save
              </Button>
              <Button
                type="button"
                variant="outline"
                className={DRAWER_BUTTON}
                disabled={submitting}
                onClick={() => void handleCancelClick()}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <DialogFooter>
              <Button type="button" variant="outline" disabled={submitting} onClick={() => void handleCancelClick()}>
                Cancel
              </Button>
              <Button type="submit" disabled={!apiKey.trim() || submitting}>
                {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                Save
              </Button>
            </DialogFooter>
          )}
        </form>
      )}

      {selectedMethod?.kind === "browser_oauth" && (
        <div className="grid grid-cols-1 gap-4">
          {activeFlow?.ownedByOtherClient ? (
            <>
              <p className="text-minor text-muted-foreground">Sign-in in progress in another window</p>
              {mobile ? (
                <Button type="button" variant="outline" className={DRAWER_BUTTON} onClick={onCancel}>
                  Cancel
                </Button>
              ) : (
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                  </Button>
                </DialogFooter>
              )}
            </>
          ) : activeFlow !== null ? (
            <>
              <div className="flex items-center gap-2 text-minor text-muted-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                <span className="status-shimmer">Waiting for browser…</span>
              </div>
              {activeFlow.authorizeUrl && (
                <div className={cn("gap-2", mobile ? "grid grid-cols-1" : "flex flex-wrap items-center")}>
                  <Button
                    type="button"
                    variant={model.isRemoteTarget ? "default" : "outline"}
                    className={mobile ? DRAWER_BUTTON : undefined}
                    onClick={() => openExternalBrowserPage(activeFlow.authorizeUrl!)}
                  >
                    Open sign-in page
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className={mobile ? DRAWER_BUTTON : undefined}
                    onClick={() => linkCopy.copy(activeFlow.authorizeUrl!)}
                  >
                    {linkCopy.copied ? "Copied" : "Copy link"}
                  </Button>
                </div>
              )}
              {activeFlow.manualInput !== "none" && (
                <form
                  className={cn("gap-2", mobile ? "grid grid-cols-1" : "flex items-center")}
                  onSubmit={(e) => void handleSubmitManual(e)}
                >
                  <Input
                    aria-label="Paste code or redirect URL"
                    placeholder="Paste code or redirect URL…"
                    value={manualInput}
                    disabled={submitting}
                    {...NO_AUTOCORRECT}
                    className={mobile ? TOUCH_INPUT : "min-w-0 flex-1"}
                    onChange={(e) => setManualInput(e.target.value)}
                  />
                  <Button
                    type="submit"
                    className={mobile ? DRAWER_BUTTON : undefined}
                    disabled={!manualInput.trim() || submitting}
                  >
                    {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    Submit
                  </Button>
                </form>
              )}
              {displayedError !== null && <RowError error={displayedError} />}
              {mobile ? (
                <Button
                  type="button"
                  variant="outline"
                  className={DRAWER_BUTTON}
                  onClick={() => void handleCancelClick()}
                >
                  Cancel
                </Button>
              ) : (
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => void handleCancelClick()}>
                    Cancel
                  </Button>
                </DialogFooter>
              )}
            </>
          ) : (
            <>
              {displayedError !== null && <RowError error={displayedError} />}
              {mobile ? (
                <div className="grid grid-cols-1 gap-2">
                  <Button
                    type="button"
                    className={DRAWER_BUTTON}
                    disabled={submitting}
                    onClick={() => void handleStartInteractive()}
                  >
                    {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {model.isRemoteTarget ? "Open sign-in page" : "Continue in browser"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className={DRAWER_BUTTON}
                    disabled={submitting}
                    onClick={() => void handleCancelClick()}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <DialogFooter>
                  <Button type="button" variant="outline" disabled={submitting} onClick={() => void handleCancelClick()}>
                    Cancel
                  </Button>
                  <Button type="button" disabled={submitting} onClick={() => void handleStartInteractive()}>
                    {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    {model.isRemoteTarget ? "Open sign-in page" : "Continue in browser"}
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </div>
      )}

      {selectedMethod?.kind === "device_code" && (
        <div className="grid grid-cols-1 gap-4">
          {activeFlow?.ownedByOtherClient ? (
            <>
              <p className="text-minor text-muted-foreground">Sign-in in progress in another window</p>
              {mobile ? (
                <Button type="button" variant="outline" className={DRAWER_BUTTON} onClick={onCancel}>
                  Cancel
                </Button>
              ) : (
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                  </Button>
                </DialogFooter>
              )}
            </>
          ) : activeFlow !== null ? (
            <>
              {activeFlow.userCode ? (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-sidebar px-4 py-3">
                  <code
                    data-testid="device-user-code"
                    className="font-mono text-title font-semibold tracking-wider select-all"
                  >
                    {activeFlow.userCode}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => codeCopy.copy(activeFlow.userCode!)}
                  >
                    {codeCopy.copied ? "Copied" : "Copy code"}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-minor text-muted-foreground">
                  <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                  <span className="status-shimmer">Waiting for browser…</span>
                </div>
              )}
              {activeFlow.verificationUrl && (
                <Button
                  type="button"
                  className={mobile ? DRAWER_BUTTON : undefined}
                  onClick={() => openExternalBrowserPage(activeFlow.verificationUrl!)}
                >
                  Open verification page
                </Button>
              )}
              {displayedError !== null && <RowError error={displayedError} />}
              {mobile ? (
                <Button
                  type="button"
                  variant="outline"
                  className={DRAWER_BUTTON}
                  onClick={() => void handleCancelClick()}
                >
                  Cancel
                </Button>
              ) : (
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => void handleCancelClick()}>
                    Cancel
                  </Button>
                </DialogFooter>
              )}
            </>
          ) : (
            <>
              {displayedError !== null && <RowError error={displayedError} />}
              {mobile ? (
                <div className="grid grid-cols-1 gap-2">
                  <Button
                    type="button"
                    className={DRAWER_BUTTON}
                    disabled={submitting}
                    onClick={() => void handleStartInteractive()}
                  >
                    {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    Continue in browser
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className={DRAWER_BUTTON}
                    disabled={submitting}
                    onClick={() => void handleCancelClick()}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <DialogFooter>
                  <Button type="button" variant="outline" disabled={submitting} onClick={() => void handleCancelClick()}>
                    Cancel
                  </Button>
                  <Button type="button" disabled={submitting} onClick={() => void handleStartInteractive()}>
                    {submitting && <Loader2 className="animate-spin" aria-hidden="true" />}
                    Continue in browser
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 已就绪厂商的 Account… 管理弹窗/抽屉内芯（支持一键 Update、切换账号、移除单个子模型商与 Sign out）。 */
export function ProviderAccountBody({
  item,
  model,
  mobile = false,
  onSwitchAccount,
  onClose,
}: {
  item: ProviderStatusItem;
  model: ProvidersSettingModel;
  mobile?: boolean;
  onSwitchAccount: () => void;
  onClose: () => void;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<ErrorLike | null>(null);
  const configuredTargets = useMemo(
    () => extractProviderAuthTargets(item.authMethods)?.filter((t) => t.configured) ?? [],
    [item.authMethods],
  );

  const handleUpdate = async () => {
    setBusyAction("update");
    setError(null);
    const res = await model.update(item.vendor);
    setBusyAction(null);
    if (res !== null) {
      onClose();
    } else {
      const latestErr = model.rowErrors[item.vendor];
      if (latestErr !== undefined) setError(latestErr);
      else onClose();
    }
  };

  const handleRemoveTarget = async (targetId: string) => {
    setBusyAction(`remove:${targetId}`);
    setError(null);
    try {
      const updated = await model.logout(item.vendor, { targetId });
      if (updated && !isSelectable(updated.availability) && !updated.canSignOut) {
        onClose();
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleSignOutAll = async () => {
    setBusyAction("signout");
    setError(null);
    try {
      await model.logout(item.vendor);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      <SettingsGroup label={item.label}>
        <div data-slot="settings-row" className="px-4 py-3">
          <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-32 flex-1 items-start gap-3">
              <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-full bg-success" />
              <div className="min-w-0 flex-1 break-words">
                <div className="text-body">{item.accountSummary ?? "Signed in"}</div>
                {item.version && (
                  <div className="mt-0.5 text-minor text-muted-foreground tabular-nums">{item.version}</div>
                )}
              </div>
            </div>
            {item.canUpdate && (
              <div className="ml-auto shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busyAction !== null}
                  onClick={() => void handleUpdate()}
                >
                  {busyAction === "update" && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Update
                </Button>
              </div>
            )}
          </div>
        </div>
      </SettingsGroup>

      {configuredTargets.length > 0 && (
        <SettingsGroup title="Model provider">
          {configuredTargets.map((t) => (
            <SettingsRow key={t.id} label={t.label}>
              {() => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busyAction !== null}
                  onClick={() => void handleRemoveTarget(t.id)}
                >
                  {busyAction === `remove:${t.id}` && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Remove
                </Button>
              )}
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      {error !== null && <RowError error={error} />}

      {mobile ? (
        <div className="grid grid-cols-1 gap-2">
          {item.authMethods.length > 0 && (
            <Button
              type="button"
              variant="outline"
              className={DRAWER_BUTTON}
              disabled={busyAction !== null}
              onClick={onSwitchAccount}
            >
              Sign in with another account…
            </Button>
          )}
          {item.canSignOut && (
            <Button
              type="button"
              variant="destructive"
              className={DRAWER_BUTTON}
              disabled={busyAction !== null}
              onClick={() => void handleSignOutAll()}
            >
              {busyAction === "signout" && <Loader2 className="animate-spin" aria-hidden="true" />}
              Sign out
            </Button>
          )}
          <Button type="button" variant="outline" className={DRAWER_BUTTON} disabled={busyAction !== null} onClick={onClose}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {item.canSignOut ? (
            <Button
              type="button"
              variant="destructive"
              disabled={busyAction !== null}
              onClick={() => void handleSignOutAll()}
            >
              {busyAction === "signout" && <Loader2 className="animate-spin" aria-hidden="true" />}
              Sign out
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {item.authMethods.length > 0 && (
              <Button type="button" variant="outline" disabled={busyAction !== null} onClick={onSwitchAccount}>
                Sign in with another account…
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busyAction !== null} onClick={onClose}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 桌面与手机共用的 Providers 主体列表（Computer 选择 + Windows Git 环境 + 厂商列表）。 */
export function ProvidersListSection({
  model,
  onOpenSignIn,
  onOpenAccount,
}: {
  model: ProvidersSettingModel;
  onOpenSignIn: (vendor: AgentVendor) => void;
  onOpenAccount: (vendor: AgentVendor) => void;
}) {
  const status = model.status;
  const hasGitGroup =
    status !== null &&
    ((!status.gitInstalled && status.canInstallGit) ||
      status.gitJob?.phase === "running" ||
      (status.gitJob?.phase === "failed" && !status.gitInstalled));
  const hasExtraTopGroup = model.selectableComputers.length >= 2 || hasGitGroup;

  return (
    <>
      {model.selectableComputers.length >= 2 && (
        <SettingsGroup label="Computer">
          <SettingsRow label="Computer">
            {(id) => (
              <Select
                id={id}
                variant="plain"
                value={model.deviceKey}
                onChange={(e) => model.selectDevice(e.target.value)}
              >
                {model.selectableComputers.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.info.self ? "This computer" : d.info.name}
                  </option>
                ))}
              </Select>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}

      <GitEnvironmentGroup model={model} />

      <SettingsGroup
        {...(hasExtraTopGroup ? { title: "Providers" } : { label: "Providers" })}
        action={
          <span className="-mr-3 ml-auto flex items-center">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={model.loading || model.refreshing}
              onClick={() => void model.refresh()}
            >
              {model.refreshing && <Loader2 className="animate-spin" aria-hidden="true" />}
              Refresh
            </Button>
          </span>
        }
      >
        {model.loading && !model.status ? (
          <div className="flex min-h-14 items-center justify-center gap-2 px-4 py-3 text-minor text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : model.loadError ? (
          <div className="px-4 py-3">
            <RowError error={model.loadError} />
          </div>
        ) : (
          model.status?.providers.map((item) => (
            <ProviderItemRow
              key={item.vendor}
              item={item}
              rowError={model.rowErrors[item.vendor]}
              busyKey={model.busyKey}
              onInstall={() => void model.install(item.vendor)}
              onUpdate={() => void model.update(item.vendor)}
              onCancelJob={(jobId) => void model.cancelJob(item.vendor, { jobId })}
              onOpenSignIn={() => onOpenSignIn(item.vendor)}
              onOpenAccount={() => onOpenAccount(item.vendor)}
            />
          ))
        )}
      </SettingsGroup>
    </>
  );
}

type ModalState =
  | { mode: "signin"; vendor: AgentVendor }
  | { mode: "account"; vendor: AgentVendor }
  | null;

/** 桌面端 Settings → Providers 完整面板（含登录/账号窄弹窗与下方归拢的 Vendor sync）。 */
export function ProvidersSettings({
  active = true,
  devices = null,
  defaultDeviceKey = LOCAL_DEVICE,
}: {
  active?: boolean;
  devices?: DeviceSettings | null;
  defaultDeviceKey?: DeviceKey;
}) {
  const model = useProvidersSetting({
    enabled: active,
    devices: devices?.devices ?? null,
    defaultDeviceKey,
  });
  const [modal, setModal] = useState<ModalState>(null);

  const modalItem = useMemo(
    () => (modal === null ? null : (model.status?.providers.find((p) => p.vendor === modal.vendor) ?? null)),
    [modal, model.status],
  );

  const handleDialogOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      if (
        modal?.mode === "signin" &&
        modalItem?.authFlow &&
        isProviderAuthFlowActive(modalItem.authFlow.phase) &&
        !modalItem.authFlow.ownedByOtherClient
      ) {
        void model.cancelAuth(modalItem.vendor, { flowId: modalItem.authFlow.flowId });
      }
      setModal(null);
    },
    [modal, modalItem, model],
  );

  return (
    <>
      <ProvidersListSection
        model={model}
        onOpenSignIn={(vendor) => setModal({ mode: "signin", vendor })}
        onOpenAccount={(vendor) => setModal({ mode: "account", vendor })}
      />

      <VendorSyncSettings client={model.targetClient} />

      <Dialog open={modal !== null && modalItem !== null} onOpenChange={handleDialogOpenChange}>
        {modal !== null && modalItem !== null && (
          <DialogContent
            title={modal.mode === "signin" ? `Sign in to ${modalItem.label}` : modalItem.label}
            className="max-w-110"
          >
            {modal.mode === "signin" ? (
              <ProviderSignInBody
                key={`${modalItem.vendor}:${model.deviceKey}`}
                item={modalItem}
                model={model}
                onDone={() => setModal(null)}
                onCancel={() => setModal(null)}
              />
            ) : (
              <ProviderAccountBody
                key={`account:${modalItem.vendor}:${model.deviceKey}`}
                item={modalItem}
                model={model}
                onSwitchAccount={() => setModal({ mode: "signin", vendor: modalItem.vendor })}
                onClose={() => setModal(null)}
              />
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
