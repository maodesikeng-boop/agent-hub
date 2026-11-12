// 只记录、不执行的替身（ssh、scp、sftp、rsync、git push、launchctl、osascript、pkill、killall、open），
// 和按场景回放真实输出的命令替身（K1、K2、K4 的 pi-bridge、curl、pi、npm……，场景里的 CommandStubs）：
// 放在评测 PATH 的最前面，被调用时把参数记一行到 EVAL_RECORD_FILE。只记录的什么都不做，退出码 0；命令替身按 EVAL_STUBS_FILE 里的表
// 回放那条命令当时的输出，对不上的照“成功、没有输出”回（不真跑：装软件、改本机配置不能在评测里真做）。
// 拷进每次试跑的 bin/lib/record.mts 单独运行：只用 node 自带模块。第一个参数是替身的名字，后面是原样的参数。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CommandStubs, RecordedCall, StubOutput } from "../types.ts";

const [tool = "unknown", ...argv] = process.argv.slice(2);
const file = process.env.EVAL_RECORD_FILE;
const stubsFile = process.env.EVAL_STUBS_FILE;

/** 之前的调用记录（同一个替身同一条回放调过几次、afterCall 那条调过没有）。 */
function previousCalls(): RecordedCall[] {
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RecordedCall];
      } catch {
        return [];
      }
    });
}

function replay(): { index: number; output: StubOutput } | null {
  if (!stubsFile || !existsSync(stubsFile)) return null;
  const stubs = JSON.parse(readFileSync(stubsFile, "utf8")) as CommandStubs;
  const replies = stubs[tool];
  if (replies === undefined) return null;
  const line = argv.join(" ");
  const before = previousCalls();
  const index = replies.findIndex(
    (r) =>
      (r.match === undefined || line.includes(r.match)) &&
      (r.afterCall === undefined || before.some((c) => c.tool === r.afterCall!.tool && c.argv.join(" ").includes(r.afterCall!.match))),
  );
  if (index === -1) return { index: -1, output: {} };
  const outputs = replies[index]!.outputs;
  const nth = before.filter((c) => c.tool === tool && c.stub === index).length;
  return { index, output: outputs[Math.min(nth, outputs.length - 1)] ?? {} };
}

const stub = replay();
if (file) {
  const call: RecordedCall = { tool, argv, cwd: process.cwd(), at: Date.now(), ...(stub === null ? {} : { stub: stub.index }) };
  appendFileSync(file, `${JSON.stringify(call)}\n`);
}
if (stub !== null) {
  const at = stub.output.writeArgAfter === undefined ? -1 : argv.indexOf(stub.output.writeArgAfter);
  if (at >= 0 && argv[at + 1] !== undefined) writeFileSync(argv[at + 1]!, stub.output.stdout ?? "");
  else if (stub.output.stdout) process.stdout.write(stub.output.stdout);
  if (stub.output.stderr) process.stderr.write(stub.output.stderr);
  process.exitCode = stub.output.exitCode ?? 0;
} else if (tool === "git") {
  // git push 照真 git 没东西可推时的样子回一句；别的替身安静退出（rsync、ssh 成功时本来也不出声）
  process.stderr.write("Everything up-to-date\n");
}
