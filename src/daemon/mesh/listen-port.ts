/**
 * Picks the port of the mesh LAN listener so a second daemon on the same computer, such as a test instance, cannot take
 * the default port from the user's daemon.
 * Postcondition: the integer in FUSA_MESH_PORT when set (0 asks the OS for a free port); otherwise 0 when the UI port is 0,
 * else MESH_LISTEN_PORT. Throws RangeError for a value that is not an integer in 0..65535, so a typo never falls back to the default port.
 */
export function meshListenPort(env: Readonly<Record<string, string | undefined>>, uiPort: number): number {
  throw new Error("Not implemented");
}
