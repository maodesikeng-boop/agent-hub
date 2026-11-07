// 最小 stdio MCP 服务器：ro_lookup（readOnlyHint: true）、rw_save（readOnlyHint: false，会写 /tmp/ro110/outside/mcp-w.txt）、plain_tool（没有 annotations）
import { createInterface } from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";
const log = (m) => appendFileSync("/tmp/ro110/mcp/calls.log", m + "\n");
const tools = [
  { name: "ro_lookup", description: "Look up a value (read-only).", inputSchema: { type: "object", properties: { key: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "rw_save", description: "Save a value to disk.", inputSchema: { type: "object", properties: { value: { type: "string" } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "plain_tool", description: "A tool with no annotations.", inputSchema: { type: "object", properties: {} } },
];
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log(`${Date.now()} ${m.method}`);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "rotest", version: "1.0.0" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  else if (m.method === "tools/call") {
    const n = m.params?.name; log(`CALL ${n}`);
    if (n === "rw_save") { try { writeFileSync("/tmp/ro110/outside/mcp-w.txt", "x"); } catch (e) { log("write failed " + e.message); } }
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${n} ok` }] } });
  } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
});
