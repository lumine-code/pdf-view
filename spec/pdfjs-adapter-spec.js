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

function createFrame({ visible = false, viewState } = {}) {
  const frame = {
    isConnected: true,
    clientWidth: visible ? 1000 : 0,
    clientHeight: visible ? 800 : 0,
    style: {},
    parentElement: { style: {} },
    closest: () => null,
    pdfViewerInitialViewState: viewState,
    getClientRects: () => (frame.clientWidth && frame.clientHeight ? [{}] : []),
  };
  return frame;
}

function createAdapter({ frame } = {}) {
  const messages = [];
  const listeners = new Map();
  const hostListeners = new Map();
  const windowListeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  const diagnostics = [];
  const hostThemeVariables = new Map([["--text-color", "rgb(10, 20, 30)"]]);
  const copiedThemeVariables = new Map();
  const themeObservers = new Set();
  const resizeObservers = [];
  const mutationObservers = [];
  class AdapterResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observe = jasmine.createSpy("observeFrame");
      this.disconnect = jasmine.createSpy("disconnectFrame");
      resizeObservers.push(this);
    }
  }
  class AdapterMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observe = jasmine.createSpy("observeVisibility");
      this.disconnect = jasmine.createSpy("disconnectVisibility");
      mutationObservers.push(this);
    }
  }
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
    close: async () => {
      await app.pdfLoadingTask?.destroy();
      app.pdfLoadingTask = null;
      app.pdfDocument = null;
    },
    load: (pdfDocument) => {
      app.pdfDocument = pdfDocument;
      app.isInitialViewSet = true;
      eventBus.dispatch("pagesinit");
      eventBus.dispatch("documentinit");
    },
    setTitleUsingUrl: (url) => {
      app.url = url;
    },
  };
  const nativeLoad = spyOn(app, "load").and.callThrough();
  const tasks = [];
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: ({ url }) => {
      const task = {
        url,
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({}),
          getOutline: async () => null,
        }),
        destroy: jasmine.createSpy("destroyTask").and.resolveTo(),
      };
      tasks.push(task);
      return task;
    },
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
      frameElement: frame,
      location: { search: "?requestId=7" },
      innerHeight: 600,
      addEventListener: (name, callback) => windowListeners.set(name, callback),
      PDFViewerApplication: app,
      pdfjsLib,
      PDFViewerApplicationOptions: {
        setAll: (values) => Object.assign(options, values),
        getAll: () => ({ ...options }),
      },
    },
    document: {
      documentElement: {
        style: { setProperty: (name, value) => copiedThemeVariables.set(name, value) },
        classList: { toggle() {} },
      },
    },
    parent: {
      ResizeObserver: AdapterResizeObserver,
      MutationObserver: AdapterMutationObserver,
      postMessage: (message) => messages.push(message),
      getComputedStyle: () => ({ getPropertyValue: (name) => hostThemeVariables.get(name) || "" }),
      lumine: {
        themes: {
          onDidChangeVariables(callback) {
            themeObservers.add(callback);
            return { dispose: () => themeObservers.delete(callback) };
          },
        },
      },
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
    hostThemeVariables,
    copiedThemeVariables,
    themeObservers,
    variablesChanged: () => {
      for (const callback of themeObservers) callback();
    },
    tasks,
    pdfjsLib,
    nativeLoad,
    resizeObservers,
    resize: () => {
      for (const observer of resizeObservers) observer.callback();
    },
    mutationObservers,
    mutate: () => {
      for (const observer of mutationObservers) observer.callback();
    },
    send: (data) => windowListeners.get("message")({ source: context.parent, data }),
    diagnosticConsole,
    initialize: async ({ documentReady = true } = {}) => {
      hostListeners.get("webviewerloaded")({ detail: { source: context.window } });
      await flushTasks();
      if (documentReady) eventBus.dispatch("documentinit");
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

  it("copies live host variable changes without a theme switch and stops after teardown", () => {
    expect(adapter.copiedThemeVariables.get("--text-color")).toBe("rgb(10, 20, 30)");
    expect(adapter.themeObservers.size).toBe(1);
    adapter.hostThemeVariables.set("--text-color", "rgb(40, 50, 60)");
    adapter.hostThemeVariables.set("--scrollbar-color", "rgb(70, 80, 90)");
    adapter.variablesChanged();
    expect(adapter.copiedThemeVariables.get("--text-color")).toBe("rgb(40, 50, 60)");
    expect(adapter.copiedThemeVariables.get("--scrollbar-color")).toBe("rgb(70, 80, 90)");
    adapter.destroy();
    expect(adapter.themeObservers.size).toBe(0);
    adapter.hostThemeVariables.set("--text-color", "rgb(90, 80, 70)");
    adapter.variablesChanged();
    expect(adapter.copiedThemeVariables.get("--text-color")).toBe("rgb(40, 50, 60)");
  });

  it("copies input, overlay, selection and focus roles into the iframe", () => {
    const variables = [
      "--input-background-color",
      "--input-border-color",
      "--overlay-background-color",
      "--overlay-border-color",
      "--text-color-selected",
      "--accent-indicator-color",
    ];
    variables.forEach((name, i) => adapter.hostThemeVariables.set(name, `rgb(${i + 1}, 20, 30)`));
    adapter.variablesChanged();
    variables.forEach((name, i) => {
      expect(adapter.copiedThemeVariables.get(name)).toBe(`rgb(${i + 1}, 20, 30)`);
    });
  });

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

  it("preserves a hidden document's saved view and initializes it once layout becomes available", async () => {
    const viewState = {
      page: 2,
      zoom: "1.25",
      left: 5,
      top: 310,
      rotation: 90,
      scrollMode: 0,
      spreadMode: 0,
      sidebarView: 0,
    };
    const frame = createFrame({ viewState });
    adapter = createAdapter({ frame });
    await adapter.initialize({ documentReady: false });
    const pdfDocument = { numPages: 3, getOutline: async () => null };
    const task = { destroy: jasmine.createSpy("destroyDeferred").and.resolveTo() };
    adapter.app.pdfDocument = null;
    adapter.app.pdfLoadingTask = task;
    adapter.app.isInitialViewSet = false;
    adapter.app.pdfViewer.pagesCount = 3;
    const setHash = spyOn(adapter.app.pdfLinkService, "setHash");

    adapter.app.load(pdfDocument);

    expect(adapter.nativeLoad).not.toHaveBeenCalled();
    expect(adapter.app.pdfDocument).toBeNull();
    expect(frame.pdfViewerCaptureViewState()).toBeUndefined();
    expect(adapter.messages.some((message) => message.type === "documentLoaded")).toBe(false);
    expect(adapter.resizeObservers[0].observe).toHaveBeenCalledWith(frame);
    frame.clientWidth = 1000;
    frame.clientHeight = 800;
    adapter.resize();
    await flushTasks();

    expect(adapter.nativeLoad).toHaveBeenCalledOnceWith(pdfDocument);
    expect(adapter.app.pdfDocument).toBe(pdfDocument);
    expect(setHash).toHaveBeenCalledWith("page=2&zoom=125,5,310");
    expect(adapter.messages.filter((message) => message.type === "documentLoaded").length).toBe(1);
    adapter.resize();
    expect(adapter.nativeLoad).toHaveBeenCalledTimes(1);
    expect(task.destroy).not.toHaveBeenCalled();
  });

  it("waits for an attached frame with nonzero layout before initializing the PDF", async () => {
    const frame = createFrame({ visible: true });
    frame.isConnected = false;
    adapter = createAdapter({ frame });
    await adapter.initialize({ documentReady: false });
    const pdfDocument = { numPages: 1, getOutline: async () => null };
    adapter.app.pdfLoadingTask = {};
    adapter.app.load(pdfDocument);
    adapter.resize();
    expect(adapter.nativeLoad).not.toHaveBeenCalled();

    frame.isConnected = true;
    frame.clientHeight = 0;
    adapter.resize();
    expect(adapter.nativeLoad).not.toHaveBeenCalled();

    frame.clientHeight = 800;
    adapter.resize();
    expect(adapter.nativeLoad).toHaveBeenCalledOnceWith(pdfDocument);
  });

  it("resumes from a visibility mutation without waiting for a resize notification", async () => {
    const frame = createFrame();
    adapter = createAdapter({ frame });
    await adapter.initialize({ documentReady: false });
    const pdfDocument = { numPages: 1, getOutline: async () => null };
    adapter.app.pdfLoadingTask = {};
    adapter.app.load(pdfDocument);
    adapter.mutate();
    expect(adapter.nativeLoad).not.toHaveBeenCalled();

    frame.clientWidth = 1000;
    frame.clientHeight = 800;
    adapter.mutate();
    expect(adapter.nativeLoad).toHaveBeenCalledOnceWith(pdfDocument);
    adapter.resize();
    adapter.mutate();
    expect(adapter.nativeLoad).toHaveBeenCalledTimes(1);
  });

  it("discards a deferred document after another loading task takes ownership", async () => {
    const frame = createFrame();
    adapter = createAdapter({ frame });
    await adapter.initialize({ documentReady: false });
    const pdfDocument = { numPages: 1, getOutline: async () => null };
    adapter.app.pdfLoadingTask = {};
    adapter.app.load(pdfDocument);
    adapter.app.pdfLoadingTask = {};
    frame.clientWidth = 1000;
    frame.clientHeight = 800;
    adapter.resize();
    expect(adapter.nativeLoad).not.toHaveBeenCalled();
    expect(adapter.messages.some((message) => message.type === "documentLoaded")).toBe(false);

    const currentDocument = { numPages: 1, getOutline: async () => null };
    adapter.app.load(currentDocument);
    expect(adapter.nativeLoad).toHaveBeenCalledOnceWith(currentDocument);
  });

  it("does not revive a deferred document after closing its loading task", async () => {
    const frame = createFrame();
    adapter = createAdapter({ frame });
    await adapter.initialize({ documentReady: false });
    const task = { destroy: jasmine.createSpy("destroyDeferred").and.resolveTo() };
    adapter.app.pdfLoadingTask = task;
    adapter.app.load({ numPages: 1, getOutline: async () => null });
    await adapter.app.close();
    frame.clientWidth = 1000;
    frame.clientHeight = 800;
    adapter.resize();
    expect(adapter.nativeLoad).not.toHaveBeenCalled();
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("disconnects layout observation and discards deferred loading when the iframe is destroyed", async () => {
    const frame = createFrame();
    adapter = createAdapter({ frame });
    await adapter.initialize({ documentReady: false });
    adapter.app.pdfLoadingTask = {};
    adapter.app.load({ numPages: 1, getOutline: async () => null });
    adapter.destroy();
    frame.clientWidth = 1000;
    frame.clientHeight = 800;
    adapter.resize();
    adapter.mutate();
    expect(adapter.resizeObservers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.mutationObservers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(adapter.nativeLoad).not.toHaveBeenCalled();
    expect(frame.pdfViewerCaptureViewState).toBeUndefined();
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

  it("prepares a replacement without closing the document and resets its view on commit", async () => {
    await adapter.initialize();
    const previous = adapter.app.pdfDocument;
    const oldTask = { destroy: jasmine.createSpy("destroyPrevious").and.resolveTo() };
    adapter.app.pdfLoadingTask = oldTask;
    adapter.app.url = "previous.pdf";
    await adapter.context.prepareDocument({
      filePath: "next.pdf",
      hash: "#page=2&next-tag",
      requestId: 8,
    });
    expect(adapter.app.pdfDocument).toBe(previous);
    expect(oldTask.destroy).not.toHaveBeenCalled();
    expect(adapter.messages.at(-1)).toEqual({ type: "documentPrepared", requestId: 8 });

    await adapter.send({ type: "commitDocument", requestId: 8 });

    expect(adapter.app.pdfDocument).not.toBe(previous);
    expect(adapter.app.initialBookmark).toBe("page=2&next-tag");
    expect(adapter.app.initialRotation).toBe(0);
    expect(adapter.options.defaultZoomValue).toBe("auto");
    expect(adapter.options.scrollModeOnLoad).toBe(0);
    expect(adapter.options.spreadModeOnLoad).toBe(0);
    expect(adapter.messages).toContain({ type: "documentCommitted", requestId: 8 });
    expect(oldTask.destroy).not.toHaveBeenCalled();
    adapter.context.acceptDocument({ requestId: 8 });
    await flushTasks();
    expect(oldTask.destroy).toHaveBeenCalledTimes(1);
  });

  it("cancels preparation and never publishes its late outline or readiness", async () => {
    await adapter.initialize();
    const previous = adapter.app.pdfDocument;
    const loading = deferred();
    const task = {
      promise: loading.promise,
      destroy: jasmine.createSpy("destroy").and.resolveTo(),
    };
    adapter.pdfjsLib.getDocument = () => task;
    const preparing = adapter.context.prepareDocument({ filePath: "cancelled.pdf", requestId: 8 });
    await adapter.context.cancelDocument({ requestId: 8 });
    loading.resolve({
      getPage: async () => ({}),
      getOutline: async () => [{ title: "Cancelled" }],
    });
    await preparing;
    expect(adapter.app.pdfDocument).toBe(previous);
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.messages.at(-1)).toEqual({
      type: "documentCancelled",
      requestId: 8,
      message: undefined,
    });
    expect(adapter.messages.some((message) => message.type === "documentPrepared")).toBe(false);
  });

  it("restores the previous document and view when a committed replacement is cancelled", async () => {
    await adapter.initialize();
    const previous = adapter.app.pdfDocument;
    const oldTask = { destroy: jasmine.createSpy("destroyPrevious").and.resolveTo() };
    adapter.app.pdfLoadingTask = oldTask;
    adapter.app.url = "previous.pdf";
    await adapter.context.prepareDocument({ filePath: "next.pdf", hash: "#page=2", requestId: 8 });
    await adapter.send({ type: "commitDocument", requestId: 8 });
    await adapter.context.cancelDocument({ requestId: 8 });
    expect(adapter.app.pdfDocument).toBe(previous);
    expect(adapter.app.pdfLoadingTask).toBe(oldTask);
    expect(adapter.app.initialBookmark).toBe("page=1&zoom=250,12,350");
    expect(adapter.app.initialRotation).toBe(90);
    expect(oldTask.destroy).not.toHaveBeenCalled();
    expect(adapter.tasks[0].destroy).toHaveBeenCalledTimes(1);
    expect(adapter.messages).toContain({
      type: "documentCancelled",
      requestId: 8,
      message: undefined,
    });
  });

  it("reports preparation failure and keeps the old document", async () => {
    await adapter.initialize();
    const previous = adapter.app.pdfDocument;
    const task = {
      promise: Promise.reject(new Error("Invalid PDF")),
      destroy: jasmine.createSpy("destroy").and.resolveTo(),
    };
    adapter.pdfjsLib.getDocument = () => task;
    await adapter.context.prepareDocument({ filePath: "invalid.pdf", requestId: 8 });
    expect(adapter.app.pdfDocument).toBe(previous);
    expect(adapter.messages.at(-1)).toEqual({
      type: "documentReplacementError",
      requestId: 8,
      message: "Invalid PDF",
    });
    expect(task.destroy).toHaveBeenCalledTimes(1);
  });

  it("declines password-protected documents before replacing the current PDF", async () => {
    await adapter.initialize();
    const previous = adapter.app.pdfDocument;
    const loading = deferred();
    const task = {
      promise: loading.promise,
      destroy: jasmine.createSpy("destroy").and.resolveTo(),
    };
    adapter.pdfjsLib.getDocument = () => task;
    const preparing = adapter.context.prepareDocument({ filePath: "encrypted.pdf", requestId: 8 });
    task.onPassword();
    await flushTasks();
    expect(adapter.app.pdfDocument).toBe(previous);
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(adapter.messages).toContain({
      type: "documentReplacementDeclined",
      requestId: 8,
      message: undefined,
    });
    loading.resolve({ getPage: async () => ({}) });
    await preparing;
  });
});
