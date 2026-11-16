// 重放本机历史上的技能加载（docs/skill-carryover-design.md）：只读打开账本和各家原始记录，用生产代码认（shared/skill-loads.ts 的识别函数、
// daemon/skill-files.ts 的已知技能名单），和工具真实的返回内容对照，列出不一致的地方，量识别耗时。
// - 生产这一侧只用实时流拿得到的东西：返回原文按各家 spec 的 outputField 取、按 SKILL_LOAD_SCAN_MAX_CHARS 截（toolOutputText）。
//   agy 的 read_file 在实时流里只回“N lines, B bytes”，历史上没存这个摘要：读成功的（原始记录里有带行号的正文）当作返回了摘要，
//   读失败的当作返回了错误，认哪个技能只看路径参数。
// - 对照这一侧不用生产代码：自己枚举本机所有技能目录当名单，在原始记录的完整返回里找技能开头（行号前缀统一去掉，不截断）。
// 2026-11-16 这一版之前（提交 984c7933）还比过“解析 shell 命令”和“输入里找路径”两种认法，数字在设计文档里。
// 用法：node scripts/skill-load-replay.ts [hub.sqlite 路径] [--role pm|all] [--list]
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { vendorTranscriptPath } from "../src/daemon/driver/transcript.ts";
import { createSkillFiles, type SkillSession } from "../src/daemon/skill-files.ts";
import { awaitsToolResult, skillNameOfToolCall, skillsOfToolResult, userSkillCommandOf, type SkillCatalog } from "../src/shared/skill-loads.ts";
import { isAgentVendor, vendorSpec } from "../src/shared/vendors.ts";
import { toolOutputText } from "../src/vendors/_common/tool-output.ts";

const args = process.argv.slice(2);
const role = args.includes("--role") && args[args.indexOf("--role") + 1] === "all" ? "all" : "pm";
const list = args.includes("--list");
const home = homedir();
const db = new DatabaseSync(args.find((a) => a.endsWith(".sqlite")) ?? join(home, ".agent-hub/state/hub.sqlite"), { readOnly: true });
const skillFiles = createSkillFiles({ launchDir: join(home, ".agent-hub/state/launch"), userHome: home, env: process.env });

// ---- 对照：本机所有技能目录里的技能和它们的开头 ----

const ORACLE_ROOTS = [
  join(home, "agent-hub/.agents/skills"),
  join(home, ".agents/skills"),
  join(home, ".claude/skills"),
  join(home, ".gemini/config/skills"),
  join(home, ".pi/agent/skills"),
  join(home, ".cursor/skills"),
  ...readdirSync(join(home, ".agent-hub/state/launch")).map((id) => join(home, ".agent-hub/state/launch", id, "skills")),
];
const nonEmptyLines = (text: string) => text.split(/\r?\n/u).map((l) => l.trimEnd()).filter((l) => l.trim() !== "");
const oracleHeads = new Map<string, Set<string>>();
for (const root of ORACLE_ROOTS) {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    continue;
  }
  for (const name of entries) {
    const file = join(root, name, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const lines = nonEmptyLines(readFileSync(file, "utf8").replace(/^﻿/u, ""));
    const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    const heads = [lines.slice(0, 2), close === -1 ? [] : lines.slice(close + 1, close + 3)].filter((h) => h.length === 2).map((h) => h.join("\n"));
    for (const head of heads) oracleHeads.set(head, (oracleHeads.get(head) ?? new Set()).add(name));
  }
}
const ORACLE_LINE_NUMBER = /^\s*\d+(?:\t|: |→)/u;
/** 对照：完整返回里出现了哪些技能的开头，和最远出现在第几个字。 */
function oracle(output: string): { names: string[]; farthest: number } {
  const lines = output.split(/\r?\n/u);
  const kept: { text: string; at: number }[] = [];
  let at = 0;
  for (const raw of lines) {
    const text = raw.replace(ORACLE_LINE_NUMBER, "").trimEnd();
    if (text.trim() !== "") kept.push({ text, at: at + raw.length });
    at += raw.length + 1;
  }
  const names = new Set<string>();
  let farthest = 0;
  for (let i = 0; i + 1 < kept.length; i++) {
    for (const name of oracleHeads.get(`${kept[i]!.text}\n${kept[i + 1]!.text}`) ?? []) {
      names.add(name);
      farthest = Math.max(farthest, kept[i + 1]!.at);
    }
  }
  return { names: [...names].sort(), farthest };
}

