// 本机在 tailnet 里叫什么、主人是谁（docs/multi-device-design.md 第 3.3 节）：问 tailscale status --json，结果缓存。
// 界面服务每个请求都要用（Host 白名单、身份头），所以 current() 是同步的、只读缓存；过期了在后台再问一次，同时最多一个在跑。
import { execFile } from "node:child_process";
import { LRUCache } from "lru-cache";
import {
  ENV_TAILNET_NAME,
  ENV_TAILNET_OWNER,
  TAILNET_PROBE_FAIL_TTL_MS,
  TAILNET_PROBE_OK_TTL_MS,
  TAILSCALE_STATUS_TIMEOUT_MS,
} from "../../shared/index.ts";

type Env = Record<string, string | undefined>;

export interface TailnetSelf {
  /** 本机的 MagicDNS 名字，小写、不带末尾的点：<机器>.<tailnet>.ts.net。serve 的 https 地址就是它。 */
  dnsName: string;
  /** 设备主人的 Tailscale 登录名（小写）。打了 tag 的设备没有主人，是 null：经 serve 的请求一律拒绝。 */
  owner: string | null;
}

const normalizeDnsName = (raw: string) => raw.trim().replace(/\.$/, "").toLowerCase();
const normalizeLogin = (raw: string) => raw.trim().toLowerCase();

interface StatusJson {
  BackendState?: unknown;
  Self?: { DNSName?: unknown; UserID?: unknown; Tags?: unknown };
  User?: Record<string, { LoginName?: unknown } | undefined>;
}

/** 解析 tailscale status --json。没登录 / 没在跑 / 没有名字 / 不是 JSON → null。 */
export function parseTailscaleStatus(stdout: string): TailnetSelf | null {
  let status: StatusJson;
  try {
    status = JSON.parse(stdout) as StatusJson;
  } catch {
    return null;
  }
  if (status?.BackendState !== "Running" || typeof status.Self?.DNSName !== "string") return null;
  const dnsName = normalizeDnsName(status.Self.DNSName);
  if (dnsName === "") return null;
  const tagged = Array.isArray(status.Self.Tags) && status.Self.Tags.length > 0;
  const login = tagged ? undefined : status.User?.[String(status.Self.UserID)]?.LoginName;
  return { dnsName, owner: typeof login === "string" && login.trim() !== "" ? normalizeLogin(login) : null };
}

export interface TailnetProbe {
  /** 缓存的结果，没问到是 null。过期（或还没问过）就在后台去问，这次先回旧的。 */
  current(): TailnetSelf | null;
  /** 等正在跑的那次（没有就新问一次）问完，回最新结果。启动时、测试里用。 */
  refresh(): Promise<TailnetSelf | null>;
}

export interface TailnetProbeOptions {
  /** 跑 tailscale status --json，回 stdout（见 runTailscaleStatus）。 */
  run: () => Promise<string>;
  /** AGENT_HUB_TAILNET_NAME、AGENT_HUB_TAILNET_OWNER 写死名字、主人；两个都写了就不跑命令。 */
  env: Env;
  now?: () => number;
  okTtlMs?: number;
  failTtlMs?: number;
}

export function createTailnetProbe(opts: TailnetProbeOptions): TailnetProbe {
  const now = opts.now ?? Date.now;
  const okTtl = opts.okTtlMs ?? TAILNET_PROBE_OK_TTL_MS;
  const failTtl = opts.failTtlMs ?? TAILNET_PROBE_FAIL_TTL_MS;
  const nameOverride = opts.env[ENV_TAILNET_NAME]?.trim() ? normalizeDnsName(opts.env[ENV_TAILNET_NAME]!) : null;
  const ownerOverride = opts.env[ENV_TAILNET_OWNER]?.trim() ? normalizeLogin(opts.env[ENV_TAILNET_OWNER]!) : null;

  if (nameOverride !== null && ownerOverride !== null) {
    const fixed = { dnsName: nameOverride, owner: ownerOverride };
    return { current: () => fixed, refresh: async () => fixed };
  }

  const cache = new LRUCache<"self", { value: TailnetSelf | null; checkedAt: number }>({ max: 1 });
  let inflight: Promise<TailnetSelf | null> | null = null;

  const withOverrides = (probed: TailnetSelf | null): TailnetSelf | null => {
    const dnsName = nameOverride ?? probed?.dnsName;
    if (dnsName === undefined) return null;
    return { dnsName, owner: ownerOverride ?? probed?.owner ?? null };
  };

  const probe = (): Promise<TailnetSelf | null> =>
    (inflight ??= opts
      .run()
      .then(parseTailscaleStatus, () => null)
      .then((result) => {
        const value = withOverrides(result);
        cache.set("self", { value, checkedAt: now() });
        inflight = null;
        return value;
      }));

  const stale = () => {
    const entry = cache.get("self");
    if (entry === undefined) return true;
    return now() - entry.checkedAt > (entry.value === null ? failTtl : okTtl);
  };

  return {
    current() {
      if (stale()) void probe();
      return cache.get("self")?.value ?? null;
    },
    refresh: () => inflight ?? probe(),
  };
}

/** 真的去跑 tailscale status --json。没装、没开、超时都是失败（探测按“没问到”处理）。 */
export function runTailscaleStatus(cli: string): () => Promise<string> {
  return () =>
    new Promise((resolve, reject) => {
      execFile(cli, ["status", "--json"], { timeout: TAILSCALE_STATUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
}
