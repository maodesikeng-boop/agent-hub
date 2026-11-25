import { describe, it } from "vitest";

// Acceptance scenarios from docs/system-wakeup-turns-design.md, rendered through MessageList with real message sequences.
describe("turn cards across turns and system wakeups", () => {
  it.todo("S1: two turns that both list steps; the second card shows only its own steps, the first card still shows its three");
  it.todo("S2: a step left unfinished in the first turn appears in the second card; steps the first turn completed do not");
  it.todo("S3: a task graph wakeup queued during a running turn keeps the card running, keeps Worked for counting from the user message, and shows a left-aligned Task graph row below the card (investigation repro: wakeup closes the running group)");
  it.todo("S3: once the PM takes the queued wakeup as a new turn, the row sits right before the new card and the new card's timer starts there");
  it.todo("S4: a wakeup taken mid-turn shows inside the running card and does not close it");
  it.todo("S5: a task graph or Router wakeup never renders as a right-aligned user bubble; it renders as a collapsed Task graph or Router row that expands to the full text");
  it.todo("S6: a Worker report arriving during a running PM turn keeps the card running and shows the report below it until the PM takes it in");
  it.todo("S7: a vendor without checklist events shows only the action line while running and Worked for after the turn, with no empty list");
  it.todo("S8: a user message sent during a running turn still renders as a right-aligned bubble and starts a new card, as before");
});
