// 组网测试共用：临时目录里的设备身份。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { DeviceId } from "../../shared/api.ts";
import { loadOrCreateMeshIdentity, type MeshIdentity } from "./identity.ts";

export const DEVICE_A: DeviceId = "11111111-1111-4111-8111-111111111111";
export const DEVICE_B: DeviceId = "22222222-2222-4222-8222-222222222222";
export const DEVICE_C: DeviceId = "33333333-3333-4333-8333-333333333333";
export const DEVICE_D: DeviceId = "44444444-4444-4444-8444-444444444444";

const dirs: string[] = [];

/** 一个测试结束后自动删掉的临时目录。 */
export function tempDir(prefix = "mesh-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 在临时目录里生成一台设备的身份。 */
export function makeIdentity(deviceId: DeviceId): Promise<MeshIdentity> {
  return loadOrCreateMeshIdentity(join(tempDir(), "mesh"), deviceId);
}
