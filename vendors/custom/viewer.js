// supress output from pdfjs
console.log = console.info = console.warn = console.error = () => {};

// Theme bridge: viewer.css maps PDF.js's theme variables to Lumine's custom
// properties (--text-color, --app-background-color, ...), which do not exist in
// this iframe document. Mirror the live values from the host onto :root here.
// Writing via CSSOM (element.style.setProperty) is allowed under the viewer's
// `style-src 'self'` CSP, unlike injecting a <style> block. Re-sync when the
// active theme changes; drop the subscription when this frame unloads so the
// host ThemeManager does not retain callbacks from reloaded iframes.
const THEME_VARS = [
  "--text-color",
  "--app-background-color",
  "--tab-background-color-active",
  "--pane-item-border-color",
  "--background-color-highlight",
  "--background-color-selected",
  "--font-family",
  // Drive the PDF container's scrollbar from the same palette as the editor's
  // "always visible" scrollbar (see the #outerContainer rules in viewer.css).
  "--scrollbar-color",
  "--scrollbar-background-color",
];

const FALLBACK_SCROLLBAR_WIDTH = 10;

function measureHostScrollbarWidth() {
  const host =
    parent.lumine?.workspace?.getElement?.() ||
    parent.document.querySelector("lumine-workspace") ||
    parent.document.body;
  const probe = parent.document.createElement("div");
  probe.style.cssText =
    "position: absolute; top: -9999px; width: 100px; height: 100px; overflow: scroll;";

  let width = 0;
  try {
    host.appendChild(probe);
    width = probe.offsetWidth - probe.clientWidth;
  } finally {
    probe.remove();
  }
  return width > 0 ? width : FALLBACK_SCROLLBAR_WIDTH;
}

function syncThemeVars() {
  try {
    const hostStyle = parent.getComputedStyle(parent.document.documentElement);
    const rootStyle = document.documentElement.style;
    for (const name of THEME_VARS) {
      const value = hostStyle.getPropertyValue(name).trim();
      if (value) {
        rootStyle.setProperty(name, value);
      }
    }
    rootStyle.setProperty(
      "--pdf-scrollbar-width",
      `${measureHostScrollbarWidth()}px`,
    );
  } catch (e) {
    // The host may be unreachable in some contexts; fall back to PDF.js defaults.
  }
}

syncThemeVars();

const themeSubscription = parent.lumine?.themes?.onDidChangeActiveThemes?.(syncThemeVars);
if (themeSubscription) {
  window.addEventListener("pagehide", () => themeSubscription.dispose(), { once: true });
}

let cachedOutline = null;
let pendingRefreshData = null;

// The pane hides an inactive tab by writing `display: none` onto the item
// view -- the wrapper around this iframe -- so visibility is read from the
// wrapper as well as the frame itself (same origin, so both are reachable).
function isHiddenInHost() {
  const frame = window.frameElement;
  if (!frame) return false;
  return frame.style.display === "none" || frame.parentElement?.style.display === "none";
}

// Watch for visibility changes to handle pending refresh when tab becomes visible
function setupVisibilityObserver() {
  const wrapper = window.frameElement?.parentElement;
  if (!wrapper) return;

  const observer = new MutationObserver(() => {
    if (!isHiddenInHost() && pendingRefreshData) {
      // We just became visible and have a pending refresh
      const data = pendingRefreshData;
      pendingRefreshData = null;
      refreshContents(data);
    }
  });

  observer.observe(wrapper, {
    attributes: true,
    attributeFilter: ["style"],
  });
}

