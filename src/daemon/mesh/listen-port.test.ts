import { describe, it } from "vitest";

describe("meshListenPort", () => {
  it.todo("uses FUSA_MESH_PORT when it is an integer in 0..65535");
  it.todo("throws RangeError for a non-integer, negative, or too large FUSA_MESH_PORT");
  it.todo("falls back to 0 when the UI port is 0 and FUSA_MESH_PORT is unset");
  it.todo("falls back to MESH_LISTEN_PORT otherwise");
  it.todo("is what the daemon passes to the mesh listener");
});
