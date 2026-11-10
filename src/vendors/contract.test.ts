// 厂商契约测试（docs/vendor-plugin-design.md 5.3 节）：名单里每一家跑同一套静态检查，不起进程、不联网。
// P1 先跑在现有结构上：声明表 VENDOR_SPECS（src/shared/vendors.ts）、守护进程登记表 DAEMON_VENDORS（src/daemon/vendors/index.ts）、
// FORKERS（src/daemon/handover/forkers.ts）、vendorTranscriptPath（src/daemon/driver/transcript.ts）。
//
// 还不能转正的（写成 it.todo，到那一步改成真断言）：
// - S1 每家有 src/vendors/<id>/spec.ts：P2；有 daemon.ts 且默认导出带 createDriver：P3。现在按现有位置查（DAEMON_VENDORS、src/daemon/vendors/<id>.ts）。
// - S2 spec.ts 不 import 别家文件夹：P2。现在查声明表所在的 src/shared/vendors.ts 及它引到的文件不碰 node:*、src/daemon。
// - S7 rawHint：P2 才有这个字段；现在经 vendorFailureOf 查（它内部的 inferVendorFromRaw 是写死三家的正则）。
// - S10 后半“readonly 为 os_sandbox 的厂商没有 OS 沙箱时派只读被拒”：现在代码对所有 Worker 一律要求 OS 沙箱
//   （ledger/workers.ts 的 WORKER_NEEDS_OS_SANDBOX_MESSAGE，不分厂商，ledger 测试里测），没有按家的入口；P4 再定要不要按家。
// - 测试专用假厂商 acme（只在测试里注册，证明“新文件夹 + 名单一项”够用）：P2。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { vendorTranscriptPath } from "../daemon/driver/transcript.ts";
import { FORKERS } from "../daemon/handover/forkers.ts";
import { DAEMON_VENDORS } from "../daemon/vendors/index.ts";
import {
  AGENT_VENDORS,
  VENDOR_AVAILABILITIES,
  VENDOR_FAILURE_SIGNS,
  VENDOR_HOME_PATHS,
  VENDOR_SPECS,
  agentLaunchArgs,
  checkModel,
  vendorFailureOf,
} from "../shared/vendors.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GARBAGE: readonly unknown[] = [null, undefined, "垃圾", 42, {}, [], { models: "x" }];

/** file（相对仓库根目录）和它经相对路径 import 到的所有文件，返回每个 import 的原文和它所在文件。 */
function importsOf(file: string, seen = new Set<string>()): { from: string; spec: string }[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const text = readFileSync(join(ROOT, file), "utf8");
  const out: { from: string; spec: string }[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
    const spec = (m[1] ?? m[2])!;
    out.push({ from: file, spec });
    if (spec.startsWith(".")) out.push(...importsOf(relative(ROOT, resolve(ROOT, dirname(file), spec)), seen));
  }
  return out;
}

