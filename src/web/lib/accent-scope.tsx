import { createContext, useContext, useState } from "react";
import type { JellyColorId } from "../../shared/slimes.ts";
import { accentStyleOf } from "./palette.ts";

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
