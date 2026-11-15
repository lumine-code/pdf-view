const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: immediate } = require("node:timers/promises");
const { NavigationAdapter } = require("../../lib/navigation");
const { getLibrary } = require("../../lib/pdfjs");
const { createPdf } = require("../helpers/pdf-fixture");

function fixture(outline) {
  const callbacks = new Map();
  const watch = (event, callback) => {
    if (!callbacks.has(event)) callbacks.set(event, new Set());
    callbacks.get(event).add(callback);
    return { dispose: () => callbacks.get(event).delete(callback) };
  };
  const item = {
    pdfDocument: { numPages: 100, getOutline: async () => outline },
    getCurrentPage: () => 1,
    getPath: () => "document.pdf",
    whenReady: () => Promise.resolve(),
    onDidLoad: (callback) => watch("load", callback),
    onDidChangeView: (callback) => watch("view", callback),
    onDidDestroy: (callback) => watch("destroy", callback),
    emit(event, data) {
      for (const callback of callbacks.get(event) || []) callback(data);
    },
  };
  const updates = [];
  const notifications = [];
  const observe = () =>
    new NavigationAdapter((candidate) => candidate === item).observeHeaders(
      item,
      (headers, options) => {
        updates.push(headers);
        notifications.push({ headers, options });
      },
    );
  return { item, updates, notifications, observe };
}

async function until(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail("Navigation work did not settle");
}

function attachPageGeometry(item, pageOffsets, { height = 1000, convertY = (y) => 1000 - y } = {}) {
  item.viewport = {
    scrollTop: 0,
    clientHeight: 400,
    clientTop: 2,
    getBoundingClientRect: () => ({ top: 100 }),
  };
  item.pdfViewer = {
    getPageView: (index) =>
      pageOffsets[index] === undefined
        ? null
        : {
            viewport: {
              height,
              convertToViewportPoint: (x, y) => [x, convertY(y)],
            },
            div: {
              isConnected: true,
              getBoundingClientRect: () => ({
                top: 102 + pageOffsets[index] - item.viewport.scrollTop,
                height,
              }),
            },
          },
  };
}

test("bookmark resolution is bounded, deduplicated, and does not request pages", async () => {
  const outline = Array.from({ length: 80 }, (_, index) => ({
    title: `Part ${index}`,
    dest: `section-${index % 20}`,
  }));
  const { item, updates, notifications, observe } = fixture(outline);
  let pending = 0;
  let maximum = 0;
  let namedCalls = 0;
  let referenceCalls = 0;
  item.pdfDocument.getPage = () => assert.fail("Navigation must not load PDF pages");
  item.pdfDocument.getDestination = async (name) => {
    namedCalls++;
    maximum = Math.max(maximum, ++pending);
    await immediate();
    pending--;
    return [{ num: Number(name.split("-")[1]), gen: 0 }, { name: "Fit" }];
  };
  item.pdfDocument.getPageIndex = async ({ num }) => {
    referenceCalls++;
    return num;
  };
  const subscription = observe();
  try {
    await until(
      () => updates.at(-1)?.[79]?.badge !== null && updates.at(-1)?.[79]?.badge !== undefined,
    );
    assert.equal(updates.at(-1).length, 80);
    assert.equal(namedCalls, 20);
    assert.equal(referenceCalls, 20);
    assert.ok(maximum <= 4);
    assert.equal(updates.at(-1)[79].badge, 20);
    assert.ok(notifications.length > 4);
    assert.ok(notifications.slice(0, -1).every(({ options }) => options.loading === true));
    assert.equal(notifications.at(-1).options.loading, false);
    assert.ok(notifications.every(({ options }) => options.instant === undefined));
  } finally {
    subscription.dispose();
  }
});

