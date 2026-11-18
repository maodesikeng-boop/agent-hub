// 飞书流式卡片实测（docs/feishu-design.md「性能 -> 4. 验证」）：真账本 + 照飞书限流规则回错误码的假传输层，每次调用加一段模拟网络延迟。
// 量：首块文字到群里出现流式卡片的延迟、一段 5,000 字回复期间“流式更新文本”调用次数、三个项目经理同时流式 N 秒有没有限流错误和丢字、RSS。
// 用法：node experiments/feishu-bench/stream.ts [并发秒数，默认 300]
// 不连真飞书：手机上出字还要加飞书服务端到客户端的推送时间，这里量不到。
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const NETWORK_MS = Number(process.env.FEISHU_BENCH_NETWORK_MS ?? 80);
const CONCURRENT_SECONDS = Number(process.argv[2] ?? 300);
/** 模型出字速度：每秒多少字（中文流式常见 100~200 字/秒）。 */
const CHARS_PER_SECOND = 150;
const DELTA_MS = 50;

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const rss = () => mb(process.memoryUsage().rss);

const rssBaseline = rss();
const { createLedger } = await import("../../src/daemon/ledger/index.ts");
const { openDatabase } = await import("../../src/daemon/store/db.ts");
const { migrate } = await import("../../src/daemon/store/migrate.ts");
const { createSessionStore } = await import("../../src/daemon/store/index.ts");
const { createResolveFolder } = await import("../../src/daemon/ledger/files.ts");

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "feishu-bench-")));
const dataHome = join(root, ".agent-hub");
mkdirSync(join(dataHome, "state"), { recursive: true });
const db = openDatabase(join(root, "hub.sqlite"));
migrate(db);
const ledger = createLedger(db, {
  pmHomeRoot: join(dataHome, "pm-home"),
  dataHome,
  worktreesDir: join(dataHome, "worktrees"),
  resolveFolder: createResolveFolder({ dataHome, userHome: root }),
});
const pms = ["小林", "阿周", "老王"].map((name) => ledger.createPm({ name, mode: "manage_only", persona: "" }));
for (const pm of pms) createSessionStore(db).update(pm.sessionId, { status: "running" });
const rssLedgerOnly = rss();

// ---- 照飞书规则限流的假传输层 ----
const { createFakeFeishu } = await import("../../src/daemon/feishu/test-helpers.ts");
const { FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE } = await import("../../src/daemon/feishu/scopes.ts");
const fake = createFakeFeishu({ clock: () => performance.now() });
fake.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
const windowOf = new Map<string, number[]>();
/** 最近一秒里同一个 key 的调用数超过 limit 就算限流。 */
const over = (key: string, limit: number) => {
  const t = performance.now();
  const recent = (windowOf.get(key) ?? []).filter((x) => t - x < 1000);
  recent.push(t);
  windowOf.set(key, recent);
  return recent.length > limit;
};
const limited: { method: string; code: number }[] = [];
const sequences = new Map<string, number>();
const sequenceErrors: string[] = [];
const rawCall = fake.call.bind(fake);
fake.call = async (method, args) => {
  await sleep(NETWORK_MS);
  const a = args as Record<string, unknown>;
  if (method === "card.element.content" || method === "card.update" || method === "card.settings") {
    const cardId = String(a.card_id);
    // 流式更新文本：全应用 50 次/秒、每张卡 10 次/秒；sequence 必须严格递增
    if ((method === "card.element.content" && over("cardkit", 50)) || over(`card:${cardId}`, 10)) {
      limited.push({ method, code: 99991400 });
      return { code: 99991400, msg: "rate limited" };
    }
    const seq = Number(a.sequence);
    if (seq <= (sequences.get(cardId) ?? 0)) sequenceErrors.push(`${cardId}: ${seq} <= ${sequences.get(cardId)}`);
    sequences.set(cardId, seq);
  }
  if (method === "message.create" && over(`chat:${String(a.receive_id)}`, 5)) {
    limited.push({ method, code: 230020 });
    return { code: 230020, msg: "send too fast" };
  }
  return rawCall(method, args);
};

