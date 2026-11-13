import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_NODE_VERSION,
  BUNDLED_NODE_WIN_X64_EXE_SHA256,
  BUNDLED_NODE_WIN_X64_ZIP_SHA256,
  assertNoSymlinksInTree,
  buildStagedDaemonPackageJson,
  collectDaemonRuntimeDependencyNames,
  pruneStagedNodeModules,
} from "./stage-win-runtime.ts";

describe("scripts/stage-win-runtime.ts 打包裁剪与完整性守卫", () => {
  it("锁定的官方 Node 24 LTS 版本满足 >= 24.21.0（MXC Windows 原生句柄流要求）且附带合法 SHA-256", () => {
    const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(BUNDLED_NODE_VERSION);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(24);
    expect(Number(match![2])).toBeGreaterThanOrEqual(21);
    expect(BUNDLED_NODE_WIN_X64_ZIP_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(BUNDLED_NODE_WIN_X64_EXE_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("后端运行时依赖集合包含所有守护进程必需包（含 @microsoft/mxc-sdk），并剔除已打进 dist/web 的重型前端包", () => {
    const deps = collectDaemonRuntimeDependencyNames();
    expect(deps).toContain("fastify");
    expect(deps).toContain("@microsoft/mxc-sdk");
    expect(deps).toContain("@agentclientprotocol/sdk");
    expect(deps).toContain("zod");

    // 纯前端包已由 vite build 打进 dist/web，绝不能混入随包 node_modules 膨胀 NSIS 安装包体积
    for (const frontendOnly of ["shiki", "mermaid", "vega", "vega-lite", "react", "react-dom", "lucide-react"]) {
      expect(deps).not.toContain(frontendOnly);
    }

    const pkg = buildStagedDaemonPackageJson();
    expect(pkg.type).toBe("module");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(deps);
  });

  it("pruneStagedNodeModules 清理非 win32-x64 ProcessContainer 二进制、类型声明与软链，assertNoSymlinksInTree 严格守卫", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-stage-prune-"));
    try {
      const nm = join(root, "node_modules");
      const mxcArm = join(nm, "@microsoft", "mxc-sdk", "bin", "arm64");
      const mxcX64 = join(nm, "@microsoft", "mxc-sdk", "bin", "x64");
      mkdirSync(mxcArm, { recursive: true });
      mkdirSync(mxcX64, { recursive: true });
      writeFileSync(join(mxcArm, "mxc_ffi.dll"), "arm64");
      writeFileSync(join(mxcX64, "mxc_ffi.dll"), "win64");
      writeFileSync(join(mxcX64, "wxc-exec.exe"), "win64-exec");
      writeFileSync(join(mxcX64, "lxc-exec"), "linux-bin");
      writeFileSync(join(mxcX64, "libmxc_ffi.so"), "linux-so");
      writeFileSync(join(nm, "@microsoft", "mxc-sdk", "index.d.ts"), "export {};");
      writeFileSync(join(nm, "@microsoft", "mxc-sdk", "index.js.map"), "{}");
      writeFileSync(join(nm, "@microsoft", "mxc-sdk", "index.js"), "export {};");

      const targetFile = join(nm, "@microsoft", "mxc-sdk", "index.js");
      symlinkSync(targetFile, join(nm, "dangling-link"));
      expect(() => assertNoSymlinksInTree(nm)).toThrow(/symlink/);

      pruneStagedNodeModules(nm, "win32");
      assertNoSymlinksInTree(nm);

      expect(() => readFileSync(join(mxcX64, "mxc_ffi.dll"))).not.toThrow();
      expect(() => readFileSync(join(mxcX64, "wxc-exec.exe"))).not.toThrow();
      expect(() => readFileSync(join(mxcX64, "lxc-exec"))).toThrow();
      expect(() => readFileSync(join(mxcArm, "mxc_ffi.dll"))).toThrow();
      expect(() => readFileSync(join(nm, "@microsoft", "mxc-sdk", "index.d.ts"))).toThrow();
      expect(() => readFileSync(join(nm, "@microsoft", "mxc-sdk", "index.js"))).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