test("returning to a pane synchronously publishes one complete outline without repeating worker requests", async () => {
  const { item } = fixture([{ title: "Chapter", dest: "chapter" }]);
  let outlineCalls = 0;
  let destinationCalls = 0;
  let referenceCalls = 0;
  item.pdfDocument.getOutline = async () => {
    outlineCalls++;
    return [{ title: "Chapter", dest: "chapter" }];
  };
  item.pdfDocument.getDestination = async () => {
    destinationCalls++;
    return [{ num: 3, gen: 0 }, { name: "Fit" }];
  };
  item.pdfDocument.getPageIndex = async () => {
    referenceCalls++;
    return 2;
  };
  const adapter = new NavigationAdapter((candidate) => candidate === item);
  let firstHeaders;
  const first = adapter.observeHeaders(item, (headers) => {
    firstHeaders = headers;
  });
  await until(() => firstHeaders[0]?.badge === 3);
  first.dispose();
  let secondHeaders;
  const notifications = [];
  const second = adapter.observeHeaders(item, (headers, options) => {
    secondHeaders = headers;
    notifications.push({ headers, options });
  });
  try {
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].options.loading, false);
    assert.equal(secondHeaders[0].badge, 3);
    await immediate();
    assert.equal(notifications.length, 1);
    assert.equal(outlineCalls, 1);
    assert.equal(destinationCalls, 1);
    assert.equal(referenceCalls, 1);
    assert.notEqual(firstHeaders, secondHeaders);
    assert.equal(firstHeaders[0].id, secondHeaders[0].id);
  } finally {
    second.dispose();
  }
});

test("cached outlines rebuild observer-local paths and current state without changing another observer", async () => {
  const { item } = fixture([
    {
      title: "Chapter",
      dest: [0, { name: "Fit" }],
      items: [
        { title: "First", dest: [0, { name: "XYZ" }, 0, 700, null] },
        { title: "Second", dest: [0, { name: "XYZ" }, 0, 300, null] },
      ],
    },
  ]);
  item.location = { pageNumber: 1, top: 550, left: 0 };
  const adapter = new NavigationAdapter(() => true);
  let firstHeaders;
  let complete = false;
  const first = adapter.observeHeaders(item, (headers, options) => {
    firstHeaders = headers;
    complete = options.loading === false;
  });
  await until(() => complete);
  item.location = { pageNumber: 1, top: 200, left: 0 };
  item.getPath = () => "renamed.pdf";
  let nextHeaders;
  const next = adapter.observeHeaders(item, (headers) => (nextHeaders = headers));
  try {
    assert.equal(nextHeaders[0].children[1].currentCount, 1);
    assert.equal(nextHeaders[0].children[0].currentCount, 0);
    assert.equal(nextHeaders[0].stackCount, 1);
    assert.equal(nextHeaders[0].children[1].filePath, "renamed.pdf");
    assert.equal(nextHeaders[0].children[1].parent, nextHeaders[0]);
    assert.equal(firstHeaders[0].children[0].currentCount, 1);
    assert.equal(firstHeaders[0].children[1].currentCount, 0);
    assert.equal(firstHeaders[0].children[1].filePath, "document.pdf");
    assert.notEqual(firstHeaders[0].children[1], nextHeaders[0].children[1]);
    assert.doesNotThrow(() => JSON.stringify(nextHeaders));
  } finally {
    first.dispose();
    next.dispose();
  }
});

test("successful empty outlines are restored synchronously", async () => {
  const { item } = fixture([]);
  const adapter = new NavigationAdapter(() => true);
  let complete = false;
  const first = adapter.observeHeaders(item, (_headers, options) => {
    complete = options.loading === false;
  });
  await until(() => complete);
  first.dispose();
  const notifications = [];
  const next = adapter.observeHeaders(item, (headers, options) =>
    notifications.push({ headers, options }),
  );
  try {
    assert.deepEqual(notifications, [
      { headers: [], options: { loading: false, scrollBoundary: null } },
    ]);
  } finally {
    next.dispose();
  }
});

test("a replacement PDF cannot reuse the completed outline of its previous document", async () => {
  const { item } = fixture([{ title: "Original", dest: [0, { name: "Fit" }] }]);
  const adapter = new NavigationAdapter(() => true);
  let complete = false;
  const first = adapter.observeHeaders(item, (_headers, options) => {
    complete = options.loading === false;
  });
  await until(() => complete);
  first.dispose();
  let resolveOutline;
  item.pdfDocument = {
    numPages: 2,
    getOutline: () => new Promise((resolve) => (resolveOutline = resolve)),
  };
  const notifications = [];
  const next = adapter.observeHeaders(item, (headers, options) =>
    notifications.push({ headers, options }),
  );
  try {
    assert.deepEqual(notifications, [
      { headers: [], options: { loading: true, scrollBoundary: null } },
    ]);
    resolveOutline([{ title: "Replacement", dest: [1, { name: "Fit" }] }]);
    await until(() => notifications.at(-1).options.loading === false);
    assert.equal(notifications.at(-1).headers[0].text, "Replacement");
    assert.equal(notifications.at(-1).headers[0].badge, 2);
    assert.ok(notifications.every(({ headers }) => headers[0]?.text !== "Original"));
  } finally {
    next.dispose();
  }
});

