import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_ASSETS, assertTauriVersionMatches, checkTagVersion, prepareReleaseAssets } from "./release-assets.ts";
import { REPO_ROOT, readDesktopAppVersion, sha256FileHex } from "./stage-runtime-common.ts";

function writeArtifact(dir: string, name: string, body: string, hashOverride?: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  const hash = hashOverride ?? sha256FileHex(join(dir, name));
  writeFileSync(join(dir, `${name}.sha256`), `${hash}  ${name}\n`);
}

describe("scripts/release-assets.ts 发版辅助", () => {
  it("标签版本必须等于 app 版本号；带后缀的是预发布，正式标签不是", () => {
    expect(checkTagVersion("v0.1.0", "0.1.0")).toEqual({ version: "0.1.0", prerelease: false });
    expect(checkTagVersion("v0.1.0-rc.1", "0.1.0")).toEqual({ version: "0.1.0", prerelease: true });
    expect(() => checkTagVersion("v0.2.0", "0.1.0")).toThrow(/不一致/);
    expect(() => checkTagVersion("0.1.0", "0.1.0")).toThrow(/不是/);
    expect(() => checkTagVersion("v0.1", "0.1.0")).toThrow(/不是/);
  });

  it("仓库里 Cargo 与 Tauri 版本号一致", () => {
    expect(() => assertTauriVersionMatches(REPO_ROOT, readDesktopAppVersion())).not.toThrow();
  });

  it("固定文件名不含版本号，也不含 unsigned-preview（第二期签名后链接不变）", () => {
    for (const spec of RELEASE_ASSETS) {
      expect(spec.fixedName).not.toMatch(/\d+\.\d+|unsigned|preview/);
    }
  });

  it("prepare 复制为固定文件名并按新文件名重写 .sha256", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-release-assets-"));
    try {
      const win = join(root, "win");
      const mac = join(root, "mac");
      writeArtifact(win, "Bellwood_0.1.0_x64-setup-unsigned-preview.exe", "win-bytes");
      writeArtifact(mac, "Bellwood_0.1.0_arm64-unsigned-preview.dmg", "mac-bytes");
      const out = join(root, "out");
      const written = prepareReleaseAssets({ dirs: { windows: win, macos: mac }, outDir: out, appVersion: "0.1.0" });
      expect(written).toEqual([
        "Bellwood-windows-x64-setup.exe",
        "Bellwood-windows-x64-setup.exe.sha256",
        "Bellwood-macos-arm64.dmg",
        "Bellwood-macos-arm64.dmg.sha256",
      ]);
      expect(readFileSync(join(out, "Bellwood-macos-arm64.dmg"), "utf8")).toBe("mac-bytes");
      const sha = readFileSync(join(out, "Bellwood-windows-x64-setup.exe.sha256"), "utf8");
      expect(sha).toBe(`${sha256FileHex(join(out, "Bellwood-windows-x64-setup.exe"))}  Bellwood-windows-x64-setup.exe\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepare 拒绝：版本不符、校验和对不上、缺文件", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-release-assets-bad-"));
    try {
      const win = join(root, "win");
      const mac = join(root, "mac");
      writeArtifact(win, "Bellwood_0.1.0_x64-setup-unsigned-preview.exe", "w");
      writeArtifact(mac, "Bellwood_0.1.0_arm64-unsigned-preview.dmg", "m");
      const dirs = { windows: win, macos: mac };
      expect(() => prepareReleaseAssets({ dirs, outDir: join(root, "o1"), appVersion: "0.2.0" })).toThrow(/不一致/);

      const badMac = join(root, "badmac");
      writeArtifact(badMac, "Bellwood_0.1.0_arm64-unsigned-preview.dmg", "m", "0".repeat(64));
      expect(() => prepareReleaseAssets({ dirs: { windows: win, macos: badMac }, outDir: join(root, "o2"), appVersion: "0.1.0" })).toThrow(/SHA-256/);

      expect(() => prepareReleaseAssets({ dirs: { windows: win, macos: join(root, "nope") }, outDir: join(root, "o3"), appVersion: "0.1.0" })).toThrow(/不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
