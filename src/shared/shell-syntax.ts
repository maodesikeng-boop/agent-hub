// 把 shell 命令解析成语法树：tree-sitter-bash（Codex 认命令也用它）。解析不了的地方是 ERROR 节点，不抛错。
// 语法文件是 wasm，模块加载时初始化一次，之后 parse 是同步的，能在账本事务里用。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";

export type ShellNode = Node;

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(readFileSync(fileURLToPath(import.meta.resolve("tree-sitter-bash/tree-sitter-bash.wasm")))));

/** 解析 script，把根节点交给 visit；树在 wasm 内存里，用完就释放，visit 之外不要留节点。 */
export function withShellTree<T>(script: string, visit: (root: ShellNode) => T): T | null {
  const tree = parser.parse(script);
  if (tree === null) return null;
  try {
    return visit(tree.rootNode);
  } finally {
    tree.delete();
  }
}
