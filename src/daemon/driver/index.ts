// 驱动层通用部分的出口。各家的驱动（实现 src/shared/driver.ts 的 Driver）在 src/vendors/<厂商>/driver.ts，
// 守护进程经 daemon/vendors/index.ts 的 createVendorDrivers 按名单建。
export { createModelCatalogs, type ModelCatalogs } from "./model-catalog.ts";
export { createMultiVendorDriver } from "./multi-driver.ts";