const { createFeishuService } = await import("../../src/daemon/feishu/service.ts");
const { FEISHU_AVATARS_DIR } = await import("../../src/daemon/feishu/avatars.ts");
const logLines: string[] = [];
const svc = createFeishuService({
  db,
  ledger,
  router: null,
  secretsFile: join(dataHome, "state", "feishu-secrets.json"),
  uploadsDir: join(dataHome, "uploads"),
  sentFilesDir: join(dataHome, "sent-files"),
  avatarsDir: FEISHU_AVATARS_DIR,
  device: { id: "11111111-2222-3333-4444-555555555555", name: "bench" },
  log: (line) => logLines.push(line),
  createTransport: () => fake,
  register: async ({ handlers }) => {
    handlers.onUrl({ url: "https://bench", expiresAt: Date.now() + 600_000 });
    return { brand: "feishu", appId: "cli_bench", appSecret: "secret", scannerOpenId: "ou_owner" };
  },
});
await svc.start();
await svc.setup.startRegistration();
while (svc.setup.status().state !== "connected") await sleep(10);
await svc.idle();
const rssWithFeishu = rss();
// 配了飞书的守护进程会加载官方 SDK（假传输层不加载）：建一个真的 SDK 传输层（不连网）量它占的内存
const { createFeishuSdkTransport } = await import("../../src/daemon/feishu/sdk.ts");
createFeishuSdkTransport({ brand: "feishu", appId: "cli_bench", appSecret: "secret", log: () => {} });
const rssWithSdk = rss();

const callsOf = (method: string) => fake.calls.filter((c) => c.method === method);
type Pm = (typeof pms)[number];
const delta = (pm: Pm, text: string) => ledger.applyDriverEvent(pm.sessionId, { type: "agent.text_delta", delta: text, at: Date.now() });
const finish = (pm: Pm, uuid: string, text: string) => ledger.applyDriverEvent(pm.sessionId, { type: "agent.text", uuid, text, at: Date.now() });
const sample = "这是一段用来测流式卡片的中文回复，带一点标点和数字 123。";
const textOfLength = (n: number) => sample.repeat(Math.ceil(n / sample.length)).slice(0, n);

/** 一个项目经理按 CHARS_PER_SECOND 写完 text，返回实际写的时长。 */
async function stream(pm: Pm, text: string, uuid: string) {
  const step = Math.max(1, Math.round((CHARS_PER_SECOND * DELTA_MS) / 1000));
  for (let i = 0; i < text.length; i += step) {
    delta(pm, text.slice(i, i + step));
    await sleep(DELTA_MS);
  }
  finish(pm, uuid, text);
}

/** 定稿卡片的正文（card.update 和不经流式直接发的卡）。 */
function finalBodies(): string[] {
  const out: string[] = [];
  for (const c of fake.calls) {
    if (c.method === "card.update") {
      const card = JSON.parse(String((c.args.card as { data: string }).data)) as { config: { streaming_mode?: boolean }; body: { elements: { content?: string }[] } };
      if (card.config.streaming_mode === false) out.push(card.body.elements[0]?.content ?? "");
    }
    if (c.method === "message.create" && c.args.msg_type === "interactive") {
      const content = JSON.parse(String(c.args.content)) as { body?: { elements: { content?: string }[] } };
      if (content.body !== undefined) out.push(content.body.elements[0]?.content ?? "");
    }
  }
  return out;
}

