// #/settings/providers：手机端一键安装/更新与底部抽屉直接登录（100% 复用 settings-model.ts 与 ProvidersSettings 共用表单内芯）。
import { useCallback, useMemo, useState } from "react";
import type { AgentVendor } from "../../../shared/index.ts";
import {
  ProviderAccountBody,
  ProviderSignInBody,
  ProvidersListSection,
} from "../../components/ProvidersSettings.tsx";
import { LOCAL_DEVICE, type DeviceKey } from "../../devices.ts";
import {
  isProviderAuthFlowActive,
  useProvidersSetting,
  type DeviceSettings,
} from "../../settings-model.ts";
import { SettingsDrawer, useDrawerTarget } from "./SettingsDrawer.tsx";

interface DrawerTarget {
  mode: "signin" | "account";
  vendor: AgentVendor;
}

export function ProvidersPage({
  devices = null,
  defaultDeviceKey = LOCAL_DEVICE,
}: {
  devices?: DeviceSettings | null;
  defaultDeviceKey?: DeviceKey;
}) {
  const model = useProvidersSetting({
    enabled: true,
    devices: devices?.devices ?? null,
    defaultDeviceKey,
  });
  const drawer = useDrawerTarget<DrawerTarget>();
  const [modeOverride, setModeOverride] = useState<"signin" | null>(null);

  const currentMode = modeOverride ?? drawer.target?.mode ?? "signin";
  const targetItem = useMemo(
    () =>
      drawer.target === null
        ? null
        : (model.status?.providers.find((p) => p.vendor === drawer.target?.vendor) ?? null),
    [drawer.target, model.status],
  );

  const openDrawer = useCallback(
    (target: DrawerTarget) => {
      setModeOverride(null);
      drawer.show(target);
    },
    [drawer],
  );

  const closeDrawer = useCallback(() => {
    setModeOverride(null);
    drawer.close();
  }, [drawer]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (
          currentMode === "signin" &&
          targetItem?.authFlow &&
          isProviderAuthFlowActive(targetItem.authFlow.phase) &&
          !targetItem.authFlow.ownedByOtherClient
        ) {
          void model.cancelAuth(targetItem.vendor, { flowId: targetItem.authFlow.flowId });
        }
        setModeOverride(null);
      }
      drawer.onOpenChange(open);
    },
    [currentMode, drawer, model, targetItem],
  );

  const drawerTitle =
    targetItem === null
      ? "Providers"
      : currentMode === "signin"
        ? `Sign in to ${targetItem.label}`
        : targetItem.label;

  return (
    <>
      <ProvidersListSection
        model={model}
        onOpenSignIn={(vendor) => openDrawer({ mode: "signin", vendor })}
        onOpenAccount={(vendor) => openDrawer({ mode: "account", vendor })}
      />

      <SettingsDrawer open={drawer.open && targetItem !== null} onOpenChange={handleOpenChange} title={drawerTitle}>
        {targetItem !== null &&
          (currentMode === "signin" ? (
            <ProviderSignInBody
              key={`${targetItem.vendor}:${model.deviceKey}`}
              item={targetItem}
              model={model}
              mobile
              onDone={closeDrawer}
              onCancel={closeDrawer}
            />
          ) : (
            <ProviderAccountBody
              key={`account:${targetItem.vendor}:${model.deviceKey}`}
              item={targetItem}
              model={model}
              mobile
              onSwitchAccount={() => setModeOverride("signin")}
              onClose={closeDrawer}
            />
          ))}
      </SettingsDrawer>
    </>
  );
}
