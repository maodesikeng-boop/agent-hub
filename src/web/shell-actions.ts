import { useEffect, useMemo, useRef } from "react";
import type { Pm, PmId, ServerInfo } from "../shared/index.ts";
import { resolvePmLook, type SlimeLook } from "../shared/slimes.ts";
import type { HubClient } from "./client.ts";
import { LOCAL_DEVICE, conversationKey, type DeviceKey, type DeviceStatus, type DeviceView } from "./devices.ts";
import type { ConversationRef } from "./notify.ts";
import type { RailComputerInput } from "./rail-model.ts";
import type { DeviceSettings } from "./settings-model.ts";
import type { useDraftStore } from "./upload.ts";

const DRAG_INTERACTIVE_SELECTOR = 'button, a, input, textarea, select, [role="button"], [data-no-drag]';

export interface NewPmDevice {
  key: DeviceKey;
  name: string;
  status: DeviceStatus;
  client: HubClient;
  server: ServerInfo;
  takenLooks: SlimeLook[];
}

export function useWindowDrag(): void {
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || !target.closest("[data-window-drag]")) return;
      if (target.closest(DRAG_INTERACTIVE_SELECTOR)) return;
      window.webkit?.messageHandlers?.windowDrag?.postMessage({ doubleClick: e.detail === 2 });
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, []);
}

interface RetainDeps {
  convs: unknown[];
  listed: boolean;
  pendingCreated: ConversationRef | null;
}

export function usePruneStaleDrafts(
  devices: readonly DeviceView[],
  listed: boolean,
  pendingCreated: ConversationRef | null,
  drafts: ReturnType<typeof useDraftStore<string>>,
  routerDraftKey: string,
): void {
  const prevRef = useRef<RetainDeps | null>(null);
  useEffect(() => {
    const convs = devices.map((d) => (d.state.phase === "ready" ? d.state.conversations : d.state.phase));
    const prev = prevRef.current;
    if (
      prev !== null &&
      prev.listed === listed &&
      prev.pendingCreated === pendingCreated &&
      prev.convs.length === convs.length &&
      convs.every((c, i) => c === prev.convs[i])
    ) {
      return;
    }
    prevRef.current = { convs, listed, pendingCreated };
    const valid = new Set<string>();
    const pendingDevicePrefixes = new Set<string>();
    let keepLocalAll = false;
    for (const d of devices) {
      if (d.state.phase === "ready") {
        for (const id of Object.keys(d.state.conversations)) valid.add(conversationKey(d.key, Number(id)));
      } else if (d.key === LOCAL_DEVICE) {
        keepLocalAll = true;
      } else {
        pendingDevicePrefixes.add(`${d.key}/`);
      }
    }
    if (pendingCreated !== null) valid.add(conversationKey(pendingCreated.device, pendingCreated.id));
    drafts.retain((k) => {
      if (k === routerDraftKey || valid.has(k)) return true;
      const slash = k.indexOf("/");
      if (slash < 0) return keepLocalAll;
      return !listed || pendingDevicePrefixes.has(k.slice(0, slash + 1));
    });
  }, [devices, listed, pendingCreated, drafts, routerDraftKey]);
}

export function useDeviceSettings(
  managed: boolean,
  devices: readonly DeviceView[],
  onChanged: () => void,
): DeviceSettings | null {
  const ref = useRef<DeviceSettings | null>(null);
  return useMemo<DeviceSettings | null>(() => {
    if (!managed) {
      ref.current = null;
      return null;
    }
    const next: DeviceSettings = { devices, onChanged };
    const prev = ref.current;
    if (
      prev !== null &&
      prev.onChanged === next.onChanged &&
      prev.devices.length === next.devices.length &&
      next.devices.every((d, i) => {
        const o = prev.devices[i]!;
        return d.key === o.key && d.info === o.info && d.status === o.status && (d.status !== "offline" || d.lastOnlineAt === o.lastOnlineAt);
      })
    ) {
      return prev;
    }
    ref.current = next;
    return next;
  }, [managed, devices, onChanged]);
}

export function newPmDevicesOf(
  devices: readonly DeviceView[],
  clientForDevice: (key: DeviceKey) => HubClient,
): NewPmDevice[] {
  return devices.map((d) => ({
    key: d.key,
    name: d.info.name,
    status: d.status,
    client: clientForDevice(d.key),
    server: d.state.server,
    takenLooks: d.state.pms.filter((pm: Pm) => pm.archivedAt == null).map(resolvePmLook),
  }));
}

export function useStableRailInputs(devices: readonly DeviceView[]): readonly RailComputerInput[] {
  const ref = useRef<readonly RailComputerInput[]>([]);
  const prev = ref.current;
  const same =
    prev.length === devices.length &&
    devices.every((d, i) => {
      const p = prev[i]!;
      return p.key === d.key && p.name === d.info.name && p.platform === d.info.platform && p.status === d.status;
    });
  if (!same) {
    ref.current = devices.map((d) => ({
      key: d.key,
      name: d.info.name,
      platform: d.info.platform,
      status: d.status,
    }));
  }
  return ref.current;
}

export function accountSettingsTarget(devices: readonly DeviceView[], managed: boolean): "computers" | "sign-in" {
  if (!managed) return "sign-in";
  return devices.length >= 1 ? "computers" : "sign-in";
}

export function togglePmPin(client: HubClient, pmId: PmId, pinned: boolean): void {
  void client.putPmPin(pmId, { pinned }).catch(() => {});
}

export function railComputerKeyOrFallback(key: DeviceKey, computers: readonly DeviceView[]): DeviceView {
  return computers.find((d) => d.key === key) ?? computers[0]!;
}