window.onload = () => {
  const sidebarConfig = parent.lumine?.config?.get("pdf-view.defaultSidebar") || "none";
  PDFViewerApplicationOptions.set("sidebarViewOnLoad",
    { none: 0, thumbs: 1, outline: 2, attachments: 3 }[sidebarConfig] ?? 0);
  PDFViewerApplicationOptions.set("defaultZoomValue",
    parent.lumine?.config?.get("pdf-view.defaultZoom") || "auto");
  PDFViewerApplicationOptions.set("enableScripting", false);
  PDFViewerApplicationOptions.set("externalLinkTarget", 4);
  PDFViewerApplicationOptions.set("disableHistory", true);
  PDFViewerApplicationOptions.set("verbosity", 0);
  setupVisibilityObserver();
  parent.postMessage({ type: "ready" });

  // A document that fails to load has no pagesinit. Report the failure so the
  // host can retry when the file settles: a restart can catch the PDF mid-write,
  // and the write that finishes it can beat the host's watcher arming, so the
  // host must not rely on a watcher event to learn the load went wrong.
  PDFViewerApplication.eventBus.on("documenterror", () => {
    parent.postMessage({ type: "loadError" });
  });

  PDFViewerApplication.eventBus.on("pagesinit", async () => {
    cachedOutline = null;
    const outline = await PDFViewerApplication.pdfDocument.getOutline();

    if (outline) {
      // Enrich outline with destHash and pre-resolve destinations
      await enrichItems(outline);
      cachedOutline = outline;
    }

    parent.postMessage({ type: "pdfjsOutline", outline: outline });

    // Send initial scroll-map data after outline is ready
    spawnCurrentDest();
  });

  // Report the visible outline entries after every viewport change. Both events
  // are deferred, never read straight from the handler: PDFViewer dispatches
  // "pagechanging" from #scrollIntoView and "updateviewarea" from the scale
  // change a destination may carry, both *before* it assigns container.scrollTop
  // — reading there reports the region being left, which sent the navigation
  // panel back to the entry the user had just navigated away from.
  PDFViewerApplication.eventBus.on("pagechanging", scheduleCurrentDest);
  PDFViewerApplication.eventBus.on("updateviewarea", scheduleCurrentDest);
};

// Coalesce the burst of events a single scroll produces into one message read
// after the scroll has landed. A timer, not requestAnimationFrame: a hidden
// viewer gets no frames, and the scroll position is readable as soon as the
// task that set it ends.
let currentDestTimer = null;

function scheduleCurrentDest() {
  if (currentDestTimer !== null) {
    return;
  }
  currentDestTimer = setTimeout(() => {
    currentDestTimer = null;
    spawnCurrentDest();
  });
}

// Helper to recursively enrich items and resolve destinations
async function enrichItems(items) {
  for (const item of items) {
    if (item.dest) {
      // 1. Get Hash
      item.destHash = PDFViewerApplication.pdfLinkService.getDestinationHash(
        item.dest
      );

      // 2. Resolve to Page Index and Coordinates (for fast scroll checking)
      try {
        let dest = item.dest;
        if (typeof dest === "string") {
          dest = await PDFViewerApplication.pdfDocument.getDestination(dest);
        }

        // Skip if destination couldn't be resolved (null or not an array)
        if (!dest || !Array.isArray(dest)) {
          continue;
        }

        const pageRef = dest[0];
        let pageIndex;

        if (typeof pageRef === "object") {
          pageIndex = await PDFViewerApplication.pdfDocument.getPageIndex(
            pageRef
          );
        } else if (Number.isInteger(pageRef)) {
          pageIndex = pageRef;
        }

        if (pageIndex !== undefined) {
          item.resolvedDest = {
            pageIndex: pageIndex,
            x: dest[2],
            y: dest[3],
          };
        }
      } catch (e) {
        // Ignore errors for unresolvable destinations (e.g., missing named destinations)
      }
    }

    if (item.items && item.items.length > 0) {
      await enrichItems(item.items);
    }
  }
}

