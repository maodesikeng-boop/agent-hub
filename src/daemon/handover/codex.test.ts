import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { ForkUnsupportedError, forkSourceOf } from "./forker.ts";
import type { ForkSource } from "./forker.ts";
import { FORKERS } from "./forkers.ts";
import { CODEX_FORKERS, CODEX_NATIVE_FORKER_ID, createCodexForker } from "./codex.ts";
import type { AgentSessionRow } from "../../shared/domain.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;
type Handler = (params: Json, server: FakeServer) => Json | Error | "hang";

/** 假的 codex app-server：按方法名回执，turn/start 之后按脚本推通知。 */
class FakeServer extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly pid = 4242;
  readonly requests: Array<{ method: string; params: Json }> = [];
  killed = false;
  spawnArgs: { command: string; args: string[]; cwd: string; env: Record<string, string> } | null = null;
  reverseReplies: Json[] = [];

  readonly handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler>) {
    super();
    this.handlers = handlers;
    let buf = "";
    this.stdin.on("data", (c: Buffer) => {
      buf += c.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.#handle(JSON.parse(line) as Json);
      }
    });
  }
  #handle(msg: Json): void {
    if (typeof msg.method !== "string") {
      this.reverseReplies.push(msg);
      return;
    }
    const method = msg.method;
    const params = (msg.params as Json | undefined) ?? {};
    this.requests.push({ method, params });
    if (msg.id === undefined) return;
    const handler = this.handlers[method];
    const result: Json | Error | "hang" = handler ? handler(params, this) : {};
    if (result === "hang") return;
    queueMicrotask(() => {
      if (result instanceof Error) this.send({ id: msg.id, error: { code: -32600, message: result.message } });
      else this.send({ id: msg.id, result });
    });
  }
  send(obj: Json): void {
    this.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\n");
  }
  notify(method: string, params: Json): void {
    this.send({ method, params });
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

const turnScript = (texts: string[], status = "completed"): Handler => (_p, s) => {
  setTimeout(() => {
    s.notify("turn/started", { turn: { id: "t1" } });
    s.notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50 } } });
    s.notify("thread/tokenUsage/updated", { tokenUsage: { last: { inputTokens: 1100, cachedInputTokens: 1000, outputTokens: 70 } } });
    for (const text of texts) s.notify("item/completed", { item: { type: "agentMessage", text } });
    s.notify("turn/completed", { turn: { id: "t1", status, error: status === "completed" ? null : { message: "boom" } } });
  }, 0);
  return { turn: { id: "t1" } };
};

const baseHandlers = (): Record<string, Handler> => ({
  initialize: () => ({}),
  "thread/fork": () => ({ thread: { id: "fork-1", ephemeral: true, path: null } }),
  "turn/start": turnScript(["交接正文"]),
  "thread/delete": () => new Error("thread is not persisted and cannot be deleted: fork-1"),
});

function setup(handlers = baseHandlers()) {
  const server = new FakeServer(handlers);
  const forker = createCodexForker({
    spawnProcess: (command, args, opts) => {
      server.spawnArgs = { command, args, cwd: opts.cwd, env: opts.env };
      return server as unknown as ChildProcess;
    },
  });
  return { server, forker };
}

function source(overrides: Partial<ForkSource> = {}): ForkSource {
  const dir = mkdtempSync(join(tmpdir(), "codex-forker-"));
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, "你是项目经理。");
  return {
    sessionId: 7,
    vendor: "codex",
    vendorSessionId: "thread-src",
    executablePath: "/bin/codex",
    cwd: "/code/foo",
    addDirs: [],
    model: "gpt-x",
    effort: "high",
    launch: {
      promptFile,
      settingsFile: join(dir, "none.json"),
      env: {
        PATH: "/run/bin:/usr/bin",
        [ENV_HUB_TOKEN]: "secret-token",
        [ENV_HUB_SOCK]: "/run/hub.sock",
      },
      fingerprint: "fp",
    } as ForkSource["launch"],
    ...overrides,
  } as ForkSource;
}

const noAbort = (): AbortSignal => new AbortController().signal;

describe("登记", () => {
  it("FORKERS.codex 就是 CODEX_FORKERS：一个 native 的办法，id 固定", () => {
    expect(FORKERS.codex).toBe(CODEX_FORKERS);
    expect(CODEX_FORKERS.map((f) => [f.id, f.kind])).toEqual([[CODEX_NATIVE_FORKER_ID, "native"]]);
    expect(CODEX_NATIVE_FORKER_ID).toBe("codex-native");
  });
});

