const { Disposable } = require("lumine");

describe("PDF outline list", () => {
  let picker, viewer, main;

  const heading = (title, dest, pageIndex, items = []) => ({
    title,
    dest,
    destHash: typeof dest === "string" ? `#${dest}` : undefined,
    resolvedDest: pageIndex == null ? undefined : { pageIndex },
    items,
  });

  function makeViewer(outline = [], outlineLoaded = true) {
    const callbacks = new Set();
    const element = document.createElement("div");
    element.className = "pdf-view";
    element.tabIndex = -1;
    const item = {
      element,
      outline,
      outlineLoaded,
      destroyed: false,
      scrollToDestination: jasmine.createSpy("scrollToDestination"),
      showOutlineList: jasmine.createSpy("showOutlineList"),
      destroy: jasmine.createSpy("destroy"),
      observeOutline(callback) {
        callbacks.add(callback);
        if (this.outlineLoaded) callback(this.outline);
        return new Disposable(() => callbacks.delete(callback));
      },
      publishOutline(nextOutline, loaded = true) {
        this.outline = nextOutline;
        this.outlineLoaded = loaded;
        for (const callback of callbacks) callback(nextOutline);
      },
      getObserverCount: () => callbacks.size,
    };
    lumine.views.getView(lumine.workspace).append(element);
    return item;
  }

  async function show(outline, loaded = true) {
    viewer = makeViewer(outline, loaded);
    picker = new (require("../lib/outline-list"))(viewer);
    await picker.show();
    await lumine.views.getNextUpdatePromise();
    return picker.selectList;
  }

  beforeEach(() => {
    picker = viewer = main = null;
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
  });

  afterEach(async () => {
    picker?.destroy();
    if (main) {
      main.viewers.clear();
      main.deactivate();
    }
    viewer?.element.remove();
    if (picker) await lumine.views.getNextUpdatePromise();
  });

  it("lists actionable nested headings in document order with distinct identities", async () => {
    const first = heading("Repeated title", "first", 0);
    const child = heading("Nested heading", [1, { name: "Fit" }], 1);
    const second = heading("Repeated title", "second", 4, [child]);
    const container = heading("Container", null, null, [first, second]);
    const external = { title: "External website", url: "https://example.com", items: [] };
    const list = await show([container, external]);

    expect(list.getItems().map((row) => row.header)).toEqual([first, second, child]);
    expect(list.getItems().map((row) => row.page)).toEqual([1, 5, 2]);
    expect(new Set(list.getItems().map((row) => row.id)).size).toBe(3);
    expect(list.getElement().textContent).toContain("Page 5");
    expect(list.getElement().textContent).not.toContain("External website");
    expect(viewer.scrollToDestination).not.toHaveBeenCalled();
  });

  it("filters titles and navigates only when the selected heading is confirmed", async () => {
    const introduction = heading("Introduction", "intro", 0);
    const loading = heading("Load combinations", "load", 2);
    const list = await show([introduction, loading]);
    const unrelated = makeViewer([heading("Other document", "other", 0)]);
    spyOn(lumine.workspace, "getActivePaneItem").and.returnValue(unrelated);

    list.getQueryEditor().setText("combin");
    await lumine.views.getNextUpdatePromise();
    expect(list.getFilteredItems().map((row) => row.header)).toEqual([loading]);
    expect(list.getElement().querySelectorAll(".character-match").length).toBeGreaterThan(0);
    await list.selectItemById(list.getItems().find((row) => row.header === loading).id);
    expect(viewer.scrollToDestination).not.toHaveBeenCalled();

    await list.confirmSelection();

    expect(viewer.scrollToDestination).toHaveBeenCalledOnceWith(loading);
    expect(unrelated.scrollToDestination).not.toHaveBeenCalled();
    expect(picker.selectListHost.isVisible()).toBe(false);
    unrelated.element.remove();
  });

  it("shows the empty state for a PDF without an outline", async () => {
    const list = await show(null);

    expect(list.getItems()).toEqual([]);
    expect(list.getElement().textContent).toContain("No headings found");
    await list.confirmSelection();
    expect(viewer.scrollToDestination).not.toHaveBeenCalled();
    expect(picker.selectListHost.isVisible()).toBe(false);
  });

  it("loads headings that arrive after the picker was opened", async () => {
    const list = await show(null, false);
    expect(list.getItems()).toEqual([]);
    expect(list.getElement().textContent).toContain("Loading headings");
    const loaded = heading("Late chapter", "late", 3);

    viewer.publishOutline([loaded]);
    await lumine.views.getNextUpdatePromise();

    expect(list.getItems().map((row) => row.header)).toEqual([loaded]);
    expect(list.getElement().textContent).not.toContain("Loading headings");
    await list.confirmSelection();
    expect(viewer.scrollToDestination).toHaveBeenCalledOnceWith(loaded);
  });

  it("invalidates selected rows when the document clears and replaces its outline", async () => {
    const oldHeading = heading("Chapter", "chapter", 0);
    const list = await show([oldHeading]);
    const oldRow = list.getSelectedItem();

    viewer.publishOutline(null, false);
    await lumine.views.getNextUpdatePromise();
    expect(list.getItems()).toEqual([]);
    picker.goToHeading(oldRow);
    expect(viewer.scrollToDestination).not.toHaveBeenCalled();

    const replacement = heading("Chapter", "chapter", 6);
    viewer.publishOutline([replacement]);
    await lumine.views.getNextUpdatePromise();
    expect(list.getSelectedItem().id).not.toBe(oldRow.id);
    picker.goToHeading(oldRow);
    expect(viewer.scrollToDestination).not.toHaveBeenCalled();
    await list.confirmSelection();
    expect(viewer.scrollToDestination).toHaveBeenCalledOnceWith(replacement);
  });

  it("refuses a pending navigation after its viewer has been destroyed", async () => {
    const list = await show([heading("Chapter", "chapter", 0)]);
    viewer.destroyed = true;

    await list.confirmSelection();

    expect(viewer.scrollToDestination).not.toHaveBeenCalled();
  });

  it("disposes its modal and outline observer", async () => {
    await show([heading("Chapter", "chapter", 0)]);
    const host = picker.selectListHost;
    const panel = host.getPanel();
    expect(viewer.getObserverCount()).toBe(1);

    picker.destroy();
    picker = null;

    expect(host.isDestroyed()).toBe(true);
    expect(viewer.getObserverCount()).toBe(0);
    expect(lumine.workspace.getModalPanels().includes(panel)).toBe(false);
    expect(() => viewer.publishOutline([heading("Later", "later", 1)])).not.toThrow();
  });

  it("cancels through the query editor without navigating and resets the next search", async () => {
    const list = await show([heading("Chapter", "chapter", 0)]);
    list.getQueryEditor().setText("chap");
    await lumine.views.getNextUpdatePromise();

    lumine.commands.dispatch(list.getQueryEditor().getElement(), "core:cancel");

    expect(picker.selectListHost.isVisible()).toBe(false);
    expect(viewer.scrollToDestination).not.toHaveBeenCalled();
    await picker.show();
    expect(list.getQuery()).toBe("");
  });

  jasmine.itWithDocumentFocus("returns focus to the PDF surface after cancellation", async () => {
    viewer = makeViewer([heading("Chapter", "chapter", 0)]);
    viewer.element.focus();
    picker = new (require("../lib/outline-list"))(viewer);
    await picker.show();
    expect(picker.selectList.getElement().contains(document.activeElement)).toBe(true);

    lumine.commands.dispatch(picker.selectList.getQueryEditor().getElement(), "core:cancel");

    expect(document.activeElement).toBe(viewer.element);
  });

  it("registers the list command only on PDF surfaces and resolves the source viewer", () => {
    const pack = lumine.packages.loadPackage("pdf-view");
    pack.requireMainModule();
    main = pack.mainModule;
    main.deactivate();
    main.activate();
    viewer = makeViewer();
    const other = makeViewer();
    main.viewers.add(viewer);
    main.viewers.add(other);
    spyOn(lumine.workspace, "getActivePaneItem").and.returnValue(other);
    const workspace = lumine.views.getView(lumine.workspace);

    lumine.commands.dispatch(workspace, "pdf-view:list");
    expect(viewer.showOutlineList).not.toHaveBeenCalled();
    expect(other.showOutlineList).not.toHaveBeenCalled();

    lumine.commands.dispatch(viewer.element, "pdf-view:list");
    expect(viewer.showOutlineList).toHaveBeenCalledTimes(1);
    expect(other.showOutlineList).not.toHaveBeenCalled();
    lumine.commands.dispatch(other.element, "pdf-view:list");
    expect(other.showOutlineList).toHaveBeenCalledTimes(1);
    other.element.remove();
  });
});
