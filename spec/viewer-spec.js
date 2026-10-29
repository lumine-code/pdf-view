const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("Native PDF view", () => {
  let main, viewer, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-native-"));
    const pack = await lumine.packages.activatePackage("pdf-view");
    main = pack.mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    if (viewer) {
      const observation = viewer.fileObservation;
      await viewer.destroy();
      await observation.closed;
      viewer = null;
    }
    await lumine.packages.deactivatePackage("pdf-view");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function open(options = {}) {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf(options));
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    await conditionPromise(
      () => viewer.pagesElement.querySelector(".page canvas"),
      "first PDF canvas",
      15000,
    );
    return viewer;
  }

  it("renders a real PDF with a worker, selectable text and native toolbar", async () => {
    await open({ pages: 3 });
    expect(viewer.element.querySelector("iframe")).toBeNull();
    expect(viewer.element.querySelector(".pdf-view-controls")).not.toBeNull();
    expect(viewer.getPageCount()).toBe(3);
    expect(Object.prototype.toString.call(viewer.document.task._worker.port)).toBe(
      "[object Worker]",
    );
    expect(viewer.pdfViewer.annotationEditorMode).toBe(-1);
    expect(viewer.pdfViewer.enableScripting).toBe(false);
    await conditionPromise(
      () => viewer.pagesElement.querySelector(".textLayer span"),
      "PDF text layer",
      15000,
    );
    expect(viewer.pagesElement.textContent).toContain("PDF integration page 1");
  });

  it("routes viewing commands to their own surface and preserves state on reload", async () => {
    await open({ pages: 4 });
    lumine.commands.dispatch(viewer.viewport, "pdf-view:last-page");
    expect(viewer.getCurrentPage()).toBe(4);
    lumine.commands.dispatch(viewer.viewport, "pdf-view:rotate-clockwise");
    viewer.setScale(1.5);
    const previous = viewer.pdfDocument;
    await viewer.reload();
    expect(viewer.pdfDocument).not.toBe(previous);
    expect(viewer.getCurrentPage()).toBe(4);
    expect(viewer.pdfViewer.pagesRotation).toBe(90);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.5, 2);
  });

  it("publishes loaded document metadata and retires reload observations", async () => {
    await open({ pages: 3 });
    const changed = jasmine.createSpy("PDF metadata changed");
    const lease = viewer.onDidChangeMetadata(changed);
    try {
      const [section] = await viewer.getMetadata();
      expect(section.id).toBe("pdf");
      expect(section.rows.find((row) => row.id === "pages").value).toBe(3);
      await viewer.reload();
      expect(changed).toHaveBeenCalled();
      lease.dispose();
      changed.calls.reset();
      viewer.emitter.emit("did-load", viewer.pdfDocument);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      lease.dispose();
    }
  });

  it("publishes generic navigation and search adapters without their own panels", async () => {
    await open({
      pages: 3,
      outline: [
        { title: "First", page: 0 },
        { title: "Third", page: 2 },
      ],
    });
    const navigation = main.provideNavigationAdapter();
    let headers = [];
    const subscription = navigation.observeHeaders(viewer, (value) => {
      headers = value;
    });
    try {
      await conditionPromise(() => headers.length === 2, "PDF outline", 10000);
      expect(headers[0].text).toBe("First");
      await navigation.navigateTo(viewer, headers[1], { focus: false });
      expect(viewer.getCurrentPage()).toBe(3);
      const factory = main.provideSearchAdapter();
      expect(factory.handlesItem(viewer)).toBe(true);
      expect(factory.canReplaceItem(viewer)).toBe(false);
      const adapter = factory.getAdapterForItem(viewer);
      await adapter.search({ findPattern: "integration", caseSensitive: false, useRegex: false });
      expect(adapter.getResultCount()).toBe(3);
      await adapter.selectNext();
      expect(adapter.getCurrentResultIndex()).toBeGreaterThanOrEqual(0);
      expect(viewer.element.querySelector("input[type=search]")).toBeNull();
    } finally {
      subscription.dispose();
    }
  });

  it("opens the context menu without invoking SyncTeX and keeps its clicked coordinates", async () => {
    await open();
    const sync = jasmine.createSpy("syncToSource").and.resolveTo(null);
    viewer.getLatexTools = () => ({ syncToSource: sync });
    const page = viewer.pagesElement.querySelector(".page");
    const rect = page.getBoundingClientRect();
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: rect.left + 100,
      clientY: rect.top + 120,
    });
    page.dispatchEvent(event);
    expect(sync).not.toHaveBeenCalled();
    expect(viewer.contextPosition.page).toBe(1);
    lumine.commands.dispatch(page, "pdf-view:synctex");
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync.calls.mostRecent().args[1]).toBe(1);
  });

  it("keeps the previous PDF visible when a reload cannot parse the replacement", async () => {
    await open();
    const previous = viewer.pdfDocument;
    fs.writeFileSync(viewer.getPath(), "not a PDF");
    await expectAsync(viewer.reload()).toBeRejected();
    expect(viewer.pdfDocument).toBe(previous);
    expect(viewer.pagesElement.querySelector("canvas")).not.toBeNull();
    expect(viewer.error).not.toBeNull();
  });

  it("settles an interrupted initialization and releases both document generations", async () => {
    await open();
    const previous = viewer.document;
    const original = viewer.pdfViewer.setDocument.bind(viewer.pdfViewer);
    spyOn(viewer.pdfViewer, "setDocument").and.callFake((pdf) => {
      if (!pdf) original(null);
    });
    const pending = viewer.reload();
    await conditionPromise(
      () => viewer.initializationWait,
      "replacement initialization waiter",
      10000,
    );
    await viewer.destroy();
    await pending;
    expect(previous.closed).toBe(true);
    expect(viewer.document.closed).toBe(true);
  });
});
