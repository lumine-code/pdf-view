const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { CompositeDisposable, Disposable } = require("lumine");
const { ZOOM_MODES, isZoomChoiceSelected } = require("./zoom-state");
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

function viewCommandState(main, action) {
  const mode = ZOOM_MODES.find((preset) => preset.command === action)?.value;
  const tool = action === "select-tool" ? "select" : action === "hand-tool" ? "hand" : null;
  if (!mode && !tool && action !== "zoom-100") return {};
  return {
    type: "radio",
    checked: ({ target }) => {
      const viewer = main.viewerForTarget(target);
      return Boolean(
        viewer?.pdfDocument &&
        (tool
          ? viewer.getViewState().tool === tool
          : isZoomChoiceSelected(viewer.getViewState(), mode ? { mode } : { scale: 1 })),
      );
    },
  };
}

function zoomStateKey(viewer) {
  const state = viewer.getViewState();
  return JSON.stringify([
    Boolean(viewer.pdfDocument),
    state.zoomMode || state.scaleValue,
    state.scale,
    state.tool,
  ]);
}

function buildTarget(target) {
  return target &&
    typeof target.providerId === "string" &&
    target.providerId &&
    typeof target.filePath === "string" &&
    target.filePath
    ? { providerId: target.providerId, filePath: target.filePath }
    : null;
}

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
    this.services = { builders: [], synctex: [] };
    this.serviceLeases = new CompositeDisposable();
    this.owner = {
      retired: false,
      viewers: this.viewers,
      observers: this.observers,
      services: this.services,
      scrollmapEdges: [],
      scrollmaps: new Map(),
      buildBindings: new Map(),
      buildResolutions: new Map(),
    };
  },

  activate() {
    this.initialize();
    const commands = Object.fromEntries(
      VIEW_COMMANDS.map((action) => [
        `pdf-view:${action}`,
        {
          ...viewCommandState(this, action),
          isAvailable: ({ target }) => Boolean(this.viewerForTarget(target)?.pdfDocument),
          didDispatch: (event) => this.run(this.viewerForTarget(event.target), action),
        },
      ]),
    );
    Object.assign(commands, {
      "pdf-view:set-zoom": {
        type: "radio",
        checked: ({ target, detail }) => {
          const viewer = this.viewerForTarget(target);
          return Boolean(
            viewer?.pdfDocument &&
            isZoomChoiceSelected(viewer.getViewState(), { scale: detail?.scale }),
          );
        },
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
      "pdf-view:compile": {
        description: "Compile the source document associated with this PDF.",
        isAvailable: ({ target }) => this.canCompileSource(this.viewerForTarget(target)),
        didDispatch: (event) => this.run(this.viewerForTarget(event.target), "compile"),
      },
      "pdf-view:toggle-compile-on-save": {
        description: "Compile this PDF's source whenever it is saved.",
        checked: ({ target }) => this.isCompileOnSaveEnabled(this.viewerForTarget(target)),
        isAvailable: ({ target }) => this.canToggleCompileOnSave(this.viewerForTarget(target)),
        didDispatch: (event) =>
          this.run(this.viewerForTarget(event.target), "toggle-compile-on-save"),
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
      const result =
        action === "compile"
          ? this.compileSource(viewer)
          : action === "toggle-compile-on-save"
            ? this.toggleCompileOnSave(viewer)
            : viewer.executeCommand(action);
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
    let lastZoomState = zoomStateKey(viewer);
    const menuStateSubscription = viewer.onDidChangeView(() => {
      if (owner.retired || !owner.viewers.has(viewer)) return;
      const state = zoomStateKey(viewer);
      if (state === lastZoomState) return;
      lastZoomState = state;
      lumine.commands.invalidateAvailability({ target: viewer.element });
    });
    viewer.getSyncTex = () => !owner.retired && owner.services.synctex.at(-1)?.payload;
    viewer.getBuildTarget = () =>
      this.getBuildBinding(viewer, owner)?.target || buildTarget(viewer.buildTarget);
    const buildPathSubscription = viewer.onDidChangePath(() => {
      this.syncBuilds(viewer, owner);
      this.updateBuildSource(viewer, owner);
    });
    const buildLoadSubscription = viewer.onDidLoad(() => this.updateBuildSource(viewer, owner));
    const buildFileSubscription = viewer.onDidChangeFile(() =>
      this.updateBuildSource(viewer, owner),
    );
    const buildFileStateSubscription = viewer.onDidChangeFileState(() =>
      this.updateBuildSource(viewer, owner),
    );
    this.syncBuilds(viewer, owner);
    this.updateBuildSource(viewer, owner);
    viewer.createCopy = (copyState) => {
      if (owner.retired) return null;
      return this.createViewer(viewer.getPath(), viewer.hash, copyState);
    };
    viewer.onDidDestroy(() => {
      menuStateSubscription.dispose();
      buildPathSubscription.dispose();
      buildLoadSubscription.dispose();
      buildFileSubscription.dispose();
      buildFileStateSubscription.dispose();
      owner.buildResolutions.get(viewer)?.controller.abort();
      owner.buildResolutions.delete(viewer);
      owner.buildBindings.delete(viewer);
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

  syncBuilds(viewer, owner = this.owner) {
    if (owner.retired || viewer.destroyed) return;
    viewer.builds.clear();
    for (const record of owner.services.builders)
      if (!record.disposed && record.payload.isBuilding(viewer.getPath()))
        viewer.builds.add(record);
    viewer.scheduleRefresh();
  },

  getBuildBinding(viewer, owner = this.owner) {
    if (!viewer || viewer.destroyed || !owner || owner.retired || !owner.viewers.has(viewer))
      return null;
    const binding = owner.buildBindings.get(viewer);
    return binding &&
      !binding.record.disposed &&
      owner.services.builders.includes(binding.record) &&
      viewer.isSameFile(binding.pdfPath)
      ? binding
      : null;
  },

  canCompileSource(viewer) {
    const binding = this.getBuildBinding(viewer);
    return Boolean(binding && binding.record.payload.canBuild(binding.target.filePath));
  },

  canToggleCompileOnSave(viewer) {
    const binding = this.getBuildBinding(viewer);
    return Boolean(
      binding && binding.record.payload.canToggleCompileOnSave(binding.target.filePath),
    );
  },

  isCompileOnSaveEnabled(viewer) {
    const binding = this.getBuildBinding(viewer);
    return Boolean(
      binding && binding.record.payload.isCompileOnSaveEnabled(binding.target.filePath),
    );
  },

  compileSource(viewer) {
    return this.runSourceAction(viewer, "canBuild", "build");
  },

  toggleCompileOnSave(viewer) {
    return this.runSourceAction(viewer, "canToggleCompileOnSave", "toggleCompileOnSave");
  },

  async runSourceAction(viewer, availability, action) {
    const owner = this.owner;
    const binding = await this.resolveBuildSource(viewer, owner);
    if (
      !binding ||
      this.getBuildBinding(viewer, owner) !== binding ||
      !binding.record.payload[availability](binding.target.filePath)
    )
      return null;
    return binding.record.payload[action](binding.target.filePath);
  },

  updateBuildSource(viewer, owner = this.owner) {
    const pending = this.resolveBuildSource(viewer, owner);
    pending.catch((error) => {
      if (!owner.retired && !viewer.destroyed)
        lumine.notifications.addError("PDF View", { detail: error.message });
    });
    return pending;
  },

  async resolveBuildSource(viewer, owner = this.owner) {
    if (!viewer || viewer.destroyed || !owner || owner.retired || !owner.viewers.has(viewer))
      return null;
    owner.buildResolutions.get(viewer)?.controller.abort();
    const controller = new AbortController();
    const pdfPath = viewer.getPath();
    const resolution = { controller, pdfPath };
    owner.buildResolutions.set(viewer, resolution);
    owner.buildBindings.delete(viewer);
    const current = () =>
      !owner.retired &&
      !viewer.destroyed &&
      !controller.signal.aborted &&
      viewer.isSameFile(pdfPath) &&
      owner.buildResolutions.get(viewer) === resolution;
    lumine.commands.invalidateAvailability({ target: viewer.element });
    if (!current()) return null;
    const cached = buildTarget(viewer.buildTarget);
    const records = [...owner.services.builders];
    let cancelled;
    const abort = new Promise((resolve) => {
      cancelled = () => resolve(null);
      controller.signal.addEventListener("abort", cancelled, { once: true });
    });
    try {
      const results = await Promise.race([
        Promise.allSettled(
          records.map(async (record) => {
            if (!current() || record.disposed) return null;
            const sourcePath = await record.payload.resolveSource(pdfPath, {
              signal: controller.signal,
              ...(cached?.providerId === record.payload.id ? { sourcePath: cached.filePath } : {}),
            });
            return typeof sourcePath === "string" &&
              path.isAbsolute(sourcePath) &&
              !sourcePath.includes("\0")
              ? { record, sourcePath }
              : null;
          }),
        ),
        abort,
      ]);
      if (!results || !current()) return null;
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
      const matches = results
        .map((result) => result.value)
        .filter((match) => match && !match.record.disposed);
      if (matches.length !== 1) return null;
      const [{ record, sourcePath }] = matches;
      const target = { providerId: record.payload.id, filePath: sourcePath };
      const binding = { record, target, pdfPath };
      owner.buildBindings.set(viewer, binding);
      viewer.buildTarget = target;
      return binding;
    } finally {
      controller.signal.removeEventListener("abort", cancelled);
      if (current()) lumine.commands.invalidateAvailability({ target: viewer.element });
    }
  },

  consumePdfBuildProvider(payload) {
    if (
      !payload ||
      typeof payload.id !== "string" ||
      !payload.id ||
      typeof payload.name !== "string" ||
      [
        "resolveSource",
        "canBuild",
        "build",
        "canToggleCompileOnSave",
        "isCompileOnSaveEnabled",
        "toggleCompileOnSave",
        "isBuilding",
        "onDidChangeBuilds",
        "onDidChangeSources",
      ].some((method) => typeof payload[method] !== "function")
    )
      throw new TypeError("Invalid PDF build provider.");
    this.initialize();
    const owner = this.owner;
    const records = owner.services.builders;
    const leases = this.serviceLeases;
    let record = records.find((entry) => entry.payload === payload);
    const created = !record;
    if (!record) {
      record = {
        payload,
        references: 0,
        disposed: false,
        subscriptions: new CompositeDisposable(),
      };
      records.push(record);
    }
    record.references++;
    const updateBuilds = () => {
      if (owner.retired || record.disposed) return;
      for (const viewer of owner.viewers) this.syncBuilds(viewer, owner);
      if (!owner.retired && !record.disposed) lumine.commands.invalidateAvailability();
    };
    const updateSources = (change) => {
      if (owner.retired || record.disposed) return;
      for (const viewer of owner.viewers)
        if (!change?.pdfPath || viewer.isSameFile(change.pdfPath))
          this.updateBuildSource(viewer, owner);
    };
    const edge = new Disposable(() => {
      leases.remove(edge);
      if (--record.references > 0) return;
      record.disposed = true;
      const index = records.indexOf(record);
      if (index !== -1) records.splice(index, 1);
      record.subscriptions.dispose();
      if (!owner.retired)
        for (const viewer of owner.viewers) {
          this.syncBuilds(viewer, owner);
          this.updateBuildSource(viewer, owner);
        }
      if (!owner.retired) lumine.commands.invalidateAvailability();
    });
    leases.add(edge);
    try {
      if (created) {
        record.subscriptions.add(
          payload.onDidChangeBuilds(updateBuilds),
          payload.onDidChangeSources(updateSources),
        );
        updateBuilds();
        updateSources();
      }
    } catch (error) {
      edge.dispose();
      throw error;
    }
    return edge;
  },

  consumeLatexSyncTex(service) {
    this.initialize();
    const owner = this.owner;
    const records = owner.services.synctex;
    const leases = this.serviceLeases;
    const record = { payload: service };
    records.push(record);
    const lease = new Disposable(() => {
      leases.remove(lease);
      const index = records.indexOf(record);
      if (index !== -1) records.splice(index, 1);
      if (!owner.retired) lumine.commands.invalidateAvailability();
    });
    leases.add(lease);
    lumine.commands.invalidateAvailability();
    return lease;
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
    for (const { controller } of this.owner?.buildResolutions.values() || []) controller.abort();
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
