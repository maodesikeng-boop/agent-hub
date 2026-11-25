import { describe, it } from "vitest";
import { takenInputOf } from "./taken-input.ts";

describe(takenInputOf.name, () => {
  it.todo("returns the stamp for a pm.wakeup system message with a well-formed meta.taken");
  it.todo("returns the stamp for a Worker report line taken in by the PM");
  it.todo("returns null for user and pm senders even when meta.taken is present");
  it.todo("returns null when meta.taken is missing, has a non-integer afterId, or a non-boolean midTurn");
});
