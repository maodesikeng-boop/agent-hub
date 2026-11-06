import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CUSTOM_MODEL,
  checkModel,
  defaultModelOption,
  effortsFor,
  modelChoiceOf,
  splitModelEffort,
  type AgentSetting,
  type AgentVendor,
  type ModelCatalog,
} from "../../shared/index.ts";
import { useModelCatalog, useModelCatalogs } from "../models.tsx";
import { Input, Select } from "../ui/input.tsx";
import { ReadonlyValue, SettingsRow } from "./SettingsList.tsx";

/** 表单里的 Agent 一栏：模型下拉选了“自定义”时 customModel 是输入框里的字。effort 是 "" = 默认。 */
export interface AgentDraft {
  vendor: AgentVendor;
  /** 模型下拉选中的：""（默认）、模型名（名单里的或以前存的）、CUSTOM_MODEL（正在填）。 */
  modelChoice: string;
  customModel: string;
  effort: string;
}

export type AgentRowKey = "vendor" | "model" | "effort";

/** 存着的值 → 表单。agy 老数据里的完整 ID（gemini-4-argon-high）拆成 模型 + 思考程度显示。 */
export function draftOf(setting: AgentSetting): AgentDraft {
  const { model, effort } = splitModelEffort(setting.vendor, setting.model, setting.effort);
  return { vendor: setting.vendor, modelChoice: modelChoiceOf(model), customModel: "", effort: effort ?? "" };
}

/** 表单 → 要存的值。自定义模型名没填或不合规返回 error（没填时 error 是 null：不提示，只是不能提交）。 */
export function settingOf(draft: AgentDraft): { ok: true; setting: AgentSetting } | { ok: false; error: string | null } {
  let model: string | null = draft.modelChoice === "" ? null : draft.modelChoice;
  if (draft.modelChoice === CUSTOM_MODEL) {
    model = draft.customModel.trim();
    if (model === "") return { ok: false, error: null };
    const problem = checkModel(draft.vendor, model);
    if (problem !== null) return { ok: false, error: problem };
  }
  // 自定义里填了带档位的完整 ID（agy）也拆开存
  return { ok: true, setting: { vendor: draft.vendor, ...splitModelEffort(draft.vendor, model, draft.effort === "" ? null : draft.effort) } };
}

/** 现在选的模型（正在填自定义时是填的字），给思考程度挑档位用。 */
function modelOf(draft: AgentDraft): string | null {
  if (draft.modelChoice === CUSTOM_MODEL) return draft.customModel.trim() || null;
  return draft.modelChoice === "" ? null : draft.modelChoice;
}

/** 换了模型：原来的思考程度新模型不支持就回到默认。 */
function withModel(draft: AgentDraft, modelChoice: string, catalog: ModelCatalog): AgentDraft {
  const next = { ...draft, modelChoice, customModel: modelChoice === CUSTOM_MODEL ? draft.customModel : "" };
  if (next.effort !== "" && !effortsFor(catalog, modelOf(next)).includes(next.effort)) next.effort = "";
  return next;
}

/**
 * 厂商、模型、思考程度三行（放在 SettingsGroup 里）；模型选“自定义”时下面多一行填模型名。新建项目经理和资料页共用。
 * 选项全从模型名单来（models.tsx，docs/ui-standard.md 第 9 条），这里不写死厂商的东西：
 * - 厂商：只有一家时只显示名字（只读），两家以上是下拉；
 * - 模型：厂商自己报的名单（拉不到用打包的），“默认”写出实际用的模型；存着的模型不在名单里时单独列一项“自定义：模型名”；
 *   这家能填完整模型名才有“自定义”；
 * - 思考程度：按选的模型给的档位，没说用这家的通用档位；只有一档（agy 的 GPT-OSS）或没有档位时整行不显示。
 * 下拉都是改了马上存的设置行样式（Select plain）。
 * errors：哪一行保存失败了。customAction：模型名那一行右边额外的东西（资料页的“保存”）。
 */
