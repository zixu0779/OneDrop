import { readFileSync } from "node:fs";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const html = readFileSync("docs/index.html", "utf8");
const ipa =
  "https://github.com/zixu0779/OneDrop/releases/download/v1.2.0/OneDrop-1.2.0.ipa";
const source = {
  apps: [
    {
      bundleIdentifier: "com.sycamore.onedrop.beta",
      beta: true,
      versions: [{ downloadURL: "https://example.org/beta.ipa" }],
    },
    {
      bundleIdentifier: "com.sycamore.onedrop",
      versions: [{ downloadURL: ipa }],
    },
  ],
};
const fetchMock = vi.fn();
const copy = vi.fn();
const animate = vi.fn();
const cancelAnimation = vi.fn();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (selector: string) =>
  document.querySelector<HTMLElement>(selector)!.click();

beforeEach(() => {
  document.documentElement.innerHTML = html;
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  animate.mockReturnValue({
    finished: new Promise(() => {}),
    cancel: cancelAnimation,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  fetchMock.mockResolvedValue({ ok: true, json: async () => source });
  copy.mockResolvedValue(undefined);
  window.eval(document.querySelector("script")!.textContent!);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "animate");
  vi.resetAllMocks();
});

it("reveals the full source and copies it automatically, with repeat copy", async () => {
  click(".source-toggle");
  await settle();
  expect(
    document.querySelector<HTMLElement>("#livecontainer-source")!.hidden,
  ).toBe(false);
  expect(
    document.querySelector(".source-toggle")!.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(copy).toHaveBeenCalledWith("https://onedrop.sycamore.top/apps.json");
  expect(document.querySelector("#source-url")!.textContent!.trim()).toBe(
    "https://onedrop.sycamore.top/apps.json",
  );
  click("#copy-source");
  await settle();
  expect(copy).toHaveBeenCalledTimes(2);
  expect(document.querySelector("#copy-feedback")!.textContent).toBe("Copied");
  expect(document.querySelector<HTMLElement>("#copy-feedback")!.hidden).toBe(
    false,
  );
  expect(document.querySelector("#copy-announcement")!.textContent).toContain(
    "copied",
  );
  expect(animate).toHaveBeenCalledTimes(2);
  expect(cancelAnimation).toHaveBeenCalledTimes(1);
  expect(document.querySelector("#source-status")!.textContent).toBe("");
});

it("keeps the source visible and reports clipboard rejection or absence", async () => {
  copy.mockRejectedValue(new Error("Denied"));
  click(".source-toggle");
  await settle();
  expect(document.querySelector("#source-status")!.textContent).toContain(
    "Copy failed",
  );
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLElement>("#copy-feedback")!.hidden).toBe(
    true,
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  click("#copy-source");
  await settle();
  expect(
    document.querySelector<HTMLElement>("#livecontainer-source")!.hidden,
  ).toBe(false);
  expect(document.querySelector("#source-status")!.textContent).toContain(
    "copy the link manually",
  );
});

it("links directly to the stable IPA, ignoring beta", async () => {
  await settle();
  expect(document.querySelector("#download-ipa")!.getAttribute("href")).toBe(
    ipa,
  );
  expect(document.querySelector("#download-ipa-label")!.textContent).toBe(
    "Download IPA",
  );
  expect(document.querySelectorAll(".platform-download-icon")).toHaveLength(2);
  const actionIcons = document.querySelectorAll("svg.platform-action-icon");
  expect(actionIcons).toHaveLength(6);
  for (const icon of actionIcons) {
    expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon.getAttribute("stroke-width")).toBe("1.8");
    expect(icon.getAttribute("stroke-linecap")).toBe("round");
    expect(icon.getAttribute("stroke-linejoin")).toBe("round");
  }
  expect(document.querySelector("span.platform-action-icon")).toBeNull();
});

it.each([
  { ok: false },
  { ok: true, json: async () => ({ apps: [] }) },
  {
    ok: true,
    json: async () => ({
      apps: [
        {
          bundleIdentifier: "com.sycamore.onedrop",
          versions: [{ downloadURL: "javascript:alert(1)" }],
        },
      ],
    }),
  },
])("reports unusable feeds and can retry", async (response) => {
  await settle();
  document.querySelector("#download-ipa")!.removeAttribute("href");
  fetchMock.mockResolvedValueOnce(response);
  click("#download-ipa");
  await settle();
  expect(document.querySelector("#ipa-status")!.textContent).toContain(
    "Could not load",
  );
  expect(document.querySelector("#download-ipa-label")!.textContent).toBe(
    "Retry IPA download",
  );
  const icon = document.querySelector("#download-ipa svg");
  expect(icon).not.toBeNull();
  click("#download-ipa");
  expect(document.querySelector("#download-ipa-label")!.textContent).toBe(
    "Preparing IPA…",
  );
  expect(document.querySelector("#download-ipa svg")).toBe(icon);
  await settle();
  expect(document.querySelector("#download-ipa")!.getAttribute("href")).toBe(
    ipa,
  );
  expect(document.querySelector("#ipa-status")!.textContent).toBe("");
  expect(document.querySelector("#download-ipa svg")).toBe(icon);
});

it("closes the floating link on repeat click, outside click, and Escape", () => {
  const panel = document.querySelector<HTMLElement>("#livecontainer-source")!;
  const toggle = document.querySelector<HTMLElement>(".source-toggle")!;
  click(".source-toggle");
  expect(document.activeElement?.id).toBe("copy-source");
  click(".source-toggle");
  expect(panel.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  click(".source-toggle");
  document.body.click();
  expect(panel.hidden).toBe(true);
  click(".source-toggle");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(panel.hidden).toBe(true);
  expect(document.activeElement).toBe(toggle);
});

it("keeps the URL selectable plain text and copies only with the separate icon", async () => {
  click(".source-toggle");
  await settle();
  click("#source-url");
  click(".source-link-row");
  await settle();
  expect(copy).toHaveBeenCalledTimes(1);
  const url = document.querySelector("#source-url")!;
  expect(url.tagName).toBe("SPAN");
  expect(url.closest("a, button")).toBeNull();
  expect(url.hasAttribute("href")).toBe(false);
  expect(url.hasAttribute("role")).toBe(false);
  expect(url.hasAttribute("tabindex")).toBe(false);
  expect(getComputedStyle(url).userSelect).toBe("text");
  document
    .querySelector("#copy-source svg")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await settle();
  expect(copy).toHaveBeenCalledTimes(2);
  click("#copy-source");
  await settle();
  expect(copy).toHaveBeenCalledTimes(3);
});

it("keeps reduced-motion feedback stationary and hides it after completion", async () => {
  vi.mocked(window.matchMedia).mockReturnValue({
    matches: true,
  } as MediaQueryList);
  let finish!: () => void;
  animate.mockReturnValue({
    finished: new Promise<void>((resolve) => {
      finish = resolve;
    }),
    cancel: cancelAnimation,
  });
  click(".source-toggle");
  await settle();
  const frames = animate.mock.calls[0]![0];
  expect(frames.every((frame: Keyframe) => frame.transform === undefined)).toBe(
    true,
  );
  expect(frames.map((frame: Keyframe) => frame.opacity)).toEqual([0, 1, 1, 0]);
  expect(animate.mock.calls[0]![1].duration).toBe(1200);
  expect(document.querySelector<HTMLElement>("#copy-feedback")!.hidden).toBe(
    false,
  );
  finish();
  await settle();
  expect(document.querySelector<HTMLElement>("#copy-feedback")!.hidden).toBe(
    true,
  );
  expect(document.querySelector("#copy-announcement")!.textContent).toBe(
    "Source link copied.",
  );
});

it("starts feedback at pointer clicks, with keyboard fallback and viewport bounds", async () => {
  const feedback = document.querySelector<HTMLElement>("#copy-feedback")!;
  Object.defineProperties(feedback, {
    offsetWidth: { value: 60 },
    offsetHeight: { value: 24 },
  });
  const toggle = document.querySelector<HTMLElement>(".source-toggle")!;
  toggle.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      detail: 1,
      clientX: 200,
      clientY: 300,
    }),
  );
  await settle();
  expect(feedback.style.left).toBe("170px");
  expect(feedback.style.top).toBe("268px");
  const row = document.querySelector<HTMLElement>("#copy-source")!;
  row.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      detail: 1,
      clientX: 400,
      clientY: 350,
    }),
  );
  await settle();
  expect(feedback.style.left).toBe("370px");
  expect(feedback.style.top).toBe("318px");
  row.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      detail: 1,
      clientX: window.innerWidth,
      clientY: window.innerHeight,
    }),
  );
  await settle();
  expect(parseFloat(feedback.style.left) + 60).toBe(window.innerWidth - 8);
  expect(parseFloat(feedback.style.top) + 24).toBe(window.innerHeight - 8);
  row.getBoundingClientRect = () =>
    ({ left: 80, width: 200, top: 100, bottom: 144 }) as DOMRect;
  row.click();
  await settle();
  expect(feedback.style.left).toBe("150px");
  expect(feedback.style.top).toBe("68px");
});

it("does not move pointer-open focus into the source row", async () => {
  const toggle = document.querySelector<HTMLButtonElement>(".source-toggle")!;
  toggle.focus();
  toggle.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      detail: 1,
      clientX: 100,
      clientY: 100,
    }),
  );
  await settle();
  expect(document.activeElement).toBe(toggle);
});