describe("fork：app-server thread/fork", () => {
  it("起的是 app-server；env 里没有 HUB_*；握手后 thread/fork 带 ephemeral、只读、从不问，config 里的 set 也没有 HUB_*", async () => {
    const { server, forker } = setup();
    const handle = await forker.fork(source(), noAbort());
    expect(handle).toEqual({ forkId: "fork-1" });
    expect(server.spawnArgs?.command).toBe("/bin/codex");
    expect(server.spawnArgs?.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(server.spawnArgs?.cwd).toBe("/code/foo");
    expect(server.spawnArgs?.env[ENV_HUB_TOKEN]).toBeUndefined();
    expect(server.spawnArgs?.env[ENV_HUB_SOCK]).toBeUndefined();
    expect(server.spawnArgs?.env.PATH).toBe("/run/bin:/usr/bin");
    expect(server.requests.map((r) => r.method)).toEqual(["initialize", "initialized", "thread/fork"]);
    const params = server.requests[2]!.params;
    expect(params).toMatchObject({
      threadId: "thread-src",
      cwd: "/code/foo",
      model: "gpt-x",
      developerInstructions: "你是项目经理。",
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });
    expect(JSON.stringify(params)).not.toContain("secret-token");
    expect(JSON.stringify(params)).not.toContain("hub.sock");
    expect((params.config as Json)["shell_environment_policy.set"]).toEqual({ PATH: "/run/bin:/usr/bin" });
    await forker.remove(handle);
  });

  it("即使调用方没去掉 HUB_*（launch.env 里还有），也不会传给 codex", async () => {
    const { server, forker } = setup();
    const handle = await forker.fork(source(), noAbort());
    expect(JSON.stringify(server.requests)).not.toContain("secret-token");
    await forker.remove(handle);
  });

  it("codex 找不到：ForkUnsupportedError（换下一个办法）", async () => {
    const forker = createCodexForker({
      spawnProcess: () => {
        const child = new EventEmitter() as unknown as ChildProcess;
        Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), kill: () => true });
        queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })));
        return child;
      },
    });
    await expect(forker.fork(source(), noAbort())).rejects.toBeInstanceOf(ForkUnsupportedError);
  });

  it("thread 找不到：ForkUnsupportedError；别的错误照抛，进程关掉", async () => {
    const a = setup({ ...baseHandlers(), "thread/fork": () => new Error("thread not found: thread-src") });
    await expect(a.forker.fork(source(), noAbort())).rejects.toBeInstanceOf(ForkUnsupportedError);
    expect(a.server.killed).toBe(true);
    const b = setup({ ...baseHandlers(), "thread/fork": () => new Error("network down") });
    const error = await b.forker.fork(source(), noAbort()).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ForkUnsupportedError);
    expect((error as Error).message).toContain("network down");
    expect(b.server.killed).toBe(true);
  });
});

