// Loaded as a classic script before PDF.js's deferred modules execute.
// Keep the embedding adapter separate from the unmodified upstream viewer.
const pdfNavigation = window.pdfViewNavigation;
let PDFViewerApplication = null;
const lifetime = new AbortController();
let initialized = false;
let documentReady = false;
let documentGeneration = 0;
let requestId = Number(new URLSearchParams(window.location.search).get("requestId")) || 0;
let cachedOutline = null;
let flatOutline = [];
let currentDestTimer = null;
let pendingRefreshData = null;
let refreshInFlight = false;
let refreshView = null;
let lastViewState = null;
let restoringView = null;
let viewLocation = null;
let visibilityObserver = null;
let pendingPosition = null;
let pendingDestination = null;
let documentReplacement = null;
const eventSubscriptions = [];

function postToHost(data) {
  parent.postMessage({ ...data, requestId });
}

function logAdapterError(action, error) {
  console.error(`pdf-view: ${action}`, error);
}

function onViewerEvent(name, callback) {
  PDFViewerApplication.eventBus.on(name, callback);
  eventSubscriptions.push([name, callback]);
}

function configureViewer(event) {
  if (event.detail?.source !== window || PDFViewerApplication) return;
  PDFViewerApplication = window.PDFViewerApplication;
  const options = window.PDFViewerApplicationOptions;
  const sidebar = parent.lumine?.config?.get("pdf-view.defaultSidebar") || "none";
  options.setAll({
    disablePreferences: true,
    sidebarViewOnLoad: { none: 0, thumbs: 1, outline: 2, attachments: 3 }[sidebar] ?? 0,
    defaultZoomValue: parent.lumine?.config?.get("pdf-view.defaultZoom") || "auto",
    enableScripting: false,
    externalLinkTarget: 4,
    disableHistory: true,
    supportsPrinting: false,
    verbosity: 0,
  });
  PDFViewerApplication.initializedPromise.then(initializeAdapter).catch((error) => {
    logAdapterError("Could not initialize the PDF.js adapter", error);
    postToHost({ type: "loadError" });
  });
}

// Generic PDF.js dispatches this at the embedding document before run().
parent.document.addEventListener("webviewerloaded", configureViewer, { signal: lifetime.signal });

function initializeAdapter() {
  if (lifetime.signal.aborted) return;
  initialized = true;
  setupVisibilityObserver();
  onViewerEvent("documenterror", () => {
    documentReady = true;
    postToHost({ type: "loadError" });
    drainRefreshQueue();
    commitPreparedDocument();
  });
  onViewerEvent("pagesinit", onPagesInitialized);
  onViewerEvent("documentinit", () => {
    documentReady = true;
    if (restoringView) {
      const state = restoringView;
      const pdfViewer = PDFViewerApplication.pdfViewer;
      pdfViewer.pagesRotation = state.rotation;
      PDFViewerApplication.eventBus.dispatch("switchscrollmode", {
        source: window,
        mode: state.scrollMode,
      });
      PDFViewerApplication.eventBus.dispatch("switchspreadmode", {
        source: window,
        mode: state.spreadMode,
      });
      PDFViewerApplication.pdfLinkService.setHash(
        pdfNavigation.viewHash(state, pdfViewer.pagesCount),
      );
    }
    if (pendingDestination) {
      const destination = pendingDestination;
      pendingDestination = null;
      scrollToDestination(destination);
    } else if (pendingPosition) {
      const position = pendingPosition;
      pendingPosition = null;
      scrollToPosition(position);
    }
    drainRefreshQueue();
    commitPreparedDocument();
  });
  onViewerEvent("pagechanging", scheduleCurrentDest);
  onViewerEvent("updateviewarea", (event) => {
    viewLocation = event.location;
    scheduleCurrentDest();
  });
  onViewerEvent("rotationchanging", scheduleCurrentDest);
  onViewerEvent("scrollmodechanged", scheduleCurrentDest);
  onViewerEvent("spreadmodechanged", scheduleCurrentDest);
  postToHost({ type: "ready" });
}

