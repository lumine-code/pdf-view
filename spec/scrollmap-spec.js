const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");
const PdfScrollmap = require("../lib/scrollmap");
const MAX_DEPTH_CONFIG = `${require("../package.json").name}.scrollmap.maxDepth`;

class FakeSimplemap {
  constructor() {
    this.element = document.createElement("div");
    this.items = [];
    this.destroyed = false;
  }
  setItems(items) {
    this.items = items;
  }
  destroy() {
    this.destroyed = true;
    this.element.remove();
  }
}

function watch(emitter, event, callback) {
  emitter.on(event, callback);
  return { dispose: () => emitter.off(event, callback) };
}

describe("PDF overview through scrollmap.widget", () => {
  let viewer,
    overview,
    events,
    searchEvents,
    navigation,
    publish,
    metrics,
    pageViews,
    previousDepth;

  beforeEach(() => {
    jasmine.useRealClock();
    previousDepth = lumine.config.get(MAX_DEPTH_CONFIG);
    lumine.config.unset(MAX_DEPTH_CONFIG);
    metrics = { width: 600, height: 400, total: 2000 };
    events = new EventEmitter();
    searchEvents = new EventEmitter();
    const element = document.createElement("div");
    element.style.cssText = "position:relative;width:600px;height:400px";
    const viewport = document.createElement("div");
    element.append(viewport);
    jasmine.attachToDOM(element);
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => metrics.width },
      clientHeight: { configurable: true, get: () => metrics.height },
      scrollHeight: { configurable: true, get: () => metrics.total },
      scrollTop: { configurable: true, value: 200, writable: true },
    });
    const readGeometry = lumine.scrollbars.getGeometry.bind(lumine.scrollbars);
    spyOn(lumine.scrollbars, "getGeometry").and.callFake((element) =>
      element === viewport
        ? {
            verticalSize: 10,
            horizontalSize: 10,
            viewportWidth: metrics.width,
            viewportHeight: metrics.height,
            scrollWidth: metrics.width,
            scrollHeight: metrics.total,
          }
        : readGeometry(element),
    );
    viewport.getBoundingClientRect = () => ({
      top: 40,
      left: 0,
      width: metrics.width,
      height: metrics.height,
    });
    const positions = [
      { top: 0, height: 500 },
      { top: 500, height: 1000 },
      { top: 1500, height: 500 },
    ];
    pageViews = positions.map(({ top, height }) => {
      const div = document.createElement("div");
      viewport.append(div);
      div.getBoundingClientRect = () => ({
        top: 40 + top - viewport.scrollTop,
        height,
        width: 600,
      });
      return { div, viewport: { height, convertToViewportPoint: (x, y) => [x, height - y] } };
    });
    const pdfDocument = { numPages: 3, getPage: jasmine.createSpy("getPage") };
    viewer = {
      element,
      viewport,
      pdfDocument,
      eventBus: new EventEmitter(),
      pdfViewer: {
        currentScale: 1,
        pagesRotation: 0,
        getPageView: jasmine.createSpy("getPageView").and.callFake((index) => pageViews[index]),
      },
      onDidLoad: (callback) => watch(events, "load", callback),
      onDidChangeView: (callback) => watch(events, "view", callback),
      onDidDestroy: (callback) => watch(events, "destroy", callback),
      searchAdapter: {
        highlightMatches: true,
        document: pdfDocument,
        counts: [0, 2, 0],
        onDidUpdate: (callback) => watch(searchEvents, "update", callback),
        onDidChangeCurrentResult: (callback) => watch(searchEvents, "current", callback),
      },
    };
    navigation = {
      observeHeaders: jasmine.createSpy("observeHeaders").and.callFake((_viewer, callback) => {
        publish = callback;
        callback([
          { level: 1, pageIndex: 0, resolvedDestination: [0, { name: "Fit" }], children: [] },
          {
            level: 2,
            pageIndex: 1,
            resolvedDestination: [1, { name: "XYZ" }, 0, 700, null],
            children: [],
          },
          { level: 7, pageIndex: 2, resolvedDestination: [2, { name: "Fit" }], children: [] },
        ]);
        return {
          dispose: () => {
            publish = null;
          },
        };
      }),
    };
  });

  afterEach(() => {
    overview?.destroy();
    if (previousDepth === undefined) lumine.config.unset(MAX_DEPTH_CONFIG);
    else lumine.config.set(MAX_DEPTH_CONFIG, previousDepth);
  });

  async function create(Widget = FakeSimplemap) {
    overview = new PdfScrollmap(viewer, Widget, navigation);
    await lumine.views.getNextUpdatePromise();
    return overview.simplemap;
  }

  it("positions bookmarks from real page geometry without duplicating the native scroll thumb", async () => {
    lumine.config.set(MAX_DEPTH_CONFIG, 2);
    const widget = await create();
    expect(widget.element.parentNode).toBe(viewer.element);
    expect(widget.element.classList.contains("pdf-view-scrollmap")).toBe(true);
    expect(widget.items.some((item) => item.cls === "marker-pdf-viewport")).toBe(false);
    expect(widget.items.some((item) => item.end !== undefined)).toBe(false);
    const headings = widget.items.filter((item) => item.cls.startsWith("marker-pdf-h"));
    expect(headings.map((item) => item.prc)).toEqual([0, 40]);
    expect(headings.map((item) => item.cls)).toEqual(["marker-pdf-h1", "marker-pdf-h2"]);
    expect(widget.items.every((item) => item.position === undefined)).toBe(true);
    expect(widget.items.find((item) => item.cls === "marker-pdf-search").prc).toBe(25);
    expect(viewer.pdfDocument.getPage).not.toHaveBeenCalled();
  });

  it("defaults to top-level headings and reacts to depth changes including zero for all levels", async () => {
    expect(require("../package.json").configSchema.scrollmap.properties.maxDepth.default).toBe(1);
    const widget = await create();
    const headings = () => widget.items.filter((item) => item.cls.startsWith("marker-pdf-h"));
    expect(headings().map((item) => item.cls)).toEqual(["marker-pdf-h1"]);
    lumine.config.set(MAX_DEPTH_CONFIG, 0);
    await lumine.views.getNextUpdatePromise();
    expect(headings().map((item) => item.cls)).toEqual([
      "marker-pdf-h1",
      "marker-pdf-h2",
      "marker-pdf-h6",
    ]);
    expect(headings().map((item) => item.prc)).toEqual([0, 40, 75]);
    lumine.config.set(MAX_DEPTH_CONFIG, 2);
    await lumine.views.getNextUpdatePromise();
    expect(headings().length).toBe(2);
    expect(navigation.observeHeaders).toHaveBeenCalledTimes(1);
    expect(viewer.pdfDocument.getPage).not.toHaveBeenCalled();
  });

  it("keeps markers unchanged while scrolling without rescanning or measuring pages again", async () => {
    const widget = await create();
    const previousItems = widget.items;
    const setItems = spyOn(widget, "setItems").and.callThrough();
    viewer.pdfViewer.getPageView.calls.reset();
    viewer.viewport.scrollTop = 400;
    for (let index = 0; index < 10; index++) events.emit("view", { location: {} });
    await lumine.views.getNextUpdatePromise();
    expect(setItems).not.toHaveBeenCalled();
    expect(widget.items).toBe(previousItems);
    expect(widget.items.some((item) => item.end !== undefined)).toBe(false);
    expect(navigation.observeHeaders).toHaveBeenCalledTimes(1);
    expect(viewer.pdfViewer.getPageView).not.toHaveBeenCalled();
  });

  it("drops stale document markers on reload and refreshes when hidden views become visible", async () => {
    const widget = await create();
    viewer.pdfDocument = { numPages: 3 };
    events.emit("load");
    await lumine.views.getNextUpdatePromise();
    expect(widget.items.length).toBe(0);
    publish([{ level: 1, pageIndex: 2, children: [] }]);
    await lumine.views.getNextUpdatePromise();
    expect(widget.items[0].prc).toBe(75);
    metrics.width = 0;
    events.emit("view");
    await lumine.views.getNextUpdatePromise();
    expect(widget.items).toEqual([]);
    expect(widget.element.style.visibility).toBe("hidden");
    metrics.width = 600;
    events.emit("view");
    await lumine.views.getNextUpdatePromise();
    expect(widget.items[0].prc).toBe(75);
    expect(widget.element.style.visibility).toBe("");
  });

  it("observes bounded markers for matching pages without requesting text", async () => {
    metrics.total = 5000000;
    metrics.height = 100;
    viewer.pdfDocument.numPages = 10000;
    viewer.searchAdapter.counts = new Array(10000).fill(1);
    viewer.searchAdapter.pending = true;
    viewer.pdfViewer.getPageView.and.callFake((index) => ({
      div: {
        isConnected: true,
        getBoundingClientRect: () => ({
          top: 40 + index * 500 - viewer.viewport.scrollTop,
          height: 500,
        }),
      },
      viewport: { height: 500 },
    }));
    const widget = await create();
    const markers = widget.items.filter((item) => item.cls === "marker-pdf-search");
    expect(markers.length).toBe(100);
    expect(markers.every((item) => item.position === undefined)).toBe(true);
    expect(viewer.searchAdapter.pending).toBe(true);
    expect(viewer.pdfViewer.getPageView.calls.count()).toBeLessThanOrEqual(103);
    expect(viewer.pdfDocument.getPage).not.toHaveBeenCalled();
    viewer.searchAdapter.highlightMatches = false;
    searchEvents.emit("update");
    await lumine.views.getNextUpdatePromise();
    expect(widget.items.some((item) => item.cls === "marker-pdf-search")).toBe(false);
  });

  it("cancels queued rendering and releases all subscriptions on provider withdrawal", async () => {
    const widget = await create();
    const render = spyOn(overview, "render").and.callThrough();
    events.emit("view");
    overview.destroy();
    const schedule = spyOn(overview, "schedule");
    lumine.config.set(MAX_DEPTH_CONFIG, 1);
    await lumine.views.getNextUpdatePromise();
    expect(render).not.toHaveBeenCalled();
    expect(widget.destroyed).toBe(true);
    expect(widget.element.parentNode).toBeNull();
    expect(publish).toBeNull();
    expect(events.listenerCount("view")).toBe(0);
    expect(searchEvents.listenerCount("update")).toBe(0);
    expect(viewer.eventBus.listenerCount("pagerendered")).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("renders through the real widget supplied by the marker-backed service", async () => {
    lumine.config.set(MAX_DEPTH_CONFIG, 2);
    const markerWasActive = Boolean(lumine.packages.getActivePackage("marker"));
    const scrollmapWasActive = Boolean(lumine.packages.getActivePackage("scrollmap"));
    try {
      await lumine.packages.activatePackage("marker");
      const pack = await lumine.packages.activatePackage("scrollmap");
      overview = new PdfScrollmap(viewer, pack.mainModule.provideScrollmapWidget(), navigation);
      overview.simplemap.element.style.cssText =
        "position:absolute;width:8px;height:400px;top:0;right:0";
      await lumine.views.getNextUpdatePromise();
      const widget = overview.simplemap;
      expect(widget.canvas).not.toBeNull();
      expect(widget.element.querySelector("canvas")).not.toBeNull();
      expect(widget.drawnItems.some((item) => item.cls === "marker-pdf-h2")).toBe(true);
      expect(widget.drawnItems.some((item) => item.cls === "marker-pdf-viewport")).toBe(false);
      expect(widget.drawnItems.some((item) => item.end !== undefined)).toBe(false);
    } finally {
      overview?.destroy();
      if (!scrollmapWasActive) await lumine.packages.deactivatePackage("scrollmap");
      if (!markerWasActive) await lumine.packages.deactivatePackage("marker");
    }
  });
});

