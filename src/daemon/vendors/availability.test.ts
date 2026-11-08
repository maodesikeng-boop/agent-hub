import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_VENDORS } from "../../shared/index.ts";
import { AGY_SIGNED_OUT_STDOUT } from "../driver/test-helpers.ts";
import { codexAuthFileAvailability } from "./codex.ts";
import { VENDOR_CATALOG_PROBES } from "./index.ts";

describe("各家怎么从名单那次查询里看登录状态", () => {
  it("每家都登记了", () => {
    for (const v of AGENT_VENDORS) expect(VENDOR_CATALOG_PROBES[v]).toBeDefined();
  });

  it("claude：initialize 回应里有 account（实测有 email）是能用；没有说不清", () => {
    const { availabilityOf } = VENDOR_CATALOG_PROBES.claude;
    expect(availabilityOf({ models: [], account: { email: "a@b.c", organization: "X" } })).toBe("available");
    expect(availabilityOf({ models: [], account: {} })).toBe("unknown");
    expect(availabilityOf({ models: [], account: { apiProvider: "firstParty" } })).toBe("unknown");
    expect(availabilityOf({ models: [] })).toBe("unknown");
  });

  it("codex：account/read 回 account: null 且要 OpenAI 登录是没登录；有账号能用；没问到说不清", () => {
    const { availabilityOf } = VENDOR_CATALOG_PROBES.codex;
    expect(availabilityOf({ models: [], account: { account: null, requiresOpenaiAuth: true } })).toBe("signed_out");
    expect(availabilityOf({ models: [], account: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } })).toBe("available");
    expect(availabilityOf({ models: [], account: { account: null, requiresOpenaiAuth: false } })).toBe("available");
    expect(availabilityOf({ models: [] })).toBe("unknown");
  });

  it("agy：问到名单是能用；东京实测没登录打印的那段话是没登录", () => {
    const probe = VENDOR_CATALOG_PROBES.agy;
    expect(probe.availabilityOf({})).toBe("available");
    expect(probe.availabilityOfError?.(new Error(`agy 没回有效 JSON（models）：${AGY_SIGNED_OUT_STDOUT}`))).toBe("signed_out");
    expect(probe.availabilityOfError?.(new Error("agy 超时（15000 ms 没回 models）"))).toBe("unknown");
  });

  describe("codex 补充判断：读 $CODEX_HOME/auth.json 在不在（不起进程）；不在时看 config.toml 的 cli_auth_credentials_store", () => {
    const withHome = (run: (dir: string) => void) => {
      const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
      try {
        run(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };

    it("auth.json 在：available（不管 config 怎么写）", () => {
      withHome((dir) => {
        writeFileSync(join(dir, "auth.json"), "{}");
        expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("available");
        writeFileSync(join(dir, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
        expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("available");
      });
    });

    it("auth.json 不在、没有 config.toml：官方默认是 file，signed_out；CODEX_HOME 没设就看 <主目录>/.codex", () => {
      withHome((dir) => {
        expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("signed_out");
        expect(codexAuthFileAvailability({}, dir.replace(/\/[^/]+$/u, "/nope"))).toBe("signed_out");
      });
    });

    it("auth.json 不在、config 写 keyring 或 auto：凭据可能在系统钥匙串，说不清（unknown）", () => {
      withHome((dir) => {
        for (const value of ["keyring", "auto"]) {
          writeFileSync(join(dir, "config.toml"), `model = "gpt-5"\ncli_auth_credentials_store = "${value}"  # 钥匙串\n`);
          expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("unknown");
        }
        writeFileSync(join(dir, "config.toml"), "cli_auth_credentials_store='keyring'\n");
        expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused")).toBe("unknown");
      });
    });

    it("auth.json 不在、config 写 file、没写这一项、写了别的值、或这一项在别的表里（不是顶层）：signed_out", () => {
      withHome((dir) => {
        const cases = [
          'cli_auth_credentials_store = "file"\n',
          'model = "gpt-5"\n',
          'cli_auth_credentials_store = "ephemeral"\n',
          '[profiles.x]\ncli_auth_credentials_store = "keyring"\n',
          '# cli_auth_credentials_store = "keyring"\n',
        ];
        for (const content of cases) {
          writeFileSync(join(dir, "config.toml"), content);
          expect(codexAuthFileAvailability({ CODEX_HOME: dir }, "/unused"), content).toBe("signed_out");
        }
      });
    });
  });
});
