// 截图用的守护进程用 `node --import` 先加载它：把 Date 钉在 UI_POLISH_NOW_MS（和浏览器的固定时间同一刻），定时器照常走。
// 种子数据的时间是钉死的，守护进程却用真实时间判断归档到期、定时任务到点；不钉的话过几天再截，已归档的项目经理会被清掉。
// 也不让它往前走：浏览器的时间是钉死的，守护进程现记的时间（这台浏览器的登录时间）跟着截图快慢变，图就不一样了。
import { install } from "@sinonjs/fake-timers";

const now = Number(process.env.UI_POLISH_NOW_MS);
if (!Number.isSafeInteger(now)) throw new Error("UI_POLISH_NOW_MS 不是毫秒时间戳");
install({ now, toFake: ["Date"] });
