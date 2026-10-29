const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { CompositeDisposable, Disposable } = require("lumine");
const PDF_OPENER_ID = "pdf-view";

const VIEW_COMMANDS = [
  "previous-page",
  "next-page",
  "first-page",
  "last-page",
  "zoom-in",
  "zoom-out",
  "zoom-next-level",
  "zoom-previous-level",
  "automatic-zoom",
  "fit-width",
  "fit-to-view",
  "zoom-100",
  "rotate-clockwise",
  "rotate-counterclockwise",
  "select-tool",
  "hand-tool",
  "scroll-up",
  "scroll-down",
  "scroll-left",
  "scroll-right",
  "page-up",
  "page-down",
];

function parseURI(uri) {
  if (typeof uri !== "string") return null;
  if (/^file:/i.test(uri)) {
    try {
      const url = new URL(uri);
      const filePath = fileURLToPath(url);
      return /\.pdf$/i.test(filePath) ? { filePath, hash: url.hash } : null;
    } catch {
      return null;
    }
  }
  const match = /^(.*\.pdf)($|#.*)/i.exec(uri);
  return match ? { filePath: match[1], hash: match[2] } : null;
}

function parseOpening(uri, options = {}) {
  const parsed = parseURI(uri);
  if (!parsed) return null;
  const fragment = options.uriFragment ?? parsed.hash;
  return { filePath: parsed.filePath, hash: fragment ? `#${fragment.replace(/^#/, "")}` : "" };
}

module.exports = {
  initialize() {
    if (this.viewers) return;
    this.viewers = new Set();
    this.observers = new Set();
    this.services = { latex: [], typst: [] };
    this.serviceLeases = new CompositeDisposable();
    this.owner = {
      retired: false,
      viewers: this.viewers,
      observers: this.observers,
      services: this.services,
      scrollmapEdges: [],
      scrollmaps: new Map(),
    };
  },

  activate() {
    this.initialize();
    const commands = Object.fromEntries(
      VIEW_COMMANDS.map((action) => [
        `pdf-view:${action}`,
        {
          isAvailable: ({ target }) => Boolean(this.viewerForTarget(target)?.pdfDocument),
          didDispatch: (event) => this.run(this.viewerForTarget(event.target), action),
        },
      ]),
    );
    Object.assign(commands, {
      "pdf-view:set-zoom": {
        hiddenInCommandPalette: true,
        isAvailable: ({ target, detail }) =>
          Boolean(
            this.viewerForTarget(target)?.pdfDocument &&
            Number.isFinite(detail?.scale) &&
            detail.scale >= 0.1 &&
            detail.scale <= 10,
          ),
        didDispatch: (event) => {
          const viewer = this.viewerForTarget(event.target);
          if (!viewer) return;
          viewer.focus();
          const operation = viewer.setScale(event.detail.scale, { smooth: true });
          operation?.catch((error) => {
            if (!viewer.destroyed)
              lumine.notifications.addError("PDF View", { detail: error.message });
          });
        },
      },
      "pdf-view:refresh": {
        description: "Read the PDF from disk and keep the current view.",
        didDispatch: (event) => this.run(this.viewerForTarget(event.target), "refresh"),
      },
      "pdf-view:copy": {
        isAvailable: ({ target }) => Boolean(this.viewerForTarget(target)?.getSelectedText()),
        didDispatch: (event) => this.run(this.viewerForTarget(event.target), "copy"),
      },
      "pdf-view:synctex": {
        description: "Open the source at the clicked PDF position.",
        isAvailable: ({ target }) => Boolean(this.viewerForTarget(target)?.canSyncToSource()),
        didDispatch: (event) => this.run(this.viewerForTarget(event.target), "synctex"),
      },
    });
    this.disposables = new CompositeDisposable(
      lumine.workspace.addPathOpener({
        id: PDF_OPENER_ID,
        label: "PDF View",
        canOpen: (uri) => Boolean(parseURI(uri)),
        handlesItem: (item, uri, options) => {
          const parsed = parseOpening(uri, options);
          return (
            this.viewers.has(item) &&
            parsed &&
            item.isSameFile(parsed.filePath) &&
            item.hash === parsed.hash
          );
        },
        canReusePendingItem: (item, uri) =>
          this.viewers.has(item) &&
          !item.destroyed &&
          !item.fileOperationDepth &&
          Boolean(parseURI(uri)),
        reusePendingItem: (item, uri, options, { signal }) => {
          const parsed = parseOpening(uri, options);
          return parsed
            ? item.reusePendingDocument(parsed.filePath, parsed.hash, {
                signal,
              })
            : false;
        },
        open: (uri, options = {}) => {
          const parsed = parseOpening(uri, options);
          return parsed && this.createViewer(parsed.filePath, parsed.hash);
        },
      }),
      lumine.commands.add(".pdf-view", commands),
      lumine.commands.add(".pdf-view", {
        "core:copy": (event) => this.viewerForTarget(event.target)?.copyText(),
        "core:move-up": (event) => this.run(this.viewerForTarget(event.target), "scroll-up"),
        "core:move-down": (event) => this.run(this.viewerForTarget(event.target), "scroll-down"),
        "core:move-left": (event) => this.run(this.viewerForTarget(event.target), "scroll-left"),
        "core:move-right": (event) => this.run(this.viewerForTarget(event.target), "scroll-right"),
        "core:page-up": (event) => this.run(this.viewerForTarget(event.target), "page-up"),
        "core:page-down": (event) => this.run(this.viewerForTarget(event.target), "page-down"),
      }),
    );
  },

  run(viewer, action) {
    if (!viewer) return;
    try {
      const result = viewer.executeCommand(action);
      result?.catch?.((error) =>
        lumine.notifications.addError("PDF View", { detail: error.message }),
      );
      return result;
    } catch (error) {
      lumine.notifications.addError("PDF View", { detail: error.message });
    }
  },

  viewerForTarget(target) {
    const element = target?.closest?.(".pdf-view");
    for (const viewer of this.viewers) if (viewer.element === element) return viewer;
    return null;
  },

  createViewer(filePath, hash = "", state = {}) {
    this.initialize();
    const Viewer = require("./viewer");
    const viewer = new Viewer(filePath, hash, state);
    const owner = this.owner;
    this.viewers.add(viewer);
    viewer.getLatexTools = () => owner.services.latex.at(-1)?.payload;
    viewer.getTypstTools = () => owner.services.typst.at(-1)?.payload;
    viewer.createCopy = (copyState) => {
      if (owner.retired) return null;
      return this.createViewer(viewer.getPath(), viewer.hash, copyState);
    };
    viewer.onDidDestroy(() => {
      owner.viewers.delete(viewer);
      owner.scrollmaps.get(viewer)?.destroy();
      owner.scrollmaps.delete(viewer);
    });
    this.attachScrollmap(viewer, owner);
    for (const callback of this.observers) callback(viewer);
    return viewer;
  },

  deserialize({ filePath, hash, state, tag, viewState }) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const restoredState =
      state ??
      (viewState && {
        page: viewState.page,
        scaleValue: viewState.zoom,
        rotation: viewState.rotation,
        left: viewState.left,
        top: viewState.top,
      });
    return this.createViewer(filePath, hash, { ...restoredState, integrationTag: tag });
  },

  provideNavigationAdapter() {
    this.initialize();
    const { NavigationAdapter } = require("./navigation");
    const owner = this.owner;
    return (owner.navigationAdapter ||= new NavigationAdapter(
      (item) => !owner.retired && owner.viewers.has(item),
    ));
  },

  provideSearchAdapter() {
    this.initialize();
    const owner = this.owner;
    return {
      handlesItem: (item) => !owner.retired && owner.viewers.has(item),
      canReplaceItem: () => false,
      getAdapterForItem: (item) =>
        !owner.retired && owner.viewers.has(item) ? item.getSearchAdapter() : null,
    };
  },

  providePdfView() {
    this.initialize();
    const owner = this.owner;
    const PdfService = require("./pdf-service");
    owner.pdfService ||= new PdfService(owner, (...args) => this.createViewer(...args));
    return (owner.pdfFacade ||= {
      openerId: PDF_OPENER_ID,
      open: (...args) => owner.pdfService.open(...args),
    });
  },

  observeViewers(callback, owner = this.owner) {
    if (owner?.retired) return new Disposable();
    this.initialize();
    const { retired, viewers, observers } = owner ?? this.owner;
    if (retired) return new Disposable();
    observers.add(callback);
    for (const viewer of viewers) callback(viewer);
    return new Disposable(() => observers.delete(callback));
  },

  provideInversionProvider() {
    this.initialize();
    const owner = this.owner;
    const targets = (owner.inversionTargets ||= new WeakMap());
    const observe = (callback) => this.observeViewers(callback, owner);
    return {
      targetType: "pdf",
      observeTargets: (callback) =>
        observe((viewer) => {
          let target = targets.get(viewer);
          if (!target) {
            target = {
              setInverted: (state) => {
                if (!viewer.destroyed)
                  viewer.element.classList.toggle("pdf-view-colors-inverted", Boolean(state));
              },
              onDidDestroy: (listener) => viewer.onDidDestroy(listener),
            };
            targets.set(viewer, target);
          }
          callback(target);
        }),
    };
  },

  consumeBuildService(kind, service) {
    this.initialize();
    const owner = this.owner;
    const records = owner.services[kind];
    const record = { payload: service };
    records.push(record);
    const edge = new CompositeDisposable();
    const sourceMatches = (viewer, file) => {
      const output = service.getOutputPath?.(file);
      return output
        ? path.resolve(output) === path.resolve(viewer.getPath())
        : viewer.getPath().replace(/\.pdf$/i, kind === "latex" ? ".tex" : ".typ") === file;
    };
    edge.add(
      new Disposable(() => {
        const index = records.indexOf(record);
        if (index !== -1) records.splice(index, 1);
        for (const viewer of owner.viewers) {
          viewer.builds.delete(record);
          if (!owner.retired) viewer.scheduleRefresh();
        }
        lumine.commands.invalidateAvailability();
      }),
    );
    for (const [method, building] of [
      ["onDidStartBuild", true],
      ["onDidFinishBuild", false],
      ["onDidFailBuild", false],
    ]) {
      if (!service[method]) continue;
      edge.add(
        service[method](({ file }) => {
          if (owner.retired) return;
          for (const viewer of owner.viewers) {
            if (!sourceMatches(viewer, file)) continue;
            if (building) viewer.builds.add(record);
            else {
              viewer.builds.delete(record);
              viewer.scheduleRefresh();
            }
          }
        }),
      );
    }
    this.serviceLeases.add(edge);
    lumine.commands.invalidateAvailability();
    return edge;
  },

  consumeLatexTools(service) {
    return this.consumeBuildService("latex", service);
  },
  consumeTypstTools(service) {
    return this.consumeBuildService("typst", service);
  },

  consumeScrollmapWidget(Widget) {
    this.initialize();
    if (typeof Widget !== "function")
      throw new TypeError("scrollmap.widget must provide a widget class");
    const owner = this.owner;
    const record = { Widget };
    const leases = this.serviceLeases;
    owner.scrollmapEdges.push(record);
    const update = () => {
      if (owner.retired) return;
      const next = owner.scrollmapEdges.at(-1)?.Widget;
      if (next === owner.scrollmapWidget) return;
      for (const map of owner.scrollmaps.values()) map.destroy();
      owner.scrollmaps.clear();
      owner.scrollmapWidget = next;
      if (next) for (const viewer of owner.viewers) this.attachScrollmap(viewer, owner);
    };
    const lease = new Disposable(() => {
      leases.remove(lease);
      const index = owner.scrollmapEdges.indexOf(record);
      if (index !== -1) owner.scrollmapEdges.splice(index, 1);
      update();
    });
    this.serviceLeases.add(lease);
    update();
    return lease;
  },

  attachScrollmap(viewer, owner = this.owner) {
    if (owner.retired || !owner.scrollmapWidget || owner.scrollmaps.has(viewer)) return;
    const PdfScrollmap = require("./scrollmap");
    owner.scrollmaps.set(
      viewer,
      new PdfScrollmap(viewer, owner.scrollmapWidget, this.provideNavigationAdapter()),
    );
  },

  provideBackgroundTips() {
    return {
      packageName: require("../package.json").name,
      tips: [
        "Read PDFs beside their source and use the search and navigation panels to explore the document.",
      ],
    };
  },

  async deactivate() {
    if (this.owner) this.owner.retired = true;
    this.owner?.pdfService?.dispose();
    this.disposables?.dispose();
    this.serviceLeases?.dispose();
    await Promise.all([...(this.viewers || [])].map((viewer) => viewer.destroy()));
    this.owner?.observers.clear();
    this.viewers = null;
    this.observers = null;
    this.services = null;
  },
};
