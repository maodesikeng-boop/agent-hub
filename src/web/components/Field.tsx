import { useId } from "react";

/** 表单里“标签 + 控件”的一组；控件通过 render 参数拿到要绑的 id。 */
export function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[13.5px] font-medium">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
