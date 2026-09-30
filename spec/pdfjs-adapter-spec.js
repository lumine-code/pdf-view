const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { URLSearchParams } = require("url");

// Do not pass Blink callbacks into a Node VM context in the renderer. The
// real iframe suite covers native signals and timers; these stand-ins keep the
// adapter's scheduling and teardown deterministic in both supported runners.
class AdapterAbortController {
  constructor() {
    const listeners = new Set();
    this.signal = {
      aborted: false,
      addEventListener: (_name, callback) => listeners.add(callback),
      removeEventListener: (_name, callback) => listeners.delete(callback),
    };
    this.abort = () => {
      this.signal.aborted = true;
      for (const callback of [...listeners]) callback();
      listeners.clear();
    };
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushTasks() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function createAdapter() {
  const messages = [];
  const listeners = new Map();
  const hostListeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const diagnostics = [];
  const diagnosticConsole = { error: (...values) => diagnostics.push(values) };
  const eventBus = {
    on(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    off(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    dispatch(name, event = {}) {
      for (const callback of [...(listeners.get(name) || [])]) callback(event);
    },
  };
  const options = {};
  const viewport = {
    viewBox: [0, 0, 200, 400],
    width: 200,
    height: 400,
    convertToViewportPoint: (x, y) => [x, 400 - y],
    convertToPdfPoint: (x, y) => [x, 400 - y],
  };
  const app = {
    eventBus,
    initializedPromise: Promise.resolve(),
    isInitialViewSet: true,
    pdfDocument: { numPages: 1, getOutline: async () => null },
    pdfLinkService: { getDestinationHash: () => "#section", setHash() {}, goToDestination() {} },
    pdfViewer: {
      pagesCount: 1,
      currentPageNumber: 1,
      currentScaleValue: "2.5",
      pagesRotation: 90,
      scrollMode: 0,
      spreadMode: 0,
      container: {
        clientLeft: 0,
        clientTop: 0,
        clientWidth: 200,
        clientHeight: 400,
        scrollTop: 0,
        scrollHeight: 400,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 400 }),
      },
      update() {
        eventBus.dispatch("updateviewarea", { location: { pageNumber: 1, left: 12, top: 350 } });
      },
      getPageView: () => ({
        viewport,
        div: {
          getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 200,
            bottom: 400,
            width: 200,
            height: 400,
          }),
        },
      }),
      scrollPageIntoView() {},
    },
    open: async () => {},
  };
  const context = vm.createContext({
    console: diagnosticConsole,
    AbortController: AdapterAbortController,
    URLSearchParams,
    setTimeout: (callback, delay = 0) => {
      const timer = ++nextTimer;
      timers.set(timer, { callback, delay });
      return timer;
    },
    clearTimeout: (timer) => timers.delete(timer),
    window: {
      location: { search: "?requestId=7" },
      innerHeight: 600,
      addEventListener: (name, callback) => windowListeners.set(name, callback),
      PDFViewerApplication: app,
      PDFViewerApplicationOptions: { setAll: (values) => Object.assign(options, values) },
    },
    document: { documentElement: { style: { setProperty() {} }, classList: { toggle() {} } } },
    parent: {
      postMessage: (message) => messages.push(message),
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      document: {
        documentElement: {},
        body: { appendChild() {} },
        addEventListener: (name, callback) => hostListeners.set(name, callback),
        createElement: () => ({ style: {}, offsetWidth: 10, clientWidth: 0, remove() {} }),
      },
    },
  });
  for (const file of ["navigation.js", "viewer.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "..", "lib", "pdfjs", file), "utf8"),
      context,
    );
  }
  return {
    context,
    app,
    options,
    eventBus,
    messages,
    listeners,
    timers,
    diagnostics,
    diagnosticConsole,
    initialize: async () => {
      hostListeners.get("webviewerloaded")({ detail: { source: context.window } });
      await flushTasks();
      eventBus.dispatch("documentinit");
    },
    destroy: () => windowListeners.get("pagehide")(),
  };
}

describe("PDF.js iframe adapter", () => {
  let adapter;
  beforeEach(() => {
    adapter = createAdapter();
  });
  afterEach(() => adapter.destroy());

  it("sets security options before announcing readiness and keeps console diagnostics", async () => {
    await adapter.initialize();
    expect(adapter.options.enableScripting).toBe(false);
    expect(adapter.options.disablePreferences).toBe(true);
    expect(adapter.messages[0].type).toBe("ready");
    expect(adapter.messages[0].requestId).toBe(7);
    expect(adapter.context.console.error).toBe(adapter.diagnosticConsole.error);
    adapter.context.logAdapterError("Diagnostic check", "detail");
    expect(adapter.diagnostics).toEqual([["pdf-view: Diagnostic check", "detail"]]);
  });

  it("discards an old document's outline after a newer pagesinit", async () => {
    await adapter.initialize();
    const oldOutline = deferred();
    adapter.app.pdfDocument.getOutline = () => oldOutline.promise;
    adapter.eventBus.dispatch("pagesinit");
    adapter.app.pdfDocument = {
      numPages: 1,
      getOutline: async () => [{ title: "New document", items: [] }],
    };
    adapter.eventBus.dispatch("pagesinit");
    await flushTasks();
    oldOutline.resolve([{ title: "Old document", items: [] }]);
    await flushTasks();
    const outlines = adapter.messages.filter((message) => message.type === "pdfjsOutline");
    expect(outlines.length).toBe(1);
    expect(outlines[0].outline[0].title).toBe("New document");
  });

  it("serializes refreshes and loads only the latest queued request with the original view", async () => {
    await adapter.initialize();
    const firstOpen = deferred();
    const secondOpen = deferred();
    const urls = [];
    adapter.app.open = ({ url }) => {
      urls.push(url);
      return urls.length === 1 ? firstOpen.promise : secondOpen.promise;
    };
    const refresh = adapter.context.refreshContents({ filePath: "first.pdf", requestId: 8 });
    adapter.context.refreshContents({ filePath: "discarded.pdf", requestId: 9 });
    adapter.context.refreshContents({ filePath: "latest.pdf", requestId: 10 });
    expect(urls).toEqual(["first.pdf"]);
    expect(adapter.app.initialBookmark).toBe("page=1&zoom=250,12,350");
    expect(adapter.app.initialRotation).toBe(90);
    firstOpen.resolve();
    adapter.eventBus.dispatch("documentinit");
    await flushTasks();
    expect(urls).toEqual(["first.pdf", "latest.pdf"]);
    secondOpen.resolve();
    adapter.eventBus.dispatch("pagesinit");
    adapter.eventBus.dispatch("documentinit");
    await refresh;
    expect(adapter.messages.find((message) => message.type === "documentLoaded").requestId).toBe(
      10,
    );
  });

  it("rejects out-of-range positioning without adding a pagesloaded retry listener", async () => {
    await adapter.initialize();
    spyOn(adapter.app.pdfViewer, "scrollPageIntoView");
    adapter.context.scrollToPosition({ page: 100, x: 20, y: 30 });
    adapter.context.scrollToPosition({ page: -1, x: 20, y: 30 });
    expect(adapter.app.pdfViewer.scrollPageIntoView).not.toHaveBeenCalled();
    expect(adapter.listeners.has("pagesloaded")).toBe(false);
  });
});
