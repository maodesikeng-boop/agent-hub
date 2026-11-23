import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_MESH_PORT, MESH_LISTEN_PORT } from "../../shared/limits.ts";
import { meshListenPort } from "./listen-port.ts";

describe("meshListenPort", () => {
  it("uses FUSA_MESH_PORT when it is an integer in 0..65535", () => {
    expect(meshListenPort({ [ENV_MESH_PORT]: "4421" }, 4417)).toBe(4421);
    expect(meshListenPort({ [ENV_MESH_PORT]: "0" }, 4417)).toBe(0);
    expect(meshListenPort({ [ENV_MESH_PORT]: "65535" }, 0)).toBe(65_535);
  });

  it("throws RangeError for a non-integer, negative, or too large FUSA_MESH_PORT", () => {
    for (const raw of ["abc", "4421.5", "-1", "65536", "44 21", "0x10"]) {
      expect(() => meshListenPort({ [ENV_MESH_PORT]: raw }, 4417), raw).toThrow(RangeError);
    }
  });

  it("falls back to 0 when the UI port is 0 and FUSA_MESH_PORT is unset", () => {
    expect(meshListenPort({}, 0)).toBe(0);
    expect(meshListenPort({ [ENV_MESH_PORT]: "" }, 0)).toBe(0);
  });

  it("falls back to MESH_LISTEN_PORT otherwise", () => {
    expect(meshListenPort({}, 4317)).toBe(MESH_LISTEN_PORT);
  });

  it("is what the daemon passes to the mesh listener", () => {
    const daemon = readFileSync(new URL("../daemon.ts", import.meta.url), "utf8");
    expect(daemon).toContain("listenPort: meshOptions.listenPort ?? meshListenPort(env, port)");
    expect(daemon).not.toContain("MESH_LISTEN_PORT");
  });
});
