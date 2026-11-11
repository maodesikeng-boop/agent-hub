// 假 Anthropic Messages 接口：记录每个请求体到 LOG（一行一个 JSON），按顺序回固定文字。
import http from "node:http";
import { appendFileSync } from "node:fs";
const [port, log] = process.argv.slice(2);
let n = 0;
http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    n += 1;
    let j = null; try { j = JSON.parse(body); } catch {}
    appendFileSync(log, JSON.stringify({ n, method: req.method, url: req.url, body: j ?? body }) + "\n");
    if (!req.url.includes("/messages") || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(req.url.includes("count_tokens") ? { input_tokens: 1000 } : { data: [] })); return;
    }
    const isSummary = JSON.stringify(j?.messages ?? "").includes("compacted-summary") || JSON.stringify(j?.messages?.at?.(-1) ?? "").toLowerCase().includes("summar");
    const text = isSummary ? "SUMMARY: the user asked for stories; nothing else notable." : `mock-reply-${n}`;
    const id = `msg_${n}`;
    if (!j?.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id, type: "message", role: "assistant", model: j?.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 10 } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
    ev("message_start", { message: { id, type: "message", role: "assistant", model: j?.model, content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 0 } } });
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    ev("content_block_stop", { index: 0 });
    ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
    ev("message_stop", {});
    res.end();
  });
}).listen(Number(port), "127.0.0.1", () => console.log("mock listening", port));
