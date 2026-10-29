const { setImmediate: yieldToLoop } = require("node:timers");

// Navigation-panel owns all outline UI. This adapter reads bookmarks only while
// the panel observes this item; it never requests PDF pages or text contents.
class NavigationAdapter {
  constructor(handlesItem) {
    this.handlesItem = handlesItem;
    this.documents = new WeakMap();
  }

  observeHeaders(item, callback) {
    let disposed = false;
    let generation = 0;
    let document = null;
    let headers = [];
    let entries = [];
    let pages = new Map();
    let pageNumbers = [];
    let active = null;
    let visible = [];
    let location = item.location || null;
    let lastScrollTop = item.viewport?.scrollTop;
    const subscriptions = [];
    const valid = (token, source) =>
      !disposed && !item.destroyed && token === generation && item.pdfDocument === source;

    const publish = (instant = false, options) => {
      if (!disposed && !item.destroyed) callback(headers, instant ? { instant: true } : options);
    };

    const markState = () => {
      if (disposed || item.destroyed) return [];
      const changed = new Set();
      const setState = (entry, field, value) => {
        if (entry[field] === value) return;
        entry[field] = value;
        changed.add(entry);
      };
      const currentPage = location?.pageNumber || item.getCurrentPage?.() || 1;
      const pageIndex = currentPage - 1;
      const onPage = pages.get(pageIndex) || [];
      const pageView = item.pdfViewer?.getPageView?.(pageIndex);
      const viewport = pageView?.viewport;
      const currentTop = location?.pageNumber === currentPage ? location.top : null;
      const currentLeft = location?.pageNumber === currentPage ? location.left : null;
      const position = (entry) => destinationPosition(entry, viewport);
      const top = Number.isFinite(currentTop)
        ? pointPosition(currentLeft || 0, currentTop, viewport)
        : -Infinity;

      let nextActive = null;
      let bestPosition = -Infinity;
      for (const entry of onPage) {
        const y = position(entry);
        if (
          y <= top + 2 &&
          (y > bestPosition || (y === bestPosition && entry.level > (nextActive?.level || 0)))
        ) {
          nextActive = entry;
          bestPosition = y;
        }
      }
      if (!nextActive) {
        const previousPage = previousPageNumber(pageNumbers, pageIndex);
        const previous = pages.get(previousPage) || [];
        // Earlier pages have no live viewport requirement: document order is
        // the PDF outline's tie-breaker for bookmarks sharing a page.
        nextActive = previous[previous.length - 1] || null;
      }

      // The currently displayed page is reliable even when PDFViewer has not
      // rendered the next page yet. Do not inspect or instantiate other pages.
      const nextVisible = onPage;
      if (active !== nextActive) {
        if (active) setState(active, "currentCount", 0);
        for (let entry = active; entry; entry = entry.parent) setState(entry, "stackCount", 0);
        active = nextActive;
        if (active) setState(active, "currentCount", 1);
        for (let entry = active; entry; entry = entry.parent) setState(entry, "stackCount", 1);
      }
      if (!sameEntries(visible, nextVisible)) {
        for (const entry of visible) setState(entry, "visibility", 0);
        for (const entry of nextVisible) setState(entry, "visibility", 1);
        visible = nextVisible.slice();
      }
      return [...changed].map((entry) => ({
        path: entry.outlinePath,
        currentCount: entry.currentCount,
        stackCount: entry.stackCount,
        visibility: entry.visibility,
      }));
    };

    const refresh = async () => {
      const source = item.pdfDocument;
      if (disposed || item.destroyed || !source || document === source) return;
      document = source;
      const token = ++generation;
      headers = [];
      entries = [];
      pages = new Map();
      pageNumbers = [];
      active = null;
      visible = [];
      location = item.location || null;
      lastScrollTop = item.viewport?.scrollTop;
      publish(true);
      try {
        let cache = this.documents.get(source);
        if (!cache) {
          cache = {
            outline: source.getOutline(),
            destinations: new Map(),
            references: new Map(),
          };
          this.documents.set(source, cache);
        }
        const outline = await cache.outline;
        if (!valid(token, source)) return;
        ({ headers, entries } = buildOutline(outline, item.getPath?.()));
        publish();

        // PDF.js outlines carry either a named or explicit destination. Resolve
        // only bookmark page references, deduplicating worker requests. Four
        // outstanding destinations keep a large outline from flooding it.
        const { destinations, references } = cache;
        for (let offset = 0; offset < entries.length && valid(token, source); offset += 32) {
          const batch = entries.slice(offset, offset + 32);
          const dirtyPages = new Set();
          let index = 0;
          const worker = async () => {
            while (index < batch.length && valid(token, source)) {
              const entry = batch[index++];
              try {
                const destination = await resolveDestination(source, entry.dest, destinations);
                if (!valid(token, source) || !Array.isArray(destination)) continue;
                const page = await resolvePage(source, destination[0], references);
                if (
                  !valid(token, source) ||
                  !Number.isInteger(page) ||
                  page < 0 ||
                  page >= source.numPages
                )
                  continue;
                entry.resolvedDestination = destination;
                entry.pageIndex = page;
                entry.startPoint = { row: page, column: 0 };
                entry.badge = page + 1;
                let pageEntries = pages.get(page);
                if (!pageEntries) {
                  pages.set(page, (pageEntries = []));
                  insertPageNumber(pageNumbers, page);
                }
                pageEntries.push(entry);
                dirtyPages.add(pageEntries);
              } catch {
                // A malformed bookmark must not discard usable siblings.
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, batch.length) }, worker));
          if (!valid(token, source)) return;
          for (const pageEntries of dirtyPages)
            pageEntries.sort((a, b) => a.outlineIndex - b.outlineIndex);
          markState();
          publish();
          if (offset + batch.length < entries.length) await new Promise(yieldToLoop);
        }
      } catch {
        if (valid(token, source)) publish();
      }
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      generation++;
      for (const subscription of subscriptions) subscription?.dispose();
      headers = [];
      entries = [];
      pages.clear();
      document = null;
    };

