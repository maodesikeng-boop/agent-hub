// 截图用的守护进程用 `node --import` 先加载它：把 Date 钉在 UI_POLISH_NOW_MS（和浏览器的固定时间同一刻），定时器照常走。
// 守护进程用 Date 判断归档到期、定时任务到点并记录浏览器登录时间；不钉死的话，跨天或截图快慢变化会让界面不一致。
import { mock } from "node:test";

const now = Number(process.env.UI_POLISH_NOW_MS);
if (!Number.isSafeInteger(now)) throw new Error("UI_POLISH_NOW_MS 不是毫秒时间戳");
mock.timers.enable({ apis: ["Date"], now });

// 父进程退出（含被强杀）时标准输入管道关闭，跟着优雅退出，不留孤儿守护进程。
process.stdin.resume();
process.stdin.once("end", () => {
  setTimeout(() => process.exit(0), 5_000).unref();
  process.kill(process.pid, "SIGTERM");
});
