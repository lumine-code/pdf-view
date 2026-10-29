const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const PdfSearchAdapter = require("../../lib/search");

function makeView(pages, options = {}) {
  const events = new EventEmitter();
  const bus = new EventEmitter();
  const reads = [];
  const view = {
    destroyed: false,
    eventBus: {
      on: (event, callback) => bus.on(event, callback),
      off: (event, callback) => bus.off(event, callback),
      dispatch: (event, value) => bus.emit(event, value),
    },
    pdfViewer: { currentPageNumber: options.page || 1 },
    getSelectedText: () => "selection",
    whenReady: () => Promise.resolve(),
    onDidLoad: (callback) => subscribe(events, "load", callback),
    onDidDestroy: (callback) => subscribe(events, "destroy", callback),
    onDidChangeView: (callback) => subscribe(events, "change", callback),
  };
  const document = {
    numPages: pages.length,
    async getPage(number) {
      reads.push(number);
      await options.beforePage?.(number);
      return {
        getTextContent: async () => ({
          items:
            typeof pages[number - 1] === "string"
              ? [{ str: pages[number - 1] }]
              : pages[number - 1],
        }),
      };
    },
  };
  const adapter = new PdfSearchAdapter(view);
  view.pdfDocument = document;
  adapter.setDocument(document);
  return { adapter, document, view, reads, events, bus };
}

function subscribe(events, event, callback) {
  events.on(event, callback);
  return { dispose: () => events.off(event, callback) };
}

test("opening does not extract text; scanning keeps exact counts without occurrence arrays", async () => {
  const { adapter, reads } = makeView(Array.from({ length: 12 }, () => "match ".repeat(1200)));
  assert.deepEqual(reads, []);
  try {
    await adapter.search({ findPattern: "match" });
    assert.equal(adapter.getResultCount(), 14400);
    assert.equal(adapter.isPending(), false);
    assert.equal(adapter.counts.length, 12);
    assert.ok(adapter.cache.size <= 4);
    assert.ok(adapter.pageMatches.filter(Boolean).length <= 6);
    assert.ok(adapter.pageMatches.every((matches) => matches.length <= 201));
  } finally {
    adapter.dispose();
  }
});

test("case, literal, regex and whole-word options match the panel's meanings", async () => {
  const { adapter } = makeView(["Cat cat scatter cat. c.t"]);
  try {
    await adapter.search({ findPattern: "cat", caseSensitive: true, wholeWord: true });
    assert.equal(adapter.getResultCount(), 2);
    await adapter.search({ findPattern: "cat", wholeWord: true });
    assert.equal(adapter.getResultCount(), 3);
    await adapter.search({ findPattern: "c.t" });
    assert.equal(adapter.getResultCount(), 1);
    await adapter.search({ findPattern: "c.t", useRegex: true });
    assert.equal(adapter.getResultCount(), 5);
    let compilations = 0;
    await adapter.search({
      findPattern: "panel-compiled",
      getFindPatternRegex() {
        compilations++;
        return /scatter/gm;
      },
    });
    assert.equal(compilations, 1);
    assert.equal(adapter.getResultCount(), 1);
    await assert.rejects(adapter.search({ findPattern: "[", useRegex: true }), SyntaxError);
    assert.equal(adapter.isPending(), false);
  } finally {
    adapter.dispose();
  }
});

test("empty regular-expression matches terminate and advance by Unicode code points", async () => {
  const { adapter } = makeView(["😀x"]);
  try {
    await adapter.search({
      findPattern: "(?=.)",
      useRegex: true,
      getFindPatternRegex: () => /(?=.)/gu,
    });
    assert.equal(adapter.getResultCount(), 2);
    assert.equal((await adapter.selectNext()).found, true);
    assert.equal(adapter.getCurrentResultIndex(), 0);
    assert.equal(adapter.pageMatchesLength[0][0], 0);
    await adapter.search({ findPattern: "$", useRegex: true });
    assert.equal(adapter.getResultCount(), 1);
  } finally {
    adapter.dispose();
  }
});

test("navigation starts at the visible page, reports exact ordinals and wraps", async () => {
  const { adapter, view } = makeView(["hit", "hit hit", "nothing"], { page: 2 });
  try {
    await adapter.search({ findPattern: "hit" });
    assert.deepEqual(await adapter.selectFirstFromCursor(), { found: true, wrapped: null });
    assert.equal(adapter.getCurrentResultIndex(), 1);
    await adapter.selectNext();
    assert.equal(adapter.getCurrentResultIndex(), 2);
    assert.deepEqual(await adapter.selectNext(), { found: true, wrapped: "up" });
    assert.equal(view.pdfViewer.currentPageNumber, 1);
    assert.equal(adapter.getCurrentResultIndex(), 0);
    assert.deepEqual(await adapter.selectPrevious(), { found: true, wrapped: "down" });
    assert.equal(adapter.getCurrentResultIndex(), 2);
    assert.equal(adapter.canReplace, false);
    assert.equal(adapter.getSelectedText(), "selection");
  } finally {
    adapter.dispose();
  }
});

