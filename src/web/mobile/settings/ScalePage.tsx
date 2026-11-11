// #/settings/scale：界面大小四档整行勾选（ChoiceRows），点了马上整页跟着缩放，不放保存按钮。
import { ChoiceRows } from "../../components/ChoiceRows.tsx";
import { SettingsGroup } from "../../components/SettingsList.tsx";
import { useUiScaleSetting } from "../../settings-model.ts";

export function ScalePage() {
  const { scale, options, setScale } = useUiScaleSetting();
  return (
    <SettingsGroup label="Interface scale">
      <ChoiceRows label="Interface scale" value={scale} options={options} onChange={setScale} />
    </SettingsGroup>
  );
}