async function onPagesInitialized() {
  const pdfDocument = PDFViewerApplication.pdfDocument;
  const generation = ++documentGeneration;
  cachedOutline = null;
  flatOutline = [];
  if (restoringView) {
    PDFViewerApplication.initialBookmark = pdfNavigation.viewHash(
      restoringView,
      pdfDocument.numPages,
    );
    PDFViewerApplication.initialRotation = restoringView.rotation;
  }
  postToHost({ type: "documentLoaded" });
  try {
    const outline = await pdfDocument.getOutline();
    const entries = [];
    if (outline) await enrichItems(outline, pdfDocument, generation, entries);
    if (!isCurrentDocument(pdfDocument, generation)) return;
    cachedOutline = outline;
    flatOutline = entries;
    postToHost({ type: "pdfjsOutline", outline });
    scheduleCurrentDest();
  } catch (error) {
    if (!isCurrentDocument(pdfDocument, generation)) return;
    logAdapterError("Could not read the document outline", error);
    postToHost({ type: "pdfjsOutline", outline: null });
  }
}

function isCurrentDocument(pdfDocument, generation) {
  return (
    !lifetime.signal.aborted &&
    generation === documentGeneration &&
    pdfDocument === PDFViewerApplication.pdfDocument
  );
}

async function enrichItems(items, pdfDocument, generation, entries, level = 0) {
  for (const item of items) {
    if (!isCurrentDocument(pdfDocument, generation)) return;
    entries.push({ item, level });
    if (item.dest) {
      item.destHash = PDFViewerApplication.pdfLinkService.getDestinationHash(item.dest);
      try {
        const dest =
          typeof item.dest === "string" ? await pdfDocument.getDestination(item.dest) : item.dest;
        if (Array.isArray(dest)) {
          const reference = dest[0];
          const index =
            reference && typeof reference === "object"
              ? await pdfDocument.getPageIndex(reference)
              : reference;
          if (pdfNavigation.pageIndex(index, pdfDocument.numPages) !== null) {
            // Keep the destination type until a real page viewport is available.
            item.resolvedDest = { pageIndex: index, destArray: dest };
            const viewport = PDFViewerApplication.pdfViewer.getPageView(index)?.viewport;
            const point = viewport && pdfNavigation.destinationPoint(dest, viewport.viewBox);
            if (point) [item.resolvedDest.x, item.resolvedDest.y] = point;
          }
        }
      } catch (error) {
        // A malformed destination must not discard valid children or the outline.
        if (parent.lumine?.config?.get("pdf-view.debug")) {
          logAdapterError("Could not resolve an outline destination", error);
        }
      }
    }
    if (item.items?.length) {
      await enrichItems(item.items, pdfDocument, generation, entries, level + 1);
    }
  }
}

function scheduleCurrentDest() {
  if (currentDestTimer !== null) return;
  currentDestTimer = setTimeout(() => {
    currentDestTimer = null;
    spawnCurrentDest();
  });
}

