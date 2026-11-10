// 假厂商 acme 只给守护进程用的路径（同 src/vendors/<id>/paths.ts）。
import type { VendorPathsModule } from "../../../../src/vendors/daemon-types.ts";

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ linuxInstallDirs, join }) => linuxInstallDirs.map((dir) => join(dir, "acme"));