test("disposing an unfinished outline does not cache a partial snapshot", async () => {
  const { item } = fixture([{ title: "Chapter", dest: "chapter" }]);
  let resolveDestination;
  item.pdfDocument.getDestination = () => new Promise((resolve) => (resolveDestination = resolve));
  const adapter = new NavigationAdapter(() => true);
  const first = adapter.observeHeaders(item, () => {});
  await until(() => resolveDestination);
  first.dispose();
  const notifications = [];
  const next = adapter.observeHeaders(item, (headers, options) =>
    notifications.push({ headers, options }),
  );
  try {
    assert.deepEqual(notifications, [
      { headers: [], options: { loading: true, scrollBoundary: null } },
    ]);
    resolveDestination([4, { name: "Fit" }]);
    await until(() => notifications.at(-1).options.loading === false);
    assert.equal(notifications.at(-1).headers[0].badge, 5);
    const count = notifications.length;
    item.destroyed = true;
    item.emit("destroy");
    item.emit("view", { pageNumber: 5 });
    await immediate();
    assert.equal(notifications.length, count);
  } finally {
    next.dispose();
  }
});

test("reload invalidates old resolutions and does not schedule their remaining bookmarks", async () => {
  const { item, updates, notifications, observe } = fixture(
    Array.from({ length: 80 }, (_, index) => ({ title: `Old ${index}`, dest: `old-${index}` })),
  );
  const waiting = [];
  item.pdfDocument.getDestination = () => new Promise((resolve) => waiting.push(resolve));
  const subscription = observe();
  try {
    await until(() => waiting.length === 4);
    item.pdfDocument = {
      numPages: 2,
      getOutline: async () => [{ title: "Replacement", dest: [1, { name: "Fit" }] }],
    };
    item.emit("load");
    await until(() => updates.at(-1)?.[0]?.badge === 2);
    const count = notifications.length;
    for (const resolve of waiting) resolve([0, { name: "Fit" }]);
    await immediate();
    assert.equal(waiting.length, 4);
    assert.equal(updates.at(-1)[0].text, "Replacement");
    assert.equal(notifications.length, count);
    assert.equal(notifications.at(-1).options.loading, false);
  } finally {
    subscription.dispose();
  }
});

for (const failure of [false, true]) {
  test(`completes outline loading after ${failure ? "a worker failure" : "an empty outline"}`, async () => {
    const { item, notifications, observe } = fixture([]);
    item.pdfDocument.getOutline = async () => {
      if (failure) throw new Error("Unreadable outline");
      return null;
    };
    const subscription = observe();
    try {
      assert.equal(notifications[0].options.loading, true);
      await until(() => notifications.at(-1).options.loading === false);
      assert.deepEqual(notifications.at(-1).headers, []);
      assert.ok(notifications.slice(0, -1).every(({ options }) => options.loading === true));
    } finally {
      subscription.dispose();
    }
  });
}

test("destroy invalidates worker results and subscriptions", async () => {
  let resolveOutline;
  const { item, updates, observe } = fixture([]);
  item.pdfDocument.getOutline = () =>
    new Promise((resolve) => {
      resolveOutline = resolve;
    });
  const subscription = observe();
  item.destroyed = true;
  item.emit("destroy");
  const count = updates.length;
  resolveOutline([{ title: "Late", dest: [0, { name: "Fit" }] }]);
  await immediate();
  item.emit("load");
  assert.equal(updates.length, count);
  subscription.dispose();
});

test("named destination navigation waits for readiness and retains panel focus", async () => {
  let resolveReady;
  const { item } = fixture([]);
  item.pdfDocument = null;
  item.whenReady = () =>
    new Promise((resolve) => {
      resolveReady = resolve;
    });
  const destinations = [];
  let focused = 0;
  item.focus = () => focused++;
  const adapter = new NavigationAdapter(() => true);
  const task = adapter.navigateTo(item, { dest: "chapter" }, { focus: false });
  item.pdfDocument = {};
  item.linkService = { goToDestination: async (destination) => destinations.push(destination) };
  resolveReady();
  assert.equal(await task, true);
  assert.deepEqual(destinations, ["chapter"]);
  assert.equal(focused, 0);
});