function spawnCurrentDest() {
  if (!initialized || !cachedOutline) return;
  const pdfViewer = PDFViewerApplication.pdfViewer;
  const container = pdfViewer.container;
  const bounds = container.getBoundingClientRect();
  const viewportRect = {
    left: bounds.left + container.clientLeft,
    top: bounds.top + container.clientTop,
    right: bounds.left + container.clientLeft + container.clientWidth,
    bottom: bounds.top + container.clientTop + container.clientHeight,
  };
  const pageGeometry = new Map();
  const visiblePages = [];
  for (let index = 0; index < pdfViewer.pagesCount; index++) {
    const pageView = pdfViewer.getPageView(index);
    if (!pageView?.div || !pageView.viewport) continue;
    const rect = pageView.div.getBoundingClientRect();
    pageGeometry.set(index, { pageView, rect });
    const range = pdfNavigation.visiblePageRange(rect, viewportRect, pageView.viewport);
    if (range) visiblePages.push({ index, ...range });
  }
  const positions = [];
  for (const { item, level } of flatOutline) {
    const resolved = item.resolvedDest;
    const geometry = pageGeometry.get(resolved?.pageIndex);
    if (!geometry) continue;
    const { pageView, rect } = geometry;
    const point = pdfNavigation.destinationPoint(resolved.destArray, pageView.viewport.viewBox);
    const rendered = pdfNavigation.viewportDestination(resolved.destArray, pageView.viewport);
    if (!point || !rendered) continue;
    resolved.x = point[0];
    resolved.y = point[1];
    positions.push({
      item,
      level,
      page: resolved.pageIndex,
      progress: pdfNavigation.pageProgress(point[1], pageView.viewport.viewBox),
      y: rect.top - viewportRect.top + container.scrollTop + rendered[1],
    });
  }
  const visibleHashes = pdfNavigation.visibleSections(positions, visiblePages);
  postToHost({ type: "visibleOutlineItems", destHash: visibleHashes });
  const toolbarHeight = viewportRect.top;
  const iframeHeight = window.innerHeight;
  const toolbarPercent = iframeHeight ? (toolbarHeight / iframeHeight) * 100 : 0;
  const contentPercent = iframeHeight ? (container.clientHeight / iframeHeight) * 100 : 100;
  const documentProgress = pdfViewer.scrollMode === 1 || pdfViewer.scrollMode === 3;
  const items = positions.map((position) => {
    const fraction = documentProgress
      ? (position.page + position.progress) / pdfViewer.pagesCount
      : position.y / Math.max(1, container.scrollHeight);
    return {
      percent: Math.max(0, Math.min(100, toolbarPercent + fraction * contentPercent)),
      page: position.page,
      x: position.item.resolvedDest.x,
      y: position.item.resolvedDest.y,
      level: position.level,
      isCurrent: visibleHashes.includes(position.item.destHash),
    };
  });
  postToHost({
    type: "scrollMapData",
    items,
    scrollPercent: documentProgress
      ? ((pdfViewer.currentPageNumber - 1) / Math.max(1, pdfViewer.pagesCount)) * 100
      : (container.scrollTop / Math.max(1, container.scrollHeight)) * 100,
  });
}

// Copy host theme variables via CSSOM, which the upstream CSP permits.
const THEME_VARS = [
  "--text-color",
  "--text-color-selected",
  "--input-background-color",
  "--input-border-color",
  "--overlay-background-color",
  "--overlay-border-color",
  "--accent-indicator-color",
  "--app-background-color",
  "--tab-background-color-active",
  "--pane-item-border-color",
  "--background-color-highlight",
  "--background-color-selected",
  "--ui-font-family",
  "--scrollbar-color",
  "--scrollbar-background-color",
];
function syncThemeVars() {
  try {
    const hostStyle = parent.getComputedStyle(parent.document.documentElement);
    for (const name of THEME_VARS) {
      const value = hostStyle.getPropertyValue(name).trim();
      if (value) document.documentElement.style.setProperty(name, value);
    }
    const probe = parent.document.createElement("div");
    probe.style.cssText =
      "position: absolute; top: -9999px; width: 100px; height: 100px; overflow: scroll;";
    const host = parent.lumine?.workspace?.getElement?.() || parent.document.body;
    try {
      host.appendChild(probe);
      document.documentElement.style.setProperty(
        "--pdf-scrollbar-width",
        `${probe.offsetWidth - probe.clientWidth || 10}px`,
      );
    } finally {
      probe.remove();
    }
  } catch (error) {
    logAdapterError("Could not synchronize the editor theme", error);
  }
}
syncThemeVars();
const themeSubscription = parent.lumine?.themes?.onDidChangeVariables?.(syncThemeVars);

function isHiddenInHost() {
  const frame = window.frameElement;
  return (
    !!frame && (frame.style.display === "none" || frame.parentElement?.style.display === "none")
  );
}

