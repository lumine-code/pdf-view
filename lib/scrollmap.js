const MAX_SEARCH_MARKERS = 400;
const MAX_DEPTH_CONFIG = `${require("../package.json").name}.scrollmap.maxDepth`;

class PdfScrollmap {
  constructor(viewer, SimplemapClass, navigationAdapter) {
    this.viewer = viewer;
    this.destroyed = false;
    this.subscriptions = [];
    this.runtimeSubscriptions = [];
    this.searchSubscriptions = [];
    this.headers = null;
    this.entries = [];
    this.headingItems = [];
    this.searchItems = [];
    this.geometryDirty = true;
    this.searchDirty = true;
    this.maxDepth = 1;
    this.simplemap = new SimplemapClass();
    this.simplemap.element.classList.add("pdf-view-scrollmap");
    this.simplemap.element.setAttribute("aria-hidden", "true");
    if (this.simplemap.setScrollElement) this.simplemap.setScrollElement(viewer.viewport);
    else viewer.element.appendChild(this.simplemap.element);
    this.subscriptions.push(lumine.scrollbars.observe(viewer.viewport, () => this.schedule()));
    this.subscriptions.push(
      lumine.config.observe(MAX_DEPTH_CONFIG, (value) => {
        const next = Number.isInteger(value) && value >= 0 ? value : 1;
        if (next === this.maxDepth) return;
        this.maxDepth = next;
        this.geometryDirty = true;
        this.schedule();
      }),
    );
    this.subscriptions.push(
      navigationAdapter.observeHeaders(viewer, (headers, options) => {
        if (this.destroyed) return;
        if (headers !== this.headers) {
          this.headers = headers;
          this.entries = flatten(headers);
          this.geometryDirty = true;
        } else if (!options?.instant && !options?.stateChanges) this.geometryDirty = true;
        this.headersDocument = viewer.pdfDocument;
        this.schedule();
      }),
    );
    this.subscriptions.push(
      viewer.onDidLoad?.(() => {
        this.geometryDirty = true;
        this.searchDirty = true;
        this.bindRuntime();
        this.bindSearch();
        this.schedule();
      }),
    );
    this.subscriptions.push(viewer.onDidChangeView?.(() => this.schedule()));
    this.subscriptions.push(viewer.onDidDestroy?.(() => this.destroy()));
    this.bindRuntime();
    this.bindSearch();
    this.schedule();
  }

  bindRuntime() {
    const bus = this.viewer.eventBus;
    if (this.bus === bus) return;
    for (const subscription of this.runtimeSubscriptions) subscription.dispose();
    this.runtimeSubscriptions = [];
    this.bus = bus;
    if (!bus) return;
    const refresh = () => {
      this.geometryDirty = true;
      this.schedule();
    };
    for (const name of ["pagerendered", "pagesloaded", "scalechanging", "rotationchanging"]) {
      bus.on(name, refresh);
      this.runtimeSubscriptions.push({ dispose: () => bus.off(name, refresh) });
    }
  }

  bindSearch() {
    // Merely observe the package's existing search controller. The overview
    // never starts a search, asks for page text, or expands its text cache.
    const adapter = this.viewer.searchAdapter;
    if (this.searchAdapter === adapter) return;
    for (const subscription of this.searchSubscriptions) subscription.dispose();
    this.searchSubscriptions = [];
    this.searchAdapter = adapter;
    if (!adapter) return;
    const refresh = () => {
      this.searchDirty = true;
      this.schedule();
    };
    this.searchSubscriptions.push(adapter.onDidUpdate(refresh));
    this.searchSubscriptions.push(adapter.onDidChangeCurrentResult(refresh));
  }

  schedule() {
    if (this.destroyed || this.viewer.destroyed || this.frame) return;
    this.frame = lumine.views.readDocument(() => {
      this.frame = null;
      if (!this.destroyed && !this.viewer.destroyed) this.render();
    });
  }