// ---- 1. 首块出字延迟：5 次 ----
const firstLatencies: number[] = [];
for (let i = 0; i < 5; i++) {
  const pm = pms[0]!;
  const before = callsOf("message.create").length;
  const t0 = performance.now();
  delta(pm, "第一句");
  while (callsOf("message.create").length === before) await sleep(1);
  // 等 message.create 的回包（模拟网络）回来
  await sleep(NETWORK_MS);
  firstLatencies.push(performance.now() - t0);
  finish(pm, `first-${i}`, "第一句。");
  await svc.idle();
  await sleep(100);
}

// ---- 2. 5,000 字一段的推送次数 ----
const pushesBefore = callsOf("card.element.content").length;
const t5k = performance.now();
const text5k = textOfLength(5000);
await stream(pms[0]!, text5k, "five-k");
await svc.idle();
const seconds5k = (performance.now() - t5k) / 1000;
const pushes5k = callsOf("card.element.content").length - pushesBefore;
const final5kOk = finalBodies().includes(text5k);

// ---- 3. 三个项目经理同时流式 CONCURRENT_SECONDS 秒 ----
const limitedBefore = limited.length;
const segments: string[] = [];
const tConc = performance.now();
let rssPeak = rss();
const peakTimer = setInterval(() => (rssPeak = Math.max(rssPeak, rss())), 1000);
await Promise.all(
  pms.map(async (pm, p) => {
    let n = 0;
    while (performance.now() - tConc < CONCURRENT_SECONDS * 1000) {
      // 每段 1,500~3,000 字，长回复会被拆成多段
      const seg = `${pm.pm.name}第${n}段：${textOfLength(1500 + ((n * 977 + p * 331) % 1500))}`;
      segments.push(seg);
      await stream(pm, seg, `conc-${p}-${n++}`);
    }
  }),
);
await svc.idle();
await sleep(500);
await svc.idle();
clearInterval(peakTimer);
const concSeconds = (performance.now() - tConc) / 1000;
const finals = new Set(finalBodies());
const lost = segments.filter((s) => !finals.has(s));
const concPushes = fake.calls.filter((c) => c.method === "card.element.content" && c.at >= tConc).map((c) => c.at);
let maxPerSecond = 0;
for (let i = 0, j = 0; i < concPushes.length; i++) {
  while (concPushes[i]! - concPushes[j]! >= 1000) j++;
  maxPerSecond = Math.max(maxPerSecond, i - j + 1);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(
  JSON.stringify(
    {
      networkMsPerCall: NETWORK_MS,
      firstChunkToCardMs: { median: Math.round(median(firstLatencies)), min: Math.round(Math.min(...firstLatencies)), max: Math.round(Math.max(...firstLatencies)), runs: firstLatencies.length },
      fiveThousandChars: { seconds: Math.round(seconds5k * 10) / 10, streamPushes: pushes5k, pushesPerSecond: Math.round((pushes5k / seconds5k) * 10) / 10, finalEqualsLedger: final5kOk },
      concurrent: {
        pms: pms.length,
        seconds: Math.round(concSeconds),
        segments: segments.length,
        chars: segments.reduce((s, x) => s + x.length, 0),
        streamPushes: concPushes.length,
        maxStreamPushesInAnySecond: maxPerSecond,
        rateLimitErrors: limited.length - limitedBefore,
        rateLimitByMethod: Object.fromEntries([...new Set(limited.slice(limitedBefore).map((l) => l.method))].map((m) => [m, limited.slice(limitedBefore).filter((l) => l.method === m).length])),
        sequenceErrors: sequenceErrors.length,
        segmentsLost: lost.length,
      },
      rssMb: { baseline: rssBaseline, ledgerOnly: rssLedgerOnly, feishuServiceNoSdk: rssWithFeishu, plusOfficialSdk: rssWithSdk, peakDuringConcurrent: rssPeak, afterConcurrent: rss() },
      errorLogLines: logLines.filter((l) => !l.includes("bench")).slice(0, 5),
    },
    null,
    2,
  ),
);
await svc.close();
ledger.close();
db.close();
rmSync(root, { recursive: true, force: true });
