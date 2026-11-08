// 报错变人话的 CI 检查（docs/user-facing-errors-design.md 第 5 节）：防止新代码把英文码、err.message 又透传出去。
// 扫源码文件（fs，不依赖 rg）。允许清单 = 现在的全部命中，写文件和行内容、不写行号；
// 每个实现块改完从清单里删自己那几条（只降不升）：清单里有、源码里没有也会失败，逼着同步删。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listFiles(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(relative(ROOT, entry.parentPath), entry.name).split("\\").join("/");
    if (accept(path)) out.push(path);
  }
  return out.sort();
}

interface Allowed {
  file: string;
  /** 行内容（去掉首尾空白），不写行号。 */
  line: string;
  /** 这行（含文件）出现几次，默认 1。 */
  times?: number;
  /** 永久白名单：实现块做完也留着。 */
  permanent?: string;
}

interface Rule {
  name: string;
  files: string[];
  pattern: RegExp;
  /** 期望命中数 = 允许清单的总次数。只降不升。 */
  expected: number;
  allowed: Allowed[];
}

const isTs = (path: string) => path.endsWith(".ts");
const isTest = (path: string) => path.endsWith(".test.ts");
const daemonTs = listFiles("src/daemon", isTs);
const daemonNonTestTs = daemonTs.filter((path) => !isTest(path));
const webTsx = listFiles("src/web", (path) => path.endsWith(".tsx"));

const SERVER = "src/daemon/ui-server/server.ts";
const AGENT_API = "src/daemon/agent-api/server.ts";
const WEB = "src/web/components";

