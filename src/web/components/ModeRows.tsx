import { PM_MODES, type PmMode } from "../../shared/index.ts";
import { MODE_LABELS, MODE_OPTION_DETAILS } from "../format.ts";
import { ChoiceRows, type ChoiceOption } from "./ChoiceRows.tsx";

const MODE_OPTIONS: readonly ChoiceOption<PmMode>[] = PM_MODES.map((mode) => ({
  value: mode,
  label: MODE_LABELS[mode],
  detail: MODE_OPTION_DETAILS[mode],
}));

/** 项目经理的模式：分组框里一种模式一行（名字、一句说明，右边一个圆，选中的打勾），新建和资料页共用。放在 SettingsGroup 里。 */
export function ModeRows({
  value,
  onChange,
  disabled,
  label,
}: {
  value: PmMode;
  onChange: (mode: PmMode) => void;
  disabled?: boolean;
  label: string;
}) {
  return <ChoiceRows label={label} value={value} options={MODE_OPTIONS} disabled={disabled} onChange={onChange} />;
}
