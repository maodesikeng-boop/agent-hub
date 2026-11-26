import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CUSTOM_MODEL,
  checkModel,
  effortLabel,
  effortsFor,
  modelChoiceOf,
  splitModelEffort,
  vendorLabel,
  type AgentSetting,
  type AgentVendor,
  isSelectable,
  type ModelCatalog,
} from "../../shared/index.ts";
import { DEFAULT_CHOICE, defaultModelText, type ErrorLike } from "../format.ts";
import {
  ADD_PROVIDER_LABEL,
  ADD_PROVIDER_VALUE,
  useModelCatalog,
  useRevalidateModels,
  useVendorChoices,
  vendorOptionLabel,
} from "../models.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { ReadonlyValue, SettingsRow } from "./SettingsList.tsx";

export interface AgentDraft {
  vendor: AgentVendor;
  modelChoice: string;
  customModel: string;
  effort: string;
}

export type AgentRowKey = "vendor" | "model" | "effort";

export function draftOf(setting: AgentSetting, catalog?: ModelCatalog | null): AgentDraft {
  const { model, effort } = splitModelEffort(setting.vendor, setting.model, setting.effort, catalog);
  return { vendor: setting.vendor, modelChoice: modelChoiceOf(model), customModel: "", effort: effort ?? "" };
}

export function settingOf(draft: AgentDraft, catalog?: ModelCatalog | null): { ok: true; setting: AgentSetting } | { ok: false; error: string | null } {
  let model: string | null = draft.modelChoice === "" ? null : draft.modelChoice;
  if (draft.modelChoice === CUSTOM_MODEL) {
    model = draft.customModel.trim();
    if (model === "") return { ok: false, error: null };
    const problem = checkModel(draft.vendor, model);
    if (problem !== null) return { ok: false, error: problem };
  }
  return { ok: true, setting: { vendor: draft.vendor, ...splitModelEffort(draft.vendor, model, draft.effort === "" ? null : draft.effort, catalog) } };
}

function modelOf(draft: AgentDraft): string | null {
  if (draft.modelChoice === CUSTOM_MODEL) return draft.customModel.trim() || null;
  return draft.modelChoice === "" ? null : draft.modelChoice;
}

function withModel(draft: AgentDraft, modelChoice: string, catalog: ModelCatalog): AgentDraft {
  const next = { ...draft, modelChoice, customModel: modelChoice === CUSTOM_MODEL ? draft.customModel : "" };
  if (next.effort !== "" && !effortsFor(catalog, modelOf(next)).includes(next.effort)) next.effort = "";
  return next;
}

