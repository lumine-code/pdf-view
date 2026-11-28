const EPSILON = 1e-8;

function adaptiveMode(value) {
  if (value === "auto") return "auto-width";
  if (["auto-width", "page-width", "page-height", "page-fit"].includes(value)) return value;
  return null;
}

class AdaptiveZoom {
  constructor(view) {
    this.view = view;
    this.mode = null;
    this.pageNumber = null;
    this.followingScroll = false;
    this.revision = 0;
  }

  setMode(mode, pageNumber) {
    this.mode = mode;
    this.pageNumber = mode ? pageNumber : null;
    this.followingScroll = false;
    this.applied = null;
    this.invalidate();
  }

  selectPage(pageNumber, { followingScroll = false } = {}) {
    if (!this.mode || (this.pageNumber === pageNumber && this.followingScroll === followingScroll))
      return;
    this.pageNumber = pageNumber;
    this.followingScroll = followingScroll;
    this.invalidate();
  }

  invalidate() {
    this.revision++;
  }

  rememberScroll() {
    this.scrollTop = this.view.viewport.scrollTop;
  }

  didScroll() {
    const { viewport, pageLayout, loading, zoomAnimation } = this.view;
    const previous = this.scrollTop;
    this.rememberScroll();
    if (!this.mode || loading || zoomAnimation?.active || previous === viewport.scrollTop) return;
    const maximum = viewport.scrollHeight - viewport.clientHeight;
    if (previous > maximum && viewport.scrollTop >= maximum - 1) return;
    const pageNumber = pageLayout.pageAtFocusLine();
    if (!pageNumber) return;
    if (pageNumber !== this.pageNumber) this.selectPage(pageNumber, { followingScroll: true });
    this.schedule();
  }

  schedule() {
    if (!this.mode || this.scheduled || this.view.loading || this.view.destroyed) return;
    this.scheduled = true;
    queueMicrotask(async () => {
      this.scheduled = false;
      if (this.view.loading || this.view.zoomAnimation.active) return;
      try {
        await this.update();
      } catch (error) {
        this.view.showError(error);
      }
    });
  }

  update({ smooth = false } = {}) {
    const view = this.view;
    const { pdfDocument, pdfViewer, viewport, pageLayout, zoomAnimation } = view;
    const { mode, followingScroll } = this;
    if (!mode || !pdfDocument || view.destroyed || !view.hasLayout()) return;
    if (followingScroll) {
      const focusedPage = pageLayout.pageAtFocusLine();
      if (!focusedPage) return;
      this.selectPage(focusedPage, { followingScroll });
    }
    const { pageNumber } = this;
    if (this.pending?.revision === this.revision) return this.pending.promise;
    const box = () =>
      `${mode}:${pageNumber}:${pdfViewer.pagesRotation}:${viewport.clientWidth}:${viewport.clientHeight}`;
    if (!smooth && this.applied === box()) return;
    const revision = ++this.revision;
    const current = () =>
      !view.destroyed && view.pdfDocument === pdfDocument && this.revision === revision;
    const pageView = pdfViewer.getPageView(pageNumber - 1);
    const apply = (page) => {
      if (!page || !current()) return;
      // An unloaded row may have changed size while its geometry was pending.
      const focusLine = followingScroll ? pageLayout.focusLine() : null;
      if (followingScroll && pageLayout.pageAtFocusLine(focusLine) !== pageNumber) return;
      const size = page.getViewport({
        scale: 96 / 72,
        rotation: (page.rotate + pdfViewer.pagesRotation) % 360,
      });
      const scale = this.scaleFor(size, mode);
      if (!(scale > 0 && Number.isFinite(scale))) return;
      const scaleChanged = Math.abs(scale - pdfViewer.currentScale) > EPSILON;
      if (!smooth && this.applied && !scaleChanged) {
        // Moving between equally sized rows should leave a continuous scroll alone.
        this.applied = box();
        pdfViewer.update();
        return;
      }
      if (scaleChanged) view.scrollAnimation.cancel();
      view.preservePageFocus();
      pageLayout.adjustToWidth();
      const anchor = this.captureAnchor(pageView, pageNumber, focusLine);
      const settle = () => {
        if (!current()) return;
        // A scrollbar can change the available box as the new scale settles.
        // Recheck once, then use a smaller fitting scale if it changed again.
        this.applyScale(this.scaleFor(size, mode));
        const fittingScale = this.scaleFor(size, mode);
        if (fittingScale < pdfViewer.currentScale - EPSILON) this.applyScale(fittingScale);
        zoomAnimation.restoreAnchor(anchor);
        if (!followingScroll) this.revealPage(pageView, pageNumber);
        this.rememberScroll();
        this.applied = box();
        pdfViewer.update();
      };
      if (smooth) return zoomAnimation.to(scale, { anchor, onComplete: settle });
      this.applyScale(scale);
      settle();
    };
    if (pageView?.pdfPage) return apply(pageView.pdfPage);
    const promise = view
      .ensurePageGeometry(pageNumber)
      .then(apply, (error) => {
        if (current()) throw error;
      })
      .finally(() => {
        if (this.pending?.revision === revision) this.pending = null;
      });
    this.pending = { revision, promise };
    return promise;
  }

  scaleFor(size, mode) {
    const { viewport } = this.view;
    const width = viewport.clientWidth / size.width;
    const height = viewport.clientHeight / size.height;
    if (mode === "auto-width") return Math.min(1, width);
    if (mode === "page-width") return width;
    if (mode === "page-height") return height;
    return Math.min(width, height);
  }

  applyScale(scale) {
    const { pdfViewer } = this.view;
    if (
      scale > 0 &&
      Number.isFinite(scale) &&
      (!pdfViewer.currentScaleValue || Math.abs(scale - pdfViewer.currentScale) > EPSILON)
    )
      pdfViewer.currentScaleValue = scale;
  }

  captureAnchor(page, pageNumber, focusLine = null) {
    const { viewport, zoomAnimation } = this.view;
    const bounds = viewport.getBoundingClientRect();
    const rect = page.div.getBoundingClientRect();
    const viewportTop = bounds.top + viewport.clientTop;
    const y =
      focusLine != null
        ? viewportTop + focusLine
        : rect.bottom > viewportTop && rect.top < viewportTop + viewport.clientHeight
          ? Math.max(viewportTop, rect.top)
          : null;
    const anchor = zoomAnimation.captureAnchor(
      [rect.left + rect.width / 2, y ?? rect.top],
      pageNumber,
    );
    anchor.x = bounds.left + viewport.clientWidth / 2;
    anchor.y = y ?? viewportTop;
    return anchor;
  }

  revealPage(page, pageNumber) {
    const { viewport, pageLayout } = this.view;
    pageLayout.alignPage(pageNumber);
    const top = page.div.offsetTop;
    const bottom = top + page.div.offsetHeight - viewport.clientHeight;
    viewport.scrollTop = Math.max(
      Math.min(top, bottom),
      Math.min(Math.max(top, bottom), viewport.scrollTop),
    );
  }
}

module.exports = { AdaptiveZoom, adaptiveMode };
