import { describe, expect, it } from "vitest";
import { diffManifests, type CaptureManifest, type CapturedShot } from "./capture.ts";

const shot = (key: string, sha256: string, focusSha256?: string): CapturedShot => ({
  key,
  screenId: key.split("@")[0]!,
  viewport: "desktop",
  file: `${key}.png`,
  sha256,
  ...(focusSha256 === undefined ? {} : { focusFile: `${key}.focus.png`, focusSha256 }),
  machineFindings: [],
});
const manifest = (...shots: CapturedShot[]): CaptureManifest => ({ commit: "abc", browser: "chromium 1", shots });

// captureAll 要起浏览器和守护进程，不在单元测试里跑，用 `pnpm ui:polish shots --verify` 验（方案第 8 节）。
describe("diffManifests", () => {
  it("两份清单每张图 sha256 都一样时返回空数组", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1"), shot("b@desktop", "2")), manifest(shot("a@desktop", "1"), shot("b@desktop", "2")))).toEqual([]);
  });

  it("一张图 sha256 不同时返回它的 key", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1"), shot("b@desktop", "2")), manifest(shot("a@desktop", "1"), shot("b@desktop", "3")))).toEqual(["b@desktop"]);
  });

  it("一边多出来的图也返回", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1")), manifest(shot("a@desktop", "1"), shot("c@desktop", "9")))).toEqual(["c@desktop"]);
  });

  it("局部图的 sha256 不同也算", () => {
    expect(diffManifests(manifest(shot("a@desktop", "1", "f1")), manifest(shot("a@desktop", "1", "f2")))).toEqual(["a@desktop"]);
  });
});