function setupVisibilityObserver() {
  const wrapper = window.frameElement?.parentElement;
  if (!wrapper) return;
  visibilityObserver = new MutationObserver(() => {
    if (!isHiddenInHost()) drainRefreshQueue();
  });
  visibilityObserver.observe(wrapper, { attributes: true, attributeFilter: ["style"] });
}

window.addEventListener(
  "pagehide",
  () => {
    lifetime.abort();
    destroyReplacementTasks();
    themeSubscription?.dispose();
    visibilityObserver?.disconnect();
    clearTimeout(currentDestTimer);
    for (const [name, callback] of eventSubscriptions)
      PDFViewerApplication.eventBus.off(name, callback);
  },
  { once: true },
);

// Send click event to parent to activate pane
window.addEventListener(
  "mousedown",
  (event) => {
    postToHost({ type: "click", button: event.button });
  },
  true,
);

window.addEventListener(
  "keydown",
  (event) => {
    if (isEditableTarget(event) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      return;
    }

    const handled = window.frameElement?.pdfViewerRedispatchKeyboardEvent?.(event);
    if (!handled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  },
  true,
);

function isEditableTarget(event) {
  const target = event.target;
  if (!target) return false;
  return !!target.closest?.(
    "input, textarea, select, [contenteditable=''], [contenteditable='true']",
  );
}

window.addEventListener(
  "contextmenu",
  (event) => {
    if (!initialized || !documentReady || refreshInFlight) return;
    const page = event.target.closest?.("div.page");
    const pageNo = Number(page?.getAttribute("data-page-number"));
    const pdfViewer = PDFViewerApplication.pdfViewer;
    if (pdfNavigation.pageIndex(pageNo - 1, pdfViewer.pagesCount) === null) return;
    const pageView = pdfViewer.getPageView(pageNo - 1);
    const bounds = (page.querySelector("canvas") || page).getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const viewport = pageView.viewport;
    const [pdfX, pdfY] = viewport.convertToPdfPoint(
      ((event.clientX - bounds.left) * viewport.width) / bounds.width,
      ((event.clientY - bounds.top) * viewport.height) / bounds.height,
    );
    postToHost({
      type: "contextmenu",
      pageNo,
      x: Math.round(pdfX - viewport.viewBox[0]),
      y: Math.round(viewport.viewBox[3] - pdfY),
    });
  },
  true,
);

window.addEventListener("message", (message) => {
  if (message.source !== parent || !message.data || typeof message.data !== "object") {
    return;
  } else if (message.data.type === "refresh") {
    return refreshContents(message.data);
  } else if (message.data.type === "prepareDocument") {
    return prepareDocument(message.data);
  } else if (message.data.type === "commitDocument") {
    if (documentReplacement?.requestId !== message.data.requestId) return;
    documentReplacement.commitRequested = true;
    return commitPreparedDocument();
  } else if (message.data.type === "cancelDocument") {
    return cancelDocument(message.data);
  } else if (message.data.type === "acceptDocument") {
    return acceptDocument(message.data);
  } else if (message.data.type === "setposition") {
    pendingDestination = null;
    return scrollToPosition(message.data);
  } else if (message.data.type === "setdestination") {
    pendingPosition = null;
    return scrollToDestination(message.data);
  } else if (message.data.type === "set-color-inverted") {
    return setColorInverted(message.data.value);
  } else if (message.data.type === "currentdest") {
    return spawnCurrentDest(message.data);
  } else if (message.data.type === "command") {
    return runViewerCommand(message.data.command);
  }
});

function refreshContents(data) {
  pendingRefreshData = data;
  return drainRefreshQueue();
}

function captureView() {
  const viewer = PDFViewerApplication.pdfViewer;
  // update() refreshes the public updateviewarea location before closing the
  // document. Its coordinates are PDF points and preserve zoom presets too.
  viewer.update();
  return {
    page: viewLocation?.pageNumber || viewer.currentPageNumber || 1,
    zoom: viewer.currentScaleValue || parent.lumine?.config?.get("pdf-view.defaultZoom") || "auto",
    left: viewLocation?.left,
    top: viewLocation?.top,
    rotation: viewer.pagesRotation,
    scrollMode: viewer.scrollMode,
    spreadMode: viewer.spreadMode,
    sidebarView: PDFViewerApplication.viewsManager?.visibleView ?? 0,
  };
}

function waitForDocumentInit() {
  const eventBus = PDFViewerApplication.eventBus;
  let complete;
  let timer;
  const promise = new Promise((resolve) => {
    complete = resolve;
  });
  const finish = (loaded) => {
    clearTimeout(timer);
    eventBus.off("documentinit", onInit);
    eventBus.off("documenterror", onError);
    lifetime.signal.removeEventListener("abort", onAbort);
    complete(loaded);
  };
  const onInit = () => finish(true);
  const onError = () => finish(false);
  const onAbort = () => finish(false);
  eventBus.on("documentinit", onInit);
  eventBus.on("documenterror", onError);
  lifetime.signal.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => finish(false), 15000);
  return { promise, cancel: onAbort };
}

