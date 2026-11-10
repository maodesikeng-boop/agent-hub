// agy 拷库复制（agy.ts）：用造出来的小库 + 假的 agy 可执行文件，不碰真的 ~/.gemini。
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMPTY_TOKEN_USAGE } from "../../shared/index.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { checkAgyUserLine } from "./protocol.ts";
import { ForkUnsupportedError } from "../../daemon/handover/forker.ts";
import type { ForkSource } from "../../daemon/handover/forker.ts";
import { FORKERS } from "../../daemon/handover/forkers.ts";
import { AGY_FORKERS, createAgyCopyForker } from "./handover.ts";
import { isAlive } from "../../daemon/driver/process.ts";

const SRC_ID = "11111111-2222-4333-8444-555555555555";
const OLD_TRAJ = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let root: string;
let rec: string;
let bin: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "agy-fork-"));
  root = join(base, "antigravity-cli");
  rec = join(base, "rec");
  mkdirSync(join(root, "conversations"), { recursive: true });
  mkdirSync(rec);
  bin = join(base, "fake-agy.sh");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" > "$REC/args"',
      'env > "$REC/env"',
      'pwd > "$REC/cwd"',
      'cat > "$REC/stdin"',
      '[ -f "$REC/bg" ] && { sleep 30 & echo $! > "$REC/bg_pid"; }',
      '[ -f "$REC/hang" ] && sleep 30',
      '[ -f "$REC/err" ] && cat "$REC/err" >&2',
      'cat "$REC/out"',
      'exit "$(cat "$REC/code" 2>/dev/null || echo 0)"',
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

/** 造一个 agy 对话库：trajectory_meta 里是两个编号，别的表的文本、二进制格里也带着这两个编号。 */
function makeDb(id: string, opts: { traj?: string; cascade?: string; meta?: boolean } = {}): string {
  const file = join(root, "conversations", `${id}.db`);
  const db = new DatabaseSync(file);
  if (opts.meta !== false) {
    db.exec("create table trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)");
    db.prepare("insert into trajectory_meta values (?, ?, 0, 0)").run(opts.traj ?? OLD_TRAJ, opts.cascade ?? id);
  }
  db.exec("create table steps (idx INTEGER, metadata BLOB, step_payload BLOB, note TEXT)");
  const insert = db.prepare("insert into steps values (?, ?, ?, ?)");
  insert.run(0, Buffer.from(`\u0012$${id}\u001a$${OLD_TRAJ}`, "latin1"), Buffer.from([0, 1, 2, 255]), `会话 ${id} / 轨迹 ${OLD_TRAJ}`);
  insert.run(1, null, Buffer.from(`x${id}y`, "latin1"), "没有编号");
  db.exec("create table trajectory_metadata_blob (id TEXT, data BLOB)");
  db.prepare("insert into trajectory_metadata_blob values (?, ?)").run(id, Buffer.from(OLD_TRAJ, "latin1"));
  db.close();
  return file;
}

const source = (over: Partial<ForkSource> = {}): ForkSource => ({
  sessionId: 7,
  vendor: "agy",
  vendorSessionId: SRC_ID,
  executablePath: bin,
  cwd: rec,
  addDirs: [],
  model: null,
  effort: null,
  launch: { promptFile: "/p.md", env: { REC: rec, PATH: process.env.PATH ?? "" }, fingerprint: "fp" },
  ...over,
});

const forker = (extra: Record<string, unknown> = {}) => createAgyCopyForker({ root, ...extra });
const signal = () => new AbortController().signal;
const rows = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

describe("登记", () => {
  it("agy 的清单只有拷库这一个：kind copy、id agy-copy，登记在 FORKERS.agy", () => {
    expect(AGY_FORKERS.map((f) => [f.id, f.kind])).toEqual([["agy-copy", "copy"]]);
    expect(FORKERS.agy).toBe(AGY_FORKERS);
  });
});

