// Entry point for the tester's script layer, used by the nightly job, the Project Manager, and the AI tester:
//   node test/tester/cli.ts list                         print the flow catalog
//   node test/tester/cli.ts preflight                    check every bench boundary
//   node test/tester/cli.ts run --cadence nightly        run the nightly flows
//   node test/tester/cli.ts run --cadence pr --changed <file>...   run flows a PR's changed paths select
//   node test/tester/cli.ts run --flow <id>...           run named flows
//   node test/tester/cli.ts status                       print runs/latest/summary.md
//   node test/tester/cli.ts vendors status               print the coverage matrix: every vendor on every bench computer
//   node test/tester/cli.ts vendors install              install missing vendor CLIs into the bench HOMEs with the product's install commands
//   node test/tester/cli.ts bench up | bench down        start or stop the local test computer outside a run
//   node test/tester/cli.ts authorize-feishu             one-time owner consent for the Feishu driver app
// Exit codes: 0 clean, 1 product alert, 2 bench alert or usage error.

/** Postcondition: the process exit code for `argv`; writes the human-readable result to stdout and errors to stderr. */
export async function main(argv: readonly string[]): Promise<number> {
  throw new Error("Not implemented");
}
