// hub worker show / log 输出里不能带密钥、令牌（redact.ts）：常见形状要遮，普通的命令不能被误伤。
import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "./redact.ts";

describe("redactSecrets", () => {
  it.each([
    ['curl -H "Authorization: Bearer abcdef1234567890" https://x.test', "abcdef1234567890"],
    ["curl -u me:hunter2hunter2 https://user:hunter2hunter2@x.test/a", "hunter2hunter2"],
    ["GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 gh pr list", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ['export OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz123456"', "sk-abcdefghijklmnopqrstuvwxyz123456"],
    ["gh auth login --with-token github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz", "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz"],
    ["curl x --token supersecretvalue", "supersecretvalue"],
    ["curl x --api-key=supersecretvalue", "supersecretvalue"],
    ['{"password": "p4ssw0rd-value"}', "p4ssw0rd-value"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"],
    ["echo AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    ["echo xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
    ["echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "eyJhbGciOiJIUzI1NiJ9"],
  ])("遮掉 %s", (input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  it.each([
    "gh pr checks 90 --watch",
    "pnpm test src/daemon/ledger/worker-view.test.ts",
    'GH_TOKEN="$(gh auth token --user me)" gh pr list',
    "echo $GH_TOKEN",
    "git log --oneline -5",
    "grep -rn token src",
    "Reading a.ts",
    "curl https://example.com/api?page=2",
  ])("不误伤 %s", (input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});
