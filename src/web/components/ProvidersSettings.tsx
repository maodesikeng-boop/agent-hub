import { Loader2 } from "../ui/icons.ts";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { RowError, SettingsGroup, SettingsRow } from "./SettingsList.tsx";
import { StatusShimmer } from "./StatusShimmer.tsx";
import { VendorSyncSettings } from "./VendorSyncSettings.tsx";

function openExternalBrowserPage(url: string): void {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
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
      className="mt-2.5 max-h-48 overflow-auto rounded-sm bg-panel p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-all"
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
                  <StatusShimmer text={gitJob.progressLine ?? "Installing…"} />
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
                <Loader2 aria-hidden="true" />
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
  const hasLog = (jobFailed || jobRunning) && Boolean(job?.logTail.trim());
  const tone = resolveItemTone(item);
  const authenticated = isProviderAuthenticated(item);
  const ready = authenticated || (item.installed && item.canSignOut);
  const combinedError: ErrorLike | null =
    rowError ?? (jobFailed && job?.error ? { text: job.kind === "update" ? "Update failed" : "Install failed", raw: job.error } : null);

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
                <StatusShimmer text={job.progressLine ?? (job.kind === "update" ? "Updating…" : "Installing…")} />
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
            </>
          ) : !item.installed ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-w-24"
              aria-label={`${jobFailed ? "Retry" : "Install"} ${item.label}`}
              disabled={!item.canInstall || busyKey === `install:${item.vendor}`}
              onClick={onInstall}
            >
              {busyKey === `install:${item.vendor}` && <Loader2 aria-hidden="true" />}
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
                className="min-w-24"
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
              className="min-w-24"
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

type CopyFeedback = ReturnType<typeof useCopyFeedback>;

function useAuthMethodSelection(item: ProviderStatusItem, isRemoteTarget: boolean) {
  const targets = useMemo(() => extractProviderAuthTargets(item.authMethods), [item.authMethods]);
  const [targetId, setTargetId] = useState<string | undefined>(() => targets?.[0]?.id);
  const visibleMethods = useMemo(
    () => visibleAuthMethodsForTarget(item.authMethods, targetId),
    [item.authMethods, targetId],
  );
  const [methodId, setMethodId] = useState<string | null>(() => {
    const flow = item.authFlow;
    if (flow && isProviderAuthFlowActive(flow.phase) && visibleMethods.some((m) => m.id === flow.methodId)) {
      return flow.methodId;
    }
    return defaultProviderAuthMethodId(visibleMethods, isRemoteTarget);
  });
  const selectedMethod = useMemo(
    () => visibleMethods.find((m) => m.id === methodId) ?? visibleMethods[0] ?? null,
    [methodId, visibleMethods],
  );
  const [variantId, setVariantId] = useState<string | undefined>(() =>
    selectedMethod?.kind === "browser_oauth" ? selectedMethod.variants?.[0]?.id : undefined,
  );
  useEffect(() => {
    if (selectedMethod?.kind !== "browser_oauth") return;
    const variants = selectedMethod.variants;
    if (variants && variants.length > 0 && !variants.some((v) => v.id === variantId)) {
      setVariantId(variants[0]!.id);
    }
  }, [selectedMethod, variantId]);
  return { targets, targetId, setTargetId, visibleMethods, methodId, setMethodId, selectedMethod, variantId, setVariantId };
}

function useAuthFlowWatcher(item: ProviderStatusItem, isRemoteTarget: boolean, onDone: () => void) {
  const watchedFlowIdRef = useRef<string | null>(
    item.authFlow && isProviderAuthFlowActive(item.authFlow.phase) && !item.authFlow.ownedByOtherClient
      ? item.authFlow.flowId
      : null,
  );
  const autoOpenedFlowRef = useRef<string | null>(null);
  useEffect(() => {
    const flow = item.authFlow;
    if (!flow || watchedFlowIdRef.current !== flow.flowId) return;
    if (flow.phase === "succeeded") {
      onDone();
      return;
    }
    if (!isRemoteTarget && flow.phase === "waiting_browser" && flow.authorizeUrl && autoOpenedFlowRef.current !== flow.flowId) {
      autoOpenedFlowRef.current = flow.flowId;
      openExternalBrowserPage(flow.authorizeUrl);
    }
  }, [item.authFlow, isRemoteTarget, onDone]);
  return { watchedFlowIdRef, autoOpenedFlowRef };
}

