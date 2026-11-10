// claude 只给守护进程用的路径（docs/vendor-plugin-design.md 的 B5：原来在 spec.ts 里，网页也打包；P3 挪到这里）。
import type { VendorPathsModule } from "../daemon-types.ts";

// macOS 上只认 PATH（沿用原来的行为），别的系统看官方安装目录
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ platform, linuxInstallDirs, join }) => (platform === "darwin" ? [] : linuxInstallDirs.map((dir) => join(dir, "claude")));
