import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ProxyOptions, UserConfig } from "vite";
import { describe, expect, it, vi } from "vitest";
import { ENV_DEV_DAEMON_PORT } from "../src/shared/limits.ts";

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

  it("vite 开发服务器把 /api/、/auth 和 WebSocket 代理到守护进程端口，只改 vite 自己页面发的 Origin", async () => {
    vi.stubEnv(ENV_DEV_DAEMON_PORT, "4000");
    try {
      vi.resetModules();
      const config = (await import("../vite.config.ts")).default as UserConfig;
      const proxy = config.server!.proxy as Record<string, ProxyOptions>;
      expect(Object.keys(proxy).sort()).toEqual(["/api/", "/auth"]);
      const target = "http://127.0.0.1:4000";
      expect(proxy["/api/"]).toMatchObject({ target, changeOrigin: true, ws: true });
      expect(proxy["/auth"]).toMatchObject({ target, changeOrigin: true });

      for (const event of ["proxyReq", "proxyReqWs"]) {
        const emitter = new EventEmitter();
        proxy["/api/"]!.configure!(emitter as never, proxy["/api/"]!);
        const rewrite = (origin: string | undefined) => {
          const headers: Record<string, string> = {};
          const req = { headers: { host: "localhost:5173", ...(origin ? { origin } : {}) } };
          emitter.emit(event, { setHeader: (k: string, v: string) => (headers[k] = v) }, req);
          return headers.origin;
        };
        expect(rewrite("http://localhost:5173")).toBe(target);
        // 别的来源（别的本机端口上的网页）原样转过去，守护进程照样回 403
        expect(rewrite("http://localhost:6666")).toBeUndefined();
        expect(rewrite(undefined)).toBeUndefined();
      }
    } finally {
      vi.unstubAllEnvs();
    }
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
