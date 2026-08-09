const { CompositeDisposable } = require("lumine");

const CONFIG_ENABLED = "pdf-view.scrollmap.enabled";
const CONFIG_MAX_DEPTH = "pdf-view.scrollmap.maxDepth";
const CONFIG_THRESHOLD = "pdf-view.scrollmap.threshold";

class PdfScrollmap {
  constructor(main, SimplemapClass) {
    this.main = main;
    this.SimplemapClass = SimplemapClass;
    this.viewerContexts = new Map();
    this.destroyed = false;
    this.disposables = new CompositeDisposable(
      lumine.config.onDidChange(CONFIG_ENABLED, () => this.updateAll()),
      lumine.config.onDidChange(CONFIG_MAX_DEPTH, () => this.updateAll()),
      lumine.config.onDidChange(CONFIG_THRESHOLD, () => this.updateAll()),
    );

    for (const viewer of this.main.viewers || []) {
      this.addViewer(viewer);
    }
  }

  destroy() {
    this.destroyed = true;
    for (const viewer of Array.from(this.viewerContexts.keys())) {
      this.removeViewer(viewer);
    }
    this.disposables.dispose();
  }

  addViewer(viewer) {
    if (this.destroyed || this.viewerContexts.has(viewer)) {
      return;
    }

    const context = {
      viewer,
      simplemap: null,
      subscriptions: new CompositeDisposable(),
      lastData: null,
    };

    this.viewerContexts.set(viewer, context);
    this.ensureSimplemap(context);

    const dataSubscription = viewer.observeScrollMapData?.((data) => {
      context.lastData = data;
      this.renderViewer(context);
    });
    if (dataSubscription) {
      context.subscriptions.add(dataSubscription);
    }

    context.subscriptions.add(
      lumine.workspace.onDidChangeActivePaneItem(() => {
        if (lumine.workspace.getActivePaneItem() === viewer && context.lastData) {
          requestAnimationFrame(() => this.renderViewer(context));
        }
      }),
    );
  }

  removeViewer(viewer) {
    const context = this.viewerContexts.get(viewer);
    if (!context) {
      return;
    }

    context.simplemap?.destroy();
    context.subscriptions.dispose();
    this.viewerContexts.delete(viewer);
  }

  ensureSimplemap(context) {
    if (!this.hasContext(context) || context.simplemap) {
      return;
    }

    const element = context.viewer.element;
    if (!element?.parentNode) {
      requestAnimationFrame(() => {
        this.ensureSimplemap(context);
        if (context.lastData) {
          this.renderViewer(context);
        }
      });
      return;
    }

    context.simplemap = new this.SimplemapClass();
    context.simplemap.element.classList.add("pdf-view-scrollmap");
    element.parentNode.insertBefore(context.simplemap.element, element.nextSibling);
  }

  ensureSimplemapPosition(context) {
    const element = context.viewer.element;
    if (!element?.parentNode || !context.simplemap) {
      return false;
    }

    const simplemapElement = context.simplemap.element;
    if (
      simplemapElement.parentNode !== element.parentNode ||
      element.nextSibling !== simplemapElement
    ) {
      simplemapElement.remove();
      element.parentNode.insertBefore(simplemapElement, element.nextSibling);
    }
    return true;
  }

  updateAll() {
    for (const context of this.viewerContexts.values()) {
      if (context.lastData) {
        this.renderViewer(context);
      }
    }
  }

  renderViewer(context) {
    if (!this.hasContext(context)) {
      return;
    }

    this.ensureSimplemap(context);
    if (!this.ensureSimplemapPosition(context)) {
      return;
    }

    const { simplemap, lastData: data } = context;
    if (!this.enabled || !data?.items) {
      simplemap.element.style.display = "none";
      simplemap.setItems([]);
      return;
    }

    const items = this.getVisibleItems(data.items);
    simplemap.element.style.display = "block";
    if (this.threshold > 0 && items.length > this.threshold) {
      simplemap.setItems([]);
      return;
    }

    simplemap.setItems(items.map((item) => this.toMarkerItem(item)));
  }

  getVisibleItems(items) {
    if (this.maxDepth <= 0) {
      return items;
    }
    return items.filter((item) => item.level < this.maxDepth);
  }

  toMarkerItem(item) {
    return {
      prc: item.percent,
      cls: `marker-pdf-h${Math.min(item.level + 1, 6)}`,
    };
  }

  hasContext(context) {
    return !this.destroyed && this.viewerContexts.get(context.viewer) === context;
  }

  get enabled() {
    return lumine.config.get(CONFIG_ENABLED) !== false;
  }

  get maxDepth() {
    return lumine.config.get(CONFIG_MAX_DEPTH) || 0;
  }

  get threshold() {
    return lumine.config.get(CONFIG_THRESHOLD) || 0;
  }
}

module.exports = PdfScrollmap;
