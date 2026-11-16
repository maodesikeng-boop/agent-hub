// 卡片下面的交付物（shared/deliverables.ts）：对话里的提问卡、右栏的门禁卡、总助的拍板卡和简报都用这一个组件，界面规则见 docs/ui-standard.md 第 22 条。
import type { Deliverable } from "../../shared/index.ts";

/**
 * 文档类一行蓝色文件链接（图标 + 标签），图片和视频一行 96px 高的缩略图（视频盖播放键），点任何一个都打开预览窗（FilePreview）：
 * 图片看大图，视频用原生播放器播，md 渲染，pdf、html 内联。副本被清理了（取文件 404）显示“文件已过期”，不留破图。
 * 文件地址按外层 DeviceScope 的设备取（别的设备的条目要包在那台设备的 DeviceScope 里）。
 * deliverables 为空时什么都不渲染。
 */
export function DeliverableFiles({ deliverables }: { deliverables: readonly Deliverable[] }): React.ReactNode {
  throw new Error("未实现");
}
