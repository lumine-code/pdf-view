const { CompositeDisposable, Disposable } = require("lumine");
const Viewer = require("./viewer");
const { enrichOutline, markOutlineState } = require("./outline");
const path = require("path");
const fs = require("fs");

/**
 * PDF Viewer Package
 * Provides PDF viewing capabilities with SyncTeX support for LaTeX integration.
 * Supports auto-refresh and integration with latex-tools.
 */
module.exports = {
  /**
   * Activates the package and registers the PDF opener.
   */
  activate() {
    if (!this.active) {
      this.active = true;
    } else {
      return;
    }
    this.viewers = new Set();
    this.viewerObservers = new Set();
    this.SimplemapClass = null;
    this.outlineScrollmap = null;
    this.latexTools = null;
    this.latexToolsSubscriptions = null;
    this.typstTools = null;
    this.typstToolsSubscriptions = null;
    this.disposables = new CompositeDisposable(
      lumine.workspace.addOpener((uri) => {
        const match = uri.match(/(.+\.pdf)($|#.*)/i);
        if (match) {
          return this.createViewer(match[1], match[2]);
        }
      }),
      lumine.commands.add("lumine-workspace", {
        "pdf-view:reload-all": () => this.reloadAll(),
      }),
      // Every viewer command, registered once on the workspace rather than once
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
      "pdf-view:zoom-reset": {
        description: "Put the zoom back to the level the settings name.",
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
    this.active = false;
    this.destroyOutlineScrollmap();
    for (let viewer of this.viewers) {
      viewer.destroy();
    }
    this.disposables.dispose();
    if (this.latexToolsSubscriptions) {
      this.latexToolsSubscriptions.dispose();
    }
    if (this.typstToolsSubscriptions) {
      this.typstToolsSubscriptions.dispose();
    }
    this.SimplemapClass = null;
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
    this.activate(); // prevent multiple activation
    return this.createViewer(state.filePath, state.hash);
  },

  /**
   * Creates a new PDF viewer instance.
   * @param {string} filePath - Path to the PDF file
   * @param {string} hash - URL hash for page/position
   * @returns {Viewer} The new viewer instance
   */
  createViewer(filePath, hash) {
    let viewer = new Viewer(filePath, hash);
    viewer.getLatexTools = () => this.latexTools; // Getter for latex-tools service
    viewer.getTypstTools = () => this.typstTools; // Getter for typst-tools service
    this.viewers.add(viewer);
    viewer.onDidDispose(() => {
      this.viewers.delete(viewer);
      this.outlineScrollmap?.removeViewer(viewer);
    });
    this.outlineScrollmap?.addViewer(viewer);
    this.viewerObservers.forEach((callback) => callback(viewer));
    return viewer;
  },

  consumeScrollmapWidget(SimplemapClass) {
    const PdfScrollmap = require("./scrollmap");
    this.SimplemapClass = SimplemapClass;
    this.destroyOutlineScrollmap();
    this.outlineScrollmap = new PdfScrollmap(this, SimplemapClass);
    return new Disposable(() => {
      if (this.SimplemapClass === SimplemapClass) {
        this.destroyOutlineScrollmap();
        this.SimplemapClass = null;
      }
    });
  },

  destroyOutlineScrollmap() {
    this.outlineScrollmap?.destroy();
    this.outlineScrollmap = null;
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
          markOutlineState(item._navigationHeaders, item._navigationVisibleDestHashes);
          callback(item._navigationHeaders, options);
        };

        const outlineDispose = item.observeOutline((outline) => {
          item._navigationHeaders = enrichOutline(outline, snoFilter);
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
      navigateTo: (item, header) => {
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
    return {
      hasIntegratedScrollmap: true,

      /**
       * Get all active viewers
       * @returns {Set<Viewer>} Set of active viewer instances
       */
      getViewers: () => this.viewers,

      /**
       * Observe viewers - calls callback for existing and new viewers
       * @param {Function} callback - Called with each viewer
       * @returns {Disposable} Disposable to stop observing
       */
      observeViewers: (callback) => {
        for (const viewer of this.viewers) {
          callback(viewer);
        }
        this.viewerObservers.add(callback);
        return new Disposable(() => {
          this.viewerObservers.delete(callback);
        });
      },

      /**
       * Find a viewer by file path
       * @param {string} filePath - The PDF file path
       * @returns {Viewer|null} The viewer or null
       */
      getViewerByPath: (filePath) => {
        for (const viewer of this.viewers) {
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
        for (const viewer of this.viewers) {
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
        const { dest, tag, split = "right", activatePane = false } = options;
        let hash = "";
        if (dest) {
          hash += `#nameddest=${dest}`;
        }
        if (tag) {
          hash += hash ? `&${tag}` : `#${tag}`;
        }
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
        if (viewer && dest) {
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
        if (!viewer) return;
        let hash = "";
        if (dest) {
          hash += `#nameddest=${dest}`;
        }
        if (tag) {
          hash += hash ? `&${tag}` : `#${tag}`;
        }
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
    if (lumine.config.get("pdf-view.debug")) {
      console.log("[pdf-view] Consuming build status service");
    }
    this.latexTools = service;
    this.latexToolsSubscriptions = new CompositeDisposable();

    // Subscribe to build events
    this.latexToolsSubscriptions.add(
      service.onDidStartBuild((data) => {
        if (lumine.config.get("pdf-view.debug")) {
          console.log("[pdf-view] Build started:", data.file);
        }
        this.handleBuildStart(data.file);
      }),
      service.onDidFinishBuild((data) => {
        if (lumine.config.get("pdf-view.debug")) {
          console.log("[pdf-view] Build finished:", data.file);
        }
        this.handleBuildFinish(data.file);
      }),
      service.onDidFailBuild((data) => {
        if (lumine.config.get("pdf-view.debug")) {
          console.log("[pdf-view] Build failed:", data.file);
        }
        this.handleBuildFinish(data.file);
      }),
    );

    return new Disposable(() => {
      if (lumine.config.get("pdf-view.debug")) {
        console.log("[pdf-view] Disposing build status service");
      }
      this.latexTools = null;
      if (this.latexToolsSubscriptions) {
        this.latexToolsSubscriptions.dispose();
        this.latexToolsSubscriptions = null;
      }
    });
  },

  /**
   * Consumes the typst-tools build status service.
   * @param {Object} service - The build status service
   * @returns {Disposable} Disposable to unregister the service
   */
  consumeTypstTools(service) {
    if (lumine.config.get("pdf-view.debug")) {
      console.log("[pdf-view] Consuming typst-tools build status service");
    }
    this.typstTools = service;
    this.typstToolsSubscriptions = new CompositeDisposable();

    this.typstToolsSubscriptions.add(
      service.onDidStartBuild((data) => {
        if (lumine.config.get("pdf-view.debug")) {
          console.log("[pdf-view] Typst build started:", data.file);
        }
        this.handleBuildStart(data.file, ".typ");
      }),
      service.onDidFinishBuild((data) => {
        if (lumine.config.get("pdf-view.debug")) {
          console.log("[pdf-view] Typst build finished:", data.file);
        }
        this.handleBuildFinish(data.file, ".typ");
      }),
      service.onDidFailBuild((data) => {
        if (lumine.config.get("pdf-view.debug")) {
          console.log("[pdf-view] Typst build failed:", data.file);
        }
        this.handleBuildFinish(data.file, ".typ");
      }),
    );

    return new Disposable(() => {
      if (lumine.config.get("pdf-view.debug")) {
        console.log("[pdf-view] Disposing typst-tools build status service");
      }
      this.typstTools = null;
      if (this.typstToolsSubscriptions) {
        this.typstToolsSubscriptions.dispose();
        this.typstToolsSubscriptions = null;
      }
    });
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
   * Reloads all open PDF viewers.
   */
  reloadAll() {
    for (let viewer of this.viewers) {
      viewer.reload();
    }
  },
};
