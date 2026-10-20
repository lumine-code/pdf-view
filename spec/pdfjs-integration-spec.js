const fs = require("fs");
const os = require("os");
const path = require("path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF.js integration", () => {
  let main, directory, viewer, previousConfig, keyboardBindings;

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
    keyboardBindings?.dispose();
    keyboardBindings = null;
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

  const press = (target, key, modifiers = {}, type = "keydown") => {
    const event = new viewer.frame.contentWindow.KeyboardEvent(type, {
      key,
      code: key.startsWith("Arrow") ? key : key === "Alt" ? "AltLeft" : `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
    target.dispatchEvent(event);
    return event;
  };
  const installPaneBindings = () => {
    const bindings = {};
    for (const direction of ["up", "down", "left", "right"]) {
      bindings[`alt-${direction}`] = `window:focus-pane-${direction}`;
      bindings[`alt-z ${direction}`] = `pane:move-active-item-${direction}`;
      bindings[`alt-z alt-${direction}`] = `pane:split-${direction}-and-move-active-item`;
      bindings[`alt-x ${direction}`] = `pane:copy-active-item-${direction}`;
      bindings[`alt-x alt-${direction}`] = `pane:split-${direction}-and-copy-active-item`;
    }
    keyboardBindings = lumine.keymaps.add("pdf-pane-keyboard-regression", {
      "lumine-workspace": bindings,
    });
  };

  for (const action of ["focus", "move", "copy", "split-move", "split-copy"]) {
    for (const direction of ["up", "down", "left", "right"]) {
      it(`runs ${action} ${direction} from a focused input in the live PDF iframe`, async () => {
        jasmine.attachToDOM(lumine.workspace.getElement());
        await open();
        await lumine.workspace.open(viewer);
        await waitForDocument();
        installPaneBindings();
        const sourcePane = lumine.workspace.paneForItem(viewer);
        const split = action.startsWith("split-");
        let targetPane;
        if (!split) {
          const editor = lumine.workspace.buildTextEditor();
          targetPane = sourcePane[`split${direction[0].toUpperCase()}${direction.slice(1)}`]({
            items: [editor],
          });
        }
        sourcePane.activate();
        viewer.frame.focus();
        const input = viewer.frame.contentDocument.getElementById("pageNumber");
        input.focus();
        expect(viewer.frame.contentDocument.activeElement).toBe(input);
        const app = application();
        const method =
          action === "focus"
            ? "focusPaneInDirection"
            : action.endsWith("move")
              ? "movePaneItem"
              : "copyPaneItem";
        const operation = spyOn(lumine.workspace, method).and.callThrough();
        if (action !== "focus") {
          const prefix = action.endsWith("move") ? "z" : "x";
          expect(press(input, prefix, { altKey: true }).defaultPrevented).toBe(true);
        }
        const suffix = press(input, `Arrow${direction[0].toUpperCase()}${direction.slice(1)}`, {
          altKey: action === "focus" || split,
        });
        expect(suffix.defaultPrevented).toBe(true);
        expect(operation).toHaveBeenCalledTimes(1);
        if (!operation.calls.count()) return;
        const result = await operation.calls.mostRecent().returnValue;
        expect(operation.calls.mostRecent().args[1].sourcePane).toBe(sourcePane);
        if (action === "focus") {
          expect(lumine.workspace.getActivePane()).toBe(targetPane);
        } else {
          expect(result.pane).toBe(split ? lumine.workspace.paneForItem(result.item) : targetPane);
          expect(result.pane.getActiveItem()).toBe(result.item);
          if (action.endsWith("move")) {
            expect(result.item).toBe(viewer);
            expect(application()).toBe(app);
          } else {
            expect(result.item).not.toBe(viewer);
            expect(sourcePane.getItems()).toContain(viewer);
            result.item.frame.blur();
            const observation = result.item.file;
            result.item.destroy();
            await observation.closed;
          }
        }
      });
    }
  }

  it("keeps ordinary editing, an unbound chord suffix and IME input native in the iframe", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await open();
    await lumine.workspace.open(viewer);
    await waitForDocument();
    installPaneBindings();
    const input = viewer.frame.contentDocument.getElementById("pageNumber");
    input.focus();
    const dispatch = spyOn(viewer.element, "dispatchEvent").and.callThrough();
    expect(press(input, "ArrowLeft").defaultPrevented).toBe(false);
    expect(press(input, "a").defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    press(input, "z", { altKey: true });
    expect(press(input, "q").defaultPrevented).toBe(false);
    dispatch.calls.reset();
    expect(press(input, "ArrowRight").defaultPrevented).toBe(false);
    expect(press(input, "a", { isComposing: true }).defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(viewer.frame.contentDocument.activeElement).toBe(input);
  });

  it("completes a keyup binding from the iframe without claiming unrelated key releases", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await open();
    await lumine.workspace.open(viewer);
    await waitForDocument();
    keyboardBindings = lumine.keymaps.add("pdf-pane-keyup-regression", {
      "lumine-workspace": { "alt-z ^alt": "pane:split-right-and-copy-active-item" },
    });
    const input = viewer.frame.contentDocument.getElementById("pageNumber");
    input.focus();
    const copy = spyOn(lumine.workspace, "copyPaneItem").and.callThrough();
    expect(press(input, "z", { altKey: true }).defaultPrevented).toBe(true);
    expect(press(input, "Alt", {}, "keyup").defaultPrevented).toBe(true);
    expect(copy).toHaveBeenCalledTimes(1);
    const { item } = await copy.calls.mostRecent().returnValue;
    item.frame.blur();
    const observation = item.file;
    item.destroy();
    await observation.closed;
    input.focus();
    expect(press(input, "q", {}, "keyup").defaultPrevented).toBe(false);
  });

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

  it("copies the full PDF view and moves the live iframe without rebuilding its document", async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await open({ pages: 3 });
    await lumine.workspace.open(viewer);
    await waitForDocument();
    const app = application();
    app.pdfViewer.pagesRotation = 90;
    app.viewsManager.toggle();
    app.eventBus.dispatch("switchscrollmode", { source: app, mode: 1 });
    app.eventBus.dispatch("switchspreadmode", { source: app, mode: 1 });
    app.pdfLinkService.setHash("page=2&zoom=150,40,650");
    for (let index = 0; index < 3; index++)
      await new Promise((resolve) => requestAnimationFrame(resolve));
    const state = viewer.frame.pdfViewerCaptureViewState();
    const { item: copy } = await lumine.workspace.copyPaneItem(viewer, { splitDirection: "right" });
    try {
      copy.element.style.cssText = viewer.element.style.cssText;
      await copy.whenReady();
      await globalThis.conditionPromise(() => {
        const copied = copy.frame.contentWindow.PDFViewerApplication;
        return copied?.pdfDocument && copied.isInitialViewSet && copy.outlineLoaded;
      }, "copied PDF document");
      const copied = copy.frame.contentWindow.PDFViewerApplication;
      expect(copied).not.toBe(app);
      expect(copied.pdfViewer.pagesRotation).toBe(state.rotation);
      expect(copied.pdfViewer.scrollMode).toBe(state.scrollMode);
      expect(copied.pdfViewer.spreadMode).toBe(state.spreadMode);
      expect(String(copied.pdfViewer.currentScaleValue)).toBe(String(state.zoom));
      const restoredState = copy.frame.pdfViewerCaptureViewState();
      expect(restoredState.page).toBe(state.page);
      expect(Math.abs(restoredState.left - state.left)).toBeLessThanOrEqual(2);
      expect(Math.abs(restoredState.top - state.top)).toBeLessThanOrEqual(2);
      expect(restoredState.sidebarView).toBe(state.sidebarView);
      expect(copied.pdfViewer.currentPageNumber).toBe(app.pdfViewer.currentPageNumber);
      const originalDocument = app.pdfDocument;
      const capture = viewer.frame.pdfViewerCaptureViewState;
      await lumine.workspace.movePaneItem(viewer, { splitDirection: "down" });
      for (let index = 0; index < 3; index++)
        await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(application()).toBe(app);
      expect(app.pdfDocument).toBe(originalDocument);
      expect(viewer.frame.pdfViewerCaptureViewState).toBe(capture);
      viewer.destroy();
      expect(copy.destroyed).toBe(false);
      expect(copy.frame.contentWindow.PDFViewerApplication).toBe(copied);
    } finally {
      copy.destroy();
    }
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

  for (const restored of [false, true]) {
    it(`defers a hidden PDF's ${restored ? "restored" : "initial"} view until it becomes visible`, async () => {
      const viewState = restored
        ? {
            page: 2,
            zoom: "1.5",
            left: 40,
            top: 650,
            rotation: 0,
            scrollMode: 0,
            spreadMode: 0,
            sidebarView: 0,
          }
        : undefined;
      const file = path.join(directory, "hidden.pdf");
      // ViewHistory is keyed by PDF fingerprint, so a fresh path alone does
      // not isolate this document from earlier three-page fixture views.
      fs.writeFileSync(
        file,
        createPdf({
          pages: 3,
          prefix: `% hidden-${restored ? "restored" : "initial"}-${path.basename(directory)}\n`,
        }),
      );
      let viewerConsole;
      let documentInitialized = false;
      let hiddenHost;
      let hiddenStyle;
      const onViewerLoaded = (event) => {
        if (event.detail?.source !== viewer.frame.contentWindow) return;
        const frameWindow = event.detail.source;
        // Install before the adapter initializes: upstream initialization and
        // the adapter's documentinit callback can otherwise log too early.
        viewerConsole = spyOn(frameWindow.console, "error").and.callThrough();
        const app = frameWindow.PDFViewerApplication;
        app.initializedPromise.then(() => {
          app.eventBus.on("documentinit", () => {
            documentInitialized = true;
          });
        });
      };
      const scrollErrors = () =>
        viewerConsole.calls
          .allArgs()
          .filter(([message]) => String(message).includes("offsetParent is not set"));
      document.addEventListener("webviewerloaded", onViewerLoaded);
      try {
        viewer = main.createViewer(file, "", viewState);
        viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
        if (restored) {
          const hiddenClass = `pdfjs-hidden-${path.basename(directory)}`;
          hiddenStyle = document.createElement("style");
          hiddenStyle.textContent = `.${hiddenClass} { display: none; }`;
          document.head.appendChild(hiddenStyle);
          hiddenHost = document.createElement("div");
          hiddenHost.className = hiddenClass;
          hiddenHost.appendChild(viewer.element);
          jasmine.attachToDOM(hiddenHost);
        } else {
          viewer.element.style.display = "none";
          jasmine.attachToDOM(viewer.element);
        }
        await viewer.whenReady();
        await globalThis.conditionPromise(() => application()?.pdfLoadingTask);
        const app = application();
        const pdfDocument = await app.pdfLoadingTask.promise;
        for (let index = 0; index < 8; index++) await Promise.resolve();
        expect(pdfDocument.numPages).toBe(3);
        expect(app.pdfLoadingTask._worker.port instanceof viewer.frame.contentWindow.Worker).toBe(
          true,
        );
        expect(app.pdfViewer.container.offsetParent).toBeNull();
        expect(app.pdfDocument).toBeNull();
        expect(documentInitialized).toBe(false);
        expect(viewer.outlineLoaded).toBe(false);
        expect(app.isInitialViewSet).toBe(false);
        if (restored) expect(viewer.serialize().viewState).toEqual(viewState);
        expect(scrollErrors()).toEqual([]);

        if (restored) hiddenHost.className = "";
        else viewer.element.style.display = "";
        await waitForDocument();
        await app.pdfViewer.onePageRendered;
        for (let index = 0; index < 3; index++)
          await new Promise((resolve) => requestAnimationFrame(resolve));

        expect(documentInitialized).toBe(true);
        expect(app.pdfDocument).toBe(pdfDocument);
        expect(app.pdfViewer.currentPageNumber).toBe(restored ? 2 : 1);
        const captured = viewer.frame.pdfViewerCaptureViewState();
        expect(captured.page).toBe(restored ? 2 : 1);
        expect(String(captured.zoom)).toBe(restored ? "1.5" : "page-width");
        expect(Math.abs(captured.left - (restored ? 40 : 0))).toBeLessThanOrEqual(2);
        expect(Math.abs(captured.top - (restored ? 650 : 792))).toBeLessThanOrEqual(2);
        expect(viewer.frame.contentDocument.querySelector(".page canvas")).not.toBeNull();
        expect(scrollErrors()).toEqual([]);
      } finally {
        document.removeEventListener("webviewerloaded", onViewerLoaded);
        hiddenHost?.remove();
        hiddenStyle?.remove();
      }
    });
  }

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