async function spawnCurrentDest() {
  // If we have cached outline with resolved destinations, use it for fast sync calculation
  if (cachedOutline) {
    const pdfViewer = PDFViewerApplication.pdfViewer;
    const container = pdfViewer.container;
    const scrollTop = container.scrollTop;
    const scrollBottom = scrollTop + container.clientHeight;
    const visibleHashes = [];

    // Flatten outline for linear scan, tracking nesting level
    const flattenOutline = (items, level = 0, result = []) => {
      for (const item of items) {
        result.push({ item, level });
        if (item.items && item.items.length > 0) {
          flattenOutline(item.items, level + 1, result);
        }
      }
      return result;
    };

    const flatItems = flattenOutline(cachedOutline);
    const itemPositions = [];

    // Calculate current Y positions (synchronous)
    for (const { item, level } of flatItems) {
      if (item.resolvedDest) {
        const pageView = pdfViewer.getPageView(item.resolvedDest.pageIndex);
        if (pageView && pageView.div) {
          // Get Y position within page from PDF coordinates
          // PDF y-coordinate is from bottom, convert to top-down viewport position
          const viewport = pageView.viewport;
          const pdfY = item.resolvedDest.y || 0;
          // viewport.height is the rendered page height
          // Scale the PDF y-coordinate to viewport pixels
          const scale = viewport.scale;
          const yInPage = (viewport.viewBox[3] - pdfY) * scale;

          // Absolute Y in container = page top + position within page
          const absoluteY = pageView.div.offsetTop + yInPage;
          itemPositions.push({ item, level, y: absoluteY });
        }
      }
    }

    // Sort by Y
    itemPositions.sort((a, b) => a.y - b.y);

    // Check visibility
    for (let i = 0; i < itemPositions.length; i++) {
      const current = itemPositions[i];
      const next = itemPositions[i + 1];

      const startY = current.y;
      // If no next item, assume end of document (or end of last page)
      const endY = next
        ? next.y
        : pdfViewer.getPageView(pdfViewer.pagesCount - 1).div.offsetTop +
          pdfViewer.getPageView(pdfViewer.pagesCount - 1).div.clientHeight;

      if (startY < scrollBottom && endY > scrollTop) {
        if (current.item.destHash) {
          visibleHashes.push(current.item.destHash);
        }
      }
    }

    // Send outline item(s) visible in the viewport.
    parent.postMessage({
      type: "visibleOutlineItems",
      destHash: visibleHashes,
    });

    // Send scroll-map data with all outline positions
    // Account for toolbar height - container.offsetTop gives the offset from the iframe top
    const toolbarHeight = container.offsetTop;
    const totalHeight = container.scrollHeight;
    const iframeHeight = window.innerHeight;
    const scrollableHeight = iframeHeight - toolbarHeight;

    if (totalHeight > 0 && itemPositions.length > 0) {
      // Calculate percent within the scrollable area (excluding toolbar)
      // Map positions to the visible scroll-map area
      const toolbarPercent = (toolbarHeight / iframeHeight) * 100;
      const contentPercent = (scrollableHeight / iframeHeight) * 100;

      const scrollMapItems = itemPositions.map((pos) => ({
        // Offset by toolbar and scale to the content area
        percent: toolbarPercent + (pos.y / totalHeight) * contentPercent,
        page: pos.item.resolvedDest?.pageIndex,
        x: pos.item.resolvedDest?.x || 0,
        y: pos.item.resolvedDest?.y || 0,
        level: pos.level,
        isCurrent: visibleHashes.includes(pos.item.destHash),
      }));
      parent.postMessage({
        type: "scrollMapData",
        items: scrollMapItems,
        scrollPercent: (scrollTop / totalHeight) * 100,
      });
    }
    return;
  }

  // Fallback for non-cached (shouldn't happen after init) or if pre-calc failed
  // ... (omitted for brevity, relying on cachedOutline)
}

// Send click event to parent to activate pane
window.addEventListener(
  "mousedown",
  (event) => {
    parent.postMessage({ type: "click", button: event.button });
  },
  true
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
  true
);

