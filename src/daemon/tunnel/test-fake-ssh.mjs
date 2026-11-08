#!/usr/bin/env node
// 假 ssh（supervisor.test.ts 用）：第一个参数是剧本文件（JSON 数组），第 N 次被启动就照第 N 步做（超出的照最后一步）。
// 一步：{ "stderr": ["行", …], "exit": 退出码 } 写完 stderr 就退出；
//       { "stderr": [...], "hang": true, "ignoreTerm": true? } 写完就一直挂着（ignoreTerm：收到 SIGTERM 也不退，只能 SIGKILL）。
// 每次启动把自己的进程号追加到 <剧本>.pids，测试据此看子进程还在不在。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const plan = process.argv[2];
const steps = JSON.parse(readFileSync(plan, "utf8"));
let count = 0;
try {
  count = Number(readFileSync(`${plan}.count`, "utf8"));
} catch {}
writeFileSync(`${plan}.count`, String(count + 1));
appendFileSync(`${plan}.pids`, `${process.pid}\n`);
const step = steps[Math.min(count, steps.length - 1)];
for (const line of step.stderr ?? []) process.stderr.write(`${line}\n`);
if (step.hang) {
  if (step.ignoreTerm) process.on("SIGTERM", () => {});
  setInterval(() => {}, 1 << 30);
} else {
  process.exitCode = step.exit ?? 0;
}
