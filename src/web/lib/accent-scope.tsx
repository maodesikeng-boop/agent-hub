import { createContext, useContext } from "react";
import type { JellyColorId } from "../../shared/slimes.ts";
import { accentStyleOf } from "./palette.ts";

const AccentColor = createContext<JellyColorId | null>(null);
export const useAccentColor = () => useContext(AccentColor);

export function AccentScope({ color, children }: { color: JellyColorId | null; children: React.ReactNode }) {
  return (
    <div data-accent={color === null ? undefined : ""} className="contents" style={color === null ? undefined : accentStyleOf(color)}>
      <AccentColor.Provider value={color}>{children}</AccentColor.Provider>
    </div>
  );
}
