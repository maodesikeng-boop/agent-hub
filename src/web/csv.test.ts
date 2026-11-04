import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";

describe("parseCsv", () => {
  it("逗号分隔、换行分行，末尾的空行不算", () => {
    expect(parseCsv("a,b\n1,2\n3,4\n", ",", 10)).toEqual({ rows: [["a", "b"], ["1", "2"], ["3", "4"]], total: 2 });
  });

  it("TSV：按制表符分", () => {
    expect(parseCsv("a\tb\n1\t2", "\t", 10).rows).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("双引号：里面的逗号、换行、转义的双引号都算内容；\\r\\n 当换行", () => {
    expect(parseCsv('名字,说明\r\n"张,三","第一行\n第二行"\r\n"他说""好""",x', ",", 10).rows).toEqual([
      ["名字", "说明"],
      ["张,三", "第一行\n第二行"],
      ['他说"好"', "x"],
    ]);
  });

  it("只留表头 + 前 maxRows 行数据，total 是数据总行数（不含表头）", () => {
    const text = ["h", ...Array.from({ length: 2500 }, (_, i) => String(i))].join("\n");
    const result = parseCsv(text, ",", 1000);
    expect(result.rows).toHaveLength(1001);
    expect(result.rows[1]).toEqual(["0"]);
    expect(result.rows[1000]).toEqual(["999"]);
    expect(result.total).toBe(2500);
  });

  it("空文件：没有行", () => {
    expect(parseCsv("", ",", 10)).toEqual({ rows: [], total: 0 });
  });

  it("只有表头：total 0", () => {
    expect(parseCsv("a,b", ",", 10)).toEqual({ rows: [["a", "b"]], total: 0 });
  });
});