type SignInMethod = NonNullable<ReturnType<typeof useAuthMethodSelection>["selectedMethod"]>;
type SignInFlow = NonNullable<ProviderStatusItem["authFlow"]>;

function flowStateFor(item: ProviderStatusItem, method: SignInMethod | null) {
  const flow = method !== null && item.authFlow?.methodId === method.id ? item.authFlow : null;
  const activeFlow = flow !== null && isProviderAuthFlowActive(flow.phase) ? flow : null;
  const terminalFlowError = flow !== null && (flow.phase === "failed" || flow.phase === "expired") && flow.error ? flow.error : null;
  return { activeFlow, terminalFlowError };
}

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
  const selection = useAuthMethodSelection(item, model.isRemoteTarget);
  const { targets, targetId, selectedMethod, variantId } = selection;
  const { watchedFlowIdRef, autoOpenedFlowRef } = useAuthFlowWatcher(item, model.isRemoteTarget, onDone);
  const [apiKey, setApiKey] = useState("");
  const [manualInput, setManualInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<ErrorLike | null>(null);
  const manualFormId = useId();
  const linkCopy = useCopyFeedback();
  const codeCopy = useCopyFeedback();
  const { activeFlow, terminalFlowError } = flowStateFor(item, selectedMethod);
  const displayedError = localError ?? terminalFlowError;

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
    selection.setTargetId(nextTargetId);
    setLocalError(null);
    setApiKey("");
    const nextVisible = visibleAuthMethodsForTarget(item.authMethods, nextTargetId);
    if (!nextVisible.some((m) => m.id === selection.methodId)) {
      selection.setMethodId(defaultProviderAuthMethodId(nextVisible, model.isRemoteTarget));
    }
  };

  const handleMethodChange = (nextMethodId: string) => {
    if (nextMethodId === selectedMethod?.id) return;
    setLocalError(null);
    setManualInput("");
    selection.setMethodId(nextMethodId);
    void cancelCurrentFlowIfOwned();
  };

  const runSubmit = async (task: () => Promise<void>) => {
    setSubmitting(true);
    setLocalError(null);
    try {
      await task();
    } catch (err) {
      setLocalError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleStartInteractive = async () => {
    if (!selectedMethod || selectedMethod.kind === "api_key" || submitting) return;
    await runSubmit(async () => {
      const updated = await model.startAuth(item.vendor, {
        methodId: selectedMethod.id,
        ...(selectedMethod.kind === "browser_oauth" && variantId !== undefined ? { variantId } : {}),
        ...(targetId !== undefined ? { targetId } : {}),
        remoteHint: model.isRemoteTarget,
      });
      const nextFlow = updated?.authFlow ?? null;
      if (!nextFlow) return;
      watchedFlowIdRef.current = nextFlow.flowId;
      if (nextFlow.phase === "succeeded") {
        onDone();
        return;
      }
      if (!model.isRemoteTarget && nextFlow.authorizeUrl) {
        autoOpenedFlowRef.current = nextFlow.flowId;
        openExternalBrowserPage(nextFlow.authorizeUrl);
      }
    });
  };

  const handleSubmitManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeFlow || !manualInput.trim() || submitting) return;
    await runSubmit(async () => {
      const updated = await model.submitAuth(item.vendor, { flowId: activeFlow.flowId, input: manualInput.trim() });
      setManualInput("");
      if (updated?.authFlow?.phase === "succeeded" || (updated && updated.authFlow?.phase !== "failed" && updated.authFlow?.phase !== "expired" && updated.availability === "available")) onDone();
    });
  };

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || submitting) return;
    await runSubmit(async () => {
      await model.saveApiKey(item.vendor, { ...(targetId !== undefined ? { targetId } : {}), apiKey: apiKey.trim() });
      onDone();
    });
  };

  const panel: SignInPanelProps = {
    mobile,
    submitting,
    error: displayedError,
    activeFlow,
    onCancel,
    onCancelFlow: () => void handleCancelClick(),
    onStart: () => void handleStartInteractive(),
  };

  return (
    <div className="grid grid-cols-1 gap-4">
      {targets !== null && (
        <AuthTargetPicker
          targets={targets}
          value={targetId}
          mobile={mobile}
          disabled={activeFlow !== null || submitting}
          onChange={handleTargetChange}
        />
      )}

      {selection.visibleMethods.length > 1 && selectedMethod && (
        <Segmented
          label="Sign-in method"
          value={selectedMethod.id}
          options={selection.visibleMethods.map((m) => ({ value: m.id, label: m.label }))}
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
              if (activeFlow === null) selection.setVariantId(next);
            }}
            className="flex w-full [&>*]:flex-auto [&>*]:justify-center [&>*]:truncate"
          />
        )}

      {selectedMethod?.kind === "api_key" && (
        <ApiKeyForm
          {...panel}
          label={selectedMethod.label}
          placeholder={selectedMethod.placeholder}
          value={apiKey}
          onChange={setApiKey}
          onSubmit={(e) => void handleSaveApiKey(e)}
        />
      )}

      {selectedMethod?.kind === "browser_oauth" && (
        <BrowserOAuthPanel
          {...panel}
          remote={model.isRemoteTarget}
          linkCopy={linkCopy}
          manualFormId={manualFormId}
          manualInput={manualInput}
          onManualInputChange={setManualInput}
          onSubmitManual={(e) => void handleSubmitManual(e)}
        />
      )}

      {selectedMethod?.kind === "device_code" && <DeviceCodePanel {...panel} codeCopy={codeCopy} />}
    </div>
  );
}

