import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { runDaemonProcess } from "../../src/daemon/entry.ts";

if (process.platform === "darwin" && process.env.E2E_FAKE_WORKER_SANDBOX === "1") {
  const fake = fileURLToPath(new URL("../fake-claude/fake-claude.ts", import.meta.url));
  // A macOS Worker can run this fake CLI, but cannot apply a nested seatbelt profile.
  childProcess.spawn = new Proxy(childProcess.spawn, {
    apply(target, receiver, args) {
      const [command, argv, options] = args;
      if (command === "/usr/bin/sandbox-exec" && Array.isArray(argv) && argv[0] === "-p" && argv[2] === fake) {
        return Reflect.apply(target, receiver, [fake, argv.slice(3), options]);
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
}

await runDaemonProcess({ userHome: homedir() });
