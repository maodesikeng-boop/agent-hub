export type VendorDaemonFile = "daemon.ts" | "paths.ts";

export function importVendorFile(id: string, file: VendorDaemonFile): Promise<unknown> {
  // @vite-ignore keeps Vite's dynamic-import-vars from baking the vendor directory list into cached transforms.
  return import(/* @vite-ignore */ `./${id}/${file}`);
}
