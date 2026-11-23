import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";
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
import { useModelCatalog, useModelCatalogs, useRevalidateModels, useVendorChoices, vendorOptionLabel } from "../models.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Select } from "../ui/input.tsx";
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
  const allCatalogs = useModelCatalogs();
  const { options: vendors, refreshUnusable } = useVendorChoices(value.vendor);
  const catalog = useModelCatalog(value.vendor);
  const revalidateModels = useRevalidateModels();
  const result = settingOf(value);
  const customRef = useRef<HTMLInputElement>(null);
  const [focusCustom, setFocusCustom] = useState(false);
  useEffect(() => {
    if (!focusCustom) return;
    customRef.current?.focus();
    setFocusCustom(false);
  }, [focusCustom]);

  const setVendor = (vendor: string) => {
    const next = vendors.find((c) => c.vendor === vendor);
    if (next === undefined || vendor === value.vendor) return;
    onChange({ vendor: next.vendor, modelChoice: "", customModel: "", effort: "" }, "vendor");
  };
  const choice = value.modelChoice;
  const unlisted = choice !== "" && choice !== CUSTOM_MODEL && !catalog.models.some((m) => m.id === choice);
  const efforts = effortsFor(catalog, modelOf(value));
  const customError = !result.ok ? result.error : null;
  const showManageProviders =
    onManageProviders !== undefined && allCatalogs.some((c) => !isSelectable(c.availability));
  return (
    <>
      <SettingsRow
        label="Provider"
        detail={switchingToVendor != null ? `Switching to ${vendorLabel(switchingToVendor)}…` : undefined}
        error={errors.vendor}
        wide
      >
        {(id) => (
          <>
            {vendors.length > 1 ? (
              <Select
                id={id}
                variant="plain"
                value={value.vendor}
                disabled={disabled || switchingToVendor != null}
                onPointerDown={refreshUnusable}
                onFocus={refreshUnusable}
                onChange={(e) => setVendor(e.target.value)}
              >
                {vendors.map((c) => (
                  <option key={c.vendor} value={c.vendor} disabled={!isSelectable(c.availability)}>
                    {vendorOptionLabel(c)}
                  </option>
                ))}
              </Select>
            ) : (
              <ReadonlyValue id={id}>{vendorOptionLabel(catalog)}</ReadonlyValue>
            )}
            {showManageProviders && (
              <Button type="button" variant="ghost" size="sm" className={cn("-mr-3 shrink-0", vendors.length > 1 && "ml-4")} aria-label="Manage providers…" onClick={onManageProviders}>
                Manage…
              </Button>
            )}
          </>
        )}
      </SettingsRow>
      <SettingsRow label="Model" wide error={errors.model}>
        {(id) => (
          <Select
            id={id}
            variant="plain"
            value={choice}
            disabled={disabled}
            onPointerDown={revalidateModels}
            onFocus={revalidateModels}
            onChange={(e) => {
              onChange(withModel(value, e.target.value, catalog), "model");
              if (e.target.value === CUSTOM_MODEL) setFocusCustom(true);
            }}
          >
            <option value="">{defaultModelText(catalog)}</option>
            {catalog.models.map((m) => (
              <option key={m.id} value={m.id} title={m.description ?? undefined}>
                {m.label}
              </option>
            ))}
            {unlisted && <option value={choice}>Custom: {choice}</option>}
            {catalog.customModelExample !== null && <option value={CUSTOM_MODEL}>Custom</option>}
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
                className={stacked ? "min-w-0 flex-1" : "w-60"}
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
            <Select id={id} variant="plain" value={value.effort} disabled={disabled} onChange={(e) => onChange({ ...value, effort: e.target.value }, "effort")}>
              <option value="">{DEFAULT_CHOICE}</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {effortLabel(e, value.vendor, catalog)}
                </option>
              ))}
              {value.effort !== "" && !efforts.includes(value.effort) && (
                <option value={value.effort}>{effortLabel(value.effort, value.vendor, catalog)}</option>
              )}
            </Select>
          )}
        </SettingsRow>
      )}
    </>
  );
}
