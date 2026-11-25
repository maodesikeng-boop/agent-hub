import assert from "node:assert/strict";
import type { Browser, Page } from "playwright";
import { API_PATHS, type DevicesResponse } from "../src/shared/index.ts";
import { VERIFY_SMOKE_STEP_TIMEOUT_MS } from "../src/shared/limits.ts";

const DESKTOP_LONG_NAME = "Yuxin Zhang's MacBook Pro";
const MOBILE_LONG_NAME = "Yuxin Zhang's MacBook Pro (16-inch, Engineering Studio)";
const MOCK_PEER_ID = "0b8e7c2a-6a51-4c1e-9d3f-5a7e00000099";
const MIN_HEADER_GAP_PX = 8;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface HeaderMeasurement {
  header: Box;
  trigger: Box;
  label: Box & { scrollWidth: number; clientWidth: number; textOverflow: string };
  chevron: Box | null;
  plus: Box;
}

interface BrowserElement {
  scrollWidth: number;
  clientWidth: number;
  getBoundingClientRect(): Box;
  querySelector(selector: string): BrowserElement | null;
}

interface BrowserGlobal {
  document: {
    fonts: { ready: Promise<unknown> };
    querySelector(selector: string): BrowserElement | null;
  };
  getComputedStyle(el: BrowserElement): { textOverflow: string };
  localStorage: { setItem(key: string, value: string): void; removeItem(key: string): void };
}

async function measureListHeader(page: Page, computerName: string, switchable: boolean): Promise<HeaderMeasurement> {
  return page.evaluate(
    async ({ name, isSwitchable }) => {
      const g = globalThis as unknown as BrowserGlobal;
      await g.document.fonts.ready;
      const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const section = g.document.querySelector(`section[aria-label="${escaped}"]`);
      if (section === null) throw new Error(`ProjectList section not found for "${name}"`);
      const header = section.querySelector("header");
      if (header === null) throw new Error("ProjectList header not found");
      const plus = header.querySelector('button[aria-label="New project manager"]');
      const trigger = isSwitchable
        ? header.querySelector(`button[aria-label="Switch computer (${escaped})"]`)
        : header.querySelector("h1");
      if (plus === null || trigger === null) {
        throw new Error(`Missing header control: trigger=${trigger !== null}, plus=${plus !== null}`);
      }
      const label = isSwitchable ? trigger.querySelector("span") : trigger;
      if (label === null) throw new Error("Missing computer name label");
      const chevron = isSwitchable ? trigger.querySelector("svg") : null;
      const box = (el: BrowserElement): Box => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      return {
        header: box(header),
        trigger: box(trigger),
        label: {
          ...box(label),
          scrollWidth: label.scrollWidth,
          clientWidth: label.clientWidth,
          textOverflow: g.getComputedStyle(label).textOverflow,
        },
        chevron: chevron === null ? null : box(chevron),
        plus: box(plus),
      };
    },
    { name: computerName, isSwitchable: switchable },
  );
}

function assertHeaderGeometry(label: string, m: HeaderMeasurement, switchable: boolean): void {
  const gap = m.plus.left - m.trigger.right;
  assert.ok(m.trigger.left >= m.header.left - 0.5, `${label}: trigger left (${m.trigger.left}) overflows header (${m.header.left})`);
  assert.ok(m.trigger.right <= m.header.right + 0.5, `${label}: trigger right (${m.trigger.right}) overflows header (${m.header.right})`);
  assert.ok(gap >= MIN_HEADER_GAP_PX, `${label}: trigger overlaps or crowds New PM button (gap=${gap.toFixed(1)}px)`);
  assert.ok(m.plus.width >= 26, `${label}: New PM button shrank to ${m.plus.width.toFixed(1)}px`);
  assert.ok(m.plus.right <= m.header.right + 0.5, `${label}: New PM button overflows header (${m.plus.right} > ${m.header.right})`);
  assert.equal(m.label.textOverflow, "ellipsis", `${label}: label missing text-overflow: ellipsis`);
  assert.ok(
    m.label.scrollWidth > m.label.clientWidth + 1,
    `${label}: long computer name did not truncate (scrollWidth=${m.label.scrollWidth}, clientWidth=${m.label.clientWidth})`,
  );
  if (switchable) {
    assert.ok(m.chevron !== null, `${label}: switchable header missing ChevronDown`);
    assert.ok(m.chevron.width >= 10 && m.chevron.height >= 10, `${label}: ChevronDown collapsed (${m.chevron.width}x${m.chevron.height})`);
    assert.ok(m.chevron.left >= m.label.right - 0.5, `${label}: ChevronDown overlaps computer name text`);
    assert.ok(m.chevron.right <= m.trigger.right + 0.5, `${label}: ChevronDown overflows trigger (${m.chevron.right} > ${m.trigger.right})`);
    assert.ok(m.chevron.right < m.plus.left, `${label}: ChevronDown overlaps New PM button`);
  }
}

