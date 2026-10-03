const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF.js integration", () => {
  let main, directory, viewer, previousConfig;

  beforeEach(async () => {
    jasmine.useRealClock();
    viewer = null;
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdfjs-integration-")));
    previousConfig = {};
    for (const [key, value] of Object.entries({
      autoRefresh: false,
      autoTime: 0,
      defaultZoom: "page-width",
      defaultSidebar: "none",
    })) {
      previousConfig[key] = lumine.config.get(`pdf-view.${key}`);
      lumine.config.set(`pdf-view.${key}`, value);
    }
    const pack = await lumine.packages.activatePackage("pdf-view");
    main = pack.mainModule;
  });

  afterEach(async () => {
    if (viewer) {
      if (document.activeElement === viewer.frame) viewer.frame.blur();
      const observation = viewer.file;
      viewer.destroy();
      await observation.closed;
    }
    await lumine.packages.deactivatePackage("pdf-view");
    for (const [key, value] of Object.entries(previousConfig))
      lumine.config.set(`pdf-view.${key}`, value);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const application = () => viewer.frame.contentWindow.PDFViewerApplication;
  const waitForDocument = async (previous = null) => {
    await globalThis.conditionPromise(() => {
      const app = application();
      return (
        app?.pdfDocument &&
        app.pdfDocument !== previous &&
        app.isInitialViewSet &&
        viewer.outlineLoaded
      );
    });
    return application();
  };
  const open = async (options = {}, filename = "document.pdf", hash = "") => {
    const file = path.join(directory, filename);
    fs.writeFileSync(file, createPdf(options));
    viewer = main.createViewer(file, hash);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    jasmine.attachToDOM(viewer.element);
    await viewer.whenReady();
    return waitForDocument();
  };

  it("configures the real viewer before initialization and renders through a worker", async () => {
    const app = await open();
    expect(app.pdfViewer.enableScripting).toBe(false);
    expect(app.pdfLinkService.externalLinkTarget).toBe(4);
    expect(app.supportsPrinting).toBe(false);
    expect(app.pdfLoadingTask._worker.port instanceof viewer.frame.contentWindow.Worker).toBe(true);
    await app.pdfViewer.onePageRendered;
    expect(viewer.frame.contentDocument.querySelector(".page canvas")).not.toBeNull();
    const page = await app.pdfDocument.getPage(1);
    const content = await page.getTextContent();
    expect(content.items.map((item) => item.str).join(" ")).toContain("PDF integration page 1");
    expect(viewer.refreshController.loadedDiskFingerprint).not.toBeNull();
  });

  it("loads and refreshes filenames containing URL delimiters", async () => {
    const app = await open({}, "chapter #1 + 50%.pdf");
    const previous = app.pdfDocument;
    fs.writeFileSync(viewer.filePath, createPdf({ pages: 2 }));
    viewer.refreshNow();
    await waitForDocument(previous);
    expect(app.pagesCount).toBe(2);
    expect(app.pdfDocument.numPages).toBe(2);
  });

  it("defers a hidden pane's refresh until it becomes visible", async () => {
    const app = await open();
    const previous = app.pdfDocument;
    const frameWindow = viewer.frame.contentWindow;
    const received = new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.data?.type !== "refresh") return;
        frameWindow.removeEventListener("message", onMessage);
        resolve();
      };
      frameWindow.addEventListener("message", onMessage);
    });
    viewer.element.style.display = "none";
    fs.writeFileSync(viewer.filePath, createPdf({ pages: 2 }));
    viewer.refreshNow();
    await received;
    expect(app.pdfDocument).toBe(previous);
    viewer.element.style.display = "";
    await waitForDocument(previous);
    expect(app.pagesCount).toBe(2);
  });

  it("bounds failed parses and recovers when the file changes again", async () => {
    const app = await open();
    fs.writeFileSync(viewer.filePath, "a stable invalid document");
    viewer.refreshNow();
    await globalThis.conditionPromise(() => viewer.refreshController.loadErrorRetries === 4);
    expect(viewer.refreshController.fileStableTimeout).toBeNull();
    expect(viewer.refreshController.inFlightRequest).toBeNull();
    fs.writeFileSync(viewer.filePath, createPdf({ pages: 2 }));
    viewer.reconcileFile();
    await waitForDocument();
    expect(app.pagesCount).toBe(2);
    expect(viewer.refreshController.loadErrorRetries).toBe(0);
  });

  it("preserves a one-page document's zoom, rotation and scroll position across refresh", async () => {
    const app = await open();
    app.pdfViewer.currentScaleValue = "2.5";
    app.pdfViewer.pagesRotation = 90;
    app.pdfViewer.container.scrollTop = 150;
    app.pdfViewer.container.scrollLeft = 200;
    app.pdfViewer.update();
    expect(app.pdfViewer.pagesRotation).toBe(90);
    const scrollTop = app.pdfViewer.container.scrollTop;
    const scrollLeft = app.pdfViewer.container.scrollLeft;
    expect(scrollTop).toBeGreaterThan(0);
    expect(scrollLeft).toBeGreaterThan(0);
    const previous = app.pdfDocument;
    viewer.refreshNow();
    await waitForDocument(previous);
    expect(app.pdfViewer.currentScale).toBeCloseTo(2.5, 5);
    expect(app.pdfViewer.pagesRotation).toBe(90);
    expect(Math.abs(app.pdfViewer.container.scrollTop - scrollTop)).toBeLessThan(4);
    expect(Math.abs(app.pdfViewer.container.scrollLeft - scrollLeft)).toBeLessThan(4);
  });

  it("resolves encoded named destinations and FitH outline coordinates", async () => {
    const dest = "A&B C++ #50%";
    const app = await open(
      {
        pages: 2,
        outline: [{ title: "Target section", dest, page: 1, top: 700 }],
      },
      "document.pdf",
      `#nameddest=${encodeURIComponent(dest)}`,
    );
    await globalThis.conditionPromise(() => app.page === 2);
    expect(viewer.outline[0].resolvedDest.pageIndex).toBe(1);
    expect(viewer.outline[0].resolvedDest.y).toBe(700);
    expect(viewer.outline[0].resolvedDest.x).toBe(0);
    await globalThis.conditionPromise(() =>
      viewer.visibleDestHashes?.includes(viewer.outline[0].destHash),
    );
    expect(viewer.scrollMapData.items.length).toBe(1);
  });

  it("refreshes documents with a prefix and a long trailing suffix accepted by PDF.js", async () => {
    const app = await open();
    const previous = app.pdfDocument;
    lumine.config.set("pdf-view.autoRefresh", true);
    fs.writeFileSync(
      viewer.filePath,
      createPdf({ pages: 2, prefix: "prefix\n", tail: " ".repeat(1100) }),
    );
    viewer.reconcileFile();
    await waitForDocument(previous);
    expect(app.pdfDocument.numPages).toBe(2);
    expect(viewer.refreshController.loadedDiskFingerprint).not.toBeNull();
  });

  it("reuses the iframe and runtime while resetting document state and publishing its URI", async () => {
    const app = await open({ pages: 3 }, "previous.pdf", "#page=3&old-tag");
    const previous = app.pdfDocument;
    const frame = viewer.frame;
    const src = frame.src;
    const contentWindow = frame.contentWindow;
    const nextPath = path.join(directory, "chapter #2 + 50%.pdf");
    fs.writeFileSync(
      nextPath,
      createPdf({ pages: 2, outline: [{ title: "Next section", page: 1, dest: "A&B" }] }),
    );
    app.pdfViewer.currentScaleValue = "2.5";
    app.pdfViewer.pagesRotation = 90;
    viewer.pauseAutoRefresh();
    viewer.setColorInverted(true);
    const paths = [];
    const uris = [];
    viewer.onDidChangePath((value) => paths.push(value));
    viewer.onDidChangeURI((value) => uris.push(value));
    const oldURI = viewer.getURI();
    const hash = "#nameddest=A%26B&next-tag";

    expect(await viewer.replaceDocument(nextPath, hash)).toBe(true);
    await waitForDocument(previous);

    expect(viewer.frame).toBe(frame);
    expect(viewer.frame.src).toBe(src);
    expect(viewer.frame.contentWindow).toBe(contentWindow);
    expect(application()).toBe(app);
    expect(viewer.getPath()).toBe(nextPath);
    expect(viewer.getURI()).toBe(`${nextPath}${hash}`);
    expect(viewer.serialize().hash).toBe(hash);
    expect(viewer.autoRefreshPausedByBuild).toBe(false);
    expect(paths).toEqual([nextPath]);
    expect(uris).toEqual([{ oldURI, newURI: `${nextPath}${hash}` }]);
    expect(app.pdfViewer.pagesRotation).toBe(0);
    expect(app.pdfViewer.currentScaleValue).toBe("page-width");
    expect(app.pdfViewer.currentPageNumber).toBe(2);
    expect(viewer.outline[0].title).toBe("Next section");
    expect(
      viewer.frame.contentDocument.documentElement.classList.contains("pdf-view-colors-inverted"),
    ).toBe(true);
  });

  it("keeps the loaded PDF and metadata after an invalid replacement", async () => {
    const app = await open({ pages: 2 }, "previous.pdf", "#page=2&old-tag");
    const previous = app.pdfDocument;
    const oldURI = viewer.getURI();
    const nextPath = path.join(directory, "invalid.pdf");
    fs.writeFileSync(nextPath, "This is not a PDF");

    const error = await viewer.replaceDocument(nextPath, "#new-tag").catch((failure) => failure);

    expect(error instanceof Error).toBe(true);
    expect(viewer.getURI()).toBe(oldURI);
    expect(app.pdfDocument).toBe(previous);
    expect(app.pdfViewer.currentPageNumber).toBe(2);
    expect(viewer.documentReplacement.pending).toBe(false);
  });

  it("cancels preparation without replacing the loaded PDF", async () => {
    const app = await open({ pages: 2 }, "previous.pdf", "#page=2");
    const previous = app.pdfDocument;
    const oldURI = viewer.getURI();
    const nextPath = path.join(directory, "next.pdf");
    fs.writeFileSync(nextPath, createPdf({ pages: 3 }));
    const controller = new AbortController();
    const result = viewer.replaceDocument(nextPath, "", { signal: controller.signal });
    const error = result.catch((failure) => failure);
    controller.abort();

    expect((await error).name).toBe("AbortError");
    expect(viewer.getURI()).toBe(oldURI);
    expect(app.pdfDocument).toBe(previous);
    expect(viewer.documentReplacement.pending).toBe(false);
  });

  it("keeps the same iframe when a newer document replaces an aborted request", async () => {
    const app = await open({}, "first.pdf", "#first-tag");
    const frame = viewer.frame;
    const contentWindow = frame.contentWindow;
    const src = frame.src;
    const secondPath = path.join(directory, "second.pdf");
    const thirdPath = path.join(directory, "third.pdf");
    fs.writeFileSync(secondPath, createPdf({ pages: 2 }));
    fs.writeFileSync(thirdPath, createPdf({ pages: 3 }));
    const controller = new AbortController();
    const preparing = viewer.replaceDocument(secondPath, "#second-tag", {
      signal: controller.signal,
    });
    const cancelled = preparing.catch((error) => error);
    controller.abort();
    const newest = viewer.replaceDocument(thirdPath, "#page=3&third-tag");

    expect((await cancelled).name).toBe("AbortError");
    expect(await newest).toBe(true);
    expect(viewer.frame).toBe(frame);
    expect(viewer.frame.contentWindow).toBe(contentWindow);
    expect(viewer.frame.src).toBe(src);
    expect(application()).toBe(app);
    expect(viewer.getURI()).toBe(`${thirdPath}#page=3&third-tag`);
    expect(app.pdfDocument.numPages).toBe(3);
    expect(app.pdfViewer.currentPageNumber).toBe(3);
  });

  it("preserves the loaded document and watcher when staging the next watcher fails", async () => {
    const app = await open({}, "first.pdf", "#first-tag");
    const previousDocument = app.pdfDocument;
    const previousObservation = viewer.file;
    const uri = viewer.getURI();
    const src = viewer.frame.src;
    const nextPath = path.join(directory, "next.pdf");
    fs.writeFileSync(nextPath, createPdf({ pages: 2 }));
    spyOn(lumine.fileWatchClient, "watchFile").and.throwError("Cannot arm watcher");

    const error = await viewer.replaceDocument(nextPath, "#next-tag").catch((failure) => failure);

    expect(error.message).toBe("Cannot arm watcher");
    expect(viewer.getURI()).toBe(uri);
    expect(viewer.file).toBe(previousObservation);
    expect(viewer.frame.src).toBe(src);
    expect(app.pdfDocument).toBe(previousDocument);
    expect(viewer.documentReplacement.pending).toBe(false);
  });

  it("restores the previous PDF when cancelled after the replacement initializes", async () => {
    const app = await open({ pages: 3 }, "first.pdf", "#page=3&first-tag");
    const previousDocument = app.pdfDocument;
    const previousObservation = viewer.file;
    const oldURI = viewer.getURI();
    const frame = viewer.frame;
    const nextPath = path.join(directory, "next.pdf");
    fs.writeFileSync(nextPath, createPdf({ pages: 2 }));
    const controller = new AbortController();
    const replacement = viewer.documentReplacement;
    const handle = replacement.handleMessage.bind(replacement);
    spyOn(replacement, "handleMessage").and.callFake((data) => {
      if (data?.type === "documentCommitted") controller.abort();
      return handle(data);
    });

    const error = await viewer
      .replaceDocument(nextPath, "#page=2", { signal: controller.signal })
      .catch((failure) => failure);

    expect(error.name).toBe("AbortError");
    expect(viewer.getURI()).toBe(oldURI);
    expect(viewer.file).toBe(previousObservation);
    expect(viewer.frame).toBe(frame);
    expect(app.pdfDocument).toBe(previousDocument);
    expect(app.pdfViewer.currentPageNumber).toBe(3);
    expect(replacement.pending).toBe(false);
  });

  it("reuses the pending workspace viewer when a newer open supersedes its replacement", async () => {
    const workspaceElement = lumine.views.getView(lumine.workspace);
    workspaceElement.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    jasmine.attachToDOM(workspaceElement);
    const firstPath = path.join(directory, "first.pdf");
    const secondPath = path.join(directory, "second.pdf");
    const thirdPath = path.join(directory, "third.pdf");
    fs.writeFileSync(firstPath, createPdf());
    fs.writeFileSync(secondPath, createPdf({ pages: 2 }));
    fs.writeFileSync(thirdPath, createPdf({ pages: 3 }));
    viewer = await lumine.workspace.open(firstPath, { pending: true });
    await viewer.whenReady();
    const app = await waitForDocument();
    const frame = viewer.frame;
    const contentWindow = frame.contentWindow;
    const src = frame.src;
    const pane = lumine.workspace.paneForItem(viewer);
    const createViewer = spyOn(main, "createViewer").and.callThrough();

    const superseded = lumine.workspace.open(secondPath, { pending: true });
    await globalThis.conditionPromise(() => viewer.documentReplacement.pending);
    const latest = lumine.workspace.open(`${thirdPath}#page=3`, { pending: true });

    expect(await superseded).toBeUndefined();
    expect(await latest).toBe(viewer);
    expect(createViewer).not.toHaveBeenCalled();
    expect(viewer.getURI()).toBe(`${thirdPath}#page=3`);
    expect(app.pdfViewer.currentPageNumber).toBe(3);
    expect(app.pdfDocument.numPages).toBe(3);
    expect(pane.getPendingItem()).toBe(viewer);
    expect(viewer.frame).toBe(frame);
    expect(viewer.frame.contentWindow).toBe(contentWindow);
    expect(viewer.frame.src).toBe(src);
    expect(application()).toBe(app);
  });
});