test("current and ancestor markers follow PDF coordinates, avoiding redundant scroll publications", async () => {
  const { item, updates, notifications, observe } = fixture([
    {
      title: "Chapter",
      dest: [0, { name: "Fit" }],
      items: [
        { title: "First", dest: [0, { name: "XYZ" }, 0, 700, null] },
        { title: "Second", dest: [0, { name: "XYZ" }, 0, 300, null] },
      ],
    },
  ]);
  item.location = { pageNumber: 1, top: 550, left: 0 };
  item.viewport = { scrollTop: 0 };
  const subscription = observe();
  try {
    await until(() => updates.at(-1)?.[0]?.children[1]?.badge === 1);
    const chapter = updates.at(-1)[0];
    assert.equal(chapter.stackCount, 1);
    assert.equal(chapter.children[0].currentCount, 1);
    const count = updates.length;
    item.emit("view", { location: { pageNumber: 1, top: 500, left: 0 } });
    assert.equal(updates.length, count);
    item.viewport.scrollTop = 300;
    item.emit("view", { location: { pageNumber: 1, top: 200, left: 0 } });
    assert.equal(chapter.children[0].currentCount, 0);
    assert.equal(chapter.children[1].currentCount, 1);
    assert.equal(chapter.stackCount, 1);
    const options = notifications.at(-1).options;
    assert.equal(options.instant, undefined);
    assert.equal(options.scrollDirection, 300);
    assert.ok(
      options.stateChanges.some(
        (change) => change.currentCount === 1 && change.path.join(".") === "0.1",
      ),
    );
    assert.doesNotThrow(() => JSON.stringify(updates.at(-1)));
  } finally {
    subscription.dispose();
  }
});

test("tracks leading pages through empty state changes and clears the boundary when the first bookmark enters view", async () => {
  const { item, notifications, observe } = fixture([
    { title: "Chapter", dest: [2, { name: "Fit" }] },
  ]);
  attachPageGeometry(item, [0, 1000, 2000]);
  item.pdfDocument.getPage = () => assert.fail("Navigation must not load PDF pages");
  const subscription = observe();
  try {
    await until(() => notifications.at(-1).options.loading === false);
    const headers = notifications.at(-1).headers;
    assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    assert.equal(headers[0].currentCount, 0);
    assert.equal(headers[0].visibility, 0);
    for (const scrollTop of [100, 500, 1000]) {
      const count = notifications.length;
      item.viewport.scrollTop = scrollTop;
      item.emit("view", { location: { pageNumber: 1, top: 1000, left: 0 } });
      assert.equal(notifications.length, count + 1);
      assert.equal(notifications.at(-1).headers, headers);
      assert.deepEqual(notifications.at(-1).options.stateChanges, []);
      assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    }
    item.viewport.scrollTop = 1600;
    item.emit("view", { location: { pageNumber: 2, top: 400, left: 0 } });
    assert.deepEqual(notifications.at(-1).options.stateChanges, []);
    assert.equal(notifications.at(-1).options.scrollBoundary, null);
    assert.equal(headers[0].currentCount, 0);
    assert.equal(headers[0].visibility, 0);
    const count = notifications.length;
    item.viewport.scrollTop = 1700;
    item.emit("view", { location: { pageNumber: 2, top: 300, left: 0 } });
    assert.equal(notifications.length, count);
  } finally {
    subscription.dispose();
  }
});

test("uses real destination coordinates for a preamble on the first bookmarked page", async () => {
  const { item, notifications, observe } = fixture([
    { title: "Late", dest: [0, { name: "XYZ" }, 0, 100, null] },
    { title: "Earlier", dest: [0, { name: "XYZ" }, 0, 300, null] },
  ]);
  attachPageGeometry(item, [0]);
  item.location = { pageNumber: 1, top: 1000, left: 0 };
  const subscription = observe();
  try {
    await until(() => notifications.at(-1).options.loading === false);
    assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    assert.ok(notifications.at(-1).headers.every((header) => header.visibility === 1));
    item.viewport.scrollTop = 300;
    item.emit("view", { location: { pageNumber: 1, top: 700, left: 0 } });
    assert.equal(notifications.at(-1).options.scrollBoundary, null);
    assert.deepEqual(notifications.at(-1).options.stateChanges, []);
    assert.ok(notifications.at(-1).headers.every((header) => header.currentCount === 0));
    item.viewport.scrollTop = 250;
    item.emit("view", { location: { pageNumber: 1, top: 750, left: 0 } });
    assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    assert.deepEqual(notifications.at(-1).options.stateChanges, []);
  } finally {
    subscription.dispose();
  }
});

