// 只记录、不执行的替身（ssh、scp、sftp、rsync、git push、launchctl、osascript、pkill、killall、open）：
// 放在评测 PATH 的最前面，被调用时把参数记一行到 EVAL_RECORD_FILE，什么都不做，退出码 0。
// 拷进每次试跑的 bin/lib/record.mts 单独运行：只用 node 自带模块。第一个参数是替身的名字，后面是原样的参数。
import { appendFileSync } from "node:fs";
import type { RecordedCall } from "../types.ts";

const [tool = "unknown", ...argv] = process.argv.slice(2);
const file = process.env.EVAL_RECORD_FILE;
if (file) {
  const call: RecordedCall = { tool, argv, cwd: process.cwd(), at: Date.now() };
  appendFileSync(file, `${JSON.stringify(call)}\n`);
}
// git push 照真 git 没东西可推时的样子回一句；别的替身安静退出（rsync、ssh 成功时本来也不出声）
if (tool === "git") process.stderr.write("Everything up-to-date\n");
