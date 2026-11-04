import { useEffect, useRef, useState } from "react";
import {
  AGENT_VENDORS,
  CUSTOM_MODEL,
  VENDOR_SPECS,
  checkModel,
  isAgentVendor,
  modelChoiceOf,
  type AgentSetting,
  type AgentVendor,
} from "../../shared/index.ts";
import { Input, Select } from "../ui/input.tsx";
import { Field } from "./Field.tsx";

/** 表单里的 Agent 一栏：模型下拉选了“自定义”时 customModel 是输入框里的字。effort 是 "" = 默认。 */
export interface AgentDraft {
  vendor: AgentVendor;
  /** 模型下拉选中的：""（默认）、清单里的别名、CUSTOM_MODEL。 */
  modelChoice: string;
  customModel: string;
  effort: string;
}

export function draftOf(setting: AgentSetting): AgentDraft {
  const modelChoice = modelChoiceOf(setting.vendor, setting.model);
  return {
    vendor: setting.vendor,
    modelChoice,
    customModel: modelChoice === CUSTOM_MODEL ? (setting.model ?? "") : "",
    effort: setting.effort ?? "",
  };
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
  return { ok: true, setting: { vendor: draft.vendor, model, effort: draft.effort === "" ? null : draft.effort } };
}

/** 厂商、模型、思考程度三个下拉；模型选“自定义”时下面多一个输入框。新建项目经理和资料页共用。 */
export function AgentFields({ value, onChange, disabled }: { value: AgentDraft; onChange: (draft: AgentDraft) => void; disabled?: boolean }) {
  const spec = VENDOR_SPECS[value.vendor];
  const result = settingOf(value);
  // 刚选了“自定义”：光标放进模型名输入框（打开页面时已经是自定义的不抢焦点）
  const customRef = useRef<HTMLInputElement>(null);
  const [focusCustom, setFocusCustom] = useState(false);
  useEffect(() => {
    if (!focusCustom) return;
    customRef.current?.focus();
    setFocusCustom(false);
  }, [focusCustom]);
  const setVendor = (vendor: string) => {
    if (!isAgentVendor(vendor) || vendor === value.vendor) return;
    // 换了厂商：模型、思考程度回到默认（别家的不一定有）
    onChange({ vendor, modelChoice: "", customModel: "", effort: "" });
  };
  return (
    <div className="grid gap-4">
      {/* 厂商一栏不窄于自己的内容（弹窗里三栏挤，“Claude Code”不能被截） */}
      <div className="grid gap-4 sm:grid-cols-[minmax(max-content,1fr)_1fr_1fr]">
        <Field label="厂商">
          {(id) => (
            <Select id={id} value={value.vendor} disabled={disabled} onChange={(e) => setVendor(e.target.value)}>
              {AGENT_VENDORS.map((v) => (
                <option key={v} value={v}>
                  {VENDOR_SPECS[v].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="模型">
          {(id) => (
            <Select
              id={id}
              value={value.modelChoice}
              disabled={disabled}
              onChange={(e) => {
                onChange({ ...value, modelChoice: e.target.value });
                if (e.target.value === CUSTOM_MODEL) setFocusCustom(true);
              }}
            >
              <option value="">默认</option>
              {spec.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {spec.customModel && <option value={CUSTOM_MODEL}>自定义</option>}
            </Select>
          )}
        </Field>
        <Field label="思考程度">
          {(id) => (
            <Select id={id} value={value.effort} disabled={disabled} onChange={(e) => onChange({ ...value, effort: e.target.value })}>
              <option value="">默认</option>
              {spec.efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {value.modelChoice === CUSTOM_MODEL && (
        <Field label="模型名">
          {(id) => (
            <Input
              ref={customRef}
              id={id}
              value={value.customModel}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder={spec.customModelExample}
              aria-invalid={!result.ok && result.error !== null}
              className="aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/20"
              onChange={(e) => onChange({ ...value, customModel: e.target.value })}
            />
          )}
        </Field>
      )}
      {!result.ok && result.error !== null && <p className="-mt-2 text-[13px] text-danger">{result.error}</p>}
    </div>
  );
}
