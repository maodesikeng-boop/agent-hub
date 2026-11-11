// 用法: node acp-probe.mjs <cwd> <turnsJson> <cmd> [args...]
// 环境变量 ADD_DIRS=dir1:dir2 传 session/new 的 additionalDirectories（仅 agent 声明支持时）；NEWMETA=json 传 session/new 的 _meta
import { spawn } from "node:child_process";
const [cwd, turnsJson, cmd, ...args] = process.argv.slice(2);
const turns = JSON.parse(turnsJson);
const p = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = "", nextId = 1; const pending = new Map(); let text = "";
const send = (obj) => p.stdin.write(JSON.stringify(obj) + "\n");
const req = (method, params) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { res, rej }); send({ jsonrpc: "2.0", id, method, params }); });
p.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log("RAW", line.slice(0, 200)); continue; }
    if (m.id !== undefined && m.method === undefined) { const h = pending.get(m.id); pending.delete(m.id); m.error ? h.rej(m.error) : h.res(m.result); continue; }
    if (m.method === "session/update") {
      const u = m.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") text += u.content.text;
      else if (process.env.V) console.log("UPD", JSON.stringify(u).slice(0, 300));
      if (u.sessionUpdate === "usage_update") console.log("USAGE", JSON.stringify(u).slice(0, 200));
      continue;
    }
    if (m.id !== undefined) { // agent -> client request
      console.log("AGENT-REQ", m.method, JSON.stringify(m.params).slice(0, 200));
      if (m.method === "session/request_permission") {
        const opt = m.params.options.find((o) => o.kind.startsWith("reject")) ?? m.params.options[0];
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
      } else send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "cancelled" } } });
      continue;
    }
    if (process.env.V) console.log("NOTE", line.slice(0, 300));
  }
});
p.stderr.on("data", (d) => process.env.V && process.stderr.write(d));
const init = await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("INIT caps", JSON.stringify(init.agentCapabilities), "meta", JSON.stringify(init._meta ?? null));
const addDirs = process.env.ADD_DIRS ? process.env.ADD_DIRS.split(":") : [];
const newParams = { cwd, mcpServers: [], ...(addDirs.length ? { additionalDirectories: addDirs } : {}), ...(process.env.NEWMETA ? { _meta: JSON.parse(process.env.NEWMETA) } : {}) };
const ns = await req("session/new", newParams);
console.log("SESSION", ns.sessionId);
if (process.env.MODEL) { try { const opt = (ns.configOptions ?? []).find((o) => o.id === "model"); console.log("model opts", JSON.stringify(opt?.options?.slice?.(0, 40)?.map((o) => o.value ?? o.name)).slice(0, 600)); await req("session/set_config_option", { sessionId: ns.sessionId, configId: "model", value: process.env.MODEL }); } catch (e) { console.log("set model err", JSON.stringify(e)); } }
for (const t of turns) {
  console.log(`\n>>> USER: ${t.slice(0, 160).replace(/\n/g, " ")}`);
  text = "";
  try { const r = await req("session/prompt", { sessionId: ns.sessionId, prompt: [{ type: "text", text: t }] }); console.log(`<<< ASSISTANT: ${text.trim().slice(0, 600)}\n[stop] ${JSON.stringify(r).slice(0, 300)}`); }
  catch (e) { console.log("PROMPT ERR", JSON.stringify(e).slice(0, 400)); }
}
p.kill("SIGTERM"); setTimeout(() => process.exit(0), 500);
