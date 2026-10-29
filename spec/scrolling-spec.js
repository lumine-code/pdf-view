const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF scrolling", () => {
  let viewer, main, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-scroll-"));
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 8 }));
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:650px;height:420px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    viewer.setScale(2);
    await frames();
    const native = viewer.element.ownerDocument.defaultView.matchMedia.bind(window);
    spyOn(viewer.element.ownerDocument.defaultView, "matchMedia").and.callFake((query) =>
      query === "(prefers-reduced-motion: reduce)" ? { matches: false } : native(query),
    );
  });

  afterEach(async () => {
    const observation = viewer.fileObservation;
    await viewer.destroy();
    await observation.closed;
    await lumine.packages.deactivatePackage("pdf-view");
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw Error("Unsafe scroll fixture cleanup");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function frames() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function arrow(target, key) {
    const event = lumine.keymaps.constructor.buildKeydownEvent(key, { target });
    lumine.keymaps.handleKeyboardEvent(event);
    return event;
  }

  it("animates both axes and accumulates held arrows through the public commands", async () => {
    const commands = lumine.commands
      .findCommands({ target: viewer.viewport })
      .map(({ name }) => name);
    for (const direction of ["up", "down", "left", "right"])
      expect(commands).toContain(`pdf-view:scroll-${direction}`);
    viewer.viewport.scrollTop = 200;
    viewer.viewport.scrollLeft = 150;
    viewer.focus();
    const run = spyOn(main, "run").and.callThrough();
    arrow(viewer.viewport, "down");
    for (let i = 0; i < 3; i++) arrow(viewer.viewport, "right");
    expect(run.calls.allArgs().map(([, action]) => action)).toEqual([
      "scroll-down",
      "scroll-right",
      "scroll-right",
      "scroll-right",
    ]);
    expect(viewer.viewport.scrollTop).toBe(200);
    expect(viewer.viewport.scrollLeft).toBe(150);
    const targetTop = viewer.scrollAnimation.targetTop;
    const targetLeft = viewer.scrollAnimation.targetLeft;
    expect(targetTop).toBe(Math.round(200 + viewer.viewport.clientHeight / 10));
    expect(targetLeft).toBe(150 + 3 * Math.round(viewer.viewport.clientWidth / 10));
    await frames();
    expect(viewer.viewport.scrollTop).toBeGreaterThan(200);
    expect(viewer.viewport.scrollTop).toBeLessThan(targetTop);
    expect(viewer.viewport.scrollLeft).toBeGreaterThan(150);
    expect(viewer.viewport.scrollLeft).toBeLessThan(targetLeft);
    await viewer.scrollAnimation.promise;
    expect(viewer.viewport.scrollTop).toBe(targetTop);
    expect(viewer.viewport.scrollLeft).toBe(targetLeft);
    expect(document.activeElement).toBe(viewer.viewport);
  });

  it("leaves arrows native while editing the page number", () => {
    const input = viewer.toolbar.pageInput;
    input.focus();
    const before = viewer.viewport.scrollTop;
    for (const key of ["up", "down", "left", "right"])
      expect(arrow(input, key).defaultPrevented).toBe(false);
    expect(viewer.scrollAnimation.active).toBe(false);
    expect(viewer.viewport.scrollTop).toBe(before);
  });

  it("keeps an accumulated arrow movement running across PDF page changes", async () => {
    await viewer.setAutoWidth();
    viewer.viewport.scrollTop = 0;
    let pending;
    for (let i = 0; i < 24; i++) pending = viewer.executeCommand("scroll-down");
    const target = viewer.scrollAnimation.targetTop;
    await pending;
    expect(viewer.viewport.scrollTop).toBe(target);
    viewer.pdfViewer.update();
    expect(viewer.getCurrentPage()).toBeGreaterThan(1);
    expect(viewer.zoomMode).toBe("auto-width");
  });

  it("stops old scrolling for manual input, zoom, explicit navigation and destruction", async () => {
    viewer.viewport.scrollTop = 200;
    viewer.executeCommand("scroll-down");
    await frames();
    const wheel = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    viewer.handleWheel(wheel);
    const stopped = viewer.viewport.scrollTop;
    expect(wheel.defaultPrevented).toBe(false);
    expect(viewer.scrollAnimation.active).toBe(false);
    await frames();
    expect(viewer.viewport.scrollTop).toBe(stopped);
    viewer.executeCommand("scroll-down");
    viewer.viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(viewer.scrollAnimation.active).toBe(false);
    viewer.executeCommand("scroll-down");
    viewer.setScale(1.5);
    expect(viewer.scrollAnimation.active).toBe(false);
    viewer.executeCommand("scroll-down");
    viewer.goToPage(3);
    expect(viewer.scrollAnimation.active).toBe(false);
    expect(viewer.getCurrentPage()).toBe(3);
    const pending = viewer.executeCommand("scroll-down");
    await viewer.destroy();
    await pending;
    expect(viewer.scrollAnimation.frame).toBeNull();
  });

  it("honors reduced motion and clamps at the scroll boundaries", async () => {
    viewer.element.ownerDocument.defaultView.matchMedia.and.returnValue({ matches: true });
    viewer.viewport.scrollTop = 0;
    await viewer.executeCommand("scroll-up");
    expect(viewer.viewport.scrollTop).toBe(0);
    await viewer.executeCommand("scroll-down");
    expect(viewer.viewport.scrollTop).toBe(Math.round(viewer.viewport.clientHeight / 10));
    viewer.viewport.scrollLeft = viewer.viewport.scrollWidth;
    const end = viewer.viewport.scrollLeft;
    await viewer.executeCommand("scroll-right");
    expect(viewer.viewport.scrollLeft).toBe(end);
    expect(viewer.scrollAnimation.active).toBe(false);
    expect(viewer.scrollAnimation.frame).toBeNull();
  });

  it("smoothly accumulates Alt wheel bursts on both axes without changing zoom or focus", async () => {
    lumine.config.set("editor.altWheelScrollMultiplier", 8);
    viewer.viewport.scrollLeft = 120;
    viewer.viewport.scrollTop = 200;
    viewer.toolbar.pageInput.focus();
    for (let index = 0; index < 3; index++) {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        altKey: true,
        deltaX: 2,
        deltaY: 5,
      });
      viewer.viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(viewer.viewport.scrollLeft).toBe(120);
    expect(viewer.viewport.scrollTop).toBe(200);
    expect(viewer.scrollAnimation.targetLeft).toBe(168);
    expect(viewer.scrollAnimation.targetTop).toBe(320);
    await frames();
    expect(viewer.viewport.scrollTop).toBeGreaterThan(200);
    expect(viewer.viewport.scrollTop).toBeLessThan(320);
    await viewer.scrollAnimation.promise;
    expect(viewer.viewport.scrollLeft).toBe(168);
    expect(viewer.viewport.scrollTop).toBe(320);
    expect(viewer.pdfViewer.currentScale).toBe(2);
    expect(document.activeElement).toBe(viewer.toolbar.pageInput);
  });

  it("normalizes line and page wheel distances and follows the platform's Shift axis convention", () => {
    viewer.element.ownerDocument.defaultView.matchMedia.and.returnValue({ matches: true });
    for (const [deltaMode, multiplier, shiftKey] of [
      [1, 4, false],
      [2, 2, false],
      [0, 8, true],
    ]) {
      lumine.config.set("editor.altWheelScrollMultiplier", multiplier);
      viewer.viewport.scrollLeft = 100;
      viewer.viewport.scrollTop = 100;
      const deltaX = shiftKey ? 2 : 0.05;
      const deltaY = shiftKey ? 5 : 0.1;
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        altKey: true,
        shiftKey,
        deltaMode,
        deltaX,
        deltaY,
      });
      let left =
        deltaX * (deltaMode === 1 ? 16 : deltaMode === 2 ? viewer.viewport.clientWidth : 1);
      let top =
        deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? viewer.viewport.clientHeight : 1);
      if (shiftKey && process.platform !== "darwin") [left, top] = [top, left];
      viewer.viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(Math.abs(viewer.viewport.scrollLeft - (100 + left * multiplier))).toBeLessThan(1);
      expect(Math.abs(viewer.viewport.scrollTop - (100 + top * multiplier))).toBeLessThan(1);
      expect(viewer.scrollAnimation.active).toBe(false);
    }
  });

  it("accepts queued reversals at the start edge and finishes outward bursts at the end edge", async () => {
    lumine.config.set("editor.altWheelScrollMultiplier", 8);
    viewer.viewport.scrollLeft = 0;
    viewer.viewport.scrollTop = 0;
    const wheel = (deltaX, deltaY) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        altKey: true,
        deltaX,
        deltaY,
      });
      viewer.viewport.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    wheel(20, 50);
    wheel(-5, -10);
    expect(viewer.scrollAnimation.targetLeft).toBe(120);
    expect(viewer.scrollAnimation.targetTop).toBe(320);
    await viewer.scrollAnimation.promise;
    expect(viewer.viewport.scrollLeft).toBe(120);
    expect(viewer.viewport.scrollTop).toBe(320);

    const maxLeft = viewer.viewport.scrollWidth - viewer.viewport.clientWidth;
    const maxTop = viewer.viewport.scrollHeight - viewer.viewport.clientHeight;
    viewer.viewport.scrollLeft = maxLeft - 20;
    viewer.viewport.scrollTop = maxTop - 20;
    wheel(20, 50);
    wheel(20, 50);
    expect(viewer.scrollAnimation.active).toBe(true);
    expect(viewer.scrollAnimation.targetLeft).toBe(maxLeft);
    expect(viewer.scrollAnimation.targetTop).toBe(maxTop);
    await viewer.scrollAnimation.promise;
    // PDF.js can refine page layout during the animation. The final edge is
    // the live scroll limit, including a smaller limit clamped by Chromium.
    expect(viewer.viewport.scrollLeft).toBe(
      viewer.viewport.scrollWidth - viewer.viewport.clientWidth,
    );
    expect(viewer.viewport.scrollTop).toBe(
      viewer.viewport.scrollHeight - viewer.viewport.clientHeight,
    );
  });

  it("retains fractional touchpad distances through a wheel burst", async () => {
    lumine.config.set("editor.altWheelScrollMultiplier", 8);
    viewer.viewport.scrollLeft = 20;
    viewer.viewport.scrollTop = 20;
    for (let index = 0; index < 10; index++) {
      viewer.viewport.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          altKey: true,
          deltaX: 0.05,
          deltaY: 0.05,
        }),
      );
    }
    expect(viewer.scrollAnimation.targetLeft).toBeCloseTo(24, 8);
    expect(viewer.scrollAnimation.targetTop).toBeCloseTo(24, 8);
    await viewer.scrollAnimation.promise;
    expect(viewer.viewport.scrollLeft).toBe(24);
    expect(viewer.viewport.scrollTop).toBe(24);
  });

  it("keeps native wheel behavior when the boost is disabled or the PDF cannot scroll", () => {
    lumine.config.set("editor.altWheelScrollMultiplier", 1);
    const disabled = new WheelEvent("wheel", { altKey: true, deltaY: 40, cancelable: true });
    viewer.handleWheel(disabled);
    expect(disabled.defaultPrevented).toBe(false);
    expect(viewer.scrollAnimation.active).toBe(false);
    lumine.config.set("editor.altWheelScrollMultiplier", 8);
    viewer.viewport.scrollTop = 0;
    const edge = new WheelEvent("wheel", { altKey: true, deltaY: -40, cancelable: true });
    viewer.handleWheel(edge);
    expect(edge.defaultPrevented).toBe(false);
    const loading = new WheelEvent("wheel", { altKey: true, deltaY: 40, cancelable: true });
    viewer.handleWheel.call({ pdfDocument: null }, loading);
    expect(loading.defaultPrevented).toBe(false);
  });

  for (const modifier of ["ctrlKey", "metaKey"]) {
    it(`keeps ${modifier} wheel zoom ahead of Alt scrolling`, async () => {
      const scroll = spyOn(viewer, "scrollBy").and.callThrough();
      const event = new WheelEvent("wheel", {
        [modifier]: true,
        altKey: true,
        deltaY: 10,
        cancelable: true,
      });
      await viewer.handleWheel(event);
      expect(event.defaultPrevented).toBe(true);
      expect(scroll).not.toHaveBeenCalled();
      expect(viewer.pdfViewer.currentScale).toBeCloseTo(2 * Math.exp(-10 * 0.002), 5);
    });
  }
});
