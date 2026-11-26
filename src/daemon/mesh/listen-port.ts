import { ENV_MESH_PORT, MESH_LISTEN_PORT } from "../../shared/limits.ts";

const MAX_PORT = 65_535;

/**
 * Picks the port of the mesh LAN listener so a second daemon on the same computer, such as a test instance, cannot take
 * the default port from the user's daemon.
 * Postcondition: the integer in FUSA_MESH_PORT when set (0 asks the OS for a free port); otherwise 0 when the UI port is 0,
 * else MESH_LISTEN_PORT. Throws RangeError for a value that is not an integer in 0..65535, so a typo never falls back to the default port.
 */
export function meshListenPort(env: Readonly<Record<string, string | undefined>>, uiPort: number): number {
  const raw = env[ENV_MESH_PORT];
  if (raw === undefined || raw === "") return uiPort === 0 ? 0 : MESH_LISTEN_PORT;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || value > MAX_PORT) throw new RangeError(`${ENV_MESH_PORT} must be an integer from 0 to ${MAX_PORT}: ${raw}`);
  return value;
}