describe("PDF scrollmap provider edges and pane ownership", () => {
  let main, directory, file, observations, leases;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-overview-owner-"));
    file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 3, outline: [{ title: "First", page: 0 }] }));
    observations = new Set();
    leases = [];
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    for (const lease of leases) lease.dispose();
    await lumine.packages.deactivatePackage("pdf-view");
    await Promise.all([...observations].map((observation) => observation.closed));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("Unsafe PDF overview fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function consume(Widget) {
    const lease = main.consumeScrollmapWidget(Widget);
    leases.push(lease);
    return lease;
  }

  function createViewer() {
    const viewer = main.createViewer(file);
    observations.add(viewer.fileObservation);
    return viewer;
  }

  it("keeps one widget alive until the shared class's last edge retires", () => {
    class Widget extends FakeSimplemap {}
    const baseline = main.owner.scrollmapWidget;
    const first = consume(Widget);
    const viewer = createViewer();
    const overview = main.owner.scrollmaps.get(viewer);
    const second = consume(Widget);
    expect(main.owner.scrollmaps.get(viewer)).toBe(overview);
    expect(viewer.element.querySelectorAll(".pdf-view-scrollmap").length).toBe(1);
    first.dispose();
    expect(main.owner.scrollmaps.get(viewer)).toBe(overview);
    expect(overview.simplemap.destroyed).toBe(false);
    second.dispose();
    expect(overview.destroyed).toBe(true);
    expect(overview.simplemap.element.parentNode).toBeNull();
    expect(main.owner.scrollmapWidget).toBe(baseline);
    if (!baseline) expect(main.owner.scrollmaps.has(viewer)).toBe(false);
  });

  it("restores the latest surviving widget in A-B-A provider order", () => {
    class A extends FakeSimplemap {}
    class B extends FakeSimplemap {}
    const first = consume(A);
    const viewer = createViewer();
    const original = main.owner.scrollmaps.get(viewer);
    const middle = consume(B);
    expect(original.destroyed).toBe(true);
    expect(main.owner.scrollmaps.get(viewer).simplemap.constructor).toBe(B);
    const last = consume(A);
    expect(main.owner.scrollmaps.get(viewer).simplemap.constructor).toBe(A);
    last.dispose();
    expect(main.owner.scrollmaps.get(viewer).simplemap.constructor).toBe(B);
    middle.dispose();
    expect(main.owner.scrollmaps.get(viewer).simplemap.constructor).toBe(A);
    expect(viewer.element.querySelectorAll(".pdf-view-scrollmap").length).toBe(1);
    first.dispose();
  });

  it("keeps a retired provider lease from changing a reactivated owner's maps", async () => {
    class Widget extends FakeSimplemap {}
    const oldLease = consume(Widget);
    const oldViewer = createViewer();
    const oldOwner = main.owner;
    const previous = oldOwner.scrollmaps.get(oldViewer);
    await lumine.packages.deactivatePackage("pdf-view");
    expect(previous.destroyed).toBe(true);
    expect(oldOwner.scrollmaps.size).toBe(0);
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    consume(Widget);
    const viewer = createViewer();
    const current = main.owner.scrollmaps.get(viewer);
    oldLease.dispose();
    expect(main.owner.scrollmaps.get(viewer)).toBe(current);
    expect(current.destroyed).toBe(false);
    expect(viewer.element.querySelectorAll(".pdf-view-scrollmap").length).toBe(1);
  });

  it("owns independent widgets for real pane copies and removes only the closed copy's strip", async () => {
    class Widget extends FakeSimplemap {}
    consume(Widget);
    const original = createViewer();
    original.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(original);
    await original.whenReady();
    const result = await lumine.workspace.copyPaneItem(original, { splitDirection: "right" });
    const copy = result.item;
    observations.add(copy.fileObservation);
    copy.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    copy.layoutChanged();
    await copy.whenReady();
    const originalMap = main.owner.scrollmaps.get(original);
    const copyMap = main.owner.scrollmaps.get(copy);
    expect(copyMap).not.toBe(originalMap);
    expect(copyMap.simplemap.element.parentNode).toBe(copy.element);
    expect(originalMap.simplemap.element.parentNode).toBe(original.element);
    expect(main.owner.scrollmaps.size).toBe(2);
    await copy.destroy();
    expect(copyMap.destroyed).toBe(true);
    expect(main.owner.scrollmaps.has(copy)).toBe(false);
    expect(main.owner.scrollmaps.get(original)).toBe(originalMap);
    expect(originalMap.destroyed).toBe(false);
  }, 15000);
});
it("styles marker layers without requiring a particular overview renderer", async () => {
  const alreadyActive = Boolean(lumine.packages.getActivePackage("pdf-view"));
  await lumine.packages.activatePackage("pdf-view");
  try {
    for (const className of ["marker-pdf-h1", "marker-pdf-h2", "marker-pdf-search"]) {
      const probe = document.createElement("div");
      probe.className = `marker ${className}`;
      document.body.append(probe);
      try {
        probe.style.setProperty("--ui-site-color-1", "rgb(10, 20, 30)");
        probe.style.setProperty("--ui-site-color-2", "rgb(40, 50, 60)");
        const style = getComputedStyle(probe);
        expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
        expect(style.opacity).toBe("1");
        expect(Number(style.zIndex)).toBeGreaterThan(0);
      } finally {
        probe.remove();
      }
    }
  } finally {
    if (!alreadyActive) await lumine.packages.deactivatePackage("pdf-view");
  }
});