describe("厂商名单", () => {
  it("S3 编号唯一、只用小写字母数字；命令名唯一", () => {
    expect(new Set(AGENT_VENDORS).size).toBe(AGENT_VENDORS.length);
    for (const id of AGENT_VENDORS) expect(id).toMatch(/^[a-z][a-z0-9]*$/);
    const commands = AGENT_VENDORS.map((v) => VENDOR_SPECS[v].cliCommand);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("各登记表的键和名单一致", () => {
    for (const table of [VENDOR_SPECS, VENDOR_HOME_PATHS, DAEMON_VENDORS, FORKERS]) {
      expect(Object.keys(table).sort()).toEqual([...AGENT_VENDORS].sort());
    }
  });

  it("S9 所有厂商的 forker id 全局唯一（存进 fork_ref，重启后凭它找回）", () => {
    const ids = AGENT_VENDORS.flatMap((v) => FORKERS[v].map((f) => f.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("S2（现有位置）声明表 src/shared/vendors.ts 浏览器安全：它和它引到的文件都不 import node:*、src/daemon", () => {
    const imports = importsOf("src/shared/vendors.ts");
    const bad = imports.filter(
      ({ from, spec }) =>
        spec.startsWith("node:") || (spec.startsWith(".") && relative(ROOT, resolve(ROOT, dirname(from), spec)).startsWith("src/daemon/")),
    );
    expect(bad).toEqual([]);
  });

  it.todo("S1 每个 id 有 src/vendors/<id>/spec.ts（P2）");
  it.todo("S1 每个 id 有 src/vendors/<id>/daemon.ts，默认导出带 createDriver（P3）");
  it.todo("S2 src/vendors/<id>/spec.ts 不 import node:*、src/daemon/**、别家文件夹（P2）");
  it.todo("acme：测试专用假厂商只在测试里注册，也过这一整套（P2）");
});

describe.each(AGENT_VENDORS)("厂商契约：%s", (id) => {
  const spec = VENDOR_SPECS[id];
  const daemon = DAEMON_VENDORS[id];

  it("S1（现有位置）守护进程侧有登记、有 createDriver；src/daemon/vendors/<id>.ts 存在", () => {
    expect(typeof daemon.createDriver).toBe("function");
    expect(typeof daemon.createComposer).toBe("function");
    expect(typeof daemon.catalog).toBe("function");
    expect(daemon.base.vendor).toBe(id);
    expect(existsSync(join(ROOT, "src/daemon/vendors", `${id}.ts`))).toBe(true);
  });

  it("S3 envVar 是 AGENT_HUB_<大写编号>", () => {
    expect(spec.envVar).toBe(`AGENT_HUB_${id.toUpperCase()}`);
  });

  it("S4 打包模型都过 checkModel；efforts 非空；默认设置不传参数", () => {
    expect(spec.models.length).toBeGreaterThan(0);
    for (const m of spec.models) {
      expect(checkModel(id, m.id), m.id).toBeNull();
      for (const e of m.efforts ?? []) expect(spec.efforts, `${m.id} 的 ${e}`).toContain(e);
    }
    expect(spec.efforts.length).toBeGreaterThan(0);
    expect(agentLaunchArgs({ vendor: id, model: null, effort: null })).toEqual([]);
  });

  it("S5 readonlySecrets、catalogWatchPaths 都在 dirs 里面", () => {
    const home = VENDOR_HOME_PATHS[id];
    const inside = (p: string) => home.dirs.some((d) => p === d || p.startsWith(`${d}/`));
    for (const p of [...home.readonlySecrets, ...home.catalogWatchPaths]) expect(inside(p), p).toBe(true);
  });

  it("S6 隐藏名单的键不带命令开头；压缩命令不在隐藏名单里、不会被拦", () => {
    const { commandPrefix, compactCommand, blockedCommands } = spec.composer;
    for (const name of Object.keys(blockedCommands)) {
      expect(name.startsWith(commandPrefix) || name.startsWith("/"), name).toBe(false);
      expect(blockedCommands[name]!.trim(), name).not.toBe("");
    }
    expect(Object.keys(blockedCommands)).not.toContain(compactCommand);
    expect(daemon.base.isCompactCommand(`${commandPrefix}${compactCommand}`)).toBe(true);
    expect(daemon.base.blockReason(`${commandPrefix}${compactCommand}`, null)).toBeNull();
  });

  it("S7 <id>_not_found 认成 missing；带这家命令名的报错不被认成别家", () => {
    const missing = { kind: "missing", serviceName: VENDOR_FAILURE_SIGNS[id].serviceName };
    expect(vendorFailureOf(`${id}_not_found: spawn ${spec.cliCommand} ENOENT`, id)).toMatchObject(missing);
    // 不告诉是哪家：只凭原文认
    expect(vendorFailureOf(`${id}_not_found: spawn ${spec.cliCommand} ENOENT`)).toMatchObject({ kind: "missing" });
    for (const other of AGENT_VENDORS.filter((v) => v !== id)) {
      expect(vendorFailureOf(`${other}_not_found: x`, id)?.kind, `${other} 的找不到程序`).toBe("missing");
    }
    expect(vendorFailureOf(`${spec.cliCommand}: 529 overloaded`)).toEqual({ kind: "busy", serviceName: VENDOR_FAILURE_SIGNS[id].serviceName });
  });

  it("S8 probe 遇到认不出的回应不抛：parse 给 null，登录状态在 VENDOR_AVAILABILITIES 里", () => {
    for (const raw of GARBAGE) {
      expect(daemon.probe.parse(raw), String(raw)).toBeNull();
      expect(VENDOR_AVAILABILITIES).toContain(daemon.probe.availabilityOf(raw));
    }
    if (daemon.probe.availabilityOfError) {
      for (const err of [new Error("boom"), "boom", null]) expect(VENDOR_AVAILABILITIES).toContain(daemon.probe.availabilityOfError(err));
    }
  });

  it("S9 本家 forker 都有非空 id、kind 是 native 或 copy", () => {
    for (const f of FORKERS[id]) {
      expect(f.id).toMatch(/\S/);
      expect(["native", "copy"]).toContain(f.kind);
    }
  });

  it("S10 原始记录：不存在的会话、不安全的会话 ID 都返回 null 不抛", () => {
    const roots = { home: "/nonexistent/agent-hub-contract-home", env: {} };
    for (const vendorSessionId of ["no-such-session-0000", "../etc/passwd", "", "."]) {
      expect(vendorTranscriptPath({ vendor: id, vendorSessionId, cwd: "/nonexistent/agent-hub-contract-cwd" }, roots)).toBeNull();
    }
  });

  it.todo("S10 readonly 为 os_sandbox 的厂商在没有 OS 沙箱时派只读被拒（现在对所有 Worker 一律要求 OS 沙箱，P4 再按家）");
});
