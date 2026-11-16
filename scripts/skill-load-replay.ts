// 重放本机历史上的技能加载（docs/skill-carryover-design.md）：只读打开账本和各家原始记录，按厂商、按信号数加载，
// 比三种认法：A 解析 shell 命令（现在的 shared/skill-loads.ts）、B 看工具返回内容里有没有已知技能的开头、C 看工具输入里有没有已知技能的路径。
// 用法：node scripts/skill-load-replay.ts [hub.sqlite 路径] [--role pm|all] [--list]
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { vendorTranscriptPath } from "../src/daemon/driver/transcript.ts";
import { toolSkillLoads, userSkillCommandOf } from "../src/shared/skill-loads.ts";
import { isAgentVendor, vendorSpec } from "../src/shared/vendors.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const role = args[args.indexOf("--role") + 1] === "all" && args.includes("--role") ? "all" : "pm";
const home = homedir();
const db = new DatabaseSync(args.find((a) => a.endsWith(".sqlite")) ?? join(home, ".agent-hub/state/hub.sqlite"), { readOnly: true });

// ---- 已知技能：本机现在各处技能目录里的 SKILL.md，按目录名 ----

const SKILL_ROOTS = [
  join(home, "agent-hub/.agents/skills"),
  join(home, ".agents/skills"),
  join(home, ".claude/skills"),
  join(home, ".gemini/config/skills"),
  join(home, ".pi/agent/skills"),
  join(home, ".cursor/skills"),
  join(home, ".agent-hub/state/launch/736/skills"),
];

const nonEmptyLines = (text: string) => text.replace(/\r\n?/gu, "\n").split("\n").filter((l) => l.trim() !== "");

/** 一个技能的两个“开头”：frontmatter 的头两行、正文的头两行（跳过 frontmatter 只读正文的也认）。 */
interface KnownSkill {
  name: string;
  head: string;
  body: string | null;
}
const known = new Map<string, KnownSkill>();
for (const root of SKILL_ROOTS) {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (known.has(name)) continue;
    const file = join(root, name, "SKILL.md");
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const text = readFileSync(file, "utf8").replace(/^﻿/u, "");
    const lines = nonEmptyLines(text);
    const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    const bodyLines = close === -1 ? lines : lines.slice(close + 1);
    known.set(name, { name, head: lines.slice(0, 2).join("\n"), body: bodyLines.length >= 2 ? bodyLines.slice(0, 2).join("\n") : null });
  }
}

// ---- 各家原始记录里的工具输出 ----

type Session = { id: number; role: string; vendor: string; vendor_session_id: string; cwd: string };
const sessions = db.prepare("SELECT id, role, vendor, vendor_session_id, cwd FROM agent_sessions").all() as unknown as Session[];

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p?.text === "string" ? p.text : "")).join("") : "";

function outputsOf(s: Session): Map<string, string> {
  const out = new Map<string, string>();
  const path = vendorTranscriptPath({ vendor: s.vendor, vendorSessionId: s.vendor_session_id, cwd: s.cwd });
  if (path === null) return out;
  if (s.vendor === "agy") {
    // 会话库里每一步一行，step_payload 是 protobuf，输出原文在里面；账本的 toolUseId 是 tool-<轮>-<步号>
    const conv = new DatabaseSync(path, { readOnly: true });
    for (const r of conv.prepare("SELECT idx, step_payload FROM steps").all() as { idx: number; step_payload: Uint8Array | null }[]) {
      if (r.step_payload) out.set(String(r.idx), Buffer.from(r.step_payload).toString("utf8"));
    }
    conv.close();
    return out;
  }
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (s.vendor === "claude" && Array.isArray(o.message?.content)) {
      for (const p of o.message.content) if (p?.type === "tool_result" && typeof p.tool_use_id === "string") out.set(p.tool_use_id, textOf(p.content));
    } else if (s.vendor === "codex" && o.payload?.type === "item_completed" && typeof o.payload.item?.id === "string") {
      out.set(o.payload.item.id, String(o.payload.item.aggregated_output ?? ""));
    } else if (s.vendor === "pi" && o.message?.role === "toolResult" && typeof o.message.toolCallId === "string") {
      out.set(o.message.toolCallId, textOf(o.message.content));
    }
  }
  return out;
}
const outputKey = (vendor: string, id: string) => (vendor === "agy" ? (/^tool-\d+-(\d+)$/u.exec(id)?.[1] ?? id) : id);

// ---- 三种认法 ----