interface SignInPanelProps {
  mobile: boolean;
  submitting: boolean;
  error: ErrorLike | null;
  activeFlow: SignInFlow | null;
  onCancel: () => void;
  onCancelFlow: () => void;
  onStart: () => void;
}

function AuthTargetPicker({
  targets,
  value,
  mobile,
  disabled,
  onChange,
}: {
  targets: NonNullable<ReturnType<typeof extractProviderAuthTargets>>;
  value: string | undefined;
  mobile: boolean;
  disabled: boolean;
  onChange: (targetId: string) => void;
}) {
  const select = (id: string) => (
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id={id} aria-label="Model provider" {...(mobile ? { className: TOUCH_INPUT } : { variant: "plain" as const })}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {targets.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.configured ? `${t.label} (Configured)` : t.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (mobile) {
    return (
      <FieldBlock label="Model provider" bare>
        {select}
      </FieldBlock>
    );
  }
  return (
    <SettingsGroup label="Model provider">
      <SettingsRow label="Model provider">{select}</SettingsRow>
    </SettingsGroup>
  );
}

function SubmitLabel({ submitting, children }: { submitting: boolean; children: React.ReactNode }) {
  return (
    <>
      {submitting && <Loader2 aria-hidden="true" />}
      {children}
    </>
  );
}

function CancelButton({ mobile, disabled, onClick }: { mobile: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" className={mobile ? DRAWER_BUTTON : undefined} disabled={disabled} onClick={onClick}>
      Cancel
    </Button>
  );
}

function SignInActions({ mobile, primary, cancel }: { mobile: boolean; primary?: React.ReactNode; cancel: React.ReactNode }) {
  if (!mobile) {
    return (
      <DialogFooter>
        {cancel}
        {primary}
      </DialogFooter>
    );
  }
  if (!primary) return cancel;
  return (
    <div className="grid grid-cols-1 gap-2">
      {primary}
      {cancel}
    </div>
  );
}

function StartActions({ mobile, submitting, onStart, onCancelFlow, label }: SignInPanelProps & { label: string }) {
  return (
    <SignInActions
      mobile={mobile}
      primary={
        <Button type="button" className={mobile ? DRAWER_BUTTON : undefined} disabled={submitting} onClick={onStart}>
          <SubmitLabel submitting={submitting}>{label}</SubmitLabel>
        </Button>
      }
      cancel={<CancelButton mobile={mobile} disabled={submitting} onClick={onCancelFlow} />}
    />
  );
}

function OtherWindowNotice({ mobile, onCancel }: { mobile: boolean; onCancel: () => void }) {
  return (
    <>
      <p className="text-minor text-muted-foreground">Sign-in in progress in another window</p>
      <SignInActions mobile={mobile} cancel={<CancelButton mobile={mobile} onClick={onCancel} />} />
    </>
  );
}

function WaitingForBrowser() {
  return (
    <div className="flex items-center gap-2 text-minor text-muted-foreground">
      <Loader2 className="size-pixel shrink-0" aria-hidden="true" />
      <StatusShimmer text="Waiting for browser…" />
    </div>
  );
}

function ApiKeyForm({
  mobile,
  submitting,
  error,
  onCancelFlow,
  label,
  placeholder,
  value,
  onChange,
  onSubmit,
}: SignInPanelProps & {
  label: string;
  placeholder: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  return (
    <form className="grid grid-cols-1 gap-4" onSubmit={onSubmit}>
      <Input
        type="password"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoFocus={!mobile}
        disabled={submitting}
        {...NO_AUTOCORRECT}
        className={mobile ? TOUCH_INPUT : "w-full"}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== null && <RowError error={error} />}
      <SignInActions
        mobile={mobile}
        primary={
          <Button type="submit" className={mobile ? DRAWER_BUTTON : undefined} disabled={!value.trim() || submitting}>
            <SubmitLabel submitting={submitting}>Save</SubmitLabel>
          </Button>
        }
        cancel={<CancelButton mobile={mobile} disabled={submitting} onClick={onCancelFlow} />}
      />
    </form>
  );
}

function BrowserOAuthPanel(
  props: SignInPanelProps & {
    remote: boolean;
    linkCopy: CopyFeedback;
    manualFormId: string;
    manualInput: string;
    onManualInputChange: (value: string) => void;
    onSubmitManual: (e: React.FormEvent) => void;
  },
) {
  const { mobile, submitting, error, activeFlow, remote, linkCopy, manualFormId, manualInput } = props;
  const startLabel = remote ? "Open sign-in page" : "Continue in browser";
  if (activeFlow?.ownedByOtherClient) {
    return (
      <div className="grid grid-cols-1 gap-4">
        <OtherWindowNotice mobile={mobile} onCancel={props.onCancel} />
      </div>
    );
  }
  if (activeFlow === null) {
    return (
      <div className="grid grid-cols-1 gap-4">
        {error !== null && <RowError error={error} />}
        <StartActions {...props} label={startLabel} />
      </div>
    );
  }
  const authorizeUrl = activeFlow.authorizeUrl;
  const hasManualInput = activeFlow.manualInput !== "none";
  const manualSubmit = (
    <Button type="submit" form={manualFormId} className={mobile ? DRAWER_BUTTON : undefined} disabled={!manualInput.trim() || submitting}>
      <SubmitLabel submitting={submitting}>Submit</SubmitLabel>
    </Button>
  );
  return (
    <div className="grid grid-cols-1 gap-4">
      <WaitingForBrowser />
      {authorizeUrl && (
        <div className={cn("gap-2", mobile ? "grid grid-cols-1" : "flex flex-wrap items-center")}>
          <Button
            type="button"
            variant={remote ? "default" : "outline"}
            className={mobile ? DRAWER_BUTTON : undefined}
            onClick={() => openExternalBrowserPage(authorizeUrl)}
          >
            Open sign-in page
          </Button>
          <Button type="button" variant="outline" className={mobile ? DRAWER_BUTTON : undefined} onClick={() => linkCopy.copy(authorizeUrl)}>
            {linkCopy.copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}
      {hasManualInput && (
        <form id={manualFormId} className="grid grid-cols-1 gap-2" onSubmit={props.onSubmitManual}>
          <Input
            aria-label="Paste code or redirect URL"
            placeholder="Paste code or redirect URL…"
            value={manualInput}
            disabled={submitting}
            {...NO_AUTOCORRECT}
            className={mobile ? TOUCH_INPUT : undefined}
            onChange={(e) => props.onManualInputChange(e.target.value)}
          />
          {mobile && manualSubmit}
        </form>
      )}
      {error !== null && <RowError error={error} />}
      <SignInActions
        mobile={mobile}
        primary={!mobile && hasManualInput ? manualSubmit : undefined}
        cancel={<CancelButton mobile={mobile} onClick={props.onCancelFlow} />}
      />
    </div>
  );
}

function DeviceCodePanel(props: SignInPanelProps & { codeCopy: CopyFeedback }) {
  const { mobile, error, activeFlow, codeCopy } = props;
  if (activeFlow?.ownedByOtherClient) {
    return (
      <div className="grid grid-cols-1 gap-4">
        <OtherWindowNotice mobile={mobile} onCancel={props.onCancel} />
      </div>
    );
  }
  if (activeFlow === null) {
    return (
      <div className="grid grid-cols-1 gap-4">
        {error !== null && <RowError error={error} />}
        <StartActions {...props} label="Continue in browser" />
      </div>
    );
  }
  const { userCode, verificationUrl } = activeFlow;
  return (
    <div className="grid grid-cols-1 gap-4">
      {userCode ? (
        <div className="flex items-center justify-between gap-3 rounded-sm bg-panel px-4 py-3">
          <code data-testid="device-user-code" className="font-mono text-title font-semibold tracking-wider select-all">
            {userCode}
          </code>
          <Button type="button" variant="outline" size="sm" onClick={() => codeCopy.copy(userCode)}>
            {codeCopy.copied ? "Copied" : "Copy code"}
          </Button>
        </div>
      ) : (
        <WaitingForBrowser />
      )}
      {verificationUrl && (
        <Button type="button" className={mobile ? DRAWER_BUTTON : undefined} onClick={() => openExternalBrowserPage(verificationUrl)}>
          Open verification page
        </Button>
      )}
      {error !== null && <RowError error={error} />}
      <SignInActions mobile={mobile} cancel={<CancelButton mobile={mobile} onClick={props.onCancelFlow} />} />
    </div>
  );
}

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
              <span aria-hidden="true" className="mt-2 size-2 rounded-full shrink-0 bg-success" />
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
                  {busyAction === "update" && <Loader2 aria-hidden="true" />}
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
                  {busyAction === `remove:${t.id}` && <Loader2 aria-hidden="true" />}
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
              {busyAction === "signout" && <Loader2 aria-hidden="true" />}
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
              {busyAction === "signout" && <Loader2 aria-hidden="true" />}
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

  const readyCount = model.status ? model.status.providers.filter((p) => p.availability === "available").length : null;
  return (
    <>
      {model.selectableComputers.length >= 2 && (
        <SettingsGroup label="Computer">
          <SettingsRow label="Computer">
            {(id) => (
              <Select value={model.deviceKey} onValueChange={(next) => model.selectDevice(next)}>
                <SelectTrigger id={id} aria-label="Computer" variant="plain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {model.selectableComputers.map((d) => (
                    <SelectItem key={d.key} value={d.key}>
                      {d.info.self ? "This computer" : d.info.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </SettingsRow>
        </SettingsGroup>
      )}

      <GitEnvironmentGroup model={model} />

      <SettingsGroup
        {...(hasExtraTopGroup ? { title: "Providers" } : readyCount === null ? { label: "Providers" } : { title: `${readyCount} ready`, label: "Providers" })}
        action={
          <Button type="button" variant="outline" size="sm" className="min-w-24" disabled={model.loading || model.refreshing} onClick={() => void model.refresh()}>
            {model.refreshing && <Loader2 aria-hidden="true" />}
            Refresh
          </Button>
        }
      >
        {model.loading && !model.status ? (
          <div className="flex min-h-14 items-center justify-center gap-2 px-4 py-3 text-minor text-muted-foreground">
            <Loader2 className="size-pixel" aria-hidden="true" />
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