test("a selected occurrence beyond the highlight budget remains highlighted", async () => {
  const { adapter } = makeView(["hit ".repeat(10000)]);
  try {
    await adapter.search({ findPattern: "hit" });
    adapter.current = { page: 0, ordinal: 9998, index: 39992, length: 3 };
    await adapter.selectNext();
    assert.equal(adapter.getCurrentResultIndex(), 9999);
    assert.equal(adapter.getResultCount(), 10000);
    assert.equal(adapter.pageMatches[0].length, 201);
    assert.equal(adapter.pageMatches[0][adapter.selected.matchIdx], 39996);
  } finally {
    adapter.dispose();
  }
});

test("search newlines map to original PDF text item offsets for highlighting", async () => {
  const { adapter } = makeView([[{ str: "hello", hasEOL: true }, { str: "world" }]]);
  try {
    await adapter.search({ findPattern: "hello\\nworld", useRegex: true });
    assert.equal(adapter.getResultCount(), 1);
    await adapter.selectNext();
    assert.deepEqual(adapter.pageMatches[0], [0]);
    assert.deepEqual(adapter.pageMatchesLength[0], [10]);
  } finally {
    adapter.dispose();
  }
});

test("a new query cancels obsolete scanning without restarting in-flight text extraction", async () => {
  let resume;
  const blocked = new Promise((resolve) => {
    resume = resolve;
  });
  const { adapter, reads } = makeView(["old new new", "new", "old"], {
    beforePage: (number) => (number === 1 ? blocked : null),
  });
  try {
    const first = adapter.search({ findPattern: "old" });
    assert.equal(adapter.isPending(), true);
    const second = adapter.search({ findPattern: "new" });
    resume();
    await Promise.all([first, second]);
    assert.equal(adapter.getResultCount(), 3);
    assert.equal(reads.filter((number) => number === 1).length, 1);
    assert.equal(adapter.isPending(), false);
  } finally {
    adapter.dispose();
  }
});

test("document replacement invalidates old results and repeated setDocument is passive", async () => {
  const { adapter, document } = makeView(["old old"]);
  try {
    await adapter.search({ findPattern: "old" });
    await adapter.selectNext();
    adapter.setDocument(document);
    assert.equal(adapter.getResultCount(), 2);
    assert.equal(adapter.getCurrentResultIndex(), 0);
    adapter.setDocument({
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "new" }] }) }),
    });
    assert.equal(adapter.getResultCount(), 0);
    assert.equal(adapter.getCurrentResultIndex(), -1);
    await adapter.search({ findPattern: "new" });
    assert.equal(adapter.getResultCount(), 1);
  } finally {
    adapter.dispose();
  }
});

test("deactivation and disposal stop obsolete work and release listeners", async () => {
  let resume;
  const blocked = new Promise((resolve) => {
    resume = resolve;
  });
  const { adapter, reads, events, bus } = makeView(["hit", "hit"], { beforePage: () => blocked });
  const searching = adapter.search({ findPattern: "hit" });
  adapter.deactivate();
  resume();
  await searching;
  assert.equal(adapter.getResultCount(), 0);
  assert.equal(adapter.highlightMatches, false);
  assert.deepEqual(reads, [1]);
  adapter.dispose();
  assert.equal(events.eventNames().length, 0);
  assert.equal(bus.eventNames().length, 0);
});

test("destroying a replaced PDF worker does not report a stale extraction error", async () => {
  let rejectOld;
  const blocked = new Promise((_resolve, reject) => {
    rejectOld = reject;
  });
  const { adapter } = makeView(["old"], { beforePage: () => blocked });
  const errors = [];
  adapter.onDidError((error) => errors.push(error));
  try {
    const oldSearch = adapter.search({ findPattern: "old" });
    adapter.setDocument({
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: "new" }] }) }),
    });
    const newSearch = adapter.search({ findPattern: "new" });
    rejectOld(new Error("Worker terminated"));
    await Promise.all([oldSearch, newSearch]);
    assert.equal(adapter.getResultCount(), 1);
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
  }
});

test("scroll modes preserve visible matches and honor percentage zones", async () => {
  const { adapter, view } = makeView(["hit"]);
  view.viewport = {
    scrollTop: 100,
    scrollLeft: 0,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 300, height: 200 }),
  };
  const element = { getBoundingClientRect: () => ({ top: 80, height: 20, left: 10, right: 30 }) };
  try {
    await adapter.search({ findPattern: "hit" });
    await adapter.selectNext({ mode: "nearest" });
    adapter.scrollMatchIntoView({ element, pageIndex: 0, matchIndex: 0 });
    assert.equal(view.viewport.scrollTop, 100);
    await adapter.selectNext({ mode: 50 });
    adapter.scrollMatchIntoView({ element, pageIndex: 0, matchIndex: 0 });
    assert.equal(view.viewport.scrollTop, 90);
  } finally {
    adapter.dispose();
  }
});
