// Shared by the iframe's classic script and the Node-based package specs.
(function exposeNavigation(root) {
  function destinationPoint(dest, viewBox) {
    if (!Array.isArray(dest) || !dest[1]?.name) return null;
    const [left, , , top] = viewBox;
    const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);
    switch (dest[1].name) {
      case "XYZ":
        return [numberOr(dest[2], left), numberOr(dest[3], top)];
      case "FitH":
      case "FitBH":
        return [left, numberOr(dest[2], top)];
      case "FitV":
      case "FitBV":
        return [numberOr(dest[2], left), top];
      case "FitR":
        return [numberOr(dest[2], left), numberOr(dest[5], top)];
      case "Fit":
      case "FitB":
        return [left, top];
      default:
        return null;
    }
  }

  function viewportDestination(dest, viewport) {
    const point = destinationPoint(dest, viewport.viewBox);
    if (!point) return null;
    if (dest[1].name === "FitR") {
      if (dest.length < 6 || !dest.slice(2, 6).every(Number.isFinite)) return null;
      const first = viewport.convertToViewportPoint(dest[2], dest[3]);
      const second = viewport.convertToViewportPoint(dest[4], dest[5]);
      return [Math.min(first[0], second[0]), Math.min(first[1], second[1])];
    }
    return viewport.convertToViewportPoint(...point);
  }

  function pageIndex(value, count) {
    return Number.isInteger(value) && value >= 0 && value < count ? value : null;
  }

  function clampPage(value, count) {
    const lastPage = Number.isInteger(count) && count > 0 ? count : 1;
    return Math.max(1, Math.min(Number.isInteger(value) ? value : 1, lastPage));
  }

  function viewHash(state, count) {
    const page = clampPage(state.page, count);
    const zoom = /^\d+(?:\.\d+)?$/.test(String(state.zoom)) ? Number(state.zoom) * 100 : state.zoom;
    const left = Number.isFinite(state.left) ? Math.round(state.left) : 0;
    const top = Number.isFinite(state.top) ? Math.round(state.top) : null;
    return `page=${page}&zoom=${zoom}${top === null ? "" : `,${left},${top}`}`;
  }

  function pageProgress(y, viewBox) {
    return Math.max(0, Math.min(1, (viewBox[3] - y) / (viewBox[3] - viewBox[1])));
  }

  function visiblePageRange(pageRect, viewportRect, viewport) {
    const left = Math.max(pageRect.left, viewportRect.left);
    const top = Math.max(pageRect.top, viewportRect.top);
    const right = Math.min(pageRect.right, viewportRect.right);
    const bottom = Math.min(pageRect.bottom, viewportRect.bottom);
    if (right <= left || bottom <= top || !pageRect.width || !pageRect.height) return null;
    const scaleX = viewport.width / pageRect.width;
    const scaleY = viewport.height / pageRect.height;
    const progress = [];
    for (const x of [left, right]) {
      for (const y of [top, bottom]) {
        const point = viewport.convertToPdfPoint(
          (x - pageRect.left) * scaleX,
          (y - pageRect.top) * scaleY,
        );
        progress.push(pageProgress(point[1], viewport.viewBox));
      }
    }
    return { start: Math.min(...progress), end: Math.max(...progress) };
  }

  // Intersect each section's document-order span with the visible PDF interval
  // of each page. That interval uses the viewport's inverse transformation, so
  // rotation, crop boxes and every page layout share the same calculation.
  function visibleSections(positions, pages) {
    const visible = [];
    const ordered = [...positions].sort((a, b) => a.page - b.page || a.progress - b.progress);
    for (let index = 0; index < ordered.length; index++) {
      const current = ordered[index];
      const next = ordered[index + 1];
      for (const page of pages) {
        if (page.index < current.page || (next && page.index > next.page)) continue;
        const start = page.index === current.page ? current.progress : 0;
        const end = next && page.index === next.page ? next.progress : 1;
        if (end > start && end > page.start && start < page.end) {
          if (current.item.destHash) visible.push(current.item.destHash);
          break;
        }
      }
    }
    return visible;
  }

  const navigation = {
    destinationPoint,
    viewportDestination,
    pageIndex,
    clampPage,
    viewHash,
    pageProgress,
    visiblePageRange,
    visibleSections,
  };
  if (typeof module === "object" && module.exports) module.exports = navigation;
  if (typeof window === "object") root.pdfViewNavigation = navigation;
})(typeof window === "object" ? window : globalThis);
