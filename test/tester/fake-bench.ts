// An in-memory Bench for unit tests: scripted health, provider status, and remote control, with every request recorded.
import { API_PATHS, VENDOR_LIST, type ProvidersStatusResponse } from "../../src/shared/index.ts";
import type { Bench, BenchConfig, InstanceClient, LocalBenchInstance, LocalInstanceConfig } from "./bench.ts";
import type { ApiClient } from "./instance-client.ts";
import type { RemoteControl } from "./remote.ts";

export interface FakeComputer {
  /** Health answers in order; the last one repeats. */
  health: Array<boolean | Error>;
  providers: ProvidersStatusResponse | Error;
  requests: string[];
}

export function providersAll(availability: "available" | "signed_out" | "not_installed", platform = "linux"): ProvidersStatusResponse {
  return {
    platform,
    gitInstalled: true,
    canInstallGit: false,
    gitJob: null,
    providers: VENDOR_LIST.map(({ id, label }) => ({ vendor: id, label, installed: availability !== "not_installed", version: "1.0", availability, accountSummary: availability === "available" ? "owner" : null, canInstall: false, canUpdate: false, canSignOut: false, authMethods: [], job: null, authFlow: null })),
  };
}

export function fakeComputer(over: Partial<FakeComputer> = {}): FakeComputer {
  return { health: [true], providers: providersAll("available"), requests: [], ...over };
}

function client(name: string, computer: FakeComputer): InstanceClient {
  const json = async <T>(method: string, path: string): Promise<T> => {
    computer.requests.push(`${method} ${path}`);
    if (path.startsWith(API_PATHS.providers)) {
      if (computer.providers instanceof Error) throw computer.providers;
      return computer.providers as T;
    }
    throw new Error(`fake bench has no route for ${method} ${path}`);
  };
  const api = { origin: "http://127.0.0.1:1", prefix: "", cookie: "c=1", json, request: async () => new Response("{}"), forDevice: () => api } as unknown as ApiClient;
  return {
    name,
    api,
    async health() {
      computer.requests.push("GET /api/health");
      const answer = computer.health.length > 1 ? computer.health.shift()! : computer.health[0]!;
      if (answer instanceof Error) throw answer;
      return { ok: answer };
    },
    state: async () => {
      throw new Error("not scripted");
    },
    send: async () => {
      computer.requests.push("POST message");
      throw new Error("fake bench never sends");
    },
    waitForReply: async () => {
      throw new Error("not scripted");
    },
    account: async () => ({ githubLogin: "bench-bot", deviceId: `dev_${name}` }),
  };
}

export interface FakeBenchHandles {
  bench: Bench;
  local: FakeComputer;
  remote: FakeComputer | null;
  control: string[];
  closed: () => boolean;
}

export function fakeBench(config: BenchConfig, options: { local?: FakeComputer; remote?: FakeComputer | null; status?: () => Promise<string> } = {}): FakeBenchHandles {
  const local = options.local ?? fakeComputer({ providers: providersAll("available", "darwin") });
  const remote = options.remote === undefined ? fakeComputer() : options.remote;
  const control: string[] = [];
  let mode: "real" | "fake" | null = "fake";
  let closed = false;
  const localConfig = config.instances.find((i): i is LocalInstanceConfig => i.role === "local")!;
  const localInstance: LocalBenchInstance = {
    ...client("mac", local),
    config: localConfig,
    codeDir: "/code",
    get mode() {
      return mode;
    },
    commit: () => "c".repeat(40),
    start: async (m) => void (control.push(`local start ${m}`), (mode = m)),
    stop: async () => void (control.push("local stop"), (mode = null)),
    restart: async (m) => void (control.push(`local restart ${m}`), (mode = m)),
    deploy: async () => {},
    logs: async () => "",
  };
  const remoteControl: Partial<RemoteControl> = {
    status: options.status ?? (async () => "active\ncommit dddd\n"),
    deploy: async (commit) => void control.push(`remote deploy ${commit}`),
    restart: async (m) => void control.push(`remote restart ${m}`),
  };
  const bench: Bench = {
    config,
    local: () => localInstance,
    remote: () => ({ ...client("tokyo", remote!), ...remoteControl }),
    hasRemote: () => remote !== null,
    close: async () => void (closed = true),
  };
  return { bench, local, remote, control, closed: () => closed };
}
