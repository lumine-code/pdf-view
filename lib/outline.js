// Pure helpers that shape a PDF.js outline into the flat, annotated form the
// navigation-adapter contract expects. Both mutate their input in place (adding
// the fields a navigation panel reads) and are kept side-effect free otherwise
// so they can be unit tested without a live viewer.

// Annotate a PDF.js outline tree for the navigation panel: give every entry a
// display `text`, a `children` alias, a 1-based `level`, a document-order
// `startPoint.row`, and a lazily-computed 1-based page `badge`. When `snoFilter`
// is set, leading section numbers ("1.2 Title" -> "Title") are stripped.
function enrichOutline(outline, snoFilter) {
  let index = 0;
  function parse(data, revel) {
    for (const item of data) {
      item.text = snoFilter ? item.title.replace(/[\d.]+ (.+)/g, "$1") : item.title;
      item.children = item.items;
      item.classList = [];
      item.level = item.revel = revel;
      item.startPoint = { row: index++ };
      Object.defineProperty(item, "badge", {
        get: () => (item.resolvedDest?.pageIndex != null ? item.resolvedDest.pageIndex + 1 : null),
        enumerable: true,
        configurable: true,
      });
      parse(item.children, revel + 1);
    }
  }
  parse(outline || [], 1);
  return outline || [];
}

// Flag which enriched entries are currently on screen. An entry's `visibility`
// is 1 when its own destination hash is visible, and `currentCount`/`stackCount`
// are reset each pass. Returns whether the subtree contains any visible entry.
function markOutlineState(headers, visibleDestHashes) {
  const visible = new Set((visibleDestHashes || []).filter(Boolean));

  function visit(items) {
    let hasVisible = false;
    for (const item of items) {
      const selfVisible = visible.has(item.destHash);
      const childVisible = visit(item.children || []);
      item.visibility = selfVisible ? 1 : 0;
      item.currentCount = 0;
      item.stackCount = 0;
      hasVisible = hasVisible || selfVisible || childVisible;
    }
    return hasVisible;
  }

  return visit(headers || []);
}

module.exports = { enrichOutline, markOutlineState };
