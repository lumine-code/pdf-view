// PDF.js lays out pages in one column. Its auto margins now center every page
// against the column's intrinsic width, including pages smaller than the pane.
class PageLayout {
  constructor(view) {
    this.view = view;
    this.middle = null;
    this.scrollTop = 0;
  }

  measureMiddle() {
    const { viewport, pagesElement } = this.view;
    return Math.max(0, (pagesElement.offsetWidth - viewport.clientWidth) / 2);
  }

  rememberMiddle() {
    this.middle = this.measureMiddle();
  }

  adjustToWidth() {
    const middle = this.measureMiddle();
    const previous = this.middle;
    this.middle = middle;
    if (previous == null || previous === middle || this.view.loading) return;
    // A lazily discovered width moves the whole column. Keep the same part of
    // it in view, except when the browser has already clamped to the right edge.
    if (middle < previous && this.view.viewport.scrollLeft >= 2 * middle) return;
    this.shiftHorizontal(middle - previous);
  }

  shiftHorizontal(delta) {
    const { viewport, scrollAnimation, pan } = this.view;
    const previous = viewport.scrollLeft;
    viewport.scrollLeft += delta;
    const shift = viewport.scrollLeft - previous;
    if (!shift) return;
    scrollAnimation.shiftHorizontal(shift);
    if (pan) pan.left += shift;
  }

  alignPage(pageNumber, previousLeft = this.view.viewport.scrollLeft) {
    const { pdfViewer, viewport } = this.view;
    const page = pdfViewer.getPageView(pageNumber - 1)?.div;
    if (!page?.isConnected) return;
    const left = page.offsetLeft;
    const width = page.offsetWidth;
    const available = viewport.clientWidth;
    viewport.scrollLeft =
      width <= available
        ? left + (width - available) / 2
        : Math.max(left, Math.min(left + width - available, previousLeft));
  }

  scrollToPage(pageNumber) {
    const { viewport, pdfViewer } = this.view;
    this.adjustToWidth();
    const offset = viewport.scrollLeft - this.middle;
    pdfViewer.currentPageNumber = pageNumber;
    this.rememberMiddle();
    this.alignPage(pageNumber, this.middle + offset);
    return offset;
  }

  didScroll() {
    const { viewport, loading, zoomAnimation } = this.view;
    const top = viewport.scrollTop;
    const movedVertically = top !== this.scrollTop;
    this.scrollTop = top;
    if (movedVertically && !loading && !zoomAnimation?.active) this.revealVisibleRow();
  }

  readingPage() {
    const { viewport, pagesElement } = this.view;
    const top = viewport.scrollTop;
    const bottom = top + viewport.clientHeight;
    // The final sheet can be fully visible before it reaches the leading edge.
    const row =
      top > 0 && bottom >= viewport.scrollHeight - 1
        ? pagesElement.lastElementChild
        : this.visibleRows(top, bottom).next().value;
    return Number(row?.dataset.pageNumber);
  }

  revealVisibleRow() {
    if (!this.middle) return;
    const { viewport, pagesElement } = this.view;
    const left = viewport.scrollLeft;
    const right = left + viewport.clientWidth;
    const axis = pagesElement.offsetWidth / 2;
    if (left < axis && right > axis) return;

    // PDF.js only renders pages intersecting both axes. A vertical move from
    // the edge of a wide sheet can otherwise leave a completely blank pane.
    const top = viewport.scrollTop;
    const bottom = top + viewport.clientHeight;
    let hasPage = false;
    for (const page of this.visibleRows(top, bottom)) {
      hasPage = true;
      if (page.offsetLeft < right && page.offsetLeft + page.offsetWidth > left) return;
    }
    if (hasPage) this.shiftHorizontal(axis - (left + right) / 2);
  }

  *visibleRows(top, bottom) {
    const pages = this.view.pagesElement.children;
    let low = 0;
    let high = pages.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const page = pages[mid];
      if (page.offsetTop + page.offsetHeight <= top) low = mid + 1;
      else high = mid;
    }
    for (let index = low; index < pages.length; index++) {
      const page = pages[index];
      if (page.offsetTop >= bottom) break;
      yield page;
    }
  }
}

module.exports = PageLayout;