describe("fork：拷库换编号", () => {
  it("原库一个字节不变；新库编号全换、长度不变；handle 带新编号和根目录", async () => {
    const srcFile = makeDb(SRC_ID);
    const before = readFileSync(srcFile);
    const handle = await forker().fork(source(), signal());

    expect(handle.forkId).toMatch(UUID);
    expect(handle.forkId).not.toBe(SRC_ID);
    expect(handle.extra).toEqual({ root });
    expect(readFileSync(srcFile).equals(before)).toBe(true);

    const dst = join(root, "conversations", `${handle.forkId}.db`);
    const [meta] = rows(dst, "select * from trajectory_meta");
    expect(meta!.cascade_id).toBe(handle.forkId);
    expect(String(meta!.trajectory_id)).toMatch(UUID);
    expect(meta!.trajectory_id).not.toBe(OLD_TRAJ);
    const newTraj = String(meta!.trajectory_id);

    const steps = rows(dst, "select idx, metadata, step_payload, note from steps order by idx");
    expect(steps[0]!.note).toBe(`会话 ${handle.forkId} / 轨迹 ${newTraj}`);
    expect(Buffer.from(steps[0]!.metadata as Uint8Array).toString("latin1")).toBe(`\u0012$${handle.forkId}\u001a$${newTraj}`);
    expect([...(steps[0]!.step_payload as Uint8Array)]).toEqual([0, 1, 2, 255]);
    expect(steps[1]!.metadata).toBeNull();
    expect(Buffer.from(steps[1]!.step_payload as Uint8Array).toString("latin1")).toBe(`x${handle.forkId}y`);
    expect(steps[1]!.note).toBe("没有编号");
    const [blob] = rows(dst, "select id, data from trajectory_metadata_blob");
    expect(blob!.id).toBe(handle.forkId);
    expect(Buffer.from(blob!.data as Uint8Array).toString("latin1")).toBe(newTraj);

    // 新库里再也找不到旧编号
    expect(readFileSync(dst).includes(SRC_ID)).toBe(false);
    expect(readFileSync(dst).includes(OLD_TRAJ)).toBe(false);
  });

  it("brain/<原编号>/ 一起拷到 brain/<新编号>/；没有 brain 目录也行", async () => {
    makeDb(SRC_ID);
    mkdirSync(join(root, "brain", SRC_ID, "scratch"), { recursive: true });
    writeFileSync(join(root, "brain", SRC_ID, "scratch", "a.md"), "笔记");
    const handle = await forker().fork(source(), signal());
    expect(readFileSync(join(root, "brain", handle.forkId, "scratch", "a.md"), "utf8")).toBe("笔记");
    expect(existsSync(join(root, "brain", SRC_ID, "scratch", "a.md"))).toBe(true);

    rmSync(join(root, "brain"), { recursive: true });
    const again = await forker().fork(source(), signal());
    expect(existsSync(join(root, "brain", again.forkId))).toBe(false);
  });

  it("每次 fork 的新编号都不一样", async () => {
    makeDb(SRC_ID);
    const a = await forker().fork(source(), signal());
    const b = await forker().fork(source(), signal());
    expect(a.forkId).not.toBe(b.forkId);
  });

  it("库文件权限 0600（和 agy 自己建的一样）", async () => {
    makeDb(SRC_ID);
    const handle = await forker().fork(source(), signal());
    expect(statSync(join(root, "conversations", `${handle.forkId}.db`)).mode & 0o777).toBe(0o600);
  });
});

