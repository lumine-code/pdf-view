const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: immediate } = require("node:timers/promises");
const { NavigationAdapter } = require("../../lib/navigation");

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

test("bookmark resolution is bounded, deduplicated, and does not request pages", async () => {
  const outline = Array.from({ length: 80 }, (_, index) => ({
    title: `Part ${index}`,
    dest: `section-${index % 20}`,
  }));
  const { item, updates, observe } = fixture(outline);
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
  } finally {
    subscription.dispose();
  }
});

test("returning to a pane reuses document metadata without repeating worker requests", async () => {
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
  const second = adapter.observeHeaders(item, (headers) => {
    secondHeaders = headers;
  });
  try {
    await until(() => secondHeaders[0]?.badge === 3);
    assert.equal(outlineCalls, 1);
    assert.equal(destinationCalls, 1);
    assert.equal(referenceCalls, 1);
    assert.notEqual(firstHeaders, secondHeaders);
    assert.equal(firstHeaders[0].id, secondHeaders[0].id);
  } finally {
    second.dispose();
  }
});

test("reload invalidates old resolutions and does not schedule their remaining bookmarks", async () => {
  const { item, updates, observe } = fixture(
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
    for (const resolve of waiting) resolve([0, { name: "Fit" }]);
    await immediate();
    assert.equal(waiting.length, 4);
    assert.equal(updates.at(-1)[0].text, "Replacement");
  } finally {
    subscription.dispose();
  }
});

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