function isEditableTarget(event) {
  const target = event.target;
  if (!target) return false;
  return !!target.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

window.addEventListener(
  "contextmenu",
  (event) => {
    const page = event.target.closest("div.page");
    if (!page) {
      return;
    }
    const pageNo = parseInt(page.getAttribute("data-page-number"), 10);
    if (isNaN(pageNo)) {
      return;
    }
    const bounds = page.querySelector("canvas").getBoundingClientRect();
    const rot = PDFViewerApplication.pdfViewer.pagesRotation;
    switch (rot) {
      case 0:
        var x = event.clientX - bounds.left;
        var y = event.clientY - bounds.top;
        break;
      case 90:
        var x = event.clientY - bounds.top;
        var y = bounds.right - event.clientX;
        break;
      case 180:
        var x = bounds.right - event.clientX;
        var y = bounds.bottom - event.clientY;
        break;
      case 270:
        var x = bounds.bottom - event.clientY;
        var y = event.clientX - bounds.left;
        break;
    }
    const res = PDFViewerApplication.pdfViewer.currentScale * 96;
    x = Math.round((x / res) * 72);
    y = Math.round((y / res) * 72);
    parent.postMessage({ type: "contextmenu", pageNo: pageNo, x: x, y: y });
  },
  true
);

window.addEventListener("message", (message) => {
  if (message.source !== parent) {
    return;
  } else if (message.data.type === "refresh") {
    return refreshContents(message.data);
  } else if (message.data.type === "setposition") {
    return scrollToPosition(message.data);
  } else if (message.data.type === "setdestination") {
    return scrollToDestination(message.data);
  } else if (message.data.type === "set-color-inverted") {
    return setColorInverted(message.data.value);
  } else if (message.data.type === "currentdest") {
    return spawnCurrentDest(message.data);
  } else if (message.data.type === "command") {
    return runViewerCommand(message.data.command);
  }
});

let lastParams = { page: 1, zoom: parent.lumine?.config?.get("pdf-view.defaultZoom") || "auto" };

function refreshContents(data) {
  if (isHiddenInHost()) {
    // Store the refresh request for when we become visible
    pendingRefreshData = data;
    return;
  }
  // Clear any pending refresh since we're doing it now
  pendingRefreshData = null;
  cachedOutline = null;
  if (PDFViewerApplication.pagesCount > 1) {
    lastParams.page = PDFViewerApplication.page;
    lastParams.zoom = PDFViewerApplication.pdfViewer.currentScaleValue;
    if (/^\d+(?:\.\d+)?$/.test(lastParams.zoom)) {
      lastParams.zoom = parseFloat(lastParams.zoom) * 100;
    }
  }
  PDFViewerApplication.initialBookmark = `page=${lastParams.page}&zoom=${lastParams.zoom}`;
  PDFViewerApplication.open({ url: data.filePath });
}

function scrollToPosition(data) {
  const pageView = PDFViewerApplication.pdfViewer.getPageView(data.page);
  if (!pageView || !pageView.div) {
    // Page not rendered yet, wait for pagesloaded event
    PDFViewerApplication.eventBus.on("pagesloaded", function onPagesLoaded() {
      PDFViewerApplication.eventBus.off("pagesloaded", onPagesLoaded);
      scrollToPosition(data);
    });
    return;
  }
  const clientHeight =
    PDFViewerApplication.appConfig.mainContainer.clientHeight;
  const clientWidth = PDFViewerApplication.appConfig.mainContainer.clientWidth;
  const height = pageView.div.offsetTop;
  const [, y1, , y2] = pageView.viewport.viewBox;
  const [x, y] = pageView.viewport.convertToViewportPoint(
    data.x,
    y2 - y1 - data.y
  );
  const percentDown = 0.5;
  const percentAcross = 0.5;
  PDFViewerApplication.pdfViewer.container.scrollTo({
    top: height + y - clientHeight * percentDown,
    left: x - clientWidth * percentAcross,
  });
}

function scrollToDestination(data) {
  PDFViewerApplication.pdfLinkService.goToDestination(data.dest);
}

function runViewerCommand(command) {
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
  document.documentElement.classList.toggle(
    "pdf-view-colors-inverted",
    Boolean(state)
  );
}
