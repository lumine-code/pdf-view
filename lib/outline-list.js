module.exports = class OutlineList {
  constructor(viewer) {
    this.viewer = viewer;
    this.rows = [];
    this.generation = 0;
    this.selectListHost = lumine.workspace.addSelectList(
      {
        items: [],
        emptyMessage: "No headings found",
        getItemId: (row) => row.id,
        search: { getFilterText: (row) => row.title, ignoreDiacritics: true },
        commands: {
          "pdf-view:go-to-heading": {
            description: "Jump to the selected heading in this document.",
            didDispatch: (event) => this.goToHeading(event.detail.item),
          },
        },
        actions: [
          {
            command: "pdf-view:go-to-heading",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
        ],
        renderItem: (row, { highlight }) => ({
          primary: highlight(row.title),
          trailing: row.page != null ? { text: `Page ${row.page}`, className: "badge" } : undefined,
        }),
      },
      { className: "pdf-view-list", crumb: "PDF Headings" },
    );
    this.selectList = this.selectListHost.getModel();
    this.outlineSubscription = viewer.observeOutline((outline) => this.updateOutline(outline));
    this.emptySubscription = this.selectList.onDidConfirmEmptySelection(() =>
      this.selectListHost.cancel("empty-selection"),
    );
  }

  updateOutline(outline) {
    const generation = ++this.generation;
    const rows = [];
    const visit = (headers, parentPath = "") => {
      for (const [index, header] of (headers || []).entries()) {
        const path = `${parentPath}${index}`;
        // An outline container may have children but no internal destination.
        if (header.dest) {
          const pageIndex = header.resolvedDest?.pageIndex;
          rows.push({
            id: `${generation}:${path}`,
            header,
            title: header.title,
            page: pageIndex != null ? pageIndex + 1 : null,
          });
        }
        visit(header.items, `${path}.`);
      }
    };
    visit(outline);
    this.rows = rows;
    return this.selectList.update({
      items: rows,
      loadingMessage: this.viewer.outlineLoaded ? null : "Loading headings…",
    });
  }

  goToHeading(row) {
    // A queued action must not jump into a reloaded or replaced document.
    if (this.viewer.destroyed || !this.rows.includes(row)) return;
    this.viewer.scrollToDestination(row.header);
  }

  show() {
    if (this.viewer.destroyed) return;
    this.updateOutline(this.viewer.outline);
    return this.selectListHost.show();
  }

  destroy() {
    this.outlineSubscription.dispose();
    this.emptySubscription.dispose();
    this.rows = [];
    this.selectListHost.destroy();
  }
};
