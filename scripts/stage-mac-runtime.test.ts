import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertSymlinksStayInside, stageMacNodeFromExtractedDir } from "./stage-mac-runtime.ts";
import { BUNDLED_NODE_ARCHIVES, BUNDLED_NODE_VERSION, pruneStagedNodeModules } from "./stage-runtime-common.ts";

describe("scripts/stage-mac-runtime.ts macOS 随包运行时", () => {
  it("Mac 与 Windows 随包同一个锁定的官方 Node 版本，且各自带合法 SHA-256", () => {
    for (const [target, spec] of Object.entries(BUNDLED_NODE_ARCHIVES)) {
      expect(spec.url, target).toContain(`/${BUNDLED_NODE_VERSION}/`);
      expect(spec.rootDir, target).toContain(BUNDLED_NODE_VERSION);
      expect(spec.archiveSha256, target).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.exeSha256, target).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(BUNDLED_NODE_ARCHIVES["darwin-arm64"].url).toMatch(/darwin-arm64\.tar\.gz$/);
  });

  it("stageMacNodeFromExtractedDir 保持官方 bin + lib 布局：npm/npx 是包内相对软链，npm 的文档与类型声明被裁掉", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-stage-mac-node-"));
    try {
      const extracted = join(root, "node-v24-darwin-arm64");
      const npmDir = join(extracted, "lib", "node_modules", "npm");
      mkdirSync(join(extracted, "bin"), { recursive: true });
      mkdirSync(join(npmDir, "bin"), { recursive: true });
      mkdirSync(join(npmDir, "docs"), { recursive: true });
      writeFileSync(join(extracted, "bin", "node"), "fake-mach-o");
      writeFileSync(join(extracted, "LICENSE"), "MIT");
      writeFileSync(join(npmDir, "bin", "npm-cli.js"), "npm");
      writeFileSync(join(npmDir, "bin", "npx-cli.js"), "npx");
      writeFileSync(join(npmDir, "index.d.ts"), "export {};");
      writeFileSync(join(npmDir, "docs", "readme.html"), "<html></html>");
      symlinkSync("/usr/bin/true", join(npmDir, "escaping-link"));

      const outNode = join(root, "runtime", "node");
      const staged = stageMacNodeFromExtractedDir(extracted, outNode);

      expect(staged).toBe(join(outNode, "bin", "node"));
      expect(readFileSync(staged, "utf8")).toBe("fake-mach-o");
      expect(readFileSync(join(outNode, "LICENSE"), "utf8")).toBe("MIT");
      // 守护进程按 <node 目录>/../lib/node_modules/npm/bin/npm-cli.js 找 npm（provider-manager/recipes.ts）
      expect(readFileSync(join(outNode, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "utf8")).toBe("npm");
      for (const name of ["npm", "npx"]) {
        const link = join(outNode, "bin", name);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link).startsWith("../lib/node_modules/npm/bin/")).toBe(true);
      }
      expect(readFileSync(join(outNode, "bin", "npx"), "utf8")).toBe("npx");
      expect(existsSync(join(outNode, "lib", "node_modules", "npm", "docs"))).toBe(false);
      expect(existsSync(join(outNode, "lib", "node_modules", "npm", "index.d.ts"))).toBe(false);
      expect(() => lstatSync(join(outNode, "lib", "node_modules", "npm", "escaping-link"))).toThrow();
      assertSymlinksStayInside(join(root, "runtime"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("assertSymlinksStayInside 拒绝绝对路径或指向包外的软链", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-stage-mac-links-"));
    try {
      mkdirSync(join(root, "a"), { recursive: true });
      symlinkSync("../../outside", join(root, "a", "up"));
      expect(() => assertSymlinksStayInside(root)).toThrow(/escapes/);
      rmSync(join(root, "a", "up"));
      symlinkSync("/Applications", join(root, "a", "abs"));
      expect(() => assertSymlinksStayInside(root)).toThrow(/escapes/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pruneStagedNodeModules(darwin-arm64) 整个去掉 mxc-sdk 的 Windows 二进制，只留 darwin-arm64 的 koffi", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-stage-mac-prune-"));
    try {
      const nm = join(root, "node_modules");
      const mxcBin = join(nm, "@microsoft", "mxc-sdk", "bin", "x64");
      mkdirSync(mxcBin, { recursive: true });
      writeFileSync(join(mxcBin, "mxc_ffi.dll"), "win");
      writeFileSync(join(nm, "@microsoft", "mxc-sdk", "index.js"), "export {};");
      for (const pkg of ["koffi-darwin-arm64", "koffi-win32-x64", "koffi-linux-x64"]) {
        mkdirSync(join(nm, "@koromix", pkg), { recursive: true });
        writeFileSync(join(nm, "@koromix", pkg, "koffi.node"), pkg);
      }

      pruneStagedNodeModules(nm, "darwin-arm64");

      expect(existsSync(join(nm, "@microsoft", "mxc-sdk", "bin"))).toBe(false);
      expect(existsSync(join(nm, "@microsoft", "mxc-sdk", "index.js"))).toBe(true);
      expect(existsSync(join(nm, "@koromix", "koffi-darwin-arm64", "koffi.node"))).toBe(true);
      expect(existsSync(join(nm, "@koromix", "koffi-win32-x64"))).toBe(false);
      expect(existsSync(join(nm, "@koromix", "koffi-linux-x64"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
