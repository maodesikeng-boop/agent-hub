import { describe, it } from "vitest";
import { Surface, SurfaceOutlet, SurfaceScope } from "./shell-surfaces.tsx";
import { WorkbenchSurfaces } from "./WorkbenchSurfaces.tsx";

describe(`${SurfaceScope.name}, ${Surface.name}, and ${SurfaceOutlet.name}`, () => {
  it.todo("keeps typed input and the same DOM element when the outlet moves to another layout");
  it.todo("keeps state while no outlet shows the surface, and shows it again unchanged");
  it.todo("stops the surface's effects while it is hidden and restarts them when an outlet shows it");
  it.todo("runs a surface's first layout effects with its element attached");
  it.todo("returns focus to the focused element after a move");
  it.todo("remounts the surface's children only when the Surface's key changes");
  it.todo("drops every element when the SurfaceScope unmounts");
});

describe(WorkbenchSurfaces.name, () => {
  it.todo("renders each surface in the set once, keyed by the set's keys");
  it.todo("rerenders surfaces in place when the layout or chrome changes");
  it.todo("passes the layout to surfaces only as props such as mobile");
});
