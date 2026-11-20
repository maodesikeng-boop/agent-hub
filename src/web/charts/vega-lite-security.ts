class ChartSpecError extends Error {}

const DATA_KEYS = new Set(["values", "datasets"]);

export function parseVegaLiteSource(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ChartSpecError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new ChartSpecError("A Vega-Lite spec must be a JSON object");
  const { usermeta: _usermeta, ...spec } = parsed as Record<string, unknown>;
  checkVegaLiteSpec(spec);
  return spec;
}

const isImageMark = (mark: unknown) => mark === "image" || (typeof mark === "object" && mark !== null && (mark as { type?: unknown }).type === "image");

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
      if (key === "url" && typeof value === "string") throw new ChartSpecError("data.url is not supported; put the data in data.values");
      if (key === "href") throw new ChartSpecError("href links are not supported");
      if (key === "mark" && isImageMark(value)) throw new ChartSpecError("Image marks are not supported; external images are blocked");
      if (key === "element" && parentKey === "bind") throw new ChartSpecError("bind.element is not supported; inputs must stay inside the chart");
      stack.push({ node: value, parentKey: key });
    }
  }
}

export interface BlockedLoader {
  load(uri: string, options?: unknown): Promise<never>;
  sanitize(uri: string, options?: unknown): Promise<never>;
  http(uri: string, options?: unknown): Promise<never>;
  file(filename: string): Promise<never>;
}

export function blockedLoader(): BlockedLoader {
  const deny = () => Promise.reject(new ChartSpecError("Charts cannot load external resources"));
  return { load: deny, sanitize: deny, http: deny, file: deny };
}

const BLOCKED_SELECTOR = "script, foreignObject, a, image, use, iframe, object, embed, animate, set";

export function sanitizeSvg(svg: string): string {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.tagName.toLowerCase() === "parsererror" || doc.querySelector("parsererror") !== null || root.tagName !== "svg") throw new ChartSpecError("Invalid SVG");
  for (const el of root.querySelectorAll(BLOCKED_SELECTOR)) el.remove();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on") || name === "href" || name.endsWith(":href") || attr.value.trim().toLowerCase().startsWith("javascript:")) el.removeAttribute(attr.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}
