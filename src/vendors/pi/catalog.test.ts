import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_CATALOG_MODELS } from "../../shared/index.ts";
import { createPiCatalogSource, parsePiModels, piCatalogProbe } from "./catalog.ts";
import { writeFakePiBinary } from "./fixtures/fake-pi.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-pi-catalog-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi 模型目录解析与探测（catalog.ts）", () => {
  it("未配置任何凭据时：No models available 识别为 signed_out 且 parse 返回 null", () => {
    const emptyOut =
      "No models available. Use /login to log into a provider via OAuth or API key, or set an API key environment variable.\n";
    expect(parsePiModels(emptyOut)).toBeNull();
    expect(piCatalogProbe.availabilityOf({ stdout: emptyOut })).toBe("signed_out");
  });

  it("解析对齐表格：拼出 <provider>/<model>，按 thinking 列区分思考档位", () => {
    const stdout = [
      "provider  model            context  max-out  thinking  images",
      "deepseek  deepseek-flash   1M       384K     yes       yes",
      "deepseek  deepseek-v4-pro  1M       384K     yes       no",
      "openai    gpt-4o-mini      128K     16K      no        yes",
    ].join("\n");

    expect(piCatalogProbe.availabilityOf({ stdout })).toBe("available");
    const catalog = parsePiModels(stdout);
    expect(catalog).not.toBeNull();
    expect(catalog!.source).toBe("vendor");
    expect(catalog!.models.map((m) => m.id)).toEqual([
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-flash",
      "openai/gpt-4o-mini",
    ]);

    const flash = catalog!.models.find((m) => m.id === "deepseek/deepseek-flash")!;
    expect(flash.efforts).toContain("high");
    expect(flash.description).toContain("支持图片");

    const mini = catalog!.models.find((m) => m.id === "openai/gpt-4o-mini")!;
    expect(mini.efforts).toEqual(["off"]);
  });

  it("超过 MAX_CATALOG_MODELS（50）时：先按模型商分组挑较新模型，再跨模型商轮询截断到 50", () => {
    const providers = ["anthropic", "deepseek", "google", "openai", "xai"];
    const rows = ["provider  model  context  max-out  thinking  images"];
    // 每家造 18 个模型（合计 90 个 > 50），按升序排列模拟真 pi 输出（v1 在前、v5 在后）
    for (const provider of providers) {
      for (let major = 1; major <= 6; major++) {
        for (let minor = 0; minor < 3; minor++) {
          rows.push(`${provider}  ${provider}-model-${major}.${minor}  200K  32K  yes  yes`);
        }
      }
    }

    const catalog = parsePiModels(rows.join("\n"));
    expect(catalog).not.toBeNull();
    expect(catalog!.models).toHaveLength(MAX_CATALOG_MODELS);

    // 5 家模型商每家都应均匀分到 10 个，且每家最新版 6.2 都在入选名单里，最老版 1.0 都被裁掉
    for (const provider of providers) {
      const picked = catalog!.models.filter((m) => m.id.startsWith(`${provider}/`));
      expect(picked).toHaveLength(10);
      expect(picked[0]!.id).toBe(`${provider}/${provider}-model-6.2`);
      expect(picked.some((m) => m.id.endsWith("-1.0"))).toBe(false);
    }
  });

  it("createPiCatalogSource：对接假 pi 可执行程序，覆盖未登录、已登录与非零退出报错", async () => {
    const dir = makeTempDir();
    const fake = writeFakePiBinary(dir, {});
    const env = { FAKE_PI_SCRIPT: fake.scriptPath, FAKE_PI_LOG: fake.logPath };

    const source = createPiCatalogSource({
      path: fake.binPath,
      cwd: dir,
      env,
      installed: () => true,
    });

    // 1. 默认无模型 → signed_out
    const signedOutRaw = await source.query(new AbortController().signal);
    expect(source.availabilityOf?.(signedOutRaw)).toBe("signed_out");
    expect(source.parse(signedOutRaw)).toBeNull();
    // 探测的工作目录可能是不信任的仓库：带 --no-approve，不加载项目 .pi/extensions
    const argv = fake.readLogs().find((e) => e.kind === "argv")?.argv;
    expect(argv).toContain("--no-approve");
    expect(argv).not.toContain("--approve");

    // 2. 配置模型表格 → available + parse
    fake.updateScript({
      listModelsStdout: [
        "provider  model            context  max-out  thinking  images",
        "deepseek  deepseek-v4-pro  1M       384K     yes       no",
      ].join("\n"),
    });
    const okRaw = await source.query(new AbortController().signal);
    expect(source.availabilityOf?.(okRaw)).toBe("available");
    const parsed = source.parse(okRaw);
    expect(parsed?.models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro"]);

    // 3. 非零退出 → 抛错并附带 stderr
    fake.updateScript({
      listModelsExitCode: 2,
      listModelsStderr: "broken config file",
    });
    await expect(source.query(new AbortController().signal)).rejects.toThrow(/broken config file/);
  });
});