// ---- 各家原始记录里的返回：live 是实时流里驱动拿得到的那份，full 是原始记录里完整的那份 ----

type SessionRow = { id: number; role: string; vendor: string; vendor_session_id: string; cwd: string; add_dirs: string };
type Output = { live: string; full: string };
const AGY_READ_OK = /(?:^|[\n\r\0-\x1f])\d+: /u;

function outputsOf(s: SessionRow): Map<string, Output> {
  const out = new Map<string, Output>();
  const path = vendorTranscriptPath({ vendor: s.vendor, vendorSessionId: s.vendor_session_id, cwd: s.cwd });
  if (path === null) return out;
  if (s.vendor === "agy") {
    // 会话库里每一步一行，step_payload 是 protobuf，返回原文在里面；账本的 toolUseId 是 tool-<轮>-<步号>
    const conv = new DatabaseSync(path, { readOnly: true });
    for (const r of conv.prepare("SELECT idx, step_payload FROM steps").all() as { idx: number; step_payload: Uint8Array | null }[]) {
      if (r.step_payload) {
        const full = Buffer.from(r.step_payload).toString("utf8");
        out.set(String(r.idx), { live: toolOutputText(full), full });
      }
    }
    conv.close();
    return out;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: { message?: { role?: string; toolCallId?: string; content?: unknown }; payload?: { type?: string; item?: { id?: unknown; aggregated_output?: unknown } } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (s.vendor === "claude" && Array.isArray(content)) {
      for (const p of content as { type?: string; tool_use_id?: string; content?: unknown }[]) {
        if (p?.type === "tool_result" && typeof p.tool_use_id === "string") out.set(p.tool_use_id, { live: toolOutputText(p.content), full: textOf(p.content) });
      }
    } else if (s.vendor === "codex" && o.payload?.type === "item_completed" && typeof o.payload.item?.id === "string") {
      // 原始记录里是 aggregated_output，实时流 app-server 里同一份是 aggregatedOutput
      out.set(o.payload.item.id, { live: toolOutputText(o.payload.item.aggregated_output), full: textOf(o.payload.item.aggregated_output) });
    } else if (s.vendor === "pi" && o.message?.role === "toolResult" && typeof o.message.toolCallId === "string") {
      // 实时流 tool_execution_end.result 是 {content, details}，content 和这里一样
      out.set(o.message.toolCallId, { live: toolOutputText({ content }), full: textOf(content) });
    }
  }
  return out;
}
const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: unknown }) => (typeof p?.text === "string" ? p.text : "")).join("\n") : "";
const outputKey = (vendor: string, id: string) => (vendor === "agy" ? (/^tool-\d+-(\d+)$/u.exec(id)?.[1] ?? id) : id);

/** 实时流里这次返回长什么样：agy 的 read_file 只回摘要（读成功）或错误。 */
function liveOutput(vendor: string, toolName: string, output: Output): string {
  if (vendor !== "agy" || vendorSpec(vendor).skillSignals.readByPath?.[toolName] === undefined) return output.live;
  return AGY_READ_OK.test(output.full) ? "1 lines, 1 bytes" : "file does not exist";
}

// ---- 重放 ----

