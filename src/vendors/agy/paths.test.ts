import { describe, expect, it } from "vitest";
import {
  AGY_FORCE_FILE_TOKEN_STORAGE_ENV,
  AGY_MACOS_LOGIN_KEYCHAIN_REL,
  agyIsolatedHomeEnv,
} from "./paths.ts";

describe("agyIsolatedHomeEnv (acceptance S3/S11/S13)", () => {
  it("enables file token storage on macOS when the effective HOME has no login.keychain-db", () => {
    const checked: string[] = [];
    const env = agyIsolatedHomeEnv({
      userHome: "/tmp/isolated-home",
      platform: "darwin",
      env: { HOME: "/tmp/isolated-home" },
      exists: (p) => {
        checked.push(p);
        return false;
      },
    });
    expect(env).toEqual({ [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "1" });
    expect(checked).toEqual([`/tmp/isolated-home/${AGY_MACOS_LOGIN_KEYCHAIN_REL}`]);
  });

  it("leaves the env untouched on macOS when login.keychain-db exists in HOME", () => {
    const env = agyIsolatedHomeEnv({
      userHome: "/Users/real",
      platform: "darwin",
      env: { HOME: "/Users/real" },
      exists: (p) => p === `/Users/real/${AGY_MACOS_LOGIN_KEYCHAIN_REL}`,
    });
    expect(env).toEqual({});
  });

  it("respects an explicit caller value for AGY_CLI_FORCE_FILE_TOKEN_STORAGE", () => {
    const env = agyIsolatedHomeEnv({
      userHome: "/tmp/isolated-home",
      platform: "darwin",
      env: { HOME: "/tmp/isolated-home", [AGY_FORCE_FILE_TOKEN_STORAGE_ENV]: "0" },
      exists: () => false,
    });
    expect(env).toEqual({});
  });

  it.each(["linux", "win32"] as const)("returns empty env on %s", (platform) => {
    expect(
      agyIsolatedHomeEnv({
        userHome: "/tmp/isolated-home",
        platform,
        env: {},
        exists: () => false,
      }),
    ).toEqual({});
  });
});
