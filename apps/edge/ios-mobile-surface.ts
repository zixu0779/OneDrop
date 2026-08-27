let viewportSyncFrame: number | undefined;
let viewportSettleTimers: number[] = [];

export function configureIosEdgeMobileSurface(): void {
  document.body.classList.add("mobile-surface", "ios-edge-surface");
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content",
    );

  const viewport = window.visualViewport;

  function syncPopupViewport(): void {
    const height = viewport?.height ?? window.innerHeight;
    const offsetTop = viewport?.offsetTop ?? 0;
    document.documentElement.style.setProperty(
      "--ios-edge-popup-height",
      `${Math.round(height)}px`,
    );
    document.documentElement.style.setProperty(
      "--ios-edge-popup-offset-top",
      `${Math.round(offsetTop)}px`,
    );
  }

  function schedulePopupViewportSync(): void {
    if (viewportSyncFrame !== undefined) return;
    viewportSyncFrame = window.requestAnimationFrame(() => {
      viewportSyncFrame = undefined;
      syncPopupViewport();
    });
  }

  function settlePopupViewport(keepFocusedControlVisible: boolean): void {
    for (const timer of viewportSettleTimers) window.clearTimeout(timer);
    viewportSettleTimers = [0, 100, 250, 500].map((delay) =>
      window.setTimeout(() => {
        schedulePopupViewportSync();
        if (!keepFocusedControlVisible) return;
        const focusedControl = document.activeElement;
        if (
          focusedControl instanceof HTMLTextAreaElement ||
          focusedControl instanceof HTMLInputElement
        ) {
          focusedControl.scrollIntoView({ block: "nearest" });
        }
      }, delay),
    );
  }

  syncPopupViewport();
  viewport?.addEventListener("resize", schedulePopupViewportSync);
  viewport?.addEventListener("scroll", schedulePopupViewportSync);
  window.addEventListener("resize", schedulePopupViewportSync);
  window.addEventListener("pageshow", schedulePopupViewportSync);
  document.addEventListener("focusin", (event) => {
    if (
      !(event.target instanceof HTMLTextAreaElement) &&
      !(event.target instanceof HTMLInputElement)
    ) {
      return;
    }
    settlePopupViewport(true);
  });
  document.addEventListener("focusout", () => {
    settlePopupViewport(false);
  });
}
