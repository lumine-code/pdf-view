const { NavigationAdapter } = require("../lib/navigation");

describe("PDF navigation adapter", () => {
  let item, updates, subscription;

  beforeEach(() => {
    const listeners = new Map();
    const on = (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return { dispose: () => listeners.get(event).delete(callback) };
    };
    item = {
      pdfDocument: { numPages: 10, getOutline: async () => [] },
      whenReady: () => Promise.resolve(),
      getPath: () => "document.pdf",
      getCurrentPage: () => 1,
      focus: jasmine.createSpy("focus"),
      linkService: { goToDestination: jasmine.createSpy("goToDestination").and.resolveTo() },
      onDidLoad: (callback) => on("load", callback),
      onDidChangeView: (callback) => on("view", callback),
      onDidDestroy: (callback) => on("destroy", callback),
      emit: (event, value) => {
        for (const callback of listeners.get(event) || []) callback(value);
      },
    };
    updates = [];
  });

  afterEach(() => subscription?.dispose());

  function observe() {
    subscription = new NavigationAdapter((candidate) => candidate === item).observeHeaders(
      item,
      (headers) => {
        updates.push(headers);
      },
    );
  }

  it("publishes the original destinations and nested identities without inventing text rows", async () => {
    const explicit = [2, { name: "Fit" }];
    item.pdfDocument.getOutline = async () => [
      { title: "Chapter", dest: "chapter", items: [{ title: "Repeated", dest: explicit }] },
      { title: "Repeated", dest: explicit },
    ];
    item.pdfDocument.getDestination = async () => [0, { name: "Fit" }];
    observe();
    await flushMicrotasks(40);
    const headers = updates.at(-1);
    expect(headers[0].children[0].level).toBe(2);
    expect(headers[0].children[0].id).not.toBe(headers[1].id);
    expect(headers[0].children[0].dest).toBe(explicit);
    expect(headers[0].dest).toBe("chapter");
    expect(headers[0].startPoint).toEqual({ row: 0, column: 0 });
    expect(headers[0].children[0].badge).toBe(3);
    expect(() => JSON.stringify(headers)).not.toThrow();
  });

  it("ignores an old document's outline after replacement", async () => {
    let resolveOld;
    item.pdfDocument.getOutline = () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      });
    observe();
    item.pdfDocument = {
      numPages: 1,
      getOutline: async () => [{ title: "New", dest: [0, { name: "Fit" }] }],
    };
    item.emit("load");
    await flushMicrotasks(40);
    resolveOld([{ title: "Stale", dest: [0, { name: "Fit" }] }]);
    await flushMicrotasks(40);
    expect(updates.at(-1)[0].text).toBe("New");
    expect(updates.some((headers) => headers[0]?.text === "Stale")).toBe(false);
  });

  it("marks the current bookmark and its ancestors from the visible PDF coordinates", async () => {
    item.location = { pageNumber: 1, left: 0, top: 550 };
    item.pdfDocument.getOutline = async () => [
      {
        title: "Chapter",
        dest: [0, { name: "Fit" }],
        items: [
          { title: "Earlier", dest: [0, { name: "XYZ" }, 0, 700, null] },
          { title: "Later", dest: [0, { name: "XYZ" }, 0, 300, null] },
        ],
      },
    ];
    observe();
    await flushMicrotasks(40);
    const chapter = updates.at(-1)[0];
    expect(chapter.stackCount).toBe(1);
    expect(chapter.currentCount).toBe(0);
    expect(chapter.children[0].currentCount).toBe(1);
    expect(chapter.children[1].currentCount).toBe(0);
    item.emit("view", { location: { pageNumber: 1, left: 0, top: 200 } });
    expect(chapter.children[0].currentCount).toBe(0);
    expect(chapter.children[1].currentCount).toBe(1);
  });

  it("does not publish pending work after its observer is disposed", async () => {
    let resolveOutline;
    item.pdfDocument.getOutline = () =>
      new Promise((resolve) => {
        resolveOutline = resolve;
      });
    observe();
    subscription.dispose();
    const previousUpdates = updates.length;
    resolveOutline([{ title: "Too late", dest: [0, { name: "Fit" }] }]);
    await flushMicrotasks(40);
    expect(updates.length).toBe(previousUpdates);
  });

  it("keeps focus in navigation-panel when requested", async () => {
    const adapter = new NavigationAdapter(() => true);
    await adapter.navigateTo(item, { dest: "chapter" }, { focus: false });
    expect(item.linkService.goToDestination).toHaveBeenCalledWith("chapter");
    expect(item.focus).not.toHaveBeenCalled();
    await adapter.navigateTo(item, { dest: "chapter" });
    expect(item.focus).toHaveBeenCalledTimes(1);
  });
});