    callback([], { instant: true });
    subscriptions.push(item.onDidLoad?.(refresh));
    subscriptions.push(
      item.onDidChangeView?.((event) => {
        const nextLocation = event?.location || event;
        if (Number.isInteger(nextLocation?.pageNumber)) location = nextLocation;
        const scrollTop = item.viewport?.scrollTop;
        const scrollDirection =
          Number.isFinite(scrollTop) && Number.isFinite(lastScrollTop)
            ? scrollTop - lastScrollTop
            : 0;
        lastScrollTop = scrollTop;
        const stateChanges = markState();
        if (stateChanges.length) publish(false, { stateChanges, scrollDirection });
      }),
    );
    subscriptions.push(item.onDidDestroy?.(dispose));
    subscriptions.push(
      item.onDidChangePath?.(() => {
        for (const entry of entries) entry.filePath = item.getPath?.();
        publish(true);
      }),
    );
    refresh();
    Promise.resolve(item.whenReady()).then(refresh, () => {});
    return { dispose };
  }

  async navigateTo(item, header, { focus = true } = {}) {
    if (item.destroyed || header?.dest == null) return false;
    if (!item.pdfDocument || !item.linkService) await item.whenReady();
    if (item.destroyed || !item.linkService) return false;
    item.scrollAnimation?.cancel();
    await item.linkService.goToDestination(header.dest);
    if (!item.destroyed && focus) item.focus();
    return !item.destroyed;
  }
}

function buildOutline(outline, filePath) {
  const headers = [];
  const pending = [
    { source: Array.isArray(outline) ? outline : [], target: headers, parent: null, path: "" },
  ];
  while (pending.length) {
    const { source, target, parent, path } = pending.pop();
    const children = [];
    for (let index = 0; index < source.length; index++) {
      const original = source[index];
      const id = `${path}${index}`;
      const entry = {
        id: `pdf-view:outline:${id}`,
        text: String(original.title || ""),
        dest: original.dest,
        level: (parent?.level || 0) + 1,
        children: [],
        classList: [],
        filePath,
        currentCount: 0,
        stackCount: 0,
        visibility: 0,
        badge: null,
      };
      // Keep internal ancestry non-enumerable: the public tree stays acyclic.
      Object.defineProperty(entry, "parent", { value: parent });
      Object.defineProperty(entry, "outlinePath", { value: id.split(".").map(Number) });
      target.push(entry);
      children.push({
        source: original.items || [],
        target: entry.children,
        parent: entry,
        path: `${id}.`,
      });
    }
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  // The work stack above avoids recursion, then assigns actual depth-first
  // document order (siblings may have been allocated before their descendants).
  const walk = [...headers].reverse();
  const ordered = [];
  while (walk.length) {
    const entry = walk.pop();
    entry.outlineIndex = ordered.length;
    ordered.push(entry);
    for (let index = entry.children.length - 1; index >= 0; index--)
      walk.push(entry.children[index]);
  }
  return { headers, entries: ordered };
}

function resolveDestination(document, destination, cache) {
  if (typeof destination !== "string") return destination;
  if (!cache.has(destination)) cache.set(destination, document.getDestination(destination));
  return cache.get(destination);
}

function resolvePage(document, reference, cache) {
  if (Number.isInteger(reference)) return reference;
  if (!reference || !Number.isInteger(reference.num) || !Number.isInteger(reference.gen))
    return null;
  const key = `${reference.num}:${reference.gen}`;
  if (!cache.has(key)) cache.set(key, document.getPageIndex(reference));
  return cache.get(key);
}

function destinationPosition(entry, viewport) {
  const destination = entry.resolvedDestination;
  const kind = destination?.[1]?.name;
  let top;
  let left = 0;
  if (kind === "XYZ") {
    left = destination[2] || 0;
    top = destination[3];
  } else if (kind === "FitH" || kind === "FitBH") top = destination[2];
  else if (kind === "FitR") {
    left = destination[2] || 0;
    top = destination[5];
  }
  return Number.isFinite(top) ? pointPosition(left, top, viewport) : -Infinity;
}

function pointPosition(left, top, viewport) {
  return viewport?.convertToViewportPoint ? viewport.convertToViewportPoint(left, top)[1] : -top;
}

function insertPageNumber(numbers, page) {
  let low = 0;
  let high = numbers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (numbers[middle] < page) low = middle + 1;
    else high = middle;
  }
  numbers.splice(low, 0, page);
}

function previousPageNumber(numbers, page) {
  let low = 0;
  let high = numbers.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (numbers[middle] < page) low = middle + 1;
    else high = middle;
  }
  return numbers[low - 1];
}

function sameEntries(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

module.exports = { NavigationAdapter };
