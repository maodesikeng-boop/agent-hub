// 预览窗里的 CSV / TSV：只解析，不依赖库。引号里的分隔符、换行、"" 转义都认。

/**
 * 返回表头加前 maxRows 行数据（rows），和数据总行数 total（不含表头）。
 * 超过 maxRows 的行只数个数、不存，大文件不会占很多内存。空行（整行没有内容）跳过。
 */
export function parseCsv(text: string, delimiter: string, maxRows: number): { rows: string[][]; total: number } {
  const rows: string[][] = [];
  let count = 0;
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") {
      if (count <= maxRows) rows.push(row);
      count++;
    }
    row = [];
    field = "";
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    started = true;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n") endRow();
    else if (c !== "\r") field += c;
  }
  if (started) endRow();
  return { rows, total: Math.max(0, count - 1) };
}
