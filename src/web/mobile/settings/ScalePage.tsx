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
