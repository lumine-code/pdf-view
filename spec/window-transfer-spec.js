const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF presentation window transfers", () => {
  let directory, viewer;
  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-window-transfer-"));
    lumine.packages.loadPackage(path.resolve(__dirname, ".."));
    await lumine.packages.activatePackage("pdf-view");
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });
  afterEach(async () => {
    viewer?.frame.blur();
    const observation = viewer?.file;
    viewer?.destroy();
    await observation?.closed;
    await lumine.workspace.discardEditorWindows();
    await lumine.packages.deactivatePackage("pdf-view");
    fs.rmSync(directory, { recursive: true, force: true });
    viewer = null;
  });

  it("preserves the PDF model, page, zoom and rotation while remounting the iframe", async () => {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 3 }));
    viewer = await lumine.workspace.open(file);
    viewer.element.style.cssText = "width:800px;height:600px";
    await viewer.whenReady();
    await globalThis.conditionPromise(
      () =>
        viewer.frame.contentWindow.PDFViewerApplication?.isInitialViewSet &&
        viewer.frame.pdfViewerCaptureViewState?.(),
    );
    const app = viewer.frame.contentWindow.PDFViewerApplication;
    app.pdfViewer.currentScaleValue = "1.5";
    app.pdfViewer.pagesRotation = 90;
    app.pdfViewer.currentPageNumber = 2;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const state = viewer.frame.pdfViewerCaptureViewState();
    const pane = lumine.workspace.paneForItem(viewer);
    const fileObservation = viewer.file;
    const frame = viewer.frame;
    const extra = await lumine.workspace.detachPane(pane);
    await globalThis.conditionPromise(
      () => viewer.ready && frame.pdfViewerCaptureViewState?.()?.page === state.page,
    );
    const moved = viewer.frame.contentWindow.PDFViewerApplication;
    expect(lumine.workspace.paneForItem(viewer)).toBe(pane);
    expect(viewer.frame).toBe(frame);
    expect(viewer.file).toBe(fileObservation);
    expect(viewer.element.ownerDocument).toBe(extra.getDocument());
    expect(moved).not.toBe(app);
    expect(moved.pdfViewer.pagesRotation).toBe(90);
    expect(String(moved.pdfViewer.currentScaleValue)).toBe(String(state.zoom));
    await lumine.workspace.attachWindow(extra);
    await globalThis.conditionPromise(
      () => viewer.ready && frame.pdfViewerCaptureViewState?.()?.page === state.page,
    );
    expect(viewer.element.ownerDocument).toBe(document);
    expect(viewer.file).toBe(fileObservation);
  });
  it("restores the PDF document when its auxiliary native host disappears", async () => {
    const file = path.join(directory, "recovery.pdf");
    fs.writeFileSync(file, createPdf({ pages: 3 }));
    viewer = await lumine.workspace.open(file);
    viewer.element.style.cssText = "width:800px;height:600px";
    await viewer.whenReady();
    const extra = await lumine.workspace.detachItem(viewer);
    await globalThis.conditionPromise(
      () => viewer.ready && !!viewer.frame.pdfViewerCaptureViewState?.(),
    );
    viewer.frame.contentWindow.PDFViewerApplication.pdfViewer.currentPageNumber = 2;
    await extra.windowService.close();
    await globalThis.conditionPromise(() => extra.isDestroyed());
    await globalThis.conditionPromise(
      () => viewer.ready && viewer.frame.pdfViewerCaptureViewState?.()?.page === 2,
    );
    expect(viewer.element.ownerDocument).toBe(document);
    expect(lumine.workspace.getPaneItems()).toContain(viewer);
    expect(viewer.frame.pdfViewerCaptureViewState().page).toBe(2);
  });
});
