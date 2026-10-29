class PdfService {
  constructor(owner, createViewer) {
    this.owner = owner;
    this.createViewer = createViewer;
    this.requests = new WeakMap();
    this.placements = new WeakMap();
    this.pendingPlacements = new Set();
  }

  dispose() {
    for (const placement of this.pendingPlacements) placement.controller.abort();
    this.pendingPlacements.clear();
  }

  async open(filePath, options = {}) {
    const { owner } = this;
    if (owner.retired) return null;
    const { signal } = options;
    signal?.throwIfAborted();
    const anchor = options.pane ?? lumine.workspace.getActivePane();
    if (anchor?.isDestroyed()) return null;
    const tag = options.reuse === false ? null : options.tag;
    let viewer =
      options.reuse !== false
        ? [...owner.viewers].find(
            (item) =>
              !item.destroyed &&
              (tag ? item.integrationTag === tag : item.isSameFile(filePath)) &&
              (!this.placements.get(item)?.controller.signal.aborted ||
                lumine.workspace.paneForItem(item)),
          )
        : null;
    if (!viewer) viewer = this.createViewer(filePath, "", { integrationTag: tag });

    // Claim the viewer before yielding. A second request for this tag must
    // share its pending placement and invalidate the first navigation.
    const request = {};
    this.requests.set(viewer, request);
    viewer.destinationRevision++;
    const current = () =>
      !owner.retired &&
      !viewer.destroyed &&
      this.requests.get(viewer) === request &&
      (request.generation == null || viewer.generation === request.generation);
    let rejectAbort;
    const aborted = new Promise((_, reject) => (rejectAbort = reject));
    const abort = () => {
      if (current()) {
        viewer.destinationRevision++;
        this.placements.get(viewer)?.controller.abort();
      }
      rejectAbort(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      signal?.throwIfAborted();
      if (!current()) return null;
      const ready = viewer.setFile(filePath);
      request.generation = viewer.generation;
      ready.catch(() => {});
      let placement = this.placements.get(viewer);
      if (!placement || placement.controller.signal.aborted) {
        const pane = lumine.workspace.paneForItem(viewer);
        const controller = new AbortController();
        placement = { controller };
        this.placements.set(viewer, placement);
        this.pendingPlacements.add(placement);
        placement.promise = lumine.workspace
          .open(viewer, {
            pane: pane ?? anchor,
            split: pane ? undefined : (options.split ?? (options.pane ? undefined : "right")),
            activatePane: options.activatePane ?? false,
            activateItem: true,
            searchAllPanes: true,
            pending: options.pending,
            signal: controller.signal,
          })
          .finally(() => {
            this.pendingPlacements.delete(placement);
            if (this.placements.get(viewer) === placement) this.placements.delete(viewer);
          });
      }
      const opened = await Promise.race([placement.promise, aborted]);
      signal?.throwIfAborted();
      if (!current()) return null;
      if (opened !== viewer || !lumine.workspace.paneForItem(viewer)) {
        await viewer.destroy();
        return null;
      }
      await Promise.race([ready, aborted]);
      signal?.throwIfAborted();
      if (!current()) return null;
      if (options.dest) {
        await Promise.race([
          viewer.scrollToDestination(options.dest, { destinationMode: options.destinationMode }),
          aborted,
        ]);
      }
      signal?.throwIfAborted();
      return current() ? viewer : null;
    } catch (error) {
      const failedCurrentRequest = current();
      if (failedCurrentRequest && !lumine.workspace.paneForItem(viewer)) await viewer.destroy();
      signal?.throwIfAborted();
      if (!failedCurrentRequest) return null;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}

module.exports = PdfService;
