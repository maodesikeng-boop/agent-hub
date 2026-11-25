import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { expect, it } from "vitest";
import { ShellCarryScope, useShellCarry } from "./shell-carry.tsx";

function Field() {
  const [value, setValue] = useShellCarry("test:field", "");
  return <input aria-label="Field" value={value} onChange={(e) => setValue(e.target.value)} />;
}

/** Mounts its children one render later, as a dialog portal does. */
function Portal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => setMounted(true), []);
  return mounted ? children : null;
}

/** Two shells with different trees, like the workbench's one-column and multi-column shells. */
function Workbench({ shell, field = true }: { shell: "one" | "multi"; field?: boolean }) {
  return (
    <ShellCarryScope key={shell}>
      {shell === "one" ? <main>{field && <Field />}</main> : <Portal>{field && <Field />}</Portal>}
    </ShellCarryScope>
  );
}

const type = (value: string) => fireEvent.change(screen.getByRole("textbox", { name: "Field" }), { target: { value } });
const field = () => screen.queryByRole("textbox", { name: "Field" });

it("carries the value into the other shell's tree when the shells swap, also behind a portal", () => {
  const { rerender } = render(<Workbench shell="multi" />);
  type("half-typed");
  rerender(<Workbench shell="one" />);
  expect(field()).toHaveValue("half-typed");
  rerender(<Workbench shell="multi" />);
  expect(field()).toHaveValue("half-typed");
});

it("starts from the initial value after a remount inside one shell, and a later swap does not bring an unmounted value back", async () => {
  const { rerender } = render(<Workbench shell="multi" />);
  type("closed form");
  rerender(<Workbench shell="multi" field={false} />);
  rerender(<Workbench shell="multi" />);
  expect(field()).toHaveValue("");

  type("closed again");
  rerender(<Workbench shell="multi" field={false} />);
  await act(async () => {});
  rerender(<Workbench shell="one" />);
  expect(field()).toHaveValue("");
});

it("is plain state outside a shell scope", () => {
  const { rerender, unmount } = render(<Field />);
  type("alone");
  rerender(<Field />);
  expect(field()).toHaveValue("alone");
  unmount();
  render(<Field />);
  expect(field()).toHaveValue("");
});