async function drainRefreshQueue() {
  if (
    !initialized ||
    !documentReady ||
    !pendingRefreshData ||
    refreshInFlight ||
    documentReplacement ||
    isHiddenInHost() ||
    lifetime.signal.aborted
  )
    return;
  refreshInFlight = true;
  try {
    if (PDFViewerApplication.pdfDocument && PDFViewerApplication.isInitialViewSet) {
      lastViewState = captureView();
    }
    refreshView = lastViewState || captureView();
    while (pendingRefreshData && !isHiddenInHost() && !lifetime.signal.aborted) {
      const data = pendingRefreshData;
      pendingRefreshData = null;
      requestId = Number.isInteger(data.requestId) ? data.requestId : requestId;
      ++documentGeneration;
      cachedOutline = null;
      flatOutline = [];
      viewLocation = null;
      documentReady = false;
      restoringView = refreshView;
      const options = window.PDFViewerApplicationOptions;
      options.setAll({
        scrollModeOnLoad: refreshView.scrollMode,
        spreadModeOnLoad: refreshView.spreadMode,
        sidebarViewOnLoad: refreshView.sidebarView,
      });
      PDFViewerApplication.initialBookmark = pdfNavigation.viewHash(
        refreshView,
        PDFViewerApplication.pagesCount,
      );
      PDFViewerApplication.initialRotation = refreshView.rotation;
      const initializedDocument = waitForDocumentInit();
      try {
        await PDFViewerApplication.open({ url: data.filePath });
        if (!(await initializedDocument.promise) && !lifetime.signal.aborted) {
          logAdapterError("Timed out waiting for the refreshed document", new Error(data.filePath));
        }
      } catch (error) {
        logAdapterError("Could not refresh the PDF", error);
      } finally {
        initializedDocument.cancel();
        restoringView = null;
      }
    }
  } finally {
    refreshInFlight = false;
    refreshView = null;
    commitPreparedDocument();
  }
}

function postReplacement(record, type, extra = {}) {
  parent.postMessage({ type, requestId: record.requestId, ...extra });
}

async function destroyTask(task) {
  try {
    await task?.destroy();
  } catch (error) {
    if (!lifetime.signal.aborted) logAdapterError("Could not release a PDF document", error);
  }
}

