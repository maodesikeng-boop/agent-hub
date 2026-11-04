// Worker 会话里 HUB_TOKEN / HUB_SOCK / CLAUDE_CODE_DISABLE_AUTO_MEMORY 会漏进测试，
// 让守护进程和假 claude 继承后误报；每个测试 worker 启动时统一清掉。
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../src/shared/hub.ts";
import { WORKER_ENV } from "../src/shared/policy.ts";

for (const name of [ENV_HUB_TOKEN, ENV_HUB_SOCK, ...Object.keys(WORKER_ENV)]) delete process.env[name];