export function AgentRows({
  value,
  onChange,
  disabled,
  errors = {},
  customAction,
  onCustomSubmit,
}: {
  value: AgentDraft;
  onChange: (draft: AgentDraft, row: AgentRowKey) => void;
  disabled?: boolean;
  errors?: Partial<Record<AgentRowKey, string | null>>;
  customAction?: ReactNode;
  onCustomSubmit?: () => void;
}) {
  const catalogs = useModelCatalogs();
  const catalog = useModelCatalog(value.vendor);
  const result = settingOf(value);
  // 刚选了“自定义”：光标放进模型名输入框（打开页面时不抢焦点）
  const customRef = useRef<HTMLInputElement>(null);
  const [focusCustom, setFocusCustom] = useState(false);
  useEffect(() => {
    if (!focusCustom) return;
    customRef.current?.focus();
    setFocusCustom(false);
  }, [focusCustom]);

  const setVendor = (vendor: string) => {
    const next = catalogs.find((c) => c.vendor === vendor);
    if (next === undefined || vendor === value.vendor) return;
    // 换了厂商：模型、思考程度回到默认（别家的不一定有）
    onChange({ vendor: next.vendor, modelChoice: "", customModel: "", effort: "" }, "vendor");
  };
  const choice = value.modelChoice;
  const unlisted = choice !== "" && choice !== CUSTOM_MODEL && !catalog.models.some((m) => m.id === choice);
  const efforts = effortsFor(catalog, modelOf(value));
  const customError = !result.ok ? result.error : null;
  return (
    <>
      <SettingsRow label="厂商" error={errors.vendor}>
        {(id) =>
          catalogs.length > 1 ? (
            <Select id={id} variant="plain" value={value.vendor} disabled={disabled} onChange={(e) => setVendor(e.target.value)}>
              {catalogs.map((c) => (
                <option key={c.vendor} value={c.vendor}>
                  {c.label}
                </option>
              ))}
            </Select>
          ) : (
            <ReadonlyValue id={id}>{catalog.label}</ReadonlyValue>
          )
        }
      </SettingsRow>
      <SettingsRow label="模型" error={errors.model}>
        {(id) => (
          <Select
            id={id}
            variant="plain"
            value={choice}
            disabled={disabled}
            onChange={(e) => {
              onChange(withModel(value, e.target.value, catalog), "model");
              if (e.target.value === CUSTOM_MODEL) setFocusCustom(true);
            }}
          >
            <option value="">{defaultModelOption(catalog)}</option>
            {catalog.models.map((m) => (
              <option key={m.id} value={m.id} title={m.description ?? undefined}>
                {m.label}
              </option>
            ))}
            {unlisted && <option value={choice}>自定义：{choice}</option>}
            {catalog.customModelExample !== null && <option value={CUSTOM_MODEL}>自定义</option>}
          </Select>
        )}
      </SettingsRow>
      {choice === CUSTOM_MODEL && (
        <SettingsRow label="模型名" error={customError}>
          {(id) => (
            <>
              <Input
                ref={customRef}
                id={id}
                value={value.customModel}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                placeholder={catalog.customModelExample ?? undefined}
                aria-invalid={customError !== null}
                className="w-[240px]"
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
      {/* 这个模型只有一档（或没有档位）时没得选，不显示下拉 */}
      {efforts.length > 1 && (
        <SettingsRow label="思考程度" error={errors.effort}>
          {(id) => (
            <Select id={id} variant="plain" value={value.effort} disabled={disabled} onChange={(e) => onChange({ ...value, effort: e.target.value }, "effort")}>
              <option value="">默认</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
              {value.effort !== "" && !efforts.includes(value.effort) && <option value={value.effort}>{value.effort}</option>}
            </Select>
          )}
        </SettingsRow>
      )}
    </>
  );
}
