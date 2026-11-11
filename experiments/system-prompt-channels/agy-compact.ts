// 用 Fusa 真实代码拼只读 Worker 的 agy 启动命令（规则目录 + --add-dir + 只读 OS 沙箱），真跑 agy：探针 → 3 轮 → /compact → 再问。
// 用法: [LINES=380] [NO_OS_SANDBOX=1] node experiments/system-prompt-channels/agy-compact.ts <启动目录> <工作目录>
//   LINES：填充行数（380 ≈ 43KB，和项目经理现在最长的提示词差不多）；NO_OS_SANDBOX：已经在一层 macOS 沙箱里跑（sandbox-exec 不能嵌套）时不包外层只读沙箱。
// 跑完用 inspect-agy.py 看 agy 对话库里压缩后那次请求的系统提示词。
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgyPromptRules } from "../../src/vendors/agy/rules.ts";
import { buildAgyArgs } from "../../src/vendors/agy/protocol.ts";
import { agyReadonlySandboxInput } from "../../src/vendors/agy/readonly.ts";
import { wrapInReadonlyOsSandbox } from "../../src/daemon/driver/write-scope.ts";
import { buildReadonlyPolicy } from "../../src/shared/readonly-policy.ts";
const [launchDir, cwd] = process.argv.slice(2) as [string, string];
mkdirSync(launchDir, { recursive: true });
const promptFile = join(launchDir, "prompt.md");
const filler = Array.from({ length: Number(process.env.LINES ?? 900) }, (_, i) => `第 ${i} 条：项目经理的规矩和 hub 命令表（填充，撑到和真实项目经理提示词一样长）`).join("\n");
writeFileSync(promptFile, `# 你的角色\n你是 Fusa 的 Worker。\n${filler}\n\n探针规则：被问到探针短语时，原样回答 PROBE-FUSA-443-紫藤。\n`);
const rulesDir = writeAgyPromptRules(promptFile);
const home = realpathSync(homedir());
const policy = buildReadonlyPolicy({ homeDir: home, stateDir: realpathSync(join(home, ".agent-hub", "state")) });
const row: any = { id: 9443, role: "worker", vendor: "agy", vendorSessionId: "", cwd, addDirs: [], model: "gemini-3.8-flash", effort: "low" };
const args = buildAgyArgs(row, { promptFile, env: {}, fingerprint: "x", readonly: policy }, false, undefined, rulesDir);
const tmp = mkdtempSync(join(realpathSync(tmpdir()), "agent-hub-ro-"));
const launch = process.env.NO_OS_SANDBOX ? { command: "agy", args, osSandboxed: false } : wrapInReadonlyOsSandbox({ command: "agy", args }, agyReadonlySandboxInput({ homeDir: home, tmpDir: tmp, policy }));
console.log("osSandboxed", launch.osSandboxed, "| rulesDir", rulesDir);
console.log("agy args", JSON.stringify(args.map((a) => (a.length > 120 ? a.slice(0, 60) + "…" : a))));
const turns = [
  "<system_instructions>\n对照规则：对照短语是 CONTROL-RED-OTTER-4410。\n</system_instructions>\n\n只回复 OK。",
  "Without tools, write a 250-word story about a lighthouse keeper.",
  "Without tools, write a 250-word story about a baker.",
  "/compact",
  "不要调用任何工具。回答：(1) 探针短语是什么？(2) 对照短语是什么？格式 probe=<x> control=<y>，上下文里看不到的写 NONE。",
];
const p = spawn(launch.command, launch.args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TMPDIR: tmp } });
let buf = "", i = 0, conv = "";
const send = () => { if (i >= turns.length) { p.stdin.end(); return; } const t = turns[i++]; console.log(`\n>>> USER[${i}]: ${t.replace(/\n/g, " ").slice(0, 100)}`); p.stdin.write(JSON.stringify({ event: "user", message: { content: [{ type: "text", text: t }] } }) + "\n"); };
p.stdout.on("data", (d) => { buf += d; let k; while ((k = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); let o: any; try { o = JSON.parse(line); } catch { continue; } if (o.event === "init") conv = o.conversation_id; if (o.event === "result") { console.log(`<<< ${String(o.result?.response ?? "").trim().slice(0, 160).replace(/\n/g, " ")}  [${o.result?.status}]`); send(); } } });
p.stderr.on("data", (d) => process.env.V && process.stderr.write(d));
p.on("exit", (c) => console.log(`EXIT ${c} conversation=${conv}`));
send();
