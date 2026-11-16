const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable, Emitter } = require("lumine");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF viewing while a compiler replaces its output", () => {
  let main, PdfDocument, viewer, directory, subscriptions, gates;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-rebuild-"));
    subscriptions = new CompositeDisposable();
    gates = [];
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    PdfDocument = require("../lib/document");
    lumine.config.set("pdf-view.autoRefresh", false);
  });

  afterEach(async () => {
    for (const release of gates) release();
    subscriptions.dispose();
    if (viewer) {
      const observation = viewer.fileObservation;
      await viewer.destroy();
      await observation.closed;
      viewer = null;
    }
    await lumine.packages.deactivatePackage("pdf-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Unsafe PDF rebuild fixture cleanup.");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function open() {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(
      file,
      createPdf({
        pages: 12,
        pagePadding: 1024 * 1024,
        pageTreeGroupSize: 1,
        outline: [{ title: "Middle", page: 6, dest: "middle" }],
      }),
    );
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:900px;height:600px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    await rendered(1);
    await viewer.fileObservation.ready;
    // A small all-in-memory PDF cannot reproduce a compiler corrupting a later
    // range read. Keep most bytes and the target pages unloaded at this point.
    expect(viewer.document.bytesRead).toBeLessThan(viewer.document.size / 2);
    expect(viewer.pdfViewer.getPageView(6).pdfPage).toBeNull();
    return file;
  }

  async function rendered(pageNumber) {
    await conditionPromise(
      () => viewer.pdfViewer.getPageView(pageNumber - 1)?.renderingState === 3,
      `PDF page ${pageNumber} rendered from disk ranges`,
      15000,
    );
    const page = await viewer.pdfDocument.getPage(pageNumber);
    const text = await page.getTextContent();
    expect(text.items.map((item) => item.str).join(" ")).toContain(`page ${pageNumber}`);
  }

  function scrollToPage(pageNumber) {
    const page = viewer.pdfViewer.getPageView(pageNumber - 1);
    viewer.viewport.scrollTop = page.div.offsetTop + 5;
    viewer.viewport.dispatchEvent(new Event("scroll"));
    viewer.pdfViewer.update();
  }

  function compiler(file) {
    const events = new Emitter();
    const sourcePath = path.join(directory, "document.tex");
    let building = false;
    const payload = {
      id: "rebuild-fixture",
      name: "Rebuild fixture",
      resolveSource: async (pdfPath) => (pdfPath === file ? sourcePath : null),
      canBuild: () => !building,
      build: () => null,
      canToggleCompileOnSave: () => false,
      isCompileOnSaveEnabled: () => false,
      toggleCompileOnSave: () => null,
      isBuilding: (pdfPath) => building && pdfPath === file,
      onDidChangeBuilds: (callback) => events.on("builds", callback),
      onDidChangeSources: (callback) => events.on("sources", callback),
    };
    subscriptions.add(events, main.consumePdfBuildProvider(payload));
    return (active) => {
      building = active;
      events.emit("builds");
    };
  }

  it("keeps uncached pages readable through truncation, deletion and rewriting until the build finishes", async () => {
    const file = await open();
    const building = compiler(file);
    const previous = viewer.document;
    const reportError = spyOn(viewer, "showError").and.callThrough();
    const consoleError = spyOn(console, "error").and.callThrough();
    const reload = spyOn(viewer, "reload").and.callThrough();
    lumine.config.set("pdf-view.autoRefresh", true);
    building(true);
    expect(viewer.builds.size).toBe(1);

    const before = previous.rangesRead;
    fs.truncateSync(file, 0);
    scrollToPage(4);
    await rendered(4);
    expect(previous.rangesRead).toBeGreaterThan(before);

    fs.unlinkSync(file);
    await viewer.linkService.goToDestination("middle");
    await rendered(7);
    expect(viewer.getCurrentPage()).toBe(7);

    fs.writeFileSync(file, createPdf({ pages: 2 }));
    scrollToPage(9);
    await rendered(9);
    expect(viewer.document).toBe(previous);
    expect(previous.closed).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();

    building(false);
    await conditionPromise(
      () => reload.calls.count() === 1,
      "finished build automatic reload",
      15000,
    );
    await reload.calls.mostRecent().returnValue;
    expect(viewer.document).not.toBe(previous);
    expect(viewer.getPageCount()).toBe(2);
    expect(previous.closed).toBe(true);
    await rendered(2);
    expect(reportError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  }, 60000);

  it("keeps the displayed generation usable while a replacement is pending and freezes the replacement's bytes too", async () => {
    const file = await open();
    const previous = viewer.document;
    const consoleError = spyOn(console, "error").and.callThrough();
    let release, candidate;
    const released = new Promise((resolve) => (release = resolve));
    gates.push(release);
    const originalOpen = PdfDocument.prototype.open;
    spyOn(PdfDocument.prototype, "open").and.callFake(async function (...args) {
      const pdf = await originalOpen.apply(this, args);
      if (this.filePath === file && this !== previous) {
        candidate = this;
        await released;
      }
      return pdf;
    });
    fs.writeFileSync(file, createPdf({ pages: 3, pagePadding: 1024 * 1024, pageTreeGroupSize: 1 }));
    const pending = viewer.reload();
    await conditionPromise(() => candidate, "parsed replacement waiting to be installed", 15000);
    fs.truncateSync(file, 0);
    scrollToPage(7);
    await rendered(7);
    expect(viewer.document).toBe(previous);
    expect(previous.closed).toBe(false);

    release();
    await pending;
    expect(viewer.document).toBe(candidate);
    expect(viewer.getPageCount()).toBe(3);
    expect(previous.closed).toBe(true);
    viewer.goToPage(2);
    await rendered(2);
    expect(viewer.error).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  }, 60000);

  it("finishes an old page's in-flight range after a successful swap without cancelling its worker underneath the viewer", async () => {
    const file = await open();
    const previous = viewer.document;
    const consoleError = spyOn(console, "error").and.callThrough();
    const read = previous.read.bind(previous);
    let release,
      rangeStarted = false;
    const released = new Promise((resolve) => (release = resolve));
    gates.push(release);
    previous.read = async (...args) => {
      rangeStarted = true;
      await released;
      return read(...args);
    };
    scrollToPage(7);
    await conditionPromise(() => rangeStarted, "uncached old page waiting on a disk range", 15000);
    expect(previous.pageRequests.size).toBeGreaterThan(0);

    fs.writeFileSync(file, createPdf({ pages: 2 }));
    const pending = viewer.reload();
    await conditionPromise(
      () => viewer.document !== previous && viewer.getPageCount() === 2,
      "replacement installed while the previous page is still loading",
      15000,
    );
    expect(previous.closed).toBe(false);
    release();
    await pending;
    await conditionPromise(() => previous.closed, "retired PDF worker cleanup", 15000);
    await rendered(2);
    expect(consoleError).not.toHaveBeenCalled();
  }, 60000);

  it("keeps reading previously uncached pages and destinations after a replacement fails to parse", async () => {
    const file = await open();
    const previous = viewer.document;
    const consoleError = spyOn(console, "error").and.callThrough();
    fs.writeFileSync(file, "unfinished compiler output");
    await expectAsync(viewer.reload()).toBeRejected();
    expect(viewer.document).toBe(previous);
    expect(previous.closed).toBe(false);
    expect(viewer.error).not.toBeNull();

    const before = previous.rangesRead;
    scrollToPage(4);
    await rendered(4);
    await viewer.linkService.goToDestination("middle");
    await rendered(7);
    expect(previous.rangesRead).toBeGreaterThan(before);
    expect(viewer.getCurrentPage()).toBe(7);
    expect(consoleError).not.toHaveBeenCalled();

    fs.writeFileSync(file, createPdf({ pages: 2 }));
    await viewer.reload();
    expect(viewer.getPageCount()).toBe(2);
    expect(previous.closed).toBe(true);
    expect(viewer.error).toBeNull();
    await rendered(2);
    expect(consoleError).not.toHaveBeenCalled();
  }, 60000);
});
