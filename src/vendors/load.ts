export type VendorDaemonFile = "daemon.ts" | "paths.ts";

export function importVendorFile(id: string, file: VendorDaemonFile): Promise<unknown> {
  // Keep the extension in the template's static part for vite dynamic-import-vars.
  return file === "daemon.ts" ? import(`./${id}/daemon.ts`) : import(`./${id}/paths.ts`);
}