const RULES: Rule[] = [
  {
    // B 块把 fail() 改成只收 ApiErrorCode 后，这条由类型检查保证，B 里顺手删掉这条规则。
    name: "守护进程 fail 第三参不许是英文码",
    files: daemonTs,
    pattern: /fail\(reply, [0-9a-zA-Z_.[\]]+, "[a-z_]+"/,
    expected: 16,
    allowed: [
      { file: SERVER, line: 'if (peer === null) return fail(reply, 401, "peer_unauthorized");' },
      { file: SERVER, line: 'if ((identity.kind === "deviceToken" || !rule.browserPaths) && !inDeviceScope(path)) return fail(reply, 403, "forbidden_peer");' },
      { file: SERVER, line: 'if (identity.kind === "none" && !rule.identities.includes("cookie")) return fail(reply, 401, "peer_unauthorized");' },
      { file: SERVER, line: 'if (unsafe && rule.origin !== null && !rule.origin(req.headers.origin ?? "", entry)) return fail(reply, 403, "forbidden_origin");' },
      { file: SERVER, line: 'if (session === null) return fail(reply, 401, "unauthorized");' },
      { file: SERVER, line: 'if (path.startsWith("/api/peer/")) return fail(reply, 401, "peer_unauthorized");' },
      { file: SERVER, line: 'return fail(reply, 500, "internal_error");' },
      { file: SERVER, line: 'app.setNotFoundHandler((_req, reply) => fail(reply, 404, "not_found"));' },
      { file: SERVER, line: 'if (attachment === null) return fail(reply, 404, "not_found");' },
      { file: SERVER, line: 'if (copy === null) return fail(reply, 404, "not_found");' },
      { file: SERVER, line: 'if (token === undefined || link !== undefined || !tokenEquals(expectedToken, token)) return fail(reply, 401, "unauthorized");' },
      { file: SERVER, line: 'if (!loginLinks.consume(link)) return fail(reply, 401, "unauthorized");' },
      { file: SERVER, line: 'if (!sessions.revoke(id)) return fail(reply, 404, "not_found");' },
      { file: SERVER, line: 'if (error instanceof OpenTargetMissing) return fail(reply, 404, "not_found");' },
      { file: SERVER, line: 'if (act === null || message === null || file === undefined || file.id === null) return fail(reply, 404, "not_found");' },
      { file: SERVER, line: 'if (act === null || attachment === null) return fail(reply, 404, "not_found");' },
    ],
  },
  {
    name: "应答体不许直接 error: 英文码（*.test.ts 除外）",
    files: daemonNonTestTs,
    pattern: /error: "[a-z_]+"/,
    expected: 2,
    allowed: [
      // B 块（联机）：统一成 device_not_found 后删掉。
      { file: "src/daemon/peers/routes.ts", line: 'const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "not_found", code: "not_found" } satisfies ApiErrorBody);' },
      { file: "src/daemon/ledger/handover.ts", line: 'error: "error",', permanent: "别的枚举（交接单状态 error），不是应答体" },
    ],
  },
  {
    name: "回给人的不许是 err.message（fail 的第三参）",
    files: daemonTs,
    pattern: /fail\(reply, [^,]+, (err|error)\.message/,
    expected: 7,
    allowed: [
      { file: SERVER, line: "if (err instanceof PickFolderError) return fail(reply, err.statusCode, err.message);" },
      { file: SERVER, line: 'if (err instanceof UploadError) return fail(reply, err.statusCode, err.message, err.statusCode === 400 ? "invalid" : undefined);' },
      { file: SERVER, line: "if (err instanceof LedgerRequestError) return fail(reply, LEDGER_ERROR_HTTP_STATUS[err.code], err.message, err.code);" },
      { file: SERVER, line: 'if (status === 400) return fail(reply, 400, err.message, "invalid");' },
      { file: SERVER, line: "if (status !== undefined && status >= 400 && status < 500) return fail(reply, status, err.message);" },
      { file: AGENT_API, line: "if (err instanceof HubError || err instanceof LedgerRequestError) return fail(reply, err.code, err.message);" },
      { file: AGENT_API, line: 'return fail(reply, "internal", err.message);' },
    ],
  },
  {
    name: "组件不许直接显示 err.message",
    files: webTsx,
    pattern: /(err|error)\.message/,
    expected: 5,
    allowed: [
      { file: `${WEB}/BrowserSessions.tsx`, line: 'const reasonOf = (err: unknown) => (err instanceof ApiError ? err.message : "操作失败");' },
      { file: `${WEB}/FilePreview.tsx`, line: 'setResult({ text: error instanceof ApiError ? error.message : "没能打开这个文件", error: true });' },
      { file: `${WEB}/PmProfile.tsx`, line: "errors={agentSave.error ? { [agentSave.error.key]: agentSave.error.message } : {}}" },
      { file: `${WEB}/PmProfile.tsx`, line: "<RowError>{modeSave.error.message}</RowError>" },
      {
        file: `${WEB}/ChartBlock.tsx`,
        line: "chartCache.set(key, { ok: false, message: error instanceof Error ? error.message : String(error) });",
        permanent: "图表语法错，不是接口错误",
      },
    ],
  },
];

/** 规则命中的“文件 + 行内容”，同一行出现几次计几次。 */
function scan(rule: Rule): Map<string, number> {
  const hits = new Map<string, number>();
  for (const file of rule.files) {
    for (const raw of readFileSync(join(ROOT, file), "utf8").split("\n")) {
      const line = raw.trim();
      if (!rule.pattern.test(line)) continue;
      const key = `${file}\n${line}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
    }
  }
  return hits;
}

describe("报错变人话：扫描规则", () => {
  it("扫得到文件（目录搬了这个检查就等于没有）", () => {
    expect(daemonTs.length).toBeGreaterThan(20);
    expect(webTsx.length).toBeGreaterThan(10);
    expect(daemonTs).toContain(SERVER);
    expect(daemonTs).toContain(AGENT_API);
  });

  it.each(RULES.map((rule) => [rule.name, rule] as const))("%s", (_name, rule) => {
    const allowed = new Map<string, number>();
    for (const entry of rule.allowed) {
      const key = `${entry.file}\n${entry.line}`;
      allowed.set(key, (allowed.get(key) ?? 0) + (entry.times ?? 1));
    }
    const hits = scan(rule);

    const show = (key: string) => key.replace("\n", "  ");
    const added = [...hits].filter(([key, n]) => n > (allowed.get(key) ?? 0)).map(([key]) => show(key));
    const removed = [...allowed].filter(([key, n]) => (hits.get(key) ?? 0) < n).map(([key]) => show(key));
    // 新增命中：新代码别再这样写；清单里有、源码里没了：从清单里删掉这条（棘轮只降不升）。
    expect(added, "新增了不该有的写法").toEqual([]);
    expect(removed, "允许清单里这几条源码里已经没有了，请从清单删掉并把 expected 调小").toEqual([]);

    const total = [...hits.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(rule.expected);
  });
});
