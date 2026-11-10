// 守护进程按约定路径加载各家文件夹里的文件（docs/vendor-plugin-design.md 3.4 节，拍板点 2 的 A）：名单只在 registry.ts，
// 守护进程侧不另登记。只有这一个函数知道“厂商文件夹在哪”，测试里加假厂商（acme 在 test/fixtures/vendors/）只 mock 它。

/** 守护进程侧每家都有的文件：daemon.ts（驱动等，见 daemon-types.ts 的 VendorDaemon）、paths.ts（只给守护进程的路径）。 */
export type VendorDaemonFile = "daemon.ts" | "paths.ts";

/** 加载 src/vendors/<id>/<file>。 */
export function importVendorFile(id: string, file: VendorDaemonFile): Promise<unknown> {
  // 扩展名写在模板的静态部分（vite 的 dynamic-import-vars 要求，vitest 也按它解析）
  return file === "daemon.ts" ? import(`./${id}/daemon.ts`) : import(`./${id}/paths.ts`);
}