/** 读文件工具给每行加的行号（Claude Read 的 `12\t`、agy read_file 的 `12: `、cat -n）。 */
const LINE_NUMBER_RE = /^[ \t]*\d+(?:\t|: |→)/u;
const normalized = (output: string) => nonEmptyLines(output).map((l) => l.replace(LINE_NUMBER_RE, "")).join("\n");

/** B：返回内容里出现已知技能的开头（frontmatter 头两行，或正文头两行）。 */
function byOutput(output: string): string[] {
  const text = `\n${normalized(output)}\n`;
  return [...known.values()].filter((k) => text.includes(`\n${k.head}\n`) || (k.body !== null && text.includes(`\n${k.body}\n`))).map((k) => k.name);
}

/** C：工具输入里出现 `<已知技能名>/SKILL.md`。 */
function byInputText(inputText: string): string[] {
  return [...known.keys()].filter((name) => inputText.includes(`${name}/SKILL.md`) || inputText.includes(`${name}\\\\SKILL.md`));
}

// ---- 重放 ----

type Counts = Record<string, number>;
const table = new Map<string, Counts>();
const bump = (key: string, field: string) => {
  const c = table.get(key) ?? {};
  c[field] = (c[field] ?? 0) + 1;
  table.set(key, c);
};
const disagreements: string[] = [];
const byId = new Map(sessions.map((s) => [s.id, s]));
const outputs = new Map<number, Map<string, string>>();

const tools = db.prepare("SELECT id, session_id, meta FROM messages WHERE kind = 'tool' AND session_id IS NOT NULL ORDER BY id").all() as unknown as { id: number; session_id: number; meta: string }[];
for (const row of tools) {
  const s = byId.get(row.session_id);
  if (!s || !isAgentVendor(s.vendor) || (role === "pm" && s.role !== "pm")) continue;
  const meta = JSON.parse(row.meta) as { toolUseId?: string; name?: string; input?: unknown; parentToolUseId?: string };
  if (meta.parentToolUseId !== undefined || typeof meta.name !== "string") continue;
  const key = `${s.role}/${s.vendor}`;
  const action = vendorSpec(s.vendor).tools?.actions[meta.name];
  bump(key, "工具调用");
  if (action === "skill") {
    bump(key, "原生技能工具");
    continue;
  }
  if (action !== "read" && action !== "command") continue;
  if (!outputs.has(s.id)) outputs.set(s.id, outputsOf(s));
  const output = outputs.get(s.id)!.get(outputKey(s.vendor, meta.toolUseId ?? ""));
  const inputText = JSON.stringify(meta.input ?? null);
  if (output !== undefined) bump(key, `${action} 有返回内容`);
  let a: string[] = [];
  try {
    a = toolSkillLoads(s.vendor, meta.name, meta.input).map((l) => l.name).filter((n) => known.has(n));
  } catch {
    bump(key, "A 抛错");
  }
  const b = output === undefined ? [] : byOutput(output);
  const c = byInputText(inputText);
  if (a.length + b.length + c.length === 0) continue;
  a.sort(), b.sort(), c.sort();
  bump(key, `${action} 涉及技能的调用`);
  for (const name of b) bump(key, `B 认到 ${action}`);
  for (const [label, names] of [["A", a], ["C", c]] as const) {
    const missed = b.filter((n) => !names.includes(n)).length;
    const extra = names.filter((n) => !b.includes(n)).length;
    for (let i = 0; i < missed; i++) bump(key, `${label} 比 B 少`);
    for (let i = 0; i < extra; i++) bump(key, `${label} 比 B 多`);
  }
  if (a.join() !== b.join() || b.join() !== c.join()) {
    disagreements.push(`${row.id} ${key} ${meta.name} out=${output === undefined ? "无" : output.length}  A=[${a}] B=[${b}] C=[${c}]  ${inputText.slice(0, 200).replaceAll("\\n", "⏎")}`);
  }
}

const users = db
  .prepare("SELECT m.text, s.vendor, s.role FROM messages m JOIN agent_sessions s ON s.id = m.session_id WHERE m.sender = 'user' AND m.kind = 'text'")
  .all() as { text: string; vendor: string; role: string }[];
for (const u of users) {
  if (role === "pm" && u.role !== "pm") continue;
  if (userSkillCommandOf(u.vendor, u.text) !== null) bump(`${u.role}/${u.vendor}`, "用户手打技能命令");
}

console.log(`已知技能 ${known.size} 个`);
for (const [key, counts] of [...table].sort()) console.log(key, JSON.stringify(counts));
console.log(`\n三种认法不一致 ${disagreements.length} 处${flag("--list") ? "：" : "（--list 列出）"}`);
if (flag("--list")) for (const d of disagreements) console.log(d);
