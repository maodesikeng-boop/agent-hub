import { createContext, useContext, useState } from "react";
import type { JellyColorId } from "../../shared/slimes.ts";
import { accentStyleOf, tintStyleOf } from "./palette.ts";

const AccentContainer = createContext<HTMLElement | null>(null);
export const useAccentContainer = () => useContext(AccentContainer);

export function AccentScope({ color, children }: { color: JellyColorId | null; children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div ref={setEl} data-accent={color === null ? undefined : ""} className="contents" style={color === null ? undefined : accentStyleOf(color)}>
      <AccentContainer.Provider value={el}>{children}</AccentContainer.Provider>
    </div>
  );
}

export function FruitTint({ color, children }: { color: JellyColorId | null; children: React.ReactNode }) {
  return (
    <div data-fruit={color === null ? undefined : ""} className="contents" style={color === null ? undefined : tintStyleOf(color)}>
      {children}
    </div>
  );
}