const counts = new Map<string, Record<string, number>>();
const bump = (key: string, field: string, n = 1) => {
  const c = counts.get(key) ?? {};
  c[field] = (c[field] ?? 0) + n;
  counts.set(key, c);
};
const disagreements: string[] = [];
const sessions = new Map((db.prepare("SELECT id, role, vendor, vendor_session_id, cwd, add_dirs FROM agent_sessions").all() as unknown as SessionRow[]).map((s) => [s.id, s]));
const outputCache = new Map<number, Map<string, Output>>();
const catalogs = new Map<number, SkillCatalog>();
const catalogOf = (s: SessionRow): SkillCatalog => {
  let c = catalogs.get(s.id);
  if (c === undefined) {
    const session: SkillSession = { id: s.id, vendor: s.vendor, cwd: s.cwd, addDirs: JSON.parse(s.add_dirs) as string[] };
    c = skillFiles.catalog(session);
    catalogs.set(s.id, c);
  }
  return c;
};
let recognizeMs = 0;
let recognized = 0;
let farthest = 0;

const tools = db.prepare("SELECT id, session_id, meta FROM messages WHERE kind = 'tool' AND session_id IS NOT NULL ORDER BY id").all() as unknown as { id: number; session_id: number; meta: string }[];
for (const row of tools) {
  const s = sessions.get(row.session_id);
  if (!s || !isAgentVendor(s.vendor) || (role === "pm" && s.role !== "pm")) continue;
  const meta = JSON.parse(row.meta) as { toolUseId?: string; name?: string; input?: unknown; parentToolUseId?: string };
  if (meta.parentToolUseId !== undefined || typeof meta.name !== "string") continue;
  const key = `${s.role}/${s.vendor}`;
  const call = { name: meta.name, input: meta.input };
  bump(key, "工具调用");
  const named = skillNameOfToolCall(s.vendor, call);
  if (named !== null) {
    bump(key, catalogOf(s).named(named) === null ? "原生技能工具（名单里没有）" : "原生技能工具");
    continue;
  }
  if (!awaitsToolResult(s.vendor, meta.name)) continue;
  if (!outputCache.has(s.id)) outputCache.set(s.id, outputsOf(s));
  const output = outputCache.get(s.id)!.get(outputKey(s.vendor, meta.toolUseId ?? ""));
  if (output === undefined) {
    bump(key, "原始记录里没有返回");
    continue;
  }
  bump(key, "有返回的读文件、命令");
  const catalog = catalogOf(s);
  const started = performance.now();
  const got = skillsOfToolResult(s.vendor, call, liveOutput(s.vendor, meta.name, output), catalog).map((k) => k.name).sort();
  recognizeMs += performance.now() - started;
  recognized++;
  const expected = oracle(output.full);
  farthest = Math.max(farthest, expected.farthest);
  if (got.length > 0) bump(key, "认到加载", got.length);
  if (got.join() === expected.names.join()) continue;
  bump(key, "不一致");
  disagreements.push(`${row.id} ${key} ${meta.name} 生产=[${got}] 返回内容=[${expected.names}]  ${JSON.stringify(meta.input ?? null).slice(0, 220).replaceAll("\\n", "⏎")}`);
}

const users = db
  .prepare("SELECT m.text, s.id FROM messages m JOIN agent_sessions s ON s.id = m.session_id WHERE m.sender = 'user' AND m.kind = 'text'")
  .all() as { text: string; id: number }[];
for (const u of users) {
  const s = sessions.get(u.id)!;
  if (!isAgentVendor(s.vendor) || (role === "pm" && s.role !== "pm")) continue;
  const name = userSkillCommandOf(s.vendor, u.text);
  if (name !== null) bump(`${s.role}/${s.vendor}`, catalogOf(s).named(name) === null ? "用户手打命令（名单里没有）" : "用户手打技能命令");
}

for (const [key, c] of [...counts].sort()) console.log(key, JSON.stringify(c));
console.log(`\n识别 ${recognized} 次工具返回，共 ${recognizeMs.toFixed(1)} ms，平均每次 ${((recognizeMs / Math.max(1, recognized)) * 1000).toFixed(1)} µs`);
console.log(`技能开头在返回原文里最远出现在第 ${farthest} 字`);
console.log(`生产代码和返回内容不一致 ${disagreements.length} 处${list ? "：" : "（--list 列出）"}`);
if (list) for (const d of disagreements) console.log(d);
