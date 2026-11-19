// 端到端测试用的守护进程入口：和 src/daemon/main.ts 一样，另外把账号组网接到本机的假 GitHub 和自建中继，
// 局域网入口只听回环、回环地址当局域网候选（FUSA_TEST_LAN=0 时不报候选，只能经中继）。只有这里能这么配，正式入口没有开关。
import { homedir } from "node:os";
import { runDaemonProcess } from "../../src/daemon/entry.ts";

const github = process.env.FUSA_TEST_GITHUB;
await runDaemonProcess({
  userHome: homedir(),
  mesh: {
    githubClientId: "Iv1.test",
    listenPort: 0,
    listenHost: "127.0.0.1",
    candidates: process.env.FUSA_TEST_LAN === "0" ? () => [] : (port) => [{ host: "127.0.0.1", port }],
    ...(github !== undefined ? { github: { webOrigin: github, apiOrigin: github } } : {}),
  },
});