describe("fork：格式对不上抛 ForkUnsupportedError（账本退回本会话写交接），不留半成品", () => {
  const leftovers = () => readdirSync(join(root, "conversations")).filter((n) => !n.startsWith(SRC_ID));

  it("找不到原会话的库", async () => {
    await expect(forker().fork(source(), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
  });

  it("会话编号不是 UUID 的样子（也防路径穿越）", async () => {
    makeDb(SRC_ID);
    for (const bad of ["", "../x", "short", `${SRC_ID}/..`]) {
      await expect(forker().fork(source({ vendorSessionId: bad }), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
    }
    expect(leftovers()).toEqual([]);
  });

  it("库里没有 trajectory_meta", async () => {
    makeDb(SRC_ID, { meta: false });
    const err = await forker().fork(source(), signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForkUnsupportedError);
    expect((err as Error).message).toContain("trajectory_meta");
    expect(leftovers()).toEqual([]);
  });

  it("trajectory_meta 缺列、不止一行", async () => {
    const file = makeDb(SRC_ID);
    const db = new DatabaseSync(file);
    db.exec("alter table trajectory_meta rename column cascade_id to cascade");
    db.close();
    await expect(forker().fork(source(), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);

    const db2 = new DatabaseSync(file);
    db2.exec("alter table trajectory_meta rename column cascade to cascade_id");
    db2.prepare("insert into trajectory_meta values (?, ?, 0, 0)").run(OLD_TRAJ, SRC_ID);
    db2.close();
    await expect(forker().fork(source(), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
    expect(leftovers()).toEqual([]);
  });

  it("cascade_id 不等于会话编号、轨迹编号不是同长 UUID：换了编号长度就变，不认识", async () => {
    makeDb(SRC_ID, { cascade: "99999999-2222-4333-8444-555555555555" });
    await expect(forker().fork(source(), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
    rmSync(join(root, "conversations", `${SRC_ID}.db`));
    makeDb(SRC_ID, { traj: "traj-1" });
    await expect(forker().fork(source(), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
    expect(leftovers()).toEqual([]);
  });

  it("根本不是 sqlite 文件", async () => {
    writeFileSync(join(root, "conversations", `${SRC_ID}.db`), "not a database, just text".repeat(100));
    await expect(forker().fork(source(), signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
    expect(leftovers()).toEqual([]);
  });
});

describe("write：--conversation <新编号> 续跑一轮", () => {
  const result = (over: Record<string, unknown> = {}) =>
    [
      JSON.stringify({ event: "init", init: { conversation_id: "x", tools: [] } }),
      JSON.stringify({ event: "step_update", step_update: { step_index: 3, usage: { input_tokens: 90, output_tokens: 9 } } }),
      JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "交接正文", usage: { input_tokens: 120, cache_read_tokens: 30, output_tokens: 20 }, ...over },
      }),
    ].join("\n");
  const feed = (out: string, code = 0) => {
    writeFileSync(join(rec, "out"), out + "\n");
    writeFileSync(join(rec, "code"), String(code));
  };
  const fakeHandle = { forkId: "99999999-8888-4777-8666-555555555555", extra: { root } };

  it("参数：--conversation 新编号、stream-json、只读模式、模型思考程度、附加目录、末尾 --print \"\"；一行合格的用户消息；不带 HUB_*；工作目录照原会话", async () => {
    feed(result());
    const src = source({
      model: "gemini-3.8-flash",
      effort: "low",
      addDirs: ["/code/bar"],
      launch: { promptFile: "/p.md", env: { REC: rec, PATH: process.env.PATH ?? "", KEEP: "1" }, fingerprint: "fp" },
    });
    const out = await forker().write(src, fakeHandle, "请写交接\n第二行", signal());
    expect(out.text).toBe("交接正文");

    const args = readFileSync(join(rec, "args"), "utf8").slice(0, -1).split("\n"); // 每个参数一行，空参数就是空行
    expect(args.slice(0, 4)).toEqual(["--input-format", "stream-json", "--output-format", "stream-json"]);
    expect(args[args.indexOf("--conversation") + 1]).toBe(fakeHandle.forkId);
    expect(args.join(" ")).toContain("--mode plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args.join(" ")).toContain("--model gemini-3.8-flash-low");
    expect(args.join(" ")).toContain("--add-dir /code/bar");
    expect(args.slice(-2)).toEqual(["--print", ""]);
    expect(args).not.toContain(SRC_ID);

    const line = readFileSync(join(rec, "stdin"), "utf8");
    expect(line.endsWith("\n")).toBe(true);
    expect(checkAgyUserLine(line.trimEnd())).toBeNull();
    expect(JSON.parse(line).message.content[0].text).toBe("请写交接\n第二行");

    const env = readFileSync(join(rec, "env"), "utf8");
    expect(env).toContain("KEEP=1");
    expect(env).not.toContain(ENV_HUB_TOKEN);
    expect(env).not.toContain(ENV_HUB_SOCK);
    expect(readFileSync(join(rec, "cwd"), "utf8").trim()).toBe(realpathSync(rec));
  });

  it("守护进程自己的环境里有 HUB_* 也不往下传", async () => {
    feed(result());
    process.env[ENV_HUB_TOKEN] = "leak";
    process.env[ENV_HUB_SOCK] = "/leak.sock";
    try {
      await forker().write(source(), fakeHandle, "写", signal());
    } finally {
      delete process.env[ENV_HUB_TOKEN];
      delete process.env[ENV_HUB_SOCK];
    }
    const env = readFileSync(join(rec, "env"), "utf8");
    expect(env).not.toContain("leak");
  });

  it("用量：取 result.usage（输入、缓存读、输出），context 是这一轮读进去的总量", async () => {
    feed(result());
    const out = await forker().write(source(), fakeHandle, "写", signal());
    expect(out.usage).toEqual({ ...EMPTY_TOKEN_USAGE, input: 120, cacheRead: 30, cacheWrite: 0, output: 20, context: 150 });
  });

  it("result 没带 usage 就取最后一个 step_update 的", async () => {
    feed(result({ usage: undefined }));
    const out = await forker().write(source(), fakeHandle, "写", signal());
    expect(out.usage).toEqual({ ...EMPTY_TOKEN_USAGE, input: 90, output: 9, context: 90 });
  });

  it("文字是空的也照常返回（空不空由账本判断）", async () => {
    feed(result({ response: "" }));
    expect((await forker().write(source(), fakeHandle, "写", signal())).text).toBe("");
  });

  it("退出码非 0 抛错（带标准错误）", async () => {
    feed("", 3);
    writeFileSync(join(rec, "err"), "boom happened\n");
    const err = await forker().write(source(), fakeHandle, "写", signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ForkUnsupportedError);
    expect((err as Error).message).toContain("boom happened");
  });

  it("result 的 status 不是 SUCCESS 抛错；没有 result 事件抛错", async () => {
    feed(result({ status: "ERROR", response: "额度用完" }));
    await expect(forker().write(source(), fakeHandle, "写", signal())).rejects.toThrow("额度用完");
    feed(JSON.stringify({ event: "init", init: {} }));
    await expect(forker().write(source(), fakeHandle, "写", signal())).rejects.toThrow(/result/);
  });

  it("agy 说找不到这个对话（认不得拷出来的库）→ ForkUnsupportedError", async () => {
    feed("", 1);
    writeFileSync(join(rec, "err"), "Error: conversation not found\n");
    await expect(forker().write(source(), fakeHandle, "写", signal())).rejects.toBeInstanceOf(ForkUnsupportedError);
  });

  it("可执行文件不存在抛错（不是 ForkUnsupportedError）", async () => {
    const err = await forker()
      .write(source({ executablePath: join(root, "no-such-agy") }), fakeHandle, "写", signal())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ForkUnsupportedError);
  });

  it("signal 中止：杀掉进程组，write 很快抛错", async () => {
    writeFileSync(join(rec, "hang"), "");
    const ac = new AbortController();
    const started = Date.now();
    const p = forker().write(source(), fakeHandle, "写", ac.signal);
    setTimeout(() => ac.abort(new Error("timeout")), 200);
    await expect(p).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("已经中止的 signal 不起进程", async () => {
    const ac = new AbortController();
    ac.abort(new Error("shutdown"));
    await expect(forker().write(source(), fakeHandle, "写", ac.signal)).rejects.toThrow("shutdown");
    expect(existsSync(join(rec, "args"))).toBe(false);
  });

  it("进程退出时即使同组后台子进程还占着 stdout/stderr，也在 exit 时立即补杀进程组、不卡死 close", async () => {
    feed(result());
    writeFileSync(join(rec, "bg"), "");
    const out = await forker().write(source(), fakeHandle, "写", signal());
    expect(out.text).toBe("交接正文");
    const bgPid = Number(readFileSync(join(rec, "bg_pid"), "utf8").trim());
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && isAlive(bgPid)) await new Promise((r) => setTimeout(r, 20));
    expect(isAlive(bgPid)).toBe(false);
  });
});

describe("remove：删干净，幂等", () => {
  const newId = "99999999-8888-4777-8666-555555555555";
  const other = "00000000-8888-4777-8666-555555555555";

  function seed(id: string): void {
    for (const f of [`conversations/${id}.db`, `conversations/${id}.db-wal`, `conversations/${id}.db-shm`, `annotations/${id}.pbtxt`, `implicit/${id}.pb`, `presence/${id}.json`]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), "x");
    }
    mkdirSync(join(root, "brain", id, "scratch"), { recursive: true });
    writeFileSync(join(root, "brain", id, "scratch", "a"), "x");
    mkdirSync(join(root, "presence", id), { recursive: true });
  }
  function summaries(): DatabaseSync {
    const db = new DatabaseSync(join(root, "conversation_summaries.db"));
    db.exec("create table if not exists conversation_summaries (conversation_id text primary key, title text)");
    db.exec("create table if not exists conversations_fts (conversation_id text, user_body text)");
    return db;
  }

  it("conversations/<id>.db*、brain/annotations/implicit/presence 下这个编号的东西、摘要库里的行都删掉；别的编号不动", async () => {
    seed(newId);
    seed(other);
    const db = summaries();
    for (const id of [newId, other]) {
      db.prepare("insert into conversation_summaries values (?, 't')").run(id);
      db.prepare("insert into conversations_fts values (?, 'b')").run(id);
      db.prepare("insert into conversations_fts values (?, 'b2')").run(id);
    }
    db.close();

    await forker().remove({ forkId: newId, extra: { root } });

    for (const sub of ["conversations", "annotations", "implicit", "presence", "brain"]) {
      expect(readdirSync(join(root, sub)).filter((n) => n.startsWith(newId))).toEqual([]);
      expect(readdirSync(join(root, sub)).filter((n) => n.startsWith(other)).length).toBeGreaterThan(0);
    }
    const left = rows(join(root, "conversation_summaries.db"), "select conversation_id from conversation_summaries");
    expect(left).toEqual([{ conversation_id: other }]);
    expect(rows(join(root, "conversation_summaries.db"), "select conversation_id from conversations_fts").map((r) => r.conversation_id)).toEqual([other, other]);
  });

  it("什么都不存在（没有摘要库、没有各个目录）算成功；连删两次也行", async () => {
    await forker().remove({ forkId: newId, extra: { root } });
    seed(newId);
    await forker().remove({ forkId: newId, extra: { root } });
    await forker().remove({ forkId: newId, extra: { root } });
  });

  it("摘要库里没有这两张表（格式变了）不算失败，其余照删", async () => {
    seed(newId);
    new DatabaseSync(join(root, "conversation_summaries.db")).close();
    await forker().remove({ forkId: newId, extra: { root } });
    expect(existsSync(join(root, "conversations", `${newId}.db`))).toBe(false);
  });

  it("handle 里的编号不是 UUID 的样子：不删任何东西，抛错", async () => {
    seed(other);
    await expect(forker().remove({ forkId: "../conversations", extra: { root } })).rejects.toThrow();
    await expect(forker().remove({ forkId: "", extra: { root } })).rejects.toThrow();
    expect(existsSync(join(root, "conversations", `${other}.db`))).toBe(true);
  });

  it("fork 出来的再 remove：什么都不剩", async () => {
    makeDb(SRC_ID);
    mkdirSync(join(root, "brain", SRC_ID), { recursive: true });
    writeFileSync(join(root, "brain", SRC_ID, "n"), "x");
    const f = forker();
    const handle = await f.fork(source(), signal());
    await f.remove(handle);
    expect(readdirSync(join(root, "conversations"))).toEqual([`${SRC_ID}.db`]);
    expect(readdirSync(join(root, "brain"))).toEqual([SRC_ID]);
  });
});
