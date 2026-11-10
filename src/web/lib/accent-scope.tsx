import { createContext, useContext, useState } from "react";
import { accentStyle, tintStyle } from "./palette.ts";

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

/**
 * 整个外壳（左栏 + 会话）的水果底色（docs/ui-standard.md 第 4 条“外壳底色”）：只设 `--fruit`，styles.css 据此算出
 * `bg-surface-chat`、`bg-surface-sidebar`、`border-line` 的颜色，组件里不各写各的。左栏也在里面，但 `--primary` 不变（那是 AccentScope 的事）。
 * colorKey 为 null（没有打开的项目经理）：不设，底色退回中性。
 */
export function FruitTint({ colorKey, children }: { colorKey: number | null; children: React.ReactNode }) {
  return (
    <div data-fruit={colorKey === null ? undefined : ""} className="contents" style={colorKey === null ? undefined : tintStyle(colorKey)}>
      {children}
    </div>
  );
}
