import { expect, it, vi } from "vitest";
import { mobileBack } from "./back.ts";

it("历史上一页不是父级时 replace 父级，不盲目后退", () => {
  history.replaceState({ hub: true, previous: "#/w/31" }, "", "/#/w/30");
  const back = vi.spyOn(history, "back");
  const replace = vi.fn();
  mobileBack({ view: "conversation", id: 1 }, replace);
  expect(back).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledWith({ view: "conversation", id: 1 });
  back.mockRestore();
});

it("历史上一页正好是父级时后退，不新增条目", () => {
  history.replaceState({ hub: true, previous: "" }, "", "/#/c/1");
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  const replace = vi.fn();
  mobileBack(null, replace);
  expect(back).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
  back.mockRestore();
});
