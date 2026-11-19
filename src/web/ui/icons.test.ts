import { describe, it } from "vitest";

describe("图标出口", () => {
  it.todo("除 ComposerAdd、ComposerSend 外，每个导出都渲染成一个 crispEdges、fill=currentColor 的 <svg>，没有 stroke、渐变和 <image>");
  it.todo("ComposerAdd、ComposerSend 是 stroke=currentColor 的线条图标，没有 crispEdges");
  it.todo("不传 aria-label 时 aria-hidden；传了 aria-label 时读屏念它");
  it.todo("className 原样带到 <svg> 上，传 strokeWidth 不报错也不改样子");
  it.todo("src/web 里除这个文件外没有 lucide-react、pixelarticons 的 import（守卫）");
});
