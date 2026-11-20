import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import {
  VENDOR_FAILURE_SIGNS,
  agentLaunchArgs,
  bundledModelCatalog,
  checkAgentSetting,
  checkModel,
  effortsFor,
  splitModelEffort,
  vendorFailureOf,
  type AgentVendor,
} from "../shared/vendors.ts";
import { VENDOR_LIST } from "./registry.ts";
import type { VendorSpec } from "./types.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ImportRef {
  from: string;
  spec: string;
  path: string | null;
  typeOnly: boolean;
}

type AstNode = { type: string; [key: string]: unknown };
const isAstNode = (v: unknown): v is AstNode => typeof v === "object" && v !== null && typeof (v as AstNode).type === "string";

export function importsOf(file: string): ImportRef[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const { program, errors } = parseSync(file, text);
  if (errors.length > 0) throw new Error(`${file} 解析失败：${errors[0]!.message}`);
  const out: ImportRef[] = [];
  const push = (spec: string, typeOnly: boolean) => {
    const path = spec.startsWith(".") ? relative(ROOT, resolve(ROOT, dirname(file), spec)).split("\\").join("/") : null;
    out.push({ from: file, spec, path, typeOnly });
  };
  const visitDynamic = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visitDynamic);
    if (!isAstNode(node)) return;
    if (node.type === "ImportExpression" && isAstNode(node.source) && typeof node.source.value === "string") {
      push(node.source.value, false);
    }
    for (const value of Object.values(node)) visitDynamic(value);
  };
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") {
      const typeOnly = stmt.importKind === "type" || (stmt.specifiers.length > 0 && stmt.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type"));
      push(stmt.source.value, typeOnly);
    } else if (stmt.type === "ExportNamedDeclaration" && stmt.source !== null) {
      const typeOnly = stmt.exportKind === "type" || (stmt.specifiers.length > 0 && stmt.specifiers.every((s) => s.exportKind === "type"));
      push(stmt.source.value, typeOnly);
    } else if (stmt.type === "ExportAllDeclaration") {
      push(stmt.source.value, stmt.exportKind === "type");
    } else {
      visitDynamic(stmt);
    }
  }
  return out;
}

export function runtimeImportsDeep(file: string, seen = new Set<string>()): ImportRef[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const own = importsOf(file).filter((i) => !i.typeOnly);
  return [...own, ...own.flatMap((i) => (i.path === null ? [] : runtimeImportsDeep(i.path, seen)))];
}

export function browserUnsafeImports(file: string): ImportRef[] {
  return runtimeImportsDeep(file).filter((i) => i.spec.startsWith("node:") || i.path?.startsWith("src/daemon/"));
}

export function otherVendorDirImports(file: string): ImportRef[] {
  const ownDir = dirname(file);
  const seen = new Set<string>();
  return [...importsOf(file), ...runtimeImportsDeep(file)].filter((i) => {
    if (i.path === null || !/^src\/vendors\/[^/]+\//.test(i.path) || i.path.startsWith(`${ownDir}/`)) return false;
    const key = `${i.from}->${i.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const sampleErrors = (spec: VendorSpec) => [`${spec.id}_not_found: spawn ${spec.cli.command} ENOENT`, `${spec.cli.command}: 529 overloaded`];

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

    it("S11 工具名到通用动作（tools.actions）：几家合成一张查，所以同一个名字在各家必须是同一个动作", () => {
      const seen = new Map<string, { id: string; action: string }>();
      for (const spec of list) {
        for (const [name, action] of Object.entries(spec.tools?.actions ?? {})) {
          const before = seen.get(name);
          if (before !== undefined) expect(action, `${name}：${before.id} 是 ${before.action}，${spec.id} 是 ${action}`).toBe(before.action);
          seen.set(name, { id: spec.id, action });
        }
      }
    });

    it("S7 rawHint 认得出自家样例报错，且不会把别家的样例报错认成自己的", () => {
      for (const spec of list) {
        if (spec.failure.rawHint) {
          for (const raw of sampleErrors(spec)) expect(spec.failure.rawHint.test(raw), `${spec.id} 漏认 ${raw}`).toBe(true);
        }
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

    it("S4 打包模型都过 checkModel；efforts 非空；默认设置不传参数；routerDefault 合法匹配", () => {
      const { bundled, efforts, routerDefault } = spec.models;
      expect(bundled.length).toBeGreaterThan(0);
      for (const m of bundled) {
        expect(checkModel(vendor, m.id), m.id).toBeNull();
        for (const e of m.efforts ?? []) expect(efforts, `${m.id} 的 ${e}`).toContain(e);
      }
      expect(efforts.length).toBeGreaterThan(0);
      expect(agentLaunchArgs({ vendor, model: null, effort: null })).toEqual([]);

      expect(routerDefault.model.trim(), `${id} routerDefault.model`).not.toBe("");
      expect(routerDefault.effort.trim(), `${id} routerDefault.effort`).not.toBe("");
      expect(checkModel(vendor, routerDefault.model), `${id} routerDefault.model 校验`).toBeNull();
      expect(efforts, `${id} routerDefault.effort 须在厂商 efforts 内`).toContain(routerDefault.effort);
      if (spec.models.effortInModelId) {
        expect(splitModelEffort(vendor, routerDefault.model, null).effort, `${id} routerDefault.model 不应预拼档位后缀`).toBeNull();
      }
      const bundledHit = bundled.find((m) => m.id === routerDefault.model);
      if (bundledHit !== undefined) {
        const modelEfforts = bundledHit.efforts ?? efforts;
        expect(modelEfforts, `${id} routerDefault.effort 须在模型 ${bundledHit.id} 支持的 efforts 内`).toContain(routerDefault.effort);
        expect(effortsFor(bundledModelCatalog(vendor), routerDefault.model)).toContain(routerDefault.effort);
      }
      expect(checkAgentSetting({ vendor, model: routerDefault.model, effort: routerDefault.effort })).toBeNull();
    });

    it("S5 readonlySecrets、catalogWatchPaths 都在 dirs 里面", () => {
      const { home } = spec;
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
      expect(vendorFailureOf(notFound)).toEqual({ kind: "missing", serviceName });
      for (const other of list.filter((o) => o.id !== id)) {
        expect(vendorFailureOf(`${other.id}_not_found: x`, vendor)?.kind, `${other.id} 的找不到程序`).toBe("missing");
      }
      expect(vendorFailureOf(busy)).toEqual({ kind: "busy", serviceName });
    });
  });
}