async function prepareDocument(data) {
  if (!initialized || lifetime.signal.aborted || !Number.isInteger(data.requestId)) return;
  if (documentReplacement) {
    postReplacement(data, "documentReplacementError", { message: "A PDF is already being opened" });
    return;
  }
  const record = { ...data, task: null, document: null, cancelled: false, committing: false };
  documentReplacement = record;
  try {
    const options = window.PDFViewerApplicationOptions;
    // PDF.js's API and worker option kinds (0x04 / 0x08) are the same groups
    // used by Application.open. Keep resource URLs and parser options intact.
    Object.assign(window.pdfjsLib.GlobalWorkerOptions, options.getAll(0x08));
    record.task = window.pdfjsLib.getDocument({ ...options.getAll(0x04), url: data.filePath });
    record.task.onPassword = () => {
      // The normal opener owns PDF.js's password dialog. Decline before
      // replacing the current document so encrypted files keep that flow.
      record.declined = true;
      cancelDocument({ requestId: record.requestId });
    };
    record.document = await record.task.promise;
    await record.document.getPage(1);
    if (record.cancelled || documentReplacement !== record || lifetime.signal.aborted) return;
    postReplacement(record, "documentPrepared");
  } catch (error) {
    if (record.cancelled || documentReplacement !== record || lifetime.signal.aborted) return;
    documentReplacement = null;
    await destroyTask(record.task);
    postReplacement(record, "documentReplacementError", { message: error.message });
    drainRefreshQueue();
  }
}

function resetDocumentNavigation() {
  ++documentGeneration;
  clearTimeout(currentDestTimer);
  currentDestTimer = null;
  cachedOutline = null;
  flatOutline = [];
  viewLocation = null;
  documentReady = false;
  pendingPosition = null;
  pendingDestination = null;
}

