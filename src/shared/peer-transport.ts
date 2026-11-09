// 设备连法声明（docs/hub-tunnel-design.md 第 5、8 节）：每种连法的名字、能力集中在这里，网页和守护进程共用。

const PEER_TRANSPORT_KINDS = ["local", "tailscale", "ssh-tunnel"] as const;
export type PeerTransportKind = (typeof PEER_TRANSPORT_KINDS)[number];

/** 远端设备的连法（写进 state/peers.json 的 transport 字段；不写时默认 tailscale）。 */
export type RemotePeerTransportKind = Exclude<PeerTransportKind, "local">;

/** ssh 隧道里那台远端设备的角色：hub = 它是中心（东京），spoke = 它是连入方（Mac）。 */
export type TunnelRole = "hub" | "spoke";

/** GET /api/devices 里每台设备的连法描述，网页只读它和 /api/state 的 tunnel 展示。 */
export type PeerTransport =
  | { kind: "local" }
  | { kind: "tailscale"; url: string }
  | { kind: "ssh-tunnel"; role: TunnelRole };

export interface PeerTransportSpec {
  /** 界面上的显示名。 */
  label: string;
  /** 能不能直接当入口给手机浏览器打开。 */
  canServeMobile: boolean;
  /** 需不需要外部转发层注入身份头（如 Tailscale-User-Login）。 */
  requiresIdentityHeader: boolean;
}

export const PEER_TRANSPORT_SPECS: Readonly<Record<PeerTransportKind, PeerTransportSpec>> = {
  local: {
    label: "本机",
    canServeMobile: false,
    requiresIdentityHeader: false,
  },
  tailscale: {
    label: "Tailscale",
    canServeMobile: true,
    requiresIdentityHeader: true,
  },
  "ssh-tunnel": {
    label: "SSH 隧道",
    canServeMobile: false,
    requiresIdentityHeader: false,
  },
};

export function isRemotePeerTransportKind(value: unknown): value is RemotePeerTransportKind {
  return value === "tailscale" || value === "ssh-tunnel";
}

export function peerTransportSpec(transport: PeerTransport | PeerTransportKind): PeerTransportSpec {
  const kind = typeof transport === "string" ? transport : transport.kind;
  return PEER_TRANSPORT_SPECS[kind];
}

export function peerTransportLabel(transport: PeerTransport): string {
  if (transport.kind === "ssh-tunnel") {
    return transport.role === "hub" ? "SSH 隧道（中心）" : "SSH 隧道";
  }
  return PEER_TRANSPORT_SPECS[transport.kind].label;
}
