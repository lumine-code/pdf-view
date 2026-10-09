const { CompositeDisposable, Disposable } = require("lumine");
const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");

let Viewer = null;
let outline = null;

function getViewer() {
  Viewer ||= require("./viewer");
  return Viewer;
}

function getOutline() {
  outline ||= require("./outline");
  return outline;
}

function parsePdfURI(uri) {
  if (typeof uri !== "string") return null;
  if (/^file:/i.test(uri)) {
    try {
      const parsed = new URL(uri);
      const filePath = fileURLToPath(parsed);
      if (/\.pdf$/i.test(filePath)) return { filePath, hash: parsed.hash };
    } catch {
      return null;
    }
  }
  const match = uri.match(/(.+\.pdf)($|#.*)/i);
  return match ? { filePath: match[1], hash: match[2] } : null;
}

function buildPdfHash(dest, tag) {
  const parts = [];
  if (dest) parts.push(`nameddest=${encodeURIComponent(dest)}`);
  if (tag) parts.push(tag);
  return parts.length > 0 ? `#${parts.join("&")}` : "";
}

function connectService(main, owner, kind, payload) {
  if (owner.retired || main.owner !== owner) return new Disposable();
  const records = owner[`${kind}Records`];
  const edges = owner[`${kind}Edges`];
  let record = records.get(payload);
  const fresh = !record;
  if (!record) {
    record = { payload, references: 0, subscriptions: new CompositeDisposable() };
    records.set(payload, record);
    owner.services.add(record.subscriptions);
  }
  record.references++;
  const edge = { record };
  edges.add(edge);
  const lease = new Disposable(() => {
    owner.services.remove(lease);
    if (owner.retired || main.owner !== owner) return;
    edges.delete(edge);
    if (--record.references === 0) records.delete(payload);
    main.updateServices(owner);
    if (!record.references) {
      owner.services.remove(record.subscriptions);
      record.subscriptions.dispose();
    }
  });
  owner.services.add(lease);
  main.updateServices(owner);
  if (fresh && kind !== "widget") {
    const isCurrent = () =>
      !owner.retired && main.owner === owner && records.get(payload) === record;
    const extension = kind === "latex" ? ".tex" : ".typ";
    for (const [method, handler] of [
      ["onDidStartBuild", "handleBuildStart"],
      ["onDidFinishBuild", "handleBuildFinish"],
      ["onDidFailBuild", "handleBuildFinish"],
    ]) {
      if (!isCurrent()) break;
      const subscription = payload[method]((data) => {
        if (isCurrent()) main[handler](data.file, extension);
      });
      if (isCurrent()) record.subscriptions.add(subscription);
      else subscription.dispose();
    }
  }
  return lease;
}

/**
 * PDF View Package
 * Provides PDF viewing capabilities with SyncTeX support for LaTeX integration.
 * Supports auto-refresh and integration with latex-tools.
 */
module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "pdf-view",
      tips: [
        "You can search inside a PDF you are reading with {{ 'pdf-view:find' | keystroke }}",
        "You can search a PDF's headings with {{ 'pdf-view:list' | keystroke }}",
      ],
    };
  },

  /**
   * Builds the state needed by deserializers without publishing commands,
   * openers, or services. PackageManager calls this before either deserialize
   * or activate, so restored viewers stay owned by the same lifecycle.
   */
  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.viewers = new Set();
    this.viewerObservers = new Set();
    this.SimplemapClass = null;
    this.outlineScrollmap = null;
    this.latexTools = null;
    this.latexToolsSubscriptions = null;
    this.typstTools = null;
    this.typstToolsSubscriptions = null;
    const owner = {
      retired: false,
      services: new CompositeDisposable(),
      viewers: this.viewers,
      observers: this.viewerObservers,
      latexRecords: new Map(),
      latexEdges: new Set(),
      typstRecords: new Map(),
      typstEdges: new Set(),
      widgetRecords: new Map(),
      widgetEdges: new Set(),
      currentWidget: null,
      bindingWidget: false,
    };
    this.owner = owner;
    this.consumeLatexTools = (service) => connectService(this, owner, "latex", service);
    this.consumeTypstTools = (service) => connectService(this, owner, "typst", service);
    this.consumeScrollmapWidget = (Widget) => connectService(this, owner, "widget", Widget);
  },

  /**
   * Activates the package and registers the PDF opener.
   */
  activate() {
    this.initialize();
    if (!this.active) {
      this.active = true;
    } else {
      return;
    }
    this.disposables = new CompositeDisposable(
      lumine.workspace.addOpener(
        (uri) => {
          const parsed = parsePdfURI(uri);
          if (parsed) return this.createViewer(parsed.filePath, parsed.hash);
        },
        {
          canReusePendingItem: (item, uri) =>
            Boolean(parsePdfURI(uri) && this.viewers.has(item) && item.canReplaceDocument()),
          reusePendingItem: (item, uri, _options, { signal }) => {
            const parsed = parsePdfURI(uri);
            if (!parsed || !this.viewers.has(item)) return false;
            return item.replaceDocument(parsed.filePath, parsed.hash, { signal });
          },
        },
      ),
      lumine.commands.add("lumine-workspace", {
        "pdf-view:reload-all": () => this.reloadAll(),
      }),
      lumine.commands.add(".pdf-view", {
        "pdf-view:list": {
          description: "Search the document outline and jump to a heading.",
          didDispatch: (event) => this.viewerForEvent(event)?.showOutlineList(),
        },
      }),
      // Application-menu commands, registered once on the workspace rather than once
      // per viewer element. Packages > PDF View is always visible and the
      // application menu dispatches at whatever holds focus, so on the element
      // scope every one of its items did nothing unless the iframe itself had
      // focus. The keymap still binds them on `.pdf-view`, so a
      // keystroke reaches the viewer it came from either way.
      lumine.commands.add("lumine-workspace", this.viewerCommands()),
    );
  },

  /**
   * The viewer a dispatch is about: the one it came from when a keystroke sent
   * it, and the active pane item when the menu or the palette did.
   * @param {Event} event - the command event
   * @returns {Viewer|null} the viewer, or null when none is showing
   */
  viewerForEvent(event) {
    const element = event?.target?.closest?.(".pdf-view");
    if (element) {
      for (const viewer of this.viewers) {
        if (viewer.element === element) return viewer;
      }
    }
    const item = lumine.workspace.getActivePaneItem();
    return this.viewers.has(item) ? item : null;
  },

  /**
   * Builds the command map, each entry resolving its viewer at dispatch time.
   * @returns {Object} a command map for `lumine.commands.add`
   */
  viewerCommands() {
    const own = {
      "pdf-view:compile": {
        description: "Build the source this PDF came from and reload it.",
        run: (viewer) => viewer.compile(),
      },
      "pdf-view:open-tex": {
        description: "Open the source file this PDF was built from.",
        run: (viewer) => viewer.openTex(),
      },
      "pdf-view:refresh": {
        description: "Read the file from disk again, now.",
        run: (viewer) => viewer.refreshNow(),
      },
      "pdf-view:toggle-refreshing": {
        description: "Reload the file by itself whenever it changes on disk.",
        run: (viewer) => viewer.toggleRefreshing(),
      },
    };
    // The rest are forwarded to the PDF.js document unchanged. Written out with
    // the `pdf-view:` prefix rather than interpolated: the full name is what
    // both a reader and `check-commands` look for, and the description belongs
    // beside the name it explains. `null` where the label is the whole story —
    // Next Page needs no second line.
    const forwarded = {
      "pdf-view:next-page": null,
      "pdf-view:previous-page": null,
      "pdf-view:first-page": null,
      "pdf-view:last-page": null,
      "pdf-view:scroll-up": null,
      "pdf-view:scroll-down": null,
      "pdf-view:scroll-left": null,
      "pdf-view:scroll-right": null,
      "pdf-view:page-up": null,
      "pdf-view:page-down": null,
      "pdf-view:zoom-in": null,
      "pdf-view:zoom-out": null,
      // `zoomReset` in PDF.js hardcodes "auto"; it does not read `defaultZoom`.
      "pdf-view:zoom-reset": {
        description: "Put the zoom back to automatic.",
      },
      // The zoom presets are named after the values PDF.js stores in
      // `currentScaleValue`, which are the values `pdf-view.defaultZoom` offers.
      "pdf-view:page-width": { description: "Zoom until the width of a page fills the viewer." },
      "pdf-view:page-fit": { description: "Zoom until a whole page fits in the viewer." },
      "pdf-view:page-actual": { description: "Zoom to the size the page would print at." },
      "pdf-view:scroll-mode-vertical": { description: "Lay the pages out in a single column." },
      "pdf-view:scroll-mode-horizontal": { description: "Lay the pages out in a single row." },
      "pdf-view:scroll-mode-wrapped": {
        description: "Lay the pages out in as many columns as fit the width.",
      },
      "pdf-view:scroll-mode-page": {
        description: "Show one page at a time, with no scrolling between them.",
      },
      "pdf-view:spread-none": { description: "Show the pages singly rather than side by side." },
      "pdf-view:spread-odd": {
        description: "Pair the pages up, with odd-numbered pages on the left.",
      },
      "pdf-view:spread-even": {
        description: "Pair the pages up, with even-numbered pages on the left.",
      },
      "pdf-view:rotate-clockwise": { description: "Turn every page a quarter turn clockwise." },
      "pdf-view:rotate-counterclockwise": {
        description: "Turn every page a quarter turn anticlockwise.",
      },
      "pdf-view:select-tool": { description: "Drag to select the document's text." },
      "pdf-view:hand-tool": { description: "Drag to move the page instead of selecting text." },
      "pdf-view:find": { description: "Search the text of the document itself." },
      "pdf-view:find-next": null,
      "pdf-view:find-previous": null,
      "pdf-view:toggle-sidebar": {
        description: "Show or hide the thumbnails and outline beside the page.",
      },
      "pdf-view:presentation-mode": { description: "Fill the screen with one page at a time." },
      "pdf-view:download": { description: "Save a copy of this document somewhere else." },
      "pdf-view:copy": { description: "Copy the text selected in the document." },
    };

    const commands = {};
    const bind = (name, run, description) => {
      const didDispatch = (event) => {
        // No PDF open is on screen already, so this declines quietly.
        const viewer = this.viewerForEvent(event);
        if (viewer) run(viewer);
      };
      commands[name] = description ? { description, didDispatch } : didDispatch;
    };
    for (const [name, { description, run }] of Object.entries(own)) bind(name, run, description);
    for (const [name, meta] of Object.entries(forwarded)) {
      const sent = name.slice("pdf-view:".length);
      bind(name, (viewer) => viewer.sendCommand(sent), meta?.description);
    }
    return commands;
  },

  /**
   * Deactivates the package and destroys all viewers.
   */
  deactivate() {
    const owner = this.owner;
    if (owner) owner.retired = true;
    this.owner = null;
    this.active = false;
    this.initialized = false;
    const scrollmap = this.outlineScrollmap;
    const disposables = this.disposables;
    const viewers = this.viewers;
    this.outlineScrollmap = null;
    this.disposables = null;
    this.SimplemapClass = null;
    this.latexTools = null;
    this.latexToolsSubscriptions = null;
    this.typstTools = null;
    this.typstToolsSubscriptions = null;
    this.viewerObservers?.clear();
    this.viewers = new Set();
    this.viewerObservers = new Set();
    if (owner) {
      for (const kind of ["latex", "typst", "widget"]) {
        owner[`${kind}Records`].clear();
        owner[`${kind}Edges`].clear();
      }
      owner.currentWidget = null;
    }
    try {
      scrollmap?.destroy();
      for (const viewer of viewers || []) viewer.destroy();
    } finally {
      viewers?.clear();
      try {
        owner?.services.dispose();
      } finally {
        disposables?.dispose();
      }
    }
  },

  /**
   * Deserializes a viewer from saved state.
   * @param {Object} state - The serialized state
   * @returns {Viewer|undefined} The restored viewer or undefined
   */
  deserialize(state) {
    if (!fs.existsSync(state.filePath)) {
      return;
    }
    this.initialize();
    return this.createViewer(state.filePath, state.hash);
  },

  /**
   * Creates a new PDF view instance.
   * @param {string} filePath - Path to the PDF file
   * @param {string} hash - URL hash for page/position
   * @returns {Viewer} The new viewer instance
   */
  createViewer(filePath, hash) {
    const owner = this.owner;
    const viewers = this.viewers;
    let viewer = new (getViewer())(filePath, hash);
    const isCurrent = () => owner && !owner.retired && this.owner === owner;
    viewer.createCopy = (copyFilePath, copyHash) =>
      isCurrent() && !viewer.destroyed ? this.createViewer(copyFilePath, copyHash) : undefined;
    viewer.getLatexTools = () => this.latexTools; // Getter for latex-tools service
    viewer.getTypstTools = () => this.typstTools; // Getter for typst-tools service
    viewer.requestLatexTools = async () => {
      if (!isCurrent()) return null;
      if (!this.latexTools) await lumine.packages.requestService("latex-tools", "^1.0.0");
      return isCurrent() ? this.latexTools : null;
    };
    viewer.requestTypstTools = async () => {
      if (!isCurrent()) return null;
      if (!this.typstTools) await lumine.packages.requestService("typst-tools", "^1.0.0");
      return isCurrent() ? this.typstTools : null;
    };
    viewers.add(viewer);
    viewer.onDidDispose(() => {
      viewers.delete(viewer);
      if (isCurrent()) this.outlineScrollmap?.removeViewer(viewer);
    });
    this.outlineScrollmap?.addViewer(viewer);
    this.viewerObservers.forEach((callback) => callback(viewer));
    return viewer;
  },

  consumeScrollmapWidget(SimplemapClass) {
    return this.owner
      ? connectService(this, this.owner, "widget", SimplemapClass)
      : new Disposable();
  },

  updateServices(owner) {
    if (owner.retired || this.owner !== owner) return;
    for (const kind of ["latex", "typst"]) {
      const record = [...owner[`${kind}Edges`]].at(-1)?.record;
      this[`${kind}Tools`] = record?.payload ?? null;
      this[`${kind}ToolsSubscriptions`] = record?.subscriptions ?? null;
    }
    if (owner.bindingWidget) return;
    owner.bindingWidget = true;
    try {
      while (!owner.retired && this.owner === owner) {
        const record = [...owner.widgetEdges].at(-1)?.record ?? null;
        if (record === owner.currentWidget) break;
        owner.currentWidget = record;
        const previous = this.outlineScrollmap;
        this.outlineScrollmap = null;
        this.SimplemapClass = record?.payload ?? null;
        previous?.destroy();
        if (owner.retired || this.owner !== owner) break;
        if (([...owner.widgetEdges].at(-1)?.record ?? null) !== record) continue;
        if (record) {
          const PdfScrollmap = require("./scrollmap");
          const runtime = new PdfScrollmap(this, record.payload);
          if (
            owner.retired ||
            this.owner !== owner ||
            [...owner.widgetEdges].at(-1)?.record !== record
          ) {
            runtime.destroy();
          } else this.outlineScrollmap = runtime;
        }
      }
    } finally {
      owner.bindingWidget = false;
    }
  },

  destroyOutlineScrollmap() {
    const scrollmap = this.outlineScrollmap;
    this.outlineScrollmap = null;
    scrollmap?.destroy();
  },

  provideNavigationAdapter() {
    return {
      handlesItem: (item) => "pdfjsPath" in item,
      observeHeaders: (item, callback) => {
        item._navigationHeaders = null;
        item._navigationVisibleDestHashes = [];
        const snoFilter = lumine.config.get("pdf-view.snoFilter");

        const emit = (options) => {
          if (!item._navigationHeaders) return;
          getOutline().markOutlineState(item._navigationHeaders, item._navigationVisibleDestHashes);
          callback(item._navigationHeaders, options);
        };

        const outlineDispose = item.observeOutline((outline) => {
          item._navigationHeaders = getOutline().enrichOutline(outline, snoFilter);
          emit({ instant: true });
        });

        let startup = true;
        let previousKey = "";
        const visibleDispose = item.observeVisible((destHashes) => {
          const hashes = Array.isArray(destHashes) ? destHashes : [destHashes];
          const key = hashes.filter(Boolean).join("\0");
          if (!startup && key === previousKey) return;
          startup = false;
          previousKey = key;
          item._navigationVisibleDestHashes = hashes;
          emit();
        });

        return new CompositeDisposable(outlineDispose, visibleDispose);
      },
      navigateTo: async (item, header) => {
        const opened = await lumine.workspace.open(item, { searchAllPanes: true });
        if (!opened) return;
        item.scrollToDestination(header);
        lumine.views.getView(item).focus();
      },
    };
  },

  /**
   * Provides the pdf-view service for other packages.
   * @returns {Object} Service object with viewer management methods
   */
  providePdfView() {
    const owner = this.owner;
    const viewers = this.viewers;
    const observers = this.viewerObservers;
    const isCurrent = () => owner && !owner.retired && this.owner === owner;
    return {
      hasIntegratedScrollmap: true,

      /**
       * Get all active viewers
       * @returns {Set<Viewer>} Set of active viewer instances
       */
      getViewers: () => viewers,

      /**
       * Observe viewers - calls callback for existing and new viewers
       * @param {Function} callback - Called with each viewer
       * @returns {Disposable} Disposable to stop observing
       */
      observeViewers: (callback) => {
        if (!isCurrent()) return new Disposable();
        for (const viewer of viewers) {
          if (!isCurrent()) return new Disposable();
          callback(viewer);
        }
        if (!isCurrent()) return new Disposable();
        observers.add(callback);
        return new Disposable(() => {
          observers.delete(callback);
        });
      },

      /**
       * Find a viewer by file path
       * @param {string} filePath - The PDF file path
       * @returns {Viewer|null} The viewer or null
       */
      getViewerByPath: (filePath) => {
        for (const viewer of viewers) {
          if (viewer.filePath === filePath) {
            return viewer;
          }
        }
        return null;
      },

      /**
       * Find a viewer by tag in hash
       * @param {string} tag - Tag to search for in viewer hash
       * @returns {Viewer|null} The viewer or null
       */
      getViewerByTag: (tag) => {
        for (const viewer of viewers) {
          if (viewer.hash && viewer.hash.includes(tag)) {
            return viewer;
          }
        }
        return null;
      },

      /**
       * Open a PDF file in the viewer
       * @param {string} filePath - Path to the PDF file
       * @param {Object} options - Options for opening
       * @param {string} options.dest - Named destination to scroll to
       * @param {string} options.tag - Tag to identify the viewer
       * @param {string} options.split - Split direction ('left', 'right', 'up', 'down')
       * @param {boolean} options.activatePane - Whether to activate the pane
       * @returns {Promise<Viewer>} The viewer instance
       */
      open: (filePath, options = {}) => {
        if (!isCurrent()) return Promise.resolve(undefined);
        const { dest, tag, split = "right", activatePane = false } = options;
        const hash = buildPdfHash(dest, tag);
        return lumine.workspace.open(`${filePath}${hash}`, {
          split,
          activatePane,
          searchAllPanes: true,
        });
      },

      /**
       * Scroll an existing viewer to a named destination
       * @param {Viewer} viewer - The viewer instance
       * @param {string} dest - Named destination
       */
      scrollToDestination: (viewer, dest) => {
        if (isCurrent() && viewer && !viewer.destroyed && dest) {
          viewer.scrollToDestination({ dest, destHash: `#${dest}` });
        }
      },

      /**
       * Update a viewer to show a different file
       * @param {Viewer} viewer - The viewer instance
       * @param {string} filePath - New PDF file path
       * @param {string} dest - Optional named destination
       * @param {string} tag - Optional tag
       */
      setFile: (viewer, filePath, dest, tag) => {
        if (!isCurrent() || !viewer || viewer.destroyed) return;
        const hash = buildPdfHash(dest, tag);
        viewer.setFile(filePath, hash);
        viewer.reload();
      },
    };
  },

  /**
   * Consumes the latex-tools build status service.
   * @param {Object} service - The build status service
   * @returns {Disposable} Disposable to unregister the service
   */
  consumeLatexTools(service) {
    return this.owner ? connectService(this, this.owner, "latex", service) : new Disposable();
  },

  /**
   * Consumes the typst-tools build status service.
   * @param {Object} service - The build status service
   * @returns {Disposable} Disposable to unregister the service
   */
  consumeTypstTools(service) {
    return this.owner ? connectService(this, this.owner, "typst", service) : new Disposable();
  },

  /**
   * Handles build start by pausing auto-refresh.
   * @param {string} sourceFile - Path to the source file being compiled
   * @param {string} sourceExt - Source file extension (e.g., '.tex', '.typ')
   */
  handleBuildStart(sourceFile, sourceExt = ".tex") {
    const pdfFile = sourceFile.replace(new RegExp("\\" + sourceExt + "$"), ".pdf");

    for (let viewer of this.viewers) {
      if (viewer.filePath === pdfFile) {
        if (lumine.config.get("pdf-view.debug")) {
          console.log(`[pdf-view] Pausing auto-refresh for ${path.basename(pdfFile)}`);
        }
        viewer.pauseAutoRefresh();
      }
    }
  },

  /**
   * Handles build finish by resuming auto-refresh.
   * @param {string} sourceFile - Path to the source file that was compiled
   * @param {string} sourceExt - Source file extension (e.g., '.tex', '.typ')
   */
  handleBuildFinish(sourceFile, sourceExt = ".tex") {
    const pdfFile = sourceFile.replace(new RegExp("\\" + sourceExt + "$"), ".pdf");

    for (let viewer of this.viewers) {
      if (viewer.filePath === pdfFile) {
        if (lumine.config.get("pdf-view.debug")) {
          console.log(`[pdf-view] Resuming auto-refresh for ${path.basename(pdfFile)}`);
        }
        viewer.resumeAutoRefresh();
      }
    }
  },

  /**
   * Reloads all open PDF views.
   */
  reloadAll() {
    for (let viewer of this.viewers) {
      viewer.reload();
    }
  },
};
