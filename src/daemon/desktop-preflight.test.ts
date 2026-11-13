import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { collectDesktopPreflight, GIT_WINDOWS_INSTALL_COMMAND } from "./desktop-preflight.ts";

describe("collectDesktopPreflight（桌面前置检查，零硬编码厂商名）", () => {
  it("动态遍历 VENDOR_LIST 并准确识别 PATH / 兜底目录下的 git.exe 与厂商 CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "fusa-preflight-"));
    try {
      const binDir = join(root, "bin");
      const homeDir = join(root, "home");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });

      // 模拟缺少 git.exe 与任何厂商 CLI 的空环境
      const emptyReport = collectDesktopPreflight({
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
        userHome: homeDir,
        platform: "win32",
      });
      expect(emptyReport.gitInstalled).toBe(false);
      expect(emptyReport.gitInstallCommand).toBe(GIT_WINDOWS_INSTALL_COMMAND);
      expect(emptyReport.vendors.map((v) => v.id)).toEqual(VENDOR_LIST.map((v) => v.id));
      expect(emptyReport.vendors.every((v) => !v.installed)).toBe(true);

      // 放入 git.exe 与注册表第一家厂商的 .cmd 垫片后重新检测立即命中
      const firstVendor = VENDOR_LIST[0]!;
      writeFileSync(join(binDir, "git.exe"), "MZ");
      writeFileSync(join(binDir, `${firstVendor.cli.command}.cmd`), "@echo off\r\n");

      const detected = collectDesktopPreflight({
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
        userHome: homeDir,
        platform: "win32",
      });
      expect(detected.gitInstalled).toBe(true);
      expect(detected.vendors.find((v) => v.id === firstVendor.id)?.installed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