describe("write：在复制那份上跑一轮", () => {
  it("收齐 agentMessage 到 turn/completed；用量按每次请求累加（input 不含缓存）；turn/start 只读", async () => {
    const { server, forker } = setup({ ...baseHandlers(), "turn/start": turnScript(["第一段", "第二段"]) });
    const src = source();
    const handle = await forker.fork(src, noAbort());
    const result = await forker.write(src, handle, "写交接", noAbort());
    expect(result.text).toBe("第一段\n\n第二段");
    expect(result.usage).toEqual({ input: 400 + 100, cacheRead: 1600, cacheWrite: 0, output: 120, context: 1100 });
    const turn = server.requests.find((r) => r.method === "turn/start")!.params;
    expect(turn).toMatchObject({
      threadId: "fork-1",
      input: [{ type: "text", text: "写交接" }],
      model: "gpt-x",
      effort: "high",
      sandboxPolicy: { type: "readOnly" },
    });
    await forker.remove(handle);
  });

  it("这一轮没成功（failed）：抛错，带 codex 的错误", async () => {
    const { forker } = setup({ ...baseHandlers(), "turn/start": turnScript([], "failed") });
    const src = source();
    const handle = await forker.fork(src, noAbort());
    await expect(forker.write(src, handle, "写交接", noAbort())).rejects.toThrow(/failed.*boom/);
    await forker.remove(handle);
  });

  it("这一轮没有文字：照常返回空串（空不空由账本判断）", async () => {
    const { forker } = setup({ ...baseHandlers(), "turn/start": turnScript([]) });
    const src = source();
    const handle = await forker.fork(src, noAbort());
    expect((await forker.write(src, handle, "x", noAbort())).text).toBe("");
    await forker.remove(handle);
  });

  it("服务端中途来审批请求：一律拒绝", async () => {
    const { server, forker } = setup({
      ...baseHandlers(),
      "turn/start": (p, s) => {
        s.send({ id: 99, method: "item/commandExecution/requestApproval", params: {} });
        return turnScript(["ok"])(p, s);
      },
    });
    const src = source();
    const handle = await forker.fork(src, noAbort());
    await forker.write(src, handle, "x", noAbort());
    expect(server.reverseReplies).toContainEqual({ jsonrpc: "2.0", id: 99, result: { decision: "decline" } });
    await forker.remove(handle);
  });

  it("超时（abort）：打断这一轮、杀进程、抛错", async () => {
    const { server, forker } = setup({
      ...baseHandlers(),
      "turn/start": (_p, s) => {
        setTimeout(() => s.notify("turn/started", { turn: { id: "t1" } }), 0);
        return { turn: { id: "t1" } };
      },
    });
    const src = source();
    const handle = await forker.fork(src, noAbort());
    const controller = new AbortController();
    const writing = forker.write(src, handle, "x", controller.signal);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(writing).rejects.toThrow();
    expect(server.killed).toBe(true);
    expect(server.requests.map((r) => r.method)).toContain("turn/interrupt");
  });

  it("进程中途退出：抛错，不干等", async () => {
    const { server, forker } = setup({
      ...baseHandlers(),
      "turn/start": (_p, s) => {
        setTimeout(() => s.emit("exit", 1, null), 5);
        return { turn: { id: "t1" } };
      },
    });
    const src = source();
    const handle = await forker.fork(src, noAbort());
    await expect(forker.write(src, handle, "x", noAbort())).rejects.toThrow(/退出/);
  });

  it("没有 fork 过的 handle（比如重启后）：抛错", async () => {
    const { forker } = setup();
    await expect(forker.write(source(), { forkId: "nope" }, "x", noAbort())).rejects.toThrow(/不在了/);
  });
});

describe("remove：先删复制那份，再关进程；幂等", () => {
  it("先 thread/delete 再杀进程；ephemeral 报 not persisted 当成已删", async () => {
    const { server, forker } = setup();
    const handle = await forker.fork(source(), noAbort());
    await forker.remove(handle);
    const methods = server.requests.map((r) => r.method);
    expect(methods.at(-1)).toBe("thread/delete");
    expect(server.requests.at(-1)!.params).toEqual({ threadId: "fork-1" });
    expect(server.killed).toBe(true);
  });

  it("没有这个 handle（进程早没了、重启后）：什么都不做，算成功；重复 remove 也行", async () => {
    const { forker } = setup();
    await expect(forker.remove({ forkId: "gone" })).resolves.toBeUndefined();
    const handle = await forker.fork(source(), noAbort());
    await forker.remove(handle);
    await expect(forker.remove(handle)).resolves.toBeUndefined();
  });

  it("thread/delete 报别的错：进程照关，错误抛给跑腿的记日志", async () => {
    const { server, forker } = setup({ ...baseHandlers(), "thread/delete": () => new Error("disk on fire") });
    const handle = await forker.fork(source(), noAbort());
    await expect(forker.remove(handle)).rejects.toThrow(/disk on fire/);
    expect(server.killed).toBe(true);
  });

  it("thread/delete 成功（这版 codex 落了盘）：也算成功", async () => {
    const { forker } = setup({ ...baseHandlers(), "thread/delete": () => ({}) });
    const handle = await forker.fork(source(), noAbort());
    await expect(forker.remove(handle)).resolves.toBeUndefined();
  });
});

describe("forkSourceOf 给的 ForkSource 能直接用", () => {
  it("env 已去掉 HUB_*", () => {
    const row = { id: 1, vendor: "codex", vendorSessionId: "v", cwd: "/c", addDirs: [], model: null, effort: null } as unknown as AgentSessionRow;
    const src = forkSourceOf(row, source().launch);
    expect(src.launch.env[ENV_HUB_TOKEN]).toBeUndefined();
  });
});
