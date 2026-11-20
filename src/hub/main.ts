import { runHubSafely } from "./cli.ts";

process.exitCode = await runHubSafely({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdin: () => process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
