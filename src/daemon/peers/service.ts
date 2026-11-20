import { z } from "zod";
import { API_PATHS, isDeviceId, type ApiErrorCode, type DeviceId, type DeviceInfo } from "../../shared/index.ts";
import { API_ERRORS } from "../../shared/errors.ts";
import { normalizeName } from "../../shared/domain.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { Mesh } from "../mesh/index.ts";
import type { ProxyTarget } from "./proxy.ts";

export class PeerError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode | undefined;
  constructor(statusCode: number, message: string, code?: ApiErrorCode) {
    super(message);
    this.name = "PeerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const invalid = (message: string) => new PeerError(400, message, "invalid");
const notFound = () => new PeerError(404, API_ERRORS.device_not_found.text, "device_not_found");
const offline = (name: string) => new PeerError(502, `连不上“${name}”`, "device_offline");

const nameBodySchema = z.strictObject({
  name: z
    .string({ error: "名字不能为空，也不能太长" })
    .transform((s) => normalizeName(s))
    .refine((v): v is string => v !== null, "名字不能为空，也不能太长"),
});

export interface PeersOptions {
  device: { id: DeviceId; name: string };
  saveName: (name: string) => void;
  mesh: Pick<Mesh, "selfId" | "trust" | "dialer" | "isOnline" | "request" | "removeDevice">;
  log?: (line: string) => void;
}

export interface Peers {
  readonly selfId: DeviceId;
  list(): DeviceInfo[];
  target(id: string): ProxyTarget | null;
  renameSelf(body: unknown): DeviceInfo;
  receiveRenamed(from: DeviceId, body: unknown): void;
  rename(id: string, body: unknown): Promise<DeviceInfo>;
  remove(id: string): Promise<void>;
  close(): void;
}

export function createPeers(opts: PeersOptions): Peers {
  const log = opts.log ?? (() => {});
  const { mesh } = opts;
  const selfId = mesh.selfId;
  const closing = new AbortController();

  const infoOf = (id: DeviceId): DeviceInfo | null => {
    const device = mesh.trust.get(id);
    if (device === undefined) return null;
    const self = id === selfId;
    const online = self || mesh.isOnline(id);
    return {
      id,
      name: self ? opts.device.name : device.name,
      platform: device.platform,
      self,
      online,
      link: self ? "local" : online ? mesh.dialer.linkOf(id) : null,
      fingerprint: device.fingerprint,
    };
  };
  const list = () => mesh.trust.list().flatMap((d) => infoOf(d.id) ?? []);
  const requirePeer = (id: string) => {
    const device = isDeviceId(id) && id !== selfId ? mesh.trust.get(id) : undefined;
    if (device === undefined) throw notFound();
    return device;
  };
  const parseName = (body: unknown) => {
    const parsed = nameBodySchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw invalid(issue?.code === "unrecognized_keys" ? `不认识的字段：${issue.keys[0]}` : (issue?.message ?? "请求体必须是 JSON 对象"));
    }
    return parsed.data.name;
  };

  const announceName = (name: string) => {
    for (const peer of mesh.trust.list().slice(1)) {
      if (!mesh.isOnline(peer.id)) continue;
      mesh
        .request(peer.id, API_PATHS.peerRenamed, { method: "PUT", body: JSON.stringify({ name }) })
        .then((res) => res.body?.cancel())
        .catch((error: unknown) => {
          if (!closing.signal.aborted) log(`${LOG_PREFIX} 联机：把新名字告诉“${peer.name}”没成：${error instanceof Error ? error.message : String(error)}`);
        });
    }
  };

  const renameSelf = (body: unknown): DeviceInfo => {
    const name = parseName(body);
    opts.device.name = name;
    opts.saveName(name);
    mesh.trust.rename(selfId, name);
    announceName(name);
    return infoOf(selfId)!;
  };

  return {
    selfId,
    list,
    target(id) {
      const device = isDeviceId(id) && id !== selfId ? mesh.trust.get(id) : undefined;
      return device === undefined ? null : { name: device.name, agent: mesh.dialer.agentFor(device.id) };
    },
    renameSelf,
    receiveRenamed(from, body) {
      mesh.trust.rename(from, parseName(body));
    },
    async rename(id, body) {
      if (id === selfId) return renameSelf(body);
      const name = parseName(body);
      const peer = requirePeer(id);
      let res: Response;
      try {
        res = await mesh.request(peer.id, API_PATHS.peerName, { method: "PUT", body: JSON.stringify({ name }) });
      } catch {
        throw offline(peer.name);
      }
      await res.body?.cancel();
      if (res.status !== 204) throw new PeerError(res.status >= 500 ? 502 : 400, `“${peer.name}”没改成名字（HTTP ${res.status}）`);
      mesh.trust.rename(peer.id, name);
      return infoOf(peer.id)!;
    },
    async remove(id) {
      if (id === selfId) throw invalid("不能移除本机：本机请退出账号");
      if (!isDeviceId(id)) throw notFound();
      try {
        await mesh.removeDevice(id);
      } catch (error) {
        throw new PeerError(404, error instanceof Error ? error.message : API_ERRORS.device_not_found.text, "device_not_found");
      }
      log(`${LOG_PREFIX} 联机：把 ${id} 移出了账号`);
    },
    close() {
      closing.abort();
    },
  };
}
