// Vega-Lite 的安全层（docs/charts-diagrams-design.md 第 2.3 节）：agent 写的规格不能发请求、不能带链接、不能拉外部图片。
// 三道：规格检查（出错能给用户一句明白话）、loader（vega 真去加载时一律拒绝）、缓存 SVG 的清洗。不 import vega，本身很小。

/** 规格不合规：消息直接显示在图块上方那一行。 */
class ChartSpecError extends Error {}

/** 这些键的子树是数据行（用户的数据列可以叫 url、href），不当规格检查。 */
const DATA_KEYS = new Set(["values", "datasets"]);

/** 把源码解析成规格对象；usermeta 整个丢掉（vega-embed 会读 usermeta.embedOptions：打开菜单、指向外部配置、改 loader）。 */
export function parseVegaLiteSource(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ChartSpecError(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ChartSpecError("Vega-Lite 规格必须是一个 JSON 对象");
  const { usermeta: _usermeta, ...spec } = parsed as Record<string, unknown>;
  checkVegaLiteSpec(spec);
  return spec;
}

const isImageMark = (mark: unknown) => mark === "image" || (typeof mark === "object" && mark !== null && (mark as { type?: unknown }).type === "image");

/** 拒绝：data.url（任何位置的字符串 url）、href（通道或 mark 属性）、图片 mark、把输入控件绑到页面元素（bind.element）。用显式栈遍历，嵌套再深也不爆栈。 */
export function checkVegaLiteSpec(spec: unknown): void {
  const stack: { node: unknown; parentKey: string }[] = [{ node: spec, parentKey: "" }];
  while (stack.length > 0) {
    const { node, parentKey } = stack.pop()!;
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, parentKey });
      continue;
    }
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYS.has(key)) continue;
      if (key === "url" && typeof value === "string") throw new ChartSpecError("不支持 data.url：数据只能写在 data.values 里");
      if (key === "href") throw new ChartSpecError("不支持 href 链接");
      if (key === "mark" && isImageMark(value)) throw new ChartSpecError("不支持图片 mark：不加载外部图片");
      if (key === "element" && parentKey === "bind") throw new ChartSpecError("不支持 bind.element：输入控件不能放进页面其他位置");
      stack.push({ node: value, parentKey: key });
    }
  }
}

/** vega-embed 的 `loader` 选项：vega 里所有加载（data.url、图片、href、配置文件）都走它，这里一律拒绝。 */
export interface BlockedLoader {
  load(uri: string, options?: unknown): Promise<never>;
  sanitize(uri: string, options?: unknown): Promise<never>;
  http(uri: string, options?: unknown): Promise<never>;
  file(filename: string): Promise<never>;
}

export function blockedLoader(): BlockedLoader {
  const deny = () => Promise.reject(new ChartSpecError("图表里不允许加载外部资源"));
  return { load: deny, sanitize: deny, http: deny, file: deny };
}

/** 白名单之外的元素：脚本、内嵌 HTML、链接、图片、引用。Vega 的 SVG 里本来没有这些。 */
const BLOCKED_SELECTOR = "script, foreignObject, a, image, use, iframe, object, embed, animate, set";

/** 缓存的 SVG 字符串以后是用 innerHTML 插回页面的：先解析，去掉不该有的元素、事件属性、链接，再序列化。解析失败就抛，不原样放行。 */
export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() === "parsererror" || doc.querySelector("parsererror") !== null || root.tagName !== "svg") throw new ChartSpecError("SVG 解析失败");
  for (const el of root.querySelectorAll(BLOCKED_SELECTOR)) el.remove();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "href" || name.endsWith(":href") || attr.value.trim().toLowerCase().startsWith("javascript:")) el.removeAttribute(attr.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}