  render() {
    if (this.destroyed || this.viewer.destroyed) return;
    const { viewport, pdfViewer, pdfDocument } = this.viewer;
    const geometry = lumine.scrollbars.getGeometry(viewport);
    const height = geometry.verticalTrackSize ?? geometry.viewportHeight;
    const width = geometry.viewportWidth;
    const total = geometry.scrollHeight;
    if (
      !this.viewer.element.isConnected ||
      !pdfDocument ||
      height <= 0 ||
      width <= 0 ||
      total <= 0
    ) {
      this.simplemap.element.style.visibility = "hidden";
      this.simplemap.setItems([]);
      this.geometryDirty = true;
      return;
    }
    this.simplemap.element.style.visibility = "";
    const signature = [
      pdfDocument,
      total,
      height,
      width,
      pdfViewer.currentScale,
      pdfViewer.pagesRotation,
    ];
    if (!sameSignature(signature, this.signature)) this.geometryDirty = true;
    const rebuilt = this.geometryDirty;
    if (rebuilt) {
      this.signature = signature;
      this.pageGeometry = new Map();
      this.viewportBounds = viewport.getBoundingClientRect();
      this.headingItems = [];
      if (this.headersDocument === pdfDocument) {
        for (const header of this.entries) {
          if (this.maxDepth > 0 && (header.level || 1) > this.maxDepth) continue;
          const page = this.pagePosition(header.pageIndex);
          if (!page) continue;
          const offset = destinationOffset(header.resolvedDestination, page);
          this.headingItems.push({
            prc: percent(page.top + offset, total),
            cls: `marker-pdf-h${Math.max(1, Math.min(header.level || 1, 6))}`,
          });
        }
      }
      this.geometryDirty = false;
    }
    const refreshSearch = this.searchDirty || rebuilt;
    if (refreshSearch) {
      this.searchItems = this.buildSearchItems(total, height);
      this.searchDirty = false;
    }
    if (rebuilt || refreshSearch)
      this.simplemap.setItems([...this.headingItems, ...this.searchItems]);
  }

  pagePosition(index) {
    if (!Number.isInteger(index) || index < 0) return null;
    if (this.pageGeometry.has(index)) return this.pageGeometry.get(index);
    const pageView = this.viewer.pdfViewer.getPageView(index);
    if (!pageView?.div?.isConnected) return null;
    const rect = pageView.div.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const value = {
      top:
        rect.top -
        this.viewportBounds.top +
        this.viewer.viewport.scrollTop -
        this.viewer.viewport.clientTop,
      height: rect.height,
      viewport: pageView.viewport,
    };
    this.pageGeometry.set(index, value);
    return value;
  }

  buildSearchItems(total, height) {
    const search = this.searchAdapter;
    if (!search?.highlightMatches || search.document !== this.viewer.pdfDocument) return [];
    const counts = search.counts || [];
    const budget = Math.max(1, Math.min(MAX_SEARCH_MARKERS, Math.floor(height)));
    const buckets = new Set();
    const items = [];
    for (let index = 0; index < counts.length; index++) {
      if (!(counts[index] > 0)) continue;
      const bucket = Math.floor((index * budget) / counts.length);
      if (buckets.has(bucket)) continue;
      const page = this.pagePosition(index);
      if (!page) continue;
      buckets.add(bucket);
      items.push({ prc: percent(page.top, total), cls: "marker-pdf-search" });
    }
    return items;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.frame?.dispose();
    this.frame = null;
    for (const subscription of [
      ...this.subscriptions,
      ...this.runtimeSubscriptions,
      ...this.searchSubscriptions,
    ])
      subscription?.dispose();
    this.subscriptions = this.runtimeSubscriptions = this.searchSubscriptions = [];
    this.simplemap.destroy();
    this.entries = [];
    this.headers = null;
    this.headingItems = this.searchItems = [];
    this.pageGeometry?.clear();
    this.searchAdapter = null;
    this.bus = null;
  }
}

function flatten(headers) {
  const pending = [...(headers || [])].reverse();
  const result = [];
  while (pending.length) {
    const header = pending.pop();
    result.push(header);
    for (let index = (header.children?.length || 0) - 1; index >= 0; index--)
      pending.push(header.children[index]);
  }
  return result;
}

function destinationOffset(destination, page) {
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
  if (!Number.isFinite(top) || !page.viewport?.convertToViewportPoint) return 0;
  const y = page.viewport.convertToViewportPoint(left, top)[1];
  const ratio = page.viewport.height > 0 ? page.height / page.viewport.height : 1;
  return Math.max(0, Math.min(page.height, y * ratio));
}

function percent(value, total) {
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function sameSignature(left, right) {
  return (
    right && left.length === right.length && left.every((value, index) => value === right[index])
  );
}

module.exports = PdfScrollmap;
