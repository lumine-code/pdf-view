const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF search adapter with the shared find panel", () => {
  let viewer, directory, searchMain, main;

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("pdf-view.autoRefresh", false);
    lumine.config.set("search-panel.scrollToResultOnLiveSearch", false);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-search-"));
    const pack = await lumine.packages.activatePackage("pdf-view");
    main = pack.mainModule;
    jasmine.attachToDOM(lumine.workspace.getElement());
    const file = path.join(directory, "search.pdf");
    fs.writeFileSync(file, createPdf({ pages: 4 }));
    viewer = main.createViewer(file);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    await lumine.packages.activatePackage("language-regex");
    const searchPackage = await lumine.packages.activatePackage("search-panel");
    searchMain = searchPackage.mainModule;
    searchMain.getFindView();
    await conditionPromise(
      () => searchMain.activeTarget?.adapter === viewer.getSearchAdapter(),
      "PDF adapter consumed through search.adapter",
      10000,
    );
  });

  afterEach(async () => {
    searchMain?.findPanel?.hide();
    if (viewer) {
      const observation = viewer.fileObservation;
      await viewer.destroy();
      await observation.closed;
      viewer = null;
    }
    await lumine.packages.deactivatePackage("pdf-view");
    await lumine.packages.deactivatePackage("search-panel");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("uses the real panel options, count, navigation and PDF.js text highlights", async () => {
    const panel = searchMain.getFindView();
    const adapter = main.provideSearchAdapter().getAdapterForItem(viewer);
    expect(panel.target.adapter).toBe(adapter);
    await panel.search("integration", { useRegex: false, caseSensitive: false, wholeWord: true });
    expect(adapter.getResultCount()).toBe(4);
    expect(adapter.isPending()).toBe(false);
    expect(panel.target.canReplace()).toBe(false);
    await panel.findNext();
    await conditionPromise(
      () => viewer.pagesElement.querySelector(".textLayer .highlight.selected"),
      "selected native PDF text highlight",
      15000,
    );
    expect(viewer.pagesElement.querySelector(".textLayer .highlight.selected").textContent).toBe(
      "integration",
    );
    expect(adapter.getCurrentResultIndex()).toBe(0);
    await panel.search("page [24]", { useRegex: true, caseSensitive: true, wholeWord: false });
    expect(adapter.getResultCount()).toBe(2);
    await panel.findNext();
    expect(viewer.getCurrentPage()).toBe(2);
    await panel.findNext();
    expect(viewer.getCurrentPage()).toBe(4);
    expect(adapter.getCurrentResultIndex()).toBe(1);
    await panel.search("pdf", { useRegex: false, caseSensitive: true, wholeWord: true });
    expect(adapter.getResultCount()).toBe(0);
    await panel.search("pdf", { caseSensitive: false });
    expect(adapter.getResultCount()).toBe(4);
    expect(viewer.element.querySelector("input[type=search]")).toBeNull();
  });

  it("refreshes results after document reload and clears highlights on item changes", async () => {
    const panel = searchMain.getFindView();
    const adapter = viewer.getSearchAdapter();
    await panel.search("integration", { useRegex: false, caseSensitive: false, wholeWord: false });
    await panel.findNext();
    const previous = viewer.pdfDocument;
    await viewer.reload();
    await adapter.searchPromise;
    expect(viewer.pdfDocument).not.toBe(previous);
    expect(adapter.getResultCount()).toBe(4);
    await lumine.workspace.open();
    expect(adapter.highlightMatches).toBe(false);
    expect(adapter.getCurrentResultIndex()).toBe(-1);
    expect(adapter.isPending()).toBe(false);
  });
});
