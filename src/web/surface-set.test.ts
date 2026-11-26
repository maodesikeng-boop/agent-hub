import { expect, it } from "vitest";
import { surfaceSetOf } from "./surface-set.ts";
import type { WorkbenchNav } from "./workbench-nav.ts";

const keys = { conversationKey: "pm-conversation", panelKey: "pm", workerKey: "worker", managed: true };

it("keeps the keys for the page under settings", () => {
  const page: WorkbenchNav["page"] = { view: "worker", id: 5 };
  const bare = surfaceSetOf({ nav: { page, settings: null }, ...keys });
  expect(bare).toEqual({ router: false, conversation: "pm-conversation", panel: "pm", worker: "worker", settings: [] });
  expect(surfaceSetOf({ nav: { page, settings: { section: "capabilities" } }, ...keys })).toEqual({ ...bare, settings: ["capabilities"] });
});

it("keeps the Router available for its route and for the default page", () => {
  expect(surfaceSetOf({ nav: { page: null, settings: null }, ...keys }).router).toBe(true);
  expect(surfaceSetOf({ nav: { page: { view: "router" }, settings: { section: "resources" } }, ...keys }).router).toBe(true);
});

it("selects a single settings body for both layouts' presentations", () => {
  for (const [section, surface] of [["capabilities", "capabilities"], ["resources", "resources"], ["computers", "account"], ["providers", "providers"], ["vendor-sync", "providers"]] as const) {
    expect(surfaceSetOf({ nav: { page: null, settings: { section } }, ...keys }).settings).toEqual([surface]);
  }
  expect(surfaceSetOf({ nav: { page: null, settings: { section: "computers" } }, ...keys, managed: false }).settings).toEqual([]);
});
