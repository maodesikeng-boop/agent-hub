// 中继测试共用：内存存储、假 WebSocket、登记和登入的步骤。
import type { DeviceId } from "../shared/api.ts";
import type { AccountId, AccountLogin } from "../shared/mesh.ts";
import type { MeshIdentity } from "../daemon/mesh/identity.ts";
import type { RelayAccountRecord, RelayAccountRoom, RelayAccountStorage, RelayControlHandle, RelaySocket } from "./core.ts";
import { RELAY_PROTOCOL_VERSION, encodeRelayFrame, parseRelayServerFrame, relayControlMessage, relayRegisterMessage, type RelayRegisterRequest, type RelayServerFrame } from "./protocol.ts";

export const RELAY_ORIGIN = "https://relay.test";
export const LOGIN: AccountLogin = { provider: "github", userId: "1001", login: "octo" };

export function memoryStorage(initial: RelayAccountRecord | null = null): RelayAccountStorage & { record: RelayAccountRecord | null; saves: number } {
  const storage = {
    record: initial === null ? null : structuredClone(initial),
    saves: 0,
    async load() {
      return storage.record === null ? null : structuredClone(storage.record);
    },
    async save(record: RelayAccountRecord) {
      storage.saves++;
      storage.record = structuredClone(record);
    },
  };
  return storage;
}

export class FakeSocket implements RelaySocket {
  readonly sent: Array<string | Uint8Array> = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string | Uint8Array): void {
    if (this.closed === null) this.sent.push(data);
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }
  frames(): RelayServerFrame[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((d) => {
      const frame = parseRelayServerFrame(d);
      if (frame === null) throw new Error(`中继发了不合规的帧：${d}`);
      return frame;
    });
  }
  last<T extends RelayServerFrame["type"]>(type: T): Extract<RelayServerFrame, { type: T }> | undefined {
    return this.frames().filter((f): f is Extract<RelayServerFrame, { type: T }> => f.type === type).at(-1);
  }
  all<T extends RelayServerFrame["type"]>(type: T): Array<Extract<RelayServerFrame, { type: T }>> {
    return this.frames().filter((f): f is Extract<RelayServerFrame, { type: T }> => f.type === type);
  }
  binary(): Uint8Array[] {
    return this.sent.filter((d): d is Uint8Array => typeof d !== "string");
  }
  clear(): void {
    this.sent.length = 0;
  }
}

export function registerRequest(identity: MeshIdentity, over: { id?: DeviceId; name?: string; token?: string } = {}): RelayRegisterRequest {
  const id = over.id ?? identity.deviceId;
  return {
    provider: "github",
    token: over.token ?? "gho_test",
    device: { id, name: over.name ?? `dev-${id.slice(0, 4)}`, platform: "linux", certPem: identity.certPem, publicKey: identity.publicKey },
    signature: identity.sign(relayRegisterMessage({ relayOrigin: RELAY_ORIGIN, provider: "github", device: id, fingerprint: identity.fingerprint })),
  };
}

export interface ConnectedDevice {
  socket: FakeSocket;
  handle: RelayControlHandle;
  session: string;
  send(frame: Parameters<typeof encodeRelayFrame>[0]): Promise<void>;
}

/** 开控制连接、回 challenge 的签名，等到 welcome。 */
export async function connect(room: RelayAccountRoom, identity: MeshIdentity, accountId: AccountId, id: DeviceId = identity.deviceId): Promise<ConnectedDevice> {
  const socket = new FakeSocket();
  const handle = room.openControl(socket);
  const challenge = socket.last("challenge");
  if (challenge === undefined) throw new Error("没收到 challenge");
  await handle.receive(
    encodeRelayFrame({
      type: "hello",
      device: id,
      version: RELAY_PROTOCOL_VERSION,
      signature: identity.sign(relayControlMessage({ relayOrigin: RELAY_ORIGIN, accountId, device: id, nonce: challenge.nonce })),
    }),
  );
  const welcome = socket.last("welcome");
  if (welcome === undefined) throw new Error(`没收到 welcome：${JSON.stringify(socket.frames())}`);
  return { socket, handle, session: welcome.session, send: (frame) => handle.receive(encodeRelayFrame(frame)) };
}
