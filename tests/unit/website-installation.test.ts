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
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const click = (selector: string) =>
  document.querySelector<HTMLElement>(selector)!.click();

beforeEach(() => {
  document.documentElement.innerHTML = html;
  vi.stubGlobal("fetch", fetchMock);
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
  expect(document.querySelector("#source-url")!.textContent).toBe(
    "https://onedrop.sycamore.top/apps.json",
  );
  click("#copy-source");
  await settle();
  expect(copy).toHaveBeenCalledTimes(2);
  expect(document.querySelector("#copy-source span")!.textContent).toBe("✓");
  expect(
    document.querySelector("#copy-source")!.getAttribute("aria-label"),
  ).toContain("copied");
  expect(document.querySelector("#source-status")!.textContent).toBe("");
});

it("keeps the source visible and reports clipboard rejection or absence", async () => {
  copy.mockRejectedValue(new Error("Denied"));
  click(".source-toggle");
  await settle();
  expect(document.querySelector("#source-status")!.textContent).toContain(
    "Copy failed",
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
  expect(document.querySelector("#download-ipa")!.textContent).toBe(
    "Download IPA",
  );
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
  expect(document.querySelector("#download-ipa")!.textContent).toBe(
    "Retry IPA download",
  );
  click("#download-ipa");
  await settle();
  expect(document.querySelector("#download-ipa")!.getAttribute("href")).toBe(
    ipa,
  );
  expect(document.querySelector("#ipa-status")!.textContent).toBe("");
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
