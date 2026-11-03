import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readJson = (path: string) => JSON.parse(read(path));

describe("骨架", () => {
  it("package.json 锁了运行时和包管理器版本", () => {
    const pkg = readJson("package.json");
    expect(pkg.engines.node).toBe(">=24.12");
    expect(pkg.packageManager).toMatch(/^pnpm@10\./);
    expect(pkg.devDependencies["@types/node"]).toMatch(/^\^24\./);
  });

  it("pnpm check 分两份做类型检查，再跑测试", () => {
    const pkg = readJson("package.json");
    expect(pkg.scripts.check).toBe("tsc --noEmit -p tsconfig.json && tsc --noEmit -p src/web/tsconfig.json && vitest run");
  });

  it("守护进程和测试那份不带 DOM、不管 src/web；网页那份带 DOM", () => {
    const daemon = readJson("tsconfig.json");
    expect(daemon.compilerOptions.lib).not.toContain("dom");
    expect(daemon.exclude).toContain("src/web");
    const web = readJson("src/web/tsconfig.json");
    expect(web.extends).toBe("../../tsconfig.json");
    expect(web.compilerOptions.lib).toContain("dom");
    expect(web.compilerOptions.types).not.toContain("node");
  });

  it("网页测试每条结束后清理，并带 jest-dom 的断言", () => {
    expect(read("vitest.config.ts")).toContain("src/web/test-setup.ts");
    const setup = read("src/web/test-setup.ts");
    expect(setup).toContain("@testing-library/jest-dom/vitest");
    expect(setup).toMatch(/afterEach\(\s*cleanup\s*\)/);
  });

  it("vite 开发服务器把 /api、/auth 和 WebSocket 代理到守护进程端口", () => {
    const config = read("vite.config.ts");
    expect(config).toContain("ENV_DEV_DAEMON_PORT");
    expect(config).toContain('"/api"');
    expect(config).toContain('"/auth"');
    expect(config).toMatch(/ws:\s*true/);
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
