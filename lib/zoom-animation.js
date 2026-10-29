const DURATION = 150;
const DRAWING_DELAY = 200;

// Keep one animation and one target per view. PDF.js reuses its existing
// canvases during the transition, then renders the visible pages at rest.
class ZoomAnimation {
  constructor(view) {
    this.view = view;
    this.window = view.element.ownerDocument.defaultView;
    this.active = false;
    this.applying = false;
  }

  to(scale, { origin, onComplete } = {}) {
    if (this.view.destroyed || !this.view.pdfDocument) return Promise.resolve();
    this.targetScale = scale;
    this.startScale = this.view.pdfViewer.currentScale;
    this.startedAt = this.window.performance.now();
    this.anchor = this.captureAnchor(origin);
    this.onComplete = onComplete;
    if (!this.active) {
      this.active = true;
      this.promise = new Promise((resolve) => {
        this.resolve = resolve;
      });
    }
    const promise = this.promise;
    if (
      this.window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      Math.abs(scale - this.startScale) < 0.000001 ||
      Math.min(scale, this.startScale) < 0.1
    ) {
      this.apply(scale, true);
      this.finish();
    } else if (!this.frame)
      this.frame = this.window.requestAnimationFrame((time) => this.tick(time));
    return promise;
  }

  tick(time) {
    this.frame = null;
    if (!this.active || this.view.destroyed) return this.cancel({ redraw: false });
    const progress = Math.min(1, (time - this.startedAt) / DURATION);
    const eased = 1 - (1 - progress) ** 3;
    const scale = this.startScale * (this.targetScale / this.startScale) ** eased;
    try {
      this.apply(progress === 1 ? this.targetScale : scale, progress === 1);
      if (progress === 1) this.finish();
      else this.frame = this.window.requestAnimationFrame((next) => this.tick(next));
    } catch (error) {
      this.cancel({ redraw: false });
      if (!this.view.destroyed) this.view.showError(error);
    }
  }

  retarget(scale) {
    if (!this.active || !Number.isFinite(scale) || Math.abs(scale - this.targetScale) < 1e-8)
      return;
    this.startScale = this.view.pdfViewer.currentScale;
    this.targetScale = scale;
    this.startedAt = this.window.performance.now();
    this.view.toolbar.update();
  }

  captureAnchor(origin) {
    const viewport = this.view.viewport;
    const bounds = viewport.getBoundingClientRect();
    const x = origin?.[0] ?? bounds.left + viewport.clientWidth / 2;
    const y = origin?.[1] ?? bounds.top + viewport.clientHeight / 2;
    const hit = this.view.element.ownerDocument
      .elementFromPoint(x, y)
      ?.closest(".page[data-page-number]");
    const pageNumber =
      hit && this.view.pagesElement.contains(hit)
        ? Number(hit.dataset.pageNumber)
        : this.view.getCurrentPage();
    const page = this.view.pdfViewer.getPageView(pageNumber - 1);
    if (!page?.viewport || !page.div) return { x, y, pageNumber };
    const rect = page.div.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x, y, pageNumber };
    const [pdfX, pdfY] = page.viewport.convertToPdfPoint(
      ((x - rect.left) * page.viewport.width) / rect.width,
      ((y - rect.top) * page.viewport.height) / rect.height,
    );
    return { x, y, pageNumber, pdfX, pdfY };
  }

  apply(scale) {
    const viewer = this.view.pdfViewer;
    this.applying = true;
    this.drawingDelay = DRAWING_DELAY;
    try {
      // updateScale rounds to 0.01, which visibly steps at small zoom levels.
      // The exact setter shares PDF.js's layout path; the host defers canvas
      // drawing through refresh() while this animation applies each scale.
      viewer.currentScaleValue = scale;
      this.restoreAnchor();
    } finally {
      this.drawingDelay = null;
      this.applying = false;
    }
  }

  restoreAnchor() {
    const anchor = this.anchor;
    if (anchor?.pdfX === undefined) return;
    const page = this.view.pdfViewer.getPageView(anchor.pageNumber - 1);
    if (!page?.viewport) return;
    const rect = page.div.getBoundingClientRect();
    const [x, y] = page.viewport.convertToViewportPoint(anchor.pdfX, anchor.pdfY);
    // Account for centered pages, pane offsets and rotated PDF coordinates.
    // Scroll bounds clamp an anchor that cannot physically stay in place.
    this.view.viewport.scrollLeft += rect.left + (x * rect.width) / page.viewport.width - anchor.x;
    this.view.viewport.scrollTop += rect.top + (y * rect.height) / page.viewport.height - anchor.y;
  }

  finish() {
    const complete = this.onComplete;
    const scale = this.targetScale;
    const resolve = this.resolve;
    if (this.frame) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.active = false;
    this.targetScale = null;
    this.resolve = null;
    this.onComplete = null;
    this.drawingDelay = DRAWING_DELAY;
    try {
      complete?.();
      this.view.layoutChanged();
      this.restoreAnchor();
      this.drawingDelay = null;
      this.view.pdfViewer.refresh();
    } finally {
      this.drawingDelay = null;
      resolve?.(scale);
    }
  }

  cancel({ redraw = true } = {}) {
    if (this.frame) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    const wasActive = this.active;
    this.active = false;
    this.targetScale = null;
    this.onComplete = null;
    this.resolve?.();
    this.resolve = null;
    if (wasActive && redraw && !this.view.destroyed && this.view.pdfDocument)
      this.view.pdfViewer.refresh();
  }
}

module.exports = ZoomAnimation;
