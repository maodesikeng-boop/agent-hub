// 在 agent 的会话里（比如 Worker）跑测试时，HUB_TOKEN / HUB_SOCK 和那家给子进程设的“父会话”变量（各家 spec 的 cli.parentSessionEnv，
// 含我们给 Worker 设的那几个）会漏进测试，让守护进程和假 claude 继承后误报；每个测试 worker 启动时统一清掉。
import { PARENT_SESSION_ENV } from "../src/daemon/driver/protocol.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../src/shared/hub.ts";

for (const name of [ENV_HUB_TOKEN, ENV_HUB_SOCK, ...PARENT_SESSION_ENV]) delete process.env[name];
