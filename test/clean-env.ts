// Tests that run inside an agent session (such as a Worker) would otherwise inherit HUB_TOKEN, HUB_SOCK, the vendor parent-session
// variables, and a review Worker's GIT_CONFIG_* hooksPath guard, so the daemon, fake vendor CLIs, and test git repos misbehave.
import { WORKER_ENV } from "../src/vendors/claude/settings.ts";
import { PARENT_SESSION_ENV } from "../src/daemon/driver/protocol.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../src/shared/hub.ts";

const INHERITED_GIT_ENV = /^(GIT_DIR|GIT_WORK_TREE|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+)$/;

for (const name of [ENV_HUB_TOKEN, ENV_HUB_SOCK, ...PARENT_SESSION_ENV, ...Object.keys(WORKER_ENV)]) delete process.env[name];
for (const name of Object.keys(process.env)) if (INHERITED_GIT_ENV.test(name)) delete process.env[name];
