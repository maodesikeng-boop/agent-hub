import { createContext, useContext, useState } from "react";
import { accentStyle } from "./palette.ts";

/** 弹窗这类浮层默认渲染到 body 上，不在会话的容器里；让它们渲染进这个容器，强调色才跟着。 */
const AccentContainer = createContext<HTMLElement | null>(null);
export const useAccentContainer = () => useContext(AccentContainer);

/**
 * 一个项目经理的会话（对话、它的 Worker 的对话、资料页、右栏）：在外层设好 `--primary` 和 `--primary-foreground`，
 * 里面的组件照常写 `bg-primary`。`display: contents` 不影响布局。colorKey 为 null：不设，沿用中性色。
 */
export function AccentScope({ colorKey, children }: { colorKey: number | null; children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div ref={setEl} data-accent={colorKey === null ? undefined : ""} className="contents" style={colorKey === null ? undefined : accentStyle(colorKey)}>
      <AccentContainer.Provider value={el}>{children}</AccentContainer.Provider>
    </div>
  );
}
