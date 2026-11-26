import { lstatSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { canonicalPath } from "./bench-paths.ts";

vi.mock("node:path", async (importOriginal) => (await importOriginal<typeof import("node:path")>()).win32);
vi.mock("node:fs", () => ({ lstatSync: vi.fn(), realpathSync: { native: vi.fn() } }));

it("stops at a missing Windows drive root", () => {
  const lstat = vi.mocked(lstatSync)
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce(undefined)
    .mockReturnValueOnce(undefined)
    .mockImplementation(() => { throw new Error("probed past the missing drive root"); });

  expect(canonicalPath("Z:\\Bench\\State")).toBe("z:\\bench\\state");
  expect(lstat.mock.calls.map(([path]) => path)).toEqual(["Z:\\Bench\\State", "Z:\\Bench", "Z:\\"]);
});
