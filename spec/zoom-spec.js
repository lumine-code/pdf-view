const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF adaptive width zoom", () => {
  let main, viewers, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("pdf-view.autoRefresh", false);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-zoom-"));
    viewers = [];
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    for (const viewer of viewers) {
      const observation = viewer.fileObservation;
      await viewer.destroy();
      await observation.closed;
    }
    await lumine.packages.deactivatePackage("pdf-view");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function attach(viewer, width = 1000, height = 500) {
    viewers.push(viewer);
    viewer.element.style.cssText = `position:absolute;width:${width}px;height:${height}px;top:0;left:0`;
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    return viewer;
  }

  async function open(width = 1000, height = 500, mixed = false, pages = 1) {
    const file = path.join(directory, "zoom.pdf");
    let contents = createPdf({ pages: mixed ? 2 : pages });
    if (mixed) {
      // Keep byte lengths and xref offsets intact while making page two wider
      // and shorter than page one. Both dimensions remain three digits.
      let occurrence = 0;
      contents = Buffer.from(
        contents
          .toString("latin1")
          .replaceAll("/MediaBox [0 0 612 792]", (value) =>
            ++occurrence === 2 ? "/MediaBox [0 0 999 400]" : value,
          ),
        "latin1",
      );
    }
    fs.writeFileSync(file, contents);
    return attach(main.createViewer(file), width, height);
  }

  async function waitForWidth(viewer, pageNumber = viewer.getCurrentPage()) {
    const page = await viewer.pdfDocument.getPage(pageNumber);
    const width = page.getViewport({
      scale: 96 / 72,
      rotation: (page.rotate + viewer.pdfViewer.pagesRotation) % 360,
    }).width;
    await conditionPromise(
      () =>
        viewer.getCurrentPage() === pageNumber &&
        Math.abs(viewer.getViewState().scale - Math.min(1, viewer.viewport.clientWidth / width)) <
          0.0001,
      "adaptive PDF width scale",
      10000,
    );
  }

  it("defaults to automatic width fitting and caps a wide viewport at 100 percent", async () => {
    const viewer = await open(420, 170);
    expect(viewer.getViewState().zoomMode).toBe("auto-width");
    expect(viewer.getViewState().scale).toBeLessThan(1);
    expect(viewer.pdfViewer.getPageView(0).width).toBeCloseTo(viewer.viewport.clientWidth, 0);
    // Width fitting deliberately leaves a tall page taller than this viewport.
    expect(viewer.pdfViewer.getPageView(0).height).toBeGreaterThan(viewer.viewport.clientHeight);
    viewer.element.style.width = "1400px";
    await waitForWidth(viewer);
    expect(viewer.getViewState().scale).toBe(1);
    viewer.setScale("page-width");
    expect(viewer.getViewState().scale).toBeGreaterThan(1);
    expect(viewer.getViewState().zoomMode).toBeNull();
  });

  it("preserves restored and explicitly requested zoom instead of replacing it with the default", async () => {
    const viewer = await open(420, 300);
    const restored = await attach(
      main.createViewer(viewer.getPath(), "", { scaleValue: "0.75" }),
      420,
      300,
    );
    expect(restored.pdfViewer.currentScale).toBe(0.75);
    expect(restored.zoomMode).toBeNull();
    const explicit = await attach(
      main.createViewer(viewer.getPath(), "#page=1&zoom=150"),
      420,
      300,
    );
    expect(explicit.pdfViewer.currentScale).toBe(1.5);
    expect(explicit.zoomMode).toBeNull();
  });

  it("adapts to width changes and ignores changes to viewport height", async () => {
    const viewer = await open(520, 700);
    await viewer.executeCommand("automatic-zoom");
    const scale = viewer.getViewState().scale;
    const availableWidth = viewer.viewport.clientWidth;
    viewer.element.style.height = "140px";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await waitForWidth(viewer);
    // Height can introduce a vertical scrollbar and reduce the available
    // width. Only that width change may influence the fitted scale.
    expect(viewer.getViewState().scale).toBeCloseTo(
      (scale * viewer.viewport.clientWidth) / availableWidth,
      4,
    );
    viewer.element.style.width = "350px";
    await waitForWidth(viewer);
    expect(viewer.getViewState().scale).toBeLessThan(scale);
    viewer.element.style.width = "1200px";
    await waitForWidth(viewer);
    expect(viewer.getViewState().scale).toBe(1);
  });

  it("leaves adaptive mode for numeric zoom, zoom commands and explicit fit presets", async () => {
    const viewer = await open(500, 500);
    for (const value of [0.75, "page-width", "page-fit", "page-actual"]) {
      await viewer.executeCommand("automatic-zoom");
      viewer.setScale(value);
      expect(viewer.getViewState().zoomMode).toBeNull();
    }
    for (const command of ["zoom-in", "zoom-out"]) {
      await viewer.executeCommand("automatic-zoom");
      await viewer.executeCommand(command);
      expect(viewer.getViewState().zoomMode).toBeNull();
    }
    viewer.setScale(0.75);
    viewer.element.style.width = "1400px";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(viewer.getViewState().scale).toBe(0.75);
    // Exiting at the same numeric scale still updates the toolbar's mode.
    await viewer.executeCommand("automatic-zoom");
    expect(viewer.getViewState().scale).toBe(1);
    viewer.setScale(1);
    expect(viewer.getViewState().zoomMode).toBeNull();
    viewer.element.style.width = "60px";
    await viewer.executeCommand("automatic-zoom");
    expect(viewer.getViewState().scale).toBeLessThan(0.1);
    await viewer.executeCommand("zoom-in");
    expect(viewer.getViewState().zoomMode).toBeNull();
    expect(viewer.getViewState().scale).toBe(0.1);
  });

  it("preserves adaptive mode through reload, serialization and pane copies", async () => {
    const viewer = await open(450, 500);
    await viewer.executeCommand("automatic-zoom");
    expect(viewer.captureView().zoomMode).toBe("auto-width");
    expect(viewer.serialize().state.zoomMode).toBe("auto-width");
    await viewer.reload();
    expect(viewer.getViewState().zoomMode).toBe("auto-width");
    await waitForWidth(viewer);
    const copy = await attach(viewer.copy(), 1200, 300);
    expect(copy.getViewState().zoomMode).toBe("auto-width");
    expect(copy.getViewState().scale).toBe(1);
    copy.element.style.width = "420px";
    await waitForWidth(copy);
    expect(copy.getViewState().scale).toBeLessThan(1);
  });

  async function waitForPreset(viewer, preset) {
    await conditionPromise(
      () => viewer.pdfViewer.currentScaleValue === preset && !viewer.zoomAnimation.active,
      `retained PDF fit preset ${preset}`,
      1500,
    );
    const page = await viewer.pdfDocument.getPage(viewer.getCurrentPage());
    const size = page.getViewport({
      scale: 96 / 72,
      rotation: page.rotate + viewer.pdfViewer.pagesRotation,
    });
    const expected = () => {
      const width = viewer.viewport.clientWidth / size.width;
      const height = viewer.viewport.clientHeight / size.height;
      if (preset === "page-actual") return 1;
      if (preset === "page-width") return width;
      if (preset === "page-height") return height;
      if (preset === "page-fit") return Math.min(width, height);
      return Math.min(1.25, size.width <= size.height ? width : Math.min(width, height));
    };
    await conditionPromise(
      () => Math.abs(viewer.pdfViewer.currentScale - expected()) < 0.0001,
      `resized PDF fit scale ${preset}`,
      1500,
    ).catch((error) => {
      throw new Error(
        `${error.message}: actual=${viewer.pdfViewer.currentScale}, expected=${expected()}, retained=${viewer.scalePreset}, available=${viewer.availableDimensions}, size=${viewer.viewport.clientWidth}:${viewer.viewport.clientHeight}`,
      );
    });
  }

  it("recalculates named fit modes on width and height changes while keeping actual size fixed", async () => {
    const viewer = await open(1000, 800);
    for (const preset of ["page-width", "page-fit", "page-height", "auto", "page-actual"]) {
      viewer.element.style.width = "1000px";
      viewer.element.style.height = "800px";
      viewer.layoutChanged();
      viewer.setScale(preset);
      viewer.element.style.width = "430px";
      viewer.layoutChanged();
      await waitForPreset(viewer, preset);
      viewer.element.style.height = "210px";
      viewer.layoutChanged();
      await waitForPreset(viewer, preset);
      expect(viewer.captureView().scaleValue).toBe(preset);
      if (preset === "page-actual") expect(viewer.pdfViewer.currentScale).toBe(1);
    }
  });

  it("retains a requested fit mode when resize interrupts pending geometry or a zoom animation", async () => {
    const viewer = await open(1000, 800);
    let resolveScale;
    const preset = spyOn(viewer, "getPresetScale").and.returnValue(
      new Promise((resolve) => (resolveScale = resolve)),
    );
    const pending = viewer.setScale("page-fit", { smooth: true });
    expect(viewer.captureView().scaleValue).toBe("page-fit");
    viewer.element.style.height = "300px";
    viewer.layoutChanged();
    resolveScale(0.75);
    await pending;
    preset.and.callThrough();
    await waitForPreset(viewer, "page-fit");

    setMotion(viewer);
    viewer.setScale(1);
    const animating = viewer.setScale("page-width", { smooth: true });
    await twoFrames();
    expect(viewer.zoomAnimation.active).toBe(true);
    viewer.element.style.width = "410px";
    viewer.layoutChanged();
    await animating;
    await waitForPreset(viewer, "page-width");
    expect(viewer.getViewState().scaleValue).toBe("page-width");
  });

  it("preserves fit mode through a copy during selection and reload in the new pane size", async () => {
    const viewer = await open(1000, 800);
    setMotion(viewer, true);
    const pending = viewer.setScale("page-fit", { smooth: true });
    expect(viewer.serialize().state.scaleValue).toBe("page-fit");
    const copy = await attach(viewer.copy(), 420, 230);
    await pending;
    await waitForPreset(copy, "page-fit");
    await copy.reload();
    await waitForPreset(copy, "page-fit");
    copy.element.style.height = "600px";
    copy.layoutChanged();
    await waitForPreset(copy, "page-fit");
  });

  it("uses the selected page's real dimensions and rotation in a mixed-size PDF", async () => {
    const viewer = await open(500, 500, true);
    await viewer.executeCommand("automatic-zoom");
    const firstScale = viewer.getViewState().scale;
    viewer.goToPage(2);
    await waitForWidth(viewer, 2);
    expect(viewer.getViewState().scale).toBeLessThan(firstScale);
    expect(viewer.getViewState().zoomMode).toBe("auto-width");
    viewer.executeCommand("rotate-clockwise");
    await waitForWidth(viewer, 2);
    expect(viewer.getCurrentPage()).toBe(2);
    expect(viewer.getViewState().scale).toBeGreaterThan(firstScale);
    expect(viewer.getViewState().zoomMode).toBe("auto-width");
    viewer.goToPage(1);
    await waitForWidth(viewer);
    expect(viewer.pdfViewer.pagesRotation).toBe(90);
  });

  it("ignores a late geometry request after a manual zoom or document change", async () => {
    const viewer = await open();
    let resolvePage;
    const request = new Promise((resolve) => {
      resolvePage = resolve;
    });
    const pdf = { getPage: jasmine.createSpy("getPage").and.returnValue(request) };
    const apply = jasmine.createSpy("apply scale");
    const context = {
      pdfDocument: pdf,
      generation: 1,
      zoomMode: "auto-width",
      zoomUpdateRevision: 0,
      destroyed: false,
      getCurrentPage: () => 7,
      hasLayout: () => true,
      viewport: { clientWidth: 400 },
      pdfViewer: {
        getPageView: () => null,
        pagesRotation: 0,
        set currentScaleValue(value) {
          apply(value);
        },
      },
    };
    const pending = viewer.updateAutoWidth.call(context);
    expect(pdf.getPage).toHaveBeenCalledOnceWith(7);
    context.zoomMode = null;
    context.zoomUpdateRevision++;
    resolvePage({ rotate: 0, getViewport: () => ({ width: 800 }) });
    await pending;
    expect(apply).not.toHaveBeenCalled();
    context.zoomMode = "auto-width";
    const replacement = viewer.updateAutoWidth.call(context);
    context.generation++;
    await replacement;
    expect(apply).not.toHaveBeenCalled();
  });

  function setMotion(viewer, reduced = false) {
    const native = viewer.zoomAnimation.window.matchMedia.bind(viewer.zoomAnimation.window);
    spyOn(viewer.zoomAnimation.window, "matchMedia").and.callFake((query) =>
      query === "(prefers-reduced-motion: reduce)" ? { matches: reduced } : native(query),
    );
  }

  function twoFrames() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function pdfPoint(viewer, x, y) {
    const page = viewer.pdfViewer.getPageView(0);
    const rect = page.div.getBoundingClientRect();
    return page.viewport.convertToPdfPoint(
      ((x - rect.left) * page.viewport.width) / rect.width,
      ((y - rect.top) * page.viewport.height) / rect.height,
    );
  }

  it("animates command zoom through intermediate frames while deferring canvas redraws", async () => {
    const viewer = await open();
    setMotion(viewer);
    viewer.setScale(1);
    const updates = spyOn(viewer.pdfViewer.getPageView(0), "update").and.callThrough();
    const finished = viewer.executeCommand("zoom-in");
    expect(viewer.zoomAnimation.active).toBe(true);
    expect(viewer.pdfViewer.currentScale).toBe(1);
    await twoFrames();
    expect(viewer.pdfViewer.currentScale).toBeGreaterThan(1);
    expect(viewer.pdfViewer.currentScale).toBeLessThan(1.1);
    await finished;
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.1, 8);
    expect(viewer.zoomAnimation.active).toBe(false);
    expect(updates.calls.count()).toBeGreaterThan(1);
    expect(updates.calls.count()).toBeLessThan(30);
    const scaled = updates.calls.allArgs().filter(([options]) => options.scale > 0);
    expect(scaled.every(([options]) => options.drawingDelay > 0)).toBe(true);
    await viewer.setScale("page-width", { smooth: true });
    expect(viewer.pdfViewer.currentScaleValue).toBe("page-width");
  });

  it("accumulates wheel bursts and keeps the PDF point under the pointer fixed on both axes", async () => {
    const viewer = await open(650, 500, false, 40);
    setMotion(viewer);
    viewer.element.style.left = "130px";
    viewer.element.style.top = "70px";
    await twoFrames();
    viewer.setScale(2);
    viewer.viewport.scrollLeft = 260;
    viewer.viewport.scrollTop = 310;
    viewer.pdfViewer.update();
    const bounds = viewer.viewport.getBoundingClientRect();
    const x = bounds.left + 210;
    const y = bounds.top + 230;
    const before = pdfPoint(viewer, x, y);
    const startLeft = viewer.viewport.scrollLeft;
    const startTop = viewer.viewport.scrollTop;
    const renderedPages = new Set();
    viewer.eventBus.on("pagerendered", ({ pageNumber, cssTransform }) => {
      if (!cssTransform) renderedPages.add(pageNumber);
    });
    let finished;
    for (let index = 0; index < 8; index++) {
      const event = new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -10,
        clientX: x,
        clientY: y,
        cancelable: true,
      });
      finished = viewer.handleWheel(event);
      expect(event.defaultPrevented).toBe(true);
    }
    expect(viewer.zoomAnimation.targetScale).toBeCloseTo(2 * Math.exp(0.16), 8);
    await twoFrames();
    const middle = pdfPoint(viewer, x, y);
    expect(Math.abs(middle[0] - before[0])).toBeLessThan(0.8);
    expect(Math.abs(middle[1] - before[1])).toBeLessThan(0.8);
    await finished;
    const after = pdfPoint(viewer, x, y);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(2 * Math.exp(0.16), 8);
    expect(Math.abs(after[0] - before[0])).toBeLessThan(0.8);
    expect(Math.abs(after[1] - before[1])).toBeLessThan(0.8);
    expect(viewer.viewport.scrollLeft).toBeGreaterThan(startLeft);
    expect(viewer.viewport.scrollTop).toBeGreaterThan(startTop);
    expect(renderedPages.size).toBeLessThan(5);
    expect(viewer.pagesElement.querySelectorAll("canvas").length).toBeLessThan(6);
  });

  it("preserves fractional intermediate scales during a small zoom", async () => {
    const viewer = await open();
    setMotion(viewer);
    viewer.setScale(0.5);
    const scales = [];
    const apply = viewer.zoomAnimation.apply.bind(viewer.zoomAnimation);
    spyOn(viewer.zoomAnimation, "apply").and.callFake((scale, final) => {
      apply(scale, final);
      scales.push(viewer.pdfViewer.currentScale);
    });
    await viewer.setScale(0.55, { smooth: true });
    expect(scales.length).toBeGreaterThan(5);
    expect(new Set(scales).size).toBe(scales.length);
    expect(
      scales.slice(0, -1).some((scale) => Math.abs(scale * 100 - Math.round(scale * 100)) > 1e-5),
    ).toBe(true);
    expect(scales.at(-1)).toBe(0.55);
  });

  it("finishes a fit animation through scrollbar changes without cancellation or a final scale jump", async () => {
    const viewer = await open(1000, 800);
    setMotion(viewer);
    viewer.setScale(2);
    await twoFrames();
    const interrupted = [];
    const cancel = viewer.zoomAnimation.cancel.bind(viewer.zoomAnimation);
    spyOn(viewer.zoomAnimation, "cancel").and.callFake((options) => {
      if (viewer.zoomAnimation.active) interrupted.push(viewer.pdfViewer.currentScale);
      return cancel(options);
    });
    let lastApplied;
    const apply = viewer.zoomAnimation.apply.bind(viewer.zoomAnimation);
    spyOn(viewer.zoomAnimation, "apply").and.callFake((scale, final) => {
      apply(scale, final);
      lastApplied = viewer.pdfViewer.currentScale;
    });
    await viewer.setScale("page-fit", { smooth: true });
    expect(interrupted).toEqual([]);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(lastApplied, 8);
    await waitForPreset(viewer, "page-fit");
  });

  it("keeps queued automatic fitting from interrupting a newer animation", async () => {
    const viewer = await open(650, 500);
    setMotion(viewer);
    viewer.setScale(1.5);
    viewer.zoomMode = "auto-width";
    viewer.scheduleAutoWidth();
    const pending = viewer.setAutoWidth({ smooth: true });
    await Promise.resolve();
    expect(viewer.zoomAnimation.active).toBe(true);
    await pending;
    await waitForWidth(viewer);
  });

  it("honors reduced motion and leaves ordinary scrolling alone", async () => {
    const viewer = await open();
    setMotion(viewer, true);
    viewer.setScale(1);
    await viewer.executeCommand("zoom-in");
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.1, 8);
    expect(viewer.zoomAnimation.active).toBe(false);
    expect(viewer.zoomAnimation.frame).toBeNull();
    const ordinary = new WheelEvent("wheel", { deltaY: 40, cancelable: true });
    viewer.handleWheel(ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    const loading = new WheelEvent("wheel", { ctrlKey: true, deltaY: 40, cancelable: true });
    viewer.handleWheel.call({ pdfDocument: null }, loading);
    expect(loading.defaultPrevented).toBe(false);
  });

  it("cancels animation on manual scale, page changes, reload and destruction", async () => {
    const viewer = await open(650, 500, false, 3);
    setMotion(viewer);
    viewer.setScale(1);
    const manual = viewer.setScale(3, { smooth: true });
    viewer.setScale(0.75);
    await manual;
    await twoFrames();
    expect(viewer.pdfViewer.currentScale).toBe(0.75);
    const navigating = viewer.executeCommand("zoom-in");
    viewer.goToPage(2);
    await navigating;
    expect(viewer.zoomAnimation.active).toBe(false);
    const reloading = viewer.setScale(2, { smooth: true });
    const reload = viewer.reload();
    await Promise.all([reloading, reload]);
    expect(viewer.zoomAnimation.active).toBe(false);
    const scale = viewer.pdfViewer.currentScale;
    await twoFrames();
    expect(viewer.pdfViewer.currentScale).toBe(scale);
    const retiring = viewer.setScale(3, { smooth: true });
    await viewer.destroy();
    await retiring;
    expect(viewer.zoomAnimation.active).toBe(false);
    expect(viewer.zoomAnimation.frame).toBeNull();
  });
});
