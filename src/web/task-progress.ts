import type { TaskGraph } from "../shared/index.ts";
import type { JellyColor, SlimePath } from "../shared/slimes.ts";

/**
 * 前置：graph 至少有一步。
 * 后置：每一步在图标里占一块，颜色看状态：做完（done）主色 blob，在干（running）浅一档的主色，等你拍板（waiting + user）强调色 accent，
 * 等项目经理（waiting + pm）琥珀色，没轮到和跳过只留轮廓。同一连通子图同层并行的步骤并排分一块。
 * 步数再多也画在同一个 10×10 格里，不越界；同样的输入每次返回同一个数组。
 */
export function taskProgressPaths(graph: Pick<TaskGraph, "nodes" | "edges">, color: JellyColor): readonly SlimePath[] {
  throw new Error("未实现");
}