async function installMockDevices(
  page: Page,
  origin: string,
  config: { name: string; switchable: boolean },
): Promise<void> {
  const devicesPattern = new RegExp(`^https?://[^/]+${API_PATHS.devices.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\?.*)?$`);
  await page.route(devicesPattern, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as DevicesResponse;
    const self = body.devices.find((d) => d.self) ?? body.devices[0]!;
    const devices = config.switchable
      ? [
          { ...self, name: config.name },
          {
            id: MOCK_PEER_ID as typeof self.id,
            name: "Tokyo Mini",
            platform: "darwin",
            self: false,
            online: true,
            link: null,
            fingerprint: null,
          },
        ]
      : [{ ...self, name: config.name }];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ devices }) });
  });
  // Proxy mock peer API calls to the local daemon and hold its WebSocket open so the page stays error-free.
  await page.route(/\/d\/[^/]+(\/api\/.*)$/, async (route) => {
    const url = new URL(route.request().url());
    const localPath = url.pathname.replace(/^\/d\/[^/]+/, "") + url.search;
    const res = await route.fetch({ url: `${origin}${localPath}` });
    await route.fulfill({ response: res });
  });
  await page.routeWebSocket(/\/d\/[^/]+\/api\/ws/, () => {});
}

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/**
 * Postcondition: a long computer name truncates with ellipsis and keeps ChevronDown fully inside the header trigger with
 * positive clearance before the shrink-0 New PM button at default desktop width, narrow minimum desktop width (both
 * resting and hovered), single-device mode, and mobile page layout.
 */
export async function verifyProjectListHeader(browser: Browser, loginUrl: string, origin: string): Promise<void> {
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await desktop.newPage();
    const errors = trackPageErrors(page);
    const config = { name: DESKTOP_LONG_NAME, switchable: true };
    await installMockDevices(page, origin, config);
    await page.goto(loginUrl);
    await page.waitForURL(`${origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.locator("#root textarea").first().waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.locator('nav[aria-label="Workspace"] button:has([data-testid^="rail-device-dot-"])').first().click({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    const switchBtn = page.getByRole("button", { name: `Switch computer (${DESKTOP_LONG_NAME})` });
    await switchBtn.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });

    assertHeaderGeometry("desktop switchable default (rest)", await measureListHeader(page, DESKTOP_LONG_NAME, true), true);
    await switchBtn.hover();
    assertHeaderGeometry("desktop switchable default (hover)", await measureListHeader(page, DESKTOP_LONG_NAME, true), true);

    await page.evaluate(() => {
      (globalThis as unknown as BrowserGlobal).localStorage.setItem("agent-hub.paneWidths", JSON.stringify({ list: 13.75 }));
    });
    await page.reload();
    await switchBtn.waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assertHeaderGeometry("desktop switchable narrow (rest)", await measureListHeader(page, DESKTOP_LONG_NAME, true), true);
    await switchBtn.hover();
    assertHeaderGeometry("desktop switchable narrow (hover)", await measureListHeader(page, DESKTOP_LONG_NAME, true), true);

    config.switchable = false;
    await page.reload();
    await page.getByRole("heading", { name: DESKTOP_LONG_NAME }).waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assertHeaderGeometry("desktop single-device narrow", await measureListHeader(page, DESKTOP_LONG_NAME, false), false);
    assert.deepEqual(errors, [], `Desktop header check hit page errors: ${errors.join("; ")}`);
  } finally {
    await desktop.close();
  }

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const page = await mobile.newPage();
    const errors = trackPageErrors(page);
    await installMockDevices(page, origin, { name: MOBILE_LONG_NAME, switchable: true });
    await page.goto(loginUrl);
    await page.waitForURL(`${origin}/`, { timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    await page.getByRole("button", { name: `Switch computer (${MOBILE_LONG_NAME})` }).waitFor({ timeout: VERIFY_SMOKE_STEP_TIMEOUT_MS });
    assertHeaderGeometry("mobile switchable", await measureListHeader(page, MOBILE_LONG_NAME, true), true);
    assert.deepEqual(errors, [], `Mobile header check hit page errors: ${errors.join("; ")}`);
  } finally {
    await mobile.close();
  }
}
