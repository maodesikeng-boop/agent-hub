import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFeishuSecrets, removeFeishuSecrets, writeFeishuSecrets } from "./secrets.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feishu-secrets-"));
  file = join(dir, "state", "feishu-secrets.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const secrets = { brand: "feishu" as const, appId: "cli_a", appSecret: "s3cret" };

describe("feishu-secrets.json", () => {
  it.skipIf(process.platform === "win32")("写入后权限是 0600，读回等于写入的", async () => {
    await writeFeishuSecrets(file, secrets);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await readFeishuSecrets(file)).toEqual(secrets);
  });

  it("文件不存在 read 返回 null；形状不对抛错", async () => {
    expect(await readFeishuSecrets(file)).toBeNull();
    await writeFeishuSecrets(file, secrets);
    writeFileSync(file, JSON.stringify({ appId: "cli_a" }));
    await expect(readFeishuSecrets(file)).rejects.toThrow();
    writeFileSync(file, "not json");
    await expect(readFeishuSecrets(file)).rejects.toThrow();
  });

  it("remove 后 read 返回 null；不存在时 remove 不报错", async () => {
    await writeFeishuSecrets(file, secrets);
    await removeFeishuSecrets(file);
    expect(await readFeishuSecrets(file)).toBeNull();
    await expect(removeFeishuSecrets(file)).resolves.toBeUndefined();
  });
});