export function AgentRows({
  value,
  onChange,
  disabled,
  stacked,
  switchingToVendor,
  errors = {},
  customAction,
  onCustomSubmit,
  onManageProviders,
}: {
  value: AgentDraft;
  onChange: (draft: AgentDraft, row: AgentRowKey) => void;
  disabled?: boolean;
  stacked?: boolean;
  switchingToVendor?: AgentVendor | null;
  errors?: Partial<Record<AgentRowKey, ErrorLike | null>>;
  customAction?: ReactNode;
  onCustomSubmit?: () => void;
  onManageProviders?: () => void;
}) {
  const { options: vendors, refreshUnusable } = useVendorChoices(value.vendor);
  const catalog = useModelCatalog(value.vendor);
  const revalidateModels = useRevalidateModels();
  const result = settingOf(value);
  const customRef = useRef<HTMLInputElement>(null);
  const focusCustomOnClose = useRef(false);
  const [focusCustom, setFocusCustom] = useState(false);
  useEffect(() => {
    if (!focusCustom) return;
    customRef.current?.focus();
    setFocusCustom(false);
  }, [focusCustom]);

  const setVendor = (vendor: string) => {
    if (vendor === ADD_PROVIDER_VALUE) {
      onManageProviders?.();
      return;
    }
    const next = vendors.find((c) => c.vendor === vendor);
    if (next === undefined || vendor === value.vendor) return;
    onChange({ vendor: next.vendor, modelChoice: "", customModel: "", effort: "" }, "vendor");
  };
  const choice = value.modelChoice;
  const unlisted = choice !== "" && choice !== CUSTOM_MODEL && !catalog.models.some((m) => m.id === choice);
  const efforts = effortsFor(catalog, modelOf(value));
  const customError = !result.ok ? result.error : null;
  const showSelect = vendors.length > 1 || onManageProviders !== undefined;
  return (
    <>
      <SettingsRow
        label="Provider"
        detail={switchingToVendor != null ? `Switching to ${vendorLabel(switchingToVendor)}…` : undefined}
        error={errors.vendor}
        wide
      >
        {(id) =>
          showSelect ? (
            <Select
              value={value.vendor}
              disabled={disabled || switchingToVendor != null}
              onValueChange={(next) => setVendor(next)}
            >
              <SelectTrigger id={id} aria-label="Provider" variant="plain" onPointerDown={refreshUnusable} onFocus={refreshUnusable}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vendors.map((c) => (
                  <SelectItem key={c.vendor} value={c.vendor} disabled={!isSelectable(c.availability)}>
                    {vendorOptionLabel(c)}
                  </SelectItem>
                ))}
                {onManageProviders !== undefined && (
                  <>
                    <SelectSeparator />
                    <SelectItem value={ADD_PROVIDER_VALUE} className="font-medium text-brand-ink">
                      {ADD_PROVIDER_LABEL}
                    </SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          ) : (
            <ReadonlyValue id={id}>{vendorOptionLabel(catalog)}</ReadonlyValue>
          )
        }
      </SettingsRow>
      <SettingsRow label="Model" wide error={errors.model}>
        {(id) => (
          <Select
            value={choice}
            disabled={disabled}
            onValueChange={(next) => {
              onChange(withModel(value, next, catalog), "model");
              if (next === CUSTOM_MODEL) {
                focusCustomOnClose.current = true;
                setFocusCustom(true);
              }
            }}
          >
            <SelectTrigger id={id} aria-label="Model" variant="plain" onPointerDown={revalidateModels} onFocus={revalidateModels}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent
              onCloseAutoFocus={(e) => {
                if (!focusCustomOnClose.current) return;
                e.preventDefault();
                focusCustomOnClose.current = false;
                customRef.current?.focus();
              }}
            >
              <SelectItem value="">{defaultModelText(catalog)}</SelectItem>
              {catalog.models.map((m) => (
                <SelectItem key={m.id} value={m.id} title={m.description ?? undefined}>
                  {m.label}
                </SelectItem>
              ))}
              {unlisted && <SelectItem value={choice}>Custom: {choice}</SelectItem>}
              {catalog.customModelExample !== null && <SelectItem value={CUSTOM_MODEL}>Custom</SelectItem>}
            </SelectContent>
          </Select>
        )}
      </SettingsRow>
      {choice === CUSTOM_MODEL && (
        <SettingsRow label="Model name" stacked={stacked} error={customError}>
          {(id) => (
            <>
              <Input
                ref={customRef}
                id={id}
                value={value.customModel}
                disabled={disabled}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={catalog.customModelExample ?? undefined}
                aria-invalid={customError !== null}
                className={stacked ? "min-w-0 flex-1" : "h-7.5 w-60 text-minor"}
                onChange={(e) => onChange(withModel({ ...value, customModel: e.target.value }, CUSTOM_MODEL, catalog), "model")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing && onCustomSubmit) {
                    e.preventDefault();
                    onCustomSubmit();
                  }
                }}
              />
              {customAction}
            </>
          )}
        </SettingsRow>
      )}
      {efforts.length > 1 && (
        <SettingsRow label="Effort" error={errors.effort}>
          {(id) => (
            <Select value={value.effort} disabled={disabled} onValueChange={(next) => onChange({ ...value, effort: next }, "effort")}>
              <SelectTrigger id={id} aria-label="Effort" variant="plain">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{DEFAULT_CHOICE}</SelectItem>
                {efforts.map((e) => (
                  <SelectItem key={e} value={e}>
                    {effortLabel(e, value.vendor, catalog)}
                  </SelectItem>
                ))}
                {value.effort !== "" && !efforts.includes(value.effort) && (
                  <SelectItem value={value.effort}>{effortLabel(value.effort, value.vendor, catalog)}</SelectItem>
                )}
              </SelectContent>
            </Select>
          )}
        </SettingsRow>
      )}
    </>
  );
}