test("scales and rotates bookmark positions with the PDF page viewport", async () => {
  const { item, notifications, observe } = fixture([
    { title: "Chapter", dest: [0, { name: "XYZ" }, 0, 300, null] },
  ]);
  attachPageGeometry(item, [0], { height: 2000, convertY: (y) => 2 * y });
  const subscription = observe();
  try {
    await until(() => notifications.at(-1).options.loading === false);
    assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    item.viewport.scrollTop = 200;
    item.emit("view", { location: { pageNumber: 1, top: 0, left: 0 } });
    assert.equal(notifications.at(-1).options.scrollBoundary, null);
  } finally {
    subscription.dispose();
  }
});

for (const [rotation, regionTop] of [
  [180, 100],
  [270, 112],
]) {
  test(`uses the rendered FitR rectangle top with a real ${rotation}-degree PDF viewport`, async () => {
    const document = getLibrary().getDocument({
      data: Uint8Array.from(createPdf()),
      verbosity: 0,
    });
    let subscription;
    try {
      const page = await (await document.promise).getPage(1);
      const viewport = page.getViewport({ scale: 1, rotation });
      const { item, notifications, observe } = fixture([
        { title: "Region", dest: [0, { name: "FitR" }, 100, 100, 500, 700] },
      ]);
      attachPageGeometry(item, [0], { height: viewport.height });
      const pageView = item.pdfViewer.getPageView(0);
      pageView.viewport = viewport;
      item.pdfViewer.getPageView = () => pageView;
      item.viewport.clientHeight = 50;
      const [left, top] = viewport.convertToPdfPoint(0, 0);
      item.location = { pageNumber: 1, left, top };
      subscription = observe();
      await until(() => notifications.at(-1).options.loading === false);
      assert.equal(notifications.at(-1).options.scrollBoundary, "start");
      item.viewport.scrollTop = regionTop;
      const [nextLeft, nextTop] = viewport.convertToPdfPoint(0, regionTop);
      item.emit("view", { location: { pageNumber: 1, left: nextLeft, top: nextTop } });
      assert.equal(notifications.at(-1).options.scrollBoundary, null);
      assert.equal(notifications.at(-1).headers[0].currentCount, 1);
    } finally {
      subscription?.dispose();
      await document.destroy();
    }
  });
}

test("does not scan first-page destinations while the viewport ends outside that page", async () => {
  const { item, notifications, observe } = fixture(
    Array.from({ length: 100 }, (_, index) => ({
      title: `Section ${index}`,
      dest: [1, { name: "XYZ" }, 0, 700, null],
    })),
  );
  attachPageGeometry(item, [0, 1000, 2000]);
  let conversions = 0;
  const getPageView = item.pdfViewer.getPageView;
  item.pdfViewer.getPageView = (index) => {
    const pageView = getPageView(index);
    if (pageView) {
      pageView.viewport.convertToViewportPoint = (x, y) => {
        if (index === 1) conversions++;
        return [x, 1000 - y];
      };
    }
    return pageView;
  };
  const subscription = observe();
  try {
    await until(() => notifications.at(-1).options.loading === false);
    assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    assert.equal(conversions, 0);
    item.viewport.scrollTop = 2200;
    item.emit("view", { location: { pageNumber: 3, top: 800, left: 0 } });
    assert.equal(notifications.at(-1).options.scrollBoundary, null);
    assert.equal(conversions, 0);
  } finally {
    subscription.dispose();
  }
});

test("does not infer a boundary from partial destinations or unavailable page geometry", async () => {
  const { item, notifications, observe } = fixture([
    { title: "Resolved", dest: [2, { name: "Fit" }] },
    { title: "Pending", dest: "chapter" },
  ]);
  attachPageGeometry(item, [0, 1000, 2000]);
  let resolveDestination;
  item.pdfDocument.getDestination = () => new Promise((resolve) => (resolveDestination = resolve));
  const subscription = observe();
  try {
    await until(() => resolveDestination);
    item.emit("view", { location: { pageNumber: 1, top: 1000, left: 0 } });
    assert.ok(notifications.every(({ options }) => options.scrollBoundary === null));
    resolveDestination([4, { name: "Fit" }]);
    await until(() => notifications.at(-1).options.loading === false);
    assert.equal(notifications.at(-1).options.scrollBoundary, "start");
    item.pdfViewer.getPageView = () => null;
    item.emit("view", { location: { pageNumber: 1, top: 1000, left: 0 } });
    assert.equal(notifications.at(-1).options.scrollBoundary, null);
    assert.deepEqual(notifications.at(-1).options.stateChanges, []);
  } finally {
    subscription.dispose();
  }
});
