import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const html = readFileSync("docs/index.html", "utf8");
const animate = vi.fn();
const scrollIntoView = vi.fn();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const element = (selector: string) =>
  document.querySelector<HTMLElement>(selector)!;
const entries = () => [
  ...document.querySelectorAll<HTMLElement>(".release-entry"),
];

beforeEach(() => {
  document.documentElement.innerHTML = html;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  animate.mockReturnValue({ finished: Promise.resolve() });
  vi.spyOn(element("#show-releases"), "getBoundingClientRect").mockReturnValue({
    height: 46.390625,
  } as DOMRect);
  vi.spyOn(element("#older-releases"), "getBoundingClientRect").mockReturnValue(
    { height: 800.390625 } as DOMRect,
  );
  const scripts = document.querySelectorAll("script");
  window.eval(scripts[scripts.length - 1]!.textContent!);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "animate");
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});

it("renders the approved eight stable releases in version order with no draft section", () => {
  expect(element("#updates-heading").textContent).toBe("Release notes");
  expect(
    entries().map((entry) =>
      entry.querySelector(".release-select")!.textContent!.trim(),
    ),
  ).toEqual([
    "v1.2.0",
    "v1.1.3",
    "v1.1.2",
    "v1.1.1",
    "v1.1.0",
    "v1.0.4",
    "v1.0.3",
    "v1.0.2",
  ]);
  expect(
    element("#show-releases").textContent!.replace(/\s+/g, " ").trim(),
  ).toBe("Show earlier releases");
  expect(
    element("#hide-releases").textContent!.replace(/\s+/g, " ").trim(),
  ).toBe("Hide earlier releases");
  expect(element("#older-releases").hidden).toBe(true);
  expect(entries()[2]!.classList.contains("release-last")).toBe(true);
  expect(document.querySelector(".preview-label, #download")).toBeNull();
  expect(element("#updates").querySelector(".eyebrow")).toBeNull();
});

it("expands without focusing a release, preserves fractional placeholder height, and keeps Hide at the bottom", async () => {
  let finish!: () => void;
  animate.mockReturnValueOnce({
    finished: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  });
  element("#show-releases").click();
  element("#show-releases").click();
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate.mock.calls[0]![0][0]).toEqual({
    height: "46.390625px",
    opacity: 0,
  });
  expect(element("#older-releases").hidden).toBe(false);
  expect(element("#show-releases").hidden).toBe(true);
  expect(document.activeElement).toBe(element(".release-timeline"));
  expect(entries()[0]!.classList.contains("is-selected")).toBe(true);
  expect(entries()[2]!.classList.contains("is-selected")).toBe(false);
  expect(element("#older-releases").lastElementChild).toBe(
    element("#hide-releases"),
  );
  expect(scrollIntoView).not.toHaveBeenCalled();
  finish();
  await settle();
  element("#hide-releases").click();
  await settle();
  expect(element("#older-releases").hidden).toBe(true);
  expect(element("#show-releases").hidden).toBe(false);
  expect(document.activeElement).toBe(element("#show-releases"));
  expect(entries()[2]!.classList.contains("release-last")).toBe(true);
  expect(scrollIntoView).toHaveBeenCalledWith({
    block: "nearest",
    behavior: "instant",
  });
});

it("selects versions with native buttons and honors reduced motion", async () => {
  vi.mocked(window.matchMedia).mockReturnValue({
    matches: true,
  } as MediaQueryList);
  entries()[1]!.querySelector<HTMLButtonElement>(".release-select")!.click();
  expect(entries()[1]!.classList.contains("is-selected")).toBe(true);
  expect(
    entries()[1]!.querySelector("button")!.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    entries()[0]!.querySelector("button")!.getAttribute("aria-pressed"),
  ).toBe("false");
  const releaseLink =
    entries()[0]!.querySelector<HTMLAnchorElement>(".release-link")!;
  releaseLink.addEventListener("click", (event) => event.preventDefault());
  releaseLink.click();
  expect(entries()[1]!.classList.contains("is-selected")).toBe(true);
  element("#show-releases").click();
  await settle();
  expect(animate.mock.calls[0]![1].duration).toBe(0);
  expect(entries()[1]!.classList.contains("is-selected")).toBe(true);
});
