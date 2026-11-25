import { describe, it } from "vitest";

describe("nodeWorkStatusOf", () => {
  it.todo("maps done and skipped steps to done");
  it.todo("maps running steps and steps waiting on the PM to running");
  it.todo("maps steps waiting on the user to waiting");
  it.todo("maps pending steps to pending");
});

describe("workerWorkStatusOf", () => {
  it.todo("maps an ended Worker to done");
  it.todo("maps an idle Worker whose last report has status problem to waiting");
  it.todo("maps any other live Worker to running");
});

describe("completedWorkStatusOf", () => {
  it.todo("maps a cancelled outcome to cancelled and a done outcome to done");
});

describe("graphProgressOf", () => {
  it.todo("counts done and skipped steps over all steps");
  it.todo("returns 0/0 for a graph with no steps");
});
