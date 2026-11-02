import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("骨架", () => {
  it("package.json 锁了运行时和包管理器版本", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.engines.node).toBe(">=24.12");
    expect(pkg.packageManager).toMatch(/^pnpm@10\./);
    expect(pkg.scripts.check).toBe("tsc --noEmit && vitest run");
  });
});

describe("各块的入口文件", () => {
  const entries = [
    "src/daemon/main.ts",
    "src/daemon/store/index.ts",
    "src/daemon/ledger/index.ts",
    "src/daemon/actions/index.ts",
    "src/daemon/driver/index.ts",
    "src/daemon/ui-server/index.ts",
    "src/web/index.html",
    "src/web/main.tsx",
    "test/fake-claude/fake-claude.ts",
    "test/smoke/main.ts",
  ];
  it.each(entries)("%s 在", (path) => {
    expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
  });
});
