// 厂商契约里只看 spec 的那一半（docs/vendor-plugin-design.md 5.3 节）：contract.test.ts 拿生产名单跑，
// acme-contract.test.ts 拿加了假厂商 acme 的名单跑同一套。名单一律读 registry.ts 的 VENDOR_LIST（测试里 mock 它就能加厂商）。
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VENDOR_FAILURE_SIGNS, VENDOR_HOME_PATHS, agentLaunchArgs, checkModel, vendorFailureOf, type AgentVendor } from "../shared/vendors.ts";
import { VENDOR_LIST } from "./registry.ts";
import type { VendorSpec } from "./types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ImportRef {
  /** 写在哪个文件里（相对仓库根目录）。 */
  from: string;
  /** import 的原文。 */
  spec: string;
  /** 相对路径解析到的文件（相对仓库根目录）；包名、node:* 是 null。 */
  path: string | null;
  /** import type / export type：编译后就没了，不影响能不能在网页里跑。 */
  typeOnly: boolean;
}

/** file（相对仓库根目录）里写的 import / export … from。 */
export function importsOf(file: string): ImportRef[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  return [...text.matchAll(/^\s*(?:import|export)\b(\s+type\b)?[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map((m) => {
    const spec = (m[2] ?? m[3])!;
    const path = spec.startsWith(".") ? relative(ROOT, resolve(ROOT, dirname(file), spec)) : null;
    return { from: file, spec, path, typeOnly: m[1] !== undefined };
  });
}

/** file 和它运行时经相对路径引到的所有文件里的运行时 import（跳过 import type）。 */
function runtimeImportsDeep(file: string, seen = new Set<string>()): ImportRef[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const own = importsOf(file).filter((i) => !i.typeOnly);
  return [...own, ...own.flatMap((i) => (i.path === null ? [] : runtimeImportsDeep(i.path, seen)))];
}

/** 网页也引的文件不许在运行时碰 node:* 和守护进程的代码。 */
export function browserUnsafeImports(file: string): ImportRef[] {
  return runtimeImportsDeep(file).filter((i) => i.spec.startsWith("node:") || i.path?.startsWith("src/daemon/"));
}

/** 别家厂商文件夹：src/vendors/<别家>/ 下的文件。 */
function otherVendorDirImports(file: string): ImportRef[] {
  const ownDir = dirname(file);
  return importsOf(file).filter((i) => i.path !== null && /^src\/vendors\/[^/]+\//.test(i.path) && !i.path.startsWith(`${ownDir}/`));
}

/** 一家的样例报错：找不到程序、服务繁忙。 */
const sampleErrors = (spec: VendorSpec) => [`${spec.id}_not_found: spawn ${spec.cli.command} ENOENT`, `${spec.cli.command}: 529 overloaded`];

/** 名单（VENDOR_LIST）里每一家跑只看 spec 的契约。specFileOf：这家 spec.ts 的位置（相对仓库根目录）。 */
export function describeSpecContract(specFileOf: (id: string) => string): void {
  const list: readonly VendorSpec[] = VENDOR_LIST;

  describe("名单（spec）", () => {
    it("S3 编号唯一、只用小写字母数字；命令名唯一", () => {
      const ids = list.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]*$/);
      const commands = list.map((s) => s.cli.command);
      expect(new Set(commands).size).toBe(commands.length);
    });

    it("S7 rawHint 不会把别家的样例报错认成自己的", () => {
      for (const spec of list) {
        for (const other of list.filter((o) => o.id !== spec.id)) {
          for (const raw of sampleErrors(other)) expect(spec.failure.rawHint?.test(raw) ?? false, `${spec.id} 认了 ${raw}`).toBe(false);
        }
      }
    });
  });

  describe.each(list.map((spec) => [spec.id, spec] as const))("厂商契约（spec）：%s", (id, spec) => {
    const vendor = id as AgentVendor;

    it("S2 spec.ts 浏览器安全：不 import node:*、src/daemon/**（连带它引到的），不 import 别家文件夹", () => {
      const file = specFileOf(id);
      expect(browserUnsafeImports(file)).toEqual([]);
      expect(otherVendorDirImports(file)).toEqual([]);
    });

    it("S3 envVar 是 AGENT_HUB_<大写编号>", () => {
      expect(spec.cli.envVar).toBe(`AGENT_HUB_${id.toUpperCase()}`);
    });

    it("S4 打包模型都过 checkModel；efforts 非空；默认设置不传参数", () => {
      const { bundled, efforts } = spec.models;
      expect(bundled.length).toBeGreaterThan(0);
      for (const m of bundled) {
        expect(checkModel(vendor, m.id), m.id).toBeNull();
        for (const e of m.efforts ?? []) expect(efforts, `${m.id} 的 ${e}`).toContain(e);
      }
      expect(efforts.length).toBeGreaterThan(0);
      expect(agentLaunchArgs({ vendor, model: null, effort: null })).toEqual([]);
    });

    it("S5 readonlySecrets、catalogWatchPaths 都在 dirs 里面", () => {
      const home = VENDOR_HOME_PATHS[vendor];
      const inside = (p: string) => home.dirs.some((d) => p === d || p.startsWith(`${d}/`));
      for (const p of [...home.readonlySecrets, ...home.catalogWatchPaths]) expect(inside(p), p).toBe(true);
    });

    it("S6 隐藏名单的键不带命令开头、原因不空；压缩命令不在隐藏名单里", () => {
      const { commandPrefix, compactCommand, blockedCommands } = spec.composer;
      for (const name of Object.keys(blockedCommands)) {
        expect(name.startsWith(commandPrefix) || name.startsWith("/"), name).toBe(false);
        expect(blockedCommands[name]!.trim(), name).not.toBe("");
      }
      expect(Object.keys(blockedCommands)).not.toContain(compactCommand);
    });

    it("S7 <id>_not_found 认成 missing；带这家命令名的报错不被认成别家", () => {
      const { serviceName } = VENDOR_FAILURE_SIGNS[vendor];
      const [notFound, busy] = sampleErrors(spec) as [string, string];
      expect(vendorFailureOf(notFound, vendor)).toEqual({ kind: "missing", serviceName });
      // 不告诉是哪家：只凭原文（rawHint）认
      expect(vendorFailureOf(notFound)).toEqual({ kind: "missing", serviceName });
      for (const other of list.filter((o) => o.id !== id)) {
        expect(vendorFailureOf(`${other.id}_not_found: x`, vendor)?.kind, `${other.id} 的找不到程序`).toBe("missing");
      }
      expect(vendorFailureOf(busy)).toEqual({ kind: "busy", serviceName });
    });
  });
}