async function commitPreparedDocument() {
  const record = documentReplacement;
  if (
    !record?.commitRequested ||
    !record.document ||
    record.committing ||
    record.cancelled ||
    refreshInFlight ||
    !documentReady ||
    lifetime.signal.aborted
  )
    return;
  record.committing = true;
  const app = PDFViewerApplication;
  record.previous = {
    task: app.pdfLoadingTask,
    document: app.pdfDocument,
    url: app.url,
    requestId,
    view: captureView(),
  };
  try {
    // Close the old UI without destroying its worker. It is released only
    // after the host accepts the new document, or reused on cancellation.
    app.pdfLoadingTask = { destroy: async () => {} };
    await app.close();
    if (record.cancelled || lifetime.signal.aborted) {
      await restoreDocument(record);
      return;
    }
    requestId = record.requestId;
    resetDocumentNavigation();
    restoringView = null;
    lastViewState = null;
    const sidebar = parent.lumine?.config?.get("pdf-view.defaultSidebar") || "none";
    window.PDFViewerApplicationOptions.setAll({
      viewOnLoad: 1,
      defaultZoomValue: parent.lumine?.config?.get("pdf-view.defaultZoom") || "auto",
      scrollModeOnLoad: 0,
      spreadModeOnLoad: 0,
      sidebarViewOnLoad: { none: 0, thumbs: 1, outline: 2, attachments: 3 }[sidebar] ?? 0,
    });
    app.initialBookmark = (record.hash || "").replace(/^#/, "");
    app.initialRotation = 0;
    app.setTitleUsingUrl(record.filePath);
    app.pdfLoadingTask = record.task;
    const initializedDocument = waitForDocumentInit();
    try {
      app.load(record.document);
      if (!(await initializedDocument.promise)) throw new Error("The PDF did not initialize");
    } finally {
      initializedDocument.cancel();
    }
    if (record.cancelled || lifetime.signal.aborted) {
      await restoreDocument(record);
      return;
    }
    record.committed = true;
    postReplacement(record, "documentCommitted");
  } catch (error) {
    record.error = error;
    await restoreDocument(record);
  }
}

async function restoreDocument(record) {
  if (lifetime.signal.aborted) return;
  const previous = record.previous;
  const app = PDFViewerApplication;
  try {
    // app.close owns the replacement task once it has been attached.
    if (app.pdfLoadingTask === record.task) await app.close();
    else await destroyTask(record.task);
    requestId = previous.requestId;
    resetDocumentNavigation();
    restoringView = previous.view;
    lastViewState = previous.view;
    app.initialBookmark = pdfNavigation.viewHash(previous.view, previous.document.numPages);
    app.initialRotation = previous.view.rotation;
    app.setTitleUsingUrl(previous.url);
    app.pdfLoadingTask = previous.task;
    const initializedDocument = waitForDocumentInit();
    try {
      app.load(previous.document);
      if (!(await initializedDocument.promise))
        throw new Error("The previous PDF did not initialize");
    } finally {
      initializedDocument.cancel();
      restoringView = null;
    }
  } catch (error) {
    logAdapterError("Could not restore the previous PDF", error);
  } finally {
    if (documentReplacement === record) documentReplacement = null;
    postReplacement(record, record.error ? "documentReplacementError" : "documentCancelled", {
      message: record.error?.message,
    });
    drainRefreshQueue();
  }
}

async function cancelDocument(data) {
  const record = documentReplacement;
  if (!record || record.requestId !== data.requestId || record.cancelled) return;
  record.cancelled = true;
  if (record.committed) return restoreDocument(record);
  if (record.committing) return;
  documentReplacement = null;
  await destroyTask(record.task);
  postReplacement(
    record,
    record.declined
      ? "documentReplacementDeclined"
      : record.error
        ? "documentReplacementError"
        : "documentCancelled",
    {
      message: record.error?.message,
    },
  );
  drainRefreshQueue();
}

function acceptDocument(data) {
  const record = documentReplacement;
  if (!record?.committed || record.requestId !== data.requestId || record.cancelled) return;
  documentReplacement = null;
  destroyTask(record.previous.task);
  drainRefreshQueue();
}

function destroyReplacementTasks() {
  const record = documentReplacement;
  if (!record) return;
  record.cancelled = true;
  documentReplacement = null;
  destroyTask(record.task);
  destroyTask(record.previous?.task);
}

function scrollToPosition(data) {
  if (
    !initialized ||
    !Number.isInteger(data.page) ||
    data.page < 0 ||
    !Number.isFinite(data.x) ||
    !Number.isFinite(data.y)
  )
    return;
  const pdfViewer = PDFViewerApplication.pdfViewer;
  if (
    !documentReady ||
    !PDFViewerApplication.pdfDocument ||
    !PDFViewerApplication.isInitialViewSet ||
    !pdfViewer.pagesCount
  ) {
    pendingPosition = data;
    return;
  }
  if (pdfNavigation.pageIndex(data.page, pdfViewer.pagesCount) === null) return;
  const pageView = pdfViewer.getPageView(data.page);
  if (!pageView?.viewport) return;
  pdfViewer.scrollPageIntoView({
    pageNumber: data.page + 1,
    destArray: [
      null,
      { name: "XYZ" },
      pageView.viewport.viewBox[0] + data.x,
      pageView.viewport.viewBox[3] - data.y,
      null,
    ],
    ignoreDestinationZoom: true,
    center: "both",
  });
}

function scrollToDestination(data) {
  if (!initialized) return;
  if (
    !documentReady ||
    !PDFViewerApplication.pdfDocument ||
    !PDFViewerApplication.isInitialViewSet
  ) {
    pendingDestination = data;
    return;
  }
  return PDFViewerApplication.pdfLinkService.goToDestination(data.dest);
}

function runViewerCommand(command) {
  if (!initialized) return;
  const app = PDFViewerApplication;
  const eventBus = app.eventBus;
  const pdfViewer = app.pdfViewer;
  const container = pdfViewer?.container || app.appConfig?.mainContainer;
  const line = 48;
  const pageY = container ? Math.max(1, container.clientHeight * 0.9) : 600;

  switch (command) {
    case "next-page":
      return eventBus.dispatch("nextpage", { source: window });
    case "previous-page":
      return eventBus.dispatch("previouspage", { source: window });
    case "first-page":
      return eventBus.dispatch("firstpage", { source: window });
    case "last-page":
      return eventBus.dispatch("lastpage", { source: window });
    case "scroll-up":
      return container?.scrollBy({ top: -line, left: 0 });
    case "scroll-down":
      return container?.scrollBy({ top: line, left: 0 });
    case "scroll-left":
      return container?.scrollBy({ top: 0, left: -line });
    case "scroll-right":
      return container?.scrollBy({ top: 0, left: line });
    case "page-up":
      return container?.scrollBy({ top: -pageY, left: 0 });
    case "page-down":
      return container?.scrollBy({ top: pageY, left: 0 });
    case "zoom-in":
      return eventBus.dispatch("zoomin", { source: window });
    case "zoom-out":
      return eventBus.dispatch("zoomout", { source: window });
    case "zoom-reset":
      return eventBus.dispatch("zoomreset", { source: window });
    case "page-width":
      return setScaleValue("page-width");
    case "page-fit":
      return setScaleValue("page-fit");
    case "page-actual":
      return setScaleValue("page-actual");
    case "scroll-mode-vertical":
      return setScrollMode(0);
    case "scroll-mode-horizontal":
      return setScrollMode(1);
    case "scroll-mode-wrapped":
      return setScrollMode(2);
    case "scroll-mode-page":
      return setScrollMode(3);
    case "spread-none":
      return setSpreadMode(0);
    case "spread-odd":
      return setSpreadMode(1);
    case "spread-even":
      return setSpreadMode(2);
    case "rotate-clockwise":
      return eventBus.dispatch("rotatecw", { source: window });
    case "rotate-counterclockwise":
      return eventBus.dispatch("rotateccw", { source: window });
    case "select-tool":
      return eventBus.dispatch("switchcursortool", { source: window, tool: 0 });
    case "hand-tool":
      return eventBus.dispatch("switchcursortool", { source: window, tool: 1 });
    case "find":
      return app.findBar?.open();
    case "find-next":
      return findAgain(false);
    case "find-previous":
      return findAgain(true);
    case "toggle-sidebar":
      return app.viewsManager?.toggle();
    case "presentation-mode":
      return app.requestPresentationMode();
    case "download":
      return eventBus.dispatch("download", { source: window });
    case "copy":
      return copySelection();
  }
}

// PDF.js keeps its zoom presets in `currentScaleValue`, and the toolbar dropdown
// writes exactly the strings `pdf-view.defaultZoom` stores ("auto", "page-width",
// "page-fit", "page-actual"), so a command and the setting name the same value.
// Presentation mode owns the scale, so decline there the way zoomReset does.
function setScaleValue(value) {
  const pdfViewer = PDFViewerApplication.pdfViewer;
  if (!pdfViewer || pdfViewer.isInPresentationMode) {
    return;
  }
  pdfViewer.currentScaleValue = value;
}

// Dispatch on the event bus rather than assigning `pdfViewer.scrollMode`
// directly: the secondary toolbar's radio state follows the event, not the
// property. The setter also throws on an invalid mode, and ignores a change
// altogether past PagesCountLimit.FORCE_SCROLL_MODE_PAGE.
function setScrollMode(mode) {
  PDFViewerApplication.eventBus.dispatch("switchscrollmode", { source: window, mode });
}

function setSpreadMode(mode) {
  PDFViewerApplication.eventBus.dispatch("switchspreadmode", { source: window, mode });
}

function copySelection() {
  const text = window.getSelection()?.toString();
  if (!text) {
    return;
  }
  try {
    document.execCommand("copy");
  } catch (e) {
    parent.navigator?.clipboard?.writeText(text);
  }
}

function findAgain(findPrevious) {
  const state = PDFViewerApplication.findController?.state;
  if (!state) {
    return PDFViewerApplication.findBar?.open();
  }
  PDFViewerApplication.eventBus.dispatch("find", {
    ...state,
    source: window,
    type: "again",
    findPrevious,
  });
}

function setColorInverted(state) {
  document.documentElement.classList.toggle("pdf-view-colors-inverted", Boolean(state));
}
