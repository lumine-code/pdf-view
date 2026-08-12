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
      "pdf-view:compile": (viewer) => viewer.compile(),
      "pdf-view:open-tex": (viewer) => viewer.openTex(),
      "pdf-view:refresh": (viewer) => viewer.refreshNow(),
      "pdf-view:toggle-refreshing": (viewer) => viewer.toggleRefreshing(),
    };
    // The rest are forwarded to the PDF.js document unchanged.
    const forwarded = [
      "next-page",
      "previous-page",
      "first-page",
      "last-page",
      "scroll-up",
      "scroll-down",
      "scroll-left",
      "scroll-right",
      "page-up",
      "page-down",
      "zoom-in",
      "zoom-out",
      "zoom-reset",
      // The zoom presets are named after the values PDF.js stores in
      // `currentScaleValue`, which are the values `pdf-view.defaultZoom` offers.
      "page-width",
      "page-fit",
      "page-actual",
      "scroll-mode-vertical",
      "scroll-mode-horizontal",
      "scroll-mode-wrapped",
      "scroll-mode-page",
      "spread-none",
      "spread-odd",
      "spread-even",
      "rotate-clockwise",
      "rotate-counterclockwise",
      "select-tool",
      "hand-tool",
      "find",
      "find-next",
      "find-previous",
      "toggle-sidebar",
      "presentation-mode",
      "download",
      "copy",
    ];

    const commands = {};
    const bind = (name, run) => {
      commands[name] = (event) => {
        // No PDF open is on screen already, so this declines quietly.
        const viewer = this.viewerForEvent(event);
        if (viewer) run(viewer);
      };
    };
    for (const [name, run] of Object.entries(own)) bind(name, run);
    for (const name of forwarded) {
      bind(`pdf-view:${name}`, (viewer) => viewer.sendCommand(name));
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
