// 底部抽屉（ui/drawer.tsx，底层 vaul）：只在测试里用的抽屉，能打开、Esc 关、点遮罩关、点关闭按钮关。
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "./drawer.tsx";

const user = userEvent.setup();

function TestDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开
      </button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerTitle className="sr-only">Pieces</DrawerTitle>
          <DrawerClose>收起</DrawerClose>
        </DrawerContent>
      </Drawer>
    </>
  );
}

const overlay = () => document.querySelector<HTMLElement>('[data-slot="drawer-overlay"]');

describe("底部抽屉 Drawer", () => {
  // jsdom 没有指针捕获，vaul 在按下遮罩、内容时会调
  beforeAll(() => {
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
  });

  it("点按钮打开，读屏标题是 Pieces", async () => {
    render(<TestDrawer />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByRole("dialog", { name: "Pieces" })).toBeTruthy();
  });

  it("Esc 关", async () => {
    render(<TestDrawer />);
    await user.click(screen.getByRole("button", { name: "打开" }));
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("点遮罩关", async () => {
    render(<TestDrawer />);
    await user.click(screen.getByRole("button", { name: "打开" }));
    await screen.findByRole("dialog");
    const el = overlay();
    expect(el).not.toBeNull();
    // vaul 的遮罩靠 pointerdown / pointerup 判断是点击还是拖动，userEvent.click 会一并发出
    await user.click(el!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("DrawerClose 关", async () => {
    render(<TestDrawer />);
    await user.click(screen.getByRole("button", { name: "打开" }));
    await user.click(await screen.findByRole("button", { name: "收起" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
