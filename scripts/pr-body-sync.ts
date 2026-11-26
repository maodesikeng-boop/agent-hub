// Sets a pull request description from an annotated `pr-body/<PR>` tag, run by .github/workflows/pr-body.yml on tag pushes.
// Invariant: it edits only the description of an open PR whose head branch lives in this repository, never posts a status, and deletes the tag after it decides.
// A tag never moves the PR head, so checks and the review stamp on the head commit stay valid.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PR_BODY_TAG_PREFIX = "pr-body/";

/** GitHub rejects a pull request body longer than this. */
export const PR_BODY_MAX_CHARS = 65_536;

export interface PrBodyTarget {
  number: number;
  state: "open" | "closed";
  /** `owner/repo` of the head branch, or null when the head repository was deleted. */
  headRepo: string | null;
  body: string | null;
}

export type PrBodySyncDecision =
  | { kind: "update"; pr: number; body: string }
  | { kind: "skip"; reason: string }
  | { kind: "reject"; reason: string };

/**
 * Accepts `refs/tags/pr-body/<N>` or `pr-body/<N>`.
 * Postcondition: returns N when it is a positive integer without leading zeros, otherwise null.
 */
export function parsePrBodyTag(_ref: string): number | null {
  throw new Error("Not implemented");
}

/**
 * Decides what the workflow does for one tag push. `repo` is `owner/repo` of the repository running the workflow, and
 * `tagMessage` is null for a lightweight tag.
 * - Invalid tag name, lightweight tag, blank message, message over PR_BODY_MAX_CHARS, PR not found, or a head in another repository: `reject`.
 * - Closed or merged PR, or a body identical to the current one: `skip`.
 * - Otherwise `update` with the message exactly as written, minus one trailing newline.
 */
export function decidePrBodySync(_input: { tagRef: string; tagMessage: string | null; repo: string; pr: PrBodyTarget | null }): PrBodySyncDecision {
  throw new Error("Not implemented");
}

export interface PrBodySyncDeps {
  fetch: typeof fetch;
  log: (line: string) => void;
}

/**
 * Reads GITHUB_REPOSITORY, GITHUB_REF, and GH_TOKEN from env, fetches the tag and the PR through the API, applies the decision,
 * and deletes the tag. Returns 0 after `update` or `skip` and 1 after `reject` or an API error.
 */
export async function main(_env: Readonly<Record<string, string | undefined>>, _deps: PrBodySyncDeps): Promise<number> {
  throw new Error("Not implemented");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.env, { fetch: (...args) => fetch(...args), log: (line) => console.log(line) });
}
