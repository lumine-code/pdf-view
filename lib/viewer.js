const { CompositeDisposable, Disposable, Emitter, watchFile } = require("lumine");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const RefreshController = require("./refresh-controller");
const DocumentReplacement = require("./document-replacement");

module.exports = class Viewer {
  constructor(filePath, hash) {
    this.disposables = new CompositeDisposable();
    this.subscriptions = new CompositeDisposable();
    this.fileStateEmitter = new Emitter();
    this.fileOperationDepth = 0;
    this.destroyed = false;
    this.documentVersion = 0;
    this.disposables.add(this.fileStateEmitter);
    this.onDidChangeTitleCallbacks = new Set();
    this.observeOutlineCallbacks = new Set();
    this.observeVisibleCallbacks = new Set();
    this.observeScrollMapDataCallbacks = new Set();
    this.outlineLoaded = false;
    this.messageHandlers = {
      click: (data) => this.handleClickMessage(data),
      contextmenu: (data) => this.handleSynctex(data),
      pdfjsOutline: (data) => this.handleOutlineMessage(data),
      visibleOutlineItems: (data) => this.handleVisibleMessage(data),
      currentOutlineItem: (data) => this.handleVisibleMessage(data),
      scrollMapData: (data) => this.emitScrollmapData(data),
      ready: (data) => this.handleReadyMessage(data),
      loadError: (data) => this.handleLoadErrorMessage(data),
      documentLoaded: (data) => this.refreshController.onDocumentLoaded(data),
    };
    this.pdfjsPath = path.join(__dirname, "..", "vendors", "pdfjs-dist", "web", "viewer.html");
    // The item view is a wrapper rather than the iframe itself, so the pane's
    // show/hide and removal reach everything drawn beside the document (the
    // scrollmap strip) -- an iframe can hold no children. ViewRegistry caches
    // the item view once, so the wrapper is created here and never replaced.
    this.element = document.createElement("div");
    this.element.classList.add("pdf-view");
    this.element.setAttribute("tabindex", "-1");
    // The pane focuses the item view on activation; keystrokes belong to the
    // PDF.js document, so forward.
    this.element.focus = () => this.frame.focus();
    this.frame = document.createElement("iframe");
    this.frame.classList.add("pdf-view-frame");
    this.frame.setAttribute("tabindex", "-1");
    // Read back as `window.frameElement.pdfViewerRedispatchKeyboardEvent` by
    // the vendored viewer, so it must sit on the iframe, never the wrapper.
    this.frame.pdfViewerRedispatchKeyboardEvent = (event) => this.redispatchKeyboardEvent(event);
    this.element.appendChild(this.frame);
    this.autoRefreshPausedByBuild = false;
    this.refreshController = new RefreshController(this);
    this.documentReplacement = new DocumentReplacement(this);
    this.readyCallbacks = new Set();
    this.getLatexTools = null; // Getter set by main module
    this.getTypstTools = null; // Getter set by main module
    this.setFile(filePath, hash);
    this.disposables.add(
      lumine.workspace.registerFileDocument({
        owner: this,
        getPath: () => this.getPath(),
        setPath: (nextPath) => this.setPath(nextPath),
        beginFileOperation: () => {
          this.fileOperationDepth++;
          this.refreshController.cancelTimers();
        },
        endFileOperation: () => {
          this.fileOperationDepth--;
          this.reconcileFile();
        },
      }),
    );
    this.reload();
    this.disposables.add(
      lumine.config.observe("pdf-view.autoRefresh", (value) => {
        this.autoRefresh = value;
        this.refreshController.preferenceChanged();
      }),
      lumine.config.observe("pdf-view.autoTime", (value) => {
        this.autoTime = value;
      }),
      lumine.config.observe("pdf-view.debug", (value) => {
        this.debug = value;
      }),
    );
    this.messageEventBinded = this.messageEvent.bind(this);
    window.addEventListener("message", this.messageEventBinded);

    // Handle focus to activate pane. `focus` does not bubble, so the listener
    // sits on the iframe, the element that actually receives it.
    this.focusEventBinded = this.focusEvent.bind(this);
    this.frame.addEventListener("focus", this.focusEventBinded);

    // Handle mousedown on tab to activate pane
    this.mousedownEventBinded = this.mousedownEvent.bind(this);
    this.element.addEventListener("mousedown", this.mousedownEventBinded);

    // Handle tab dragging - disable pointer events on iframe during drag
    // Listen at the document level to catch all drag operations
    this.dragStartBinded = this.dragStartHandler.bind(this);
    this.dragOverBinded = this.dragOverHandler.bind(this);
    this.dragEndBinded = this.dragEndHandler.bind(this);
    this.dropBinded = this.dropHandler.bind(this);

    document.addEventListener("dragstart", this.dragStartBinded, true);
    document.addEventListener("dragover", this.dragOverBinded, true);
    document.addEventListener("dragend", this.dragEndBinded, true);
    document.addEventListener("drop", this.dropBinded, true);
  }

  dragStartHandler() {
    // When any drag starts (likely a tab), disable pointer events on the iframe
    // This allows the drop zone detection to work properly
    this.frame.style.pointerEvents = "none";
    this._isDragging = true;
  }

  dragOverHandler() {
    // Keep pointer events disabled during drag
    if (this._isDragging) {
      this.frame.style.pointerEvents = "none";
    }
  }

  dragEndHandler() {
    // Re-enable pointer events when drag operation ends
    this.frame.style.pointerEvents = "";
    this._isDragging = false;
  }

  dropHandler() {
    // Re-enable pointer events after drop
    this.frame.style.pointerEvents = "";
    this._isDragging = false;
  }

  pauseAutoRefresh() {
    this.refreshController.pauseAutoRefresh();
  }

  resumeAutoRefresh() {
    this.refreshController.resumeAutoRefresh();
  }

  setFile(filePath, hash, observation) {
    const oldPath = this.file?.path;
    const oldURI = oldPath && this.getURI();
    this.observeFilePath(filePath, observation);
    this.hash = hash || "";
    this.refreshController.resetForFile();
    this.setFileState(this.getDiskFingerprint() ? "unmodified" : "removed");
    this.clearNavigationState();
    if (oldPath && oldPath !== filePath) this.fileStateEmitter.emit("did-change-path", filePath);
    if (oldURI && oldURI !== this.getURI()) {
      this.documentVersion++;
      this.updateTitle();
      this.fileStateEmitter.emit("did-change-uri", { oldURI, newURI: this.getURI() });
    }
  }

  canReplaceDocument() {
    return (
      !this.destroyed &&
      this.getFileState() === "unmodified" &&
      this.ready &&
      this.refreshController.loadedDiskFingerprint !== null &&
      !this.refreshController.inFlightRequest &&
      !this.fileOperationDepth
    );
  }

  replaceDocument(filePath, hash = "", options = {}) {
    return this.documentReplacement.replace(filePath, hash, options);
  }

  prepareFileObservation(filePath) {
    return watchFile(filePath);
  }

  observeFilePath(filePath, observation) {
    const file = observation || this.prepareFileObservation(filePath);
    if (this.file?.path !== filePath) this.autoRefreshPausedByBuild = false;
    this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();
    this.file = file;
    const reconcile = () => {
      if (this.file === file) this.reconcileFile();
    };
    this.subscriptions.add(
      file,
      file.onDidChange(reconcile),
      file.onDidInvalidate(reconcile),
      file.onDidError((error) => console.error("Unable to watch PDF", error)),
    );
    file.ready.then(reconcile, () => {});
  }

  setPath(nextPath) {
    if (nextPath === this.getPath()) return;
    const oldURI = this.getURI();
    this.documentVersion++;
    this.observeFilePath(nextPath);
    this.fileStateEmitter.emit("did-change-path", nextPath);
    this.updateTitle();
    this.fileStateEmitter.emit("did-change-uri", { oldURI, newURI: this.getURI() });
  }

  onDidChangePath(callback) {
    return this.fileStateEmitter.on("did-change-path", callback);
  }

  onDidChangeURI(callback) {
    return this.fileStateEmitter.on("did-change-uri", callback);
  }

  reconcileFile() {
    if (this.destroyed || this.fileOperationDepth) return;
    const fingerprint = this.getDiskFingerprint();
    if (fingerprint) {
      this.setFileState("unmodified");
      this.refreshController.scheduleStableRefresh();
    } else {
      this.setFileState("removed");
      this.refreshController.fileUnavailable();
    }
  }

  sendMessage(data) {
    try {
      if (data.type === "refresh" || data.type === "prepareDocument") {
        data = { ...data, filePath: pathToFileURL(data.filePath).href };
      }
      this.frame.contentWindow.postMessage(data, "*");
      return true;
    } catch (err) {
      if (this.debug) {
        console.error(`pdf-view: Cannot send message to PDFjs: ${err}`, data);
      }
      return false;
    }
  }

  get filePath() {
    return this.file.path;
  }

  getPath() {
    return this.filePath;
  }

  getURI() {
    return `${this.filePath}${this.hash}`;
  }

  getFileState() {
    return this.fileState;
  }

  onDidChangeFileState(callback) {
    return this.fileStateEmitter.on("did-change-file-state", callback);
  }

  setFileState(fileState) {
    if (fileState === this.fileState) return;
    this.fileState = fileState;
    this.fileStateEmitter.emit("did-change-file-state", fileState);
  }

  // For service consumers: the pane itself focuses the view, not the item.
  focus() {
    this.frame.focus();
    this.activatePane();
  }

  serialize() {
    return {
      deserializer: "pdf-view",
      filePath: this.filePath,
      hash: this.hash,
    };
  }

  copy() {
    if (this.createCopy) return this.createCopy(this.filePath, this.getCopyHash());
    const viewer = new Viewer(this.filePath, this.getCopyHash());
    viewer.getLatexTools = this.getLatexTools;
    viewer.getTypstTools = this.getTypstTools;
    return viewer;
  }

  getCopyHash() {
    if (!this.hash) {
      return "";
    }

    const hash = this.hash.startsWith("#") ? this.hash.slice(1) : this.hash;
    const params = hash.split("&").filter((part) => part.includes("="));
    return params.length > 0 ? `#${params.join("&")}` : "";
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.outlineList?.destroy();
    this.documentReplacement.destroy();
    let pane = lumine.workspace.paneForItem(this);
    if (pane) {
      pane.destroyItem(this);
    }
    window.removeEventListener("message", this.messageEventBinded);
    this.frame.removeEventListener("focus", this.focusEventBinded);
    this.element.removeEventListener("mousedown", this.mousedownEventBinded);
    delete this.frame.pdfViewerRedispatchKeyboardEvent;

    // Clean up drag event handlers from document
    document.removeEventListener("dragstart", this.dragStartBinded, true);
    document.removeEventListener("dragover", this.dragOverBinded, true);
    document.removeEventListener("dragend", this.dragEndBinded, true);
    document.removeEventListener("drop", this.dropBinded, true);

    this.refreshController.destroy();

    this.element.remove();
    this.disposables.dispose();
    this.subscriptions.dispose();
  }

  getTitle() {
    return path.basename(this.filePath);
  }

  reload() {
    this.documentReplacement?.cancelForReload();
    this.ready = false;
    const requestId = this.refreshController.beginReload();
    this.setFileState(this.getDiskFingerprint() ? "unmodified" : "removed");
    this.clearNavigationState();
    const url = pathToFileURL(this.pdfjsPath);
    url.searchParams.set("file", pathToFileURL(this.filePath).href);
    url.searchParams.set("requestId", String(requestId));
    url.hash = this.hash;
    this.frame.src = url.href;
    this.updateTitle();
  }

  refresh() {
    return this.refreshController.refresh();
  }

  refreshNow() {
    return this.refreshController.refreshNow();
  }

  toggleRefreshing() {
    this.autoRefresh = !this.autoRefresh;
    this.refreshController.preferenceChanged();
    if (this.autoRefresh) {
      lumine.notifications.addHint("pdf-view: Auto-refreshing activated in active file");
    } else {
      lumine.notifications.addHint("pdf-view: Auto-refreshing deactivated in active file");
    }
  }

  /**
   * Sets page and thumbnail color inversion for viewer integrations.
   * @param {boolean} state - Whether document colors should be inverted
   */
  setColorInverted(state) {
    // Sticky: the iframe document is rebuilt on every reload, so the state is
    // re-sent from handleReadyMessage rather than asking consumers to watch.
    this.colorInverted = Boolean(state);
    this.sendMessage({ type: "set-color-inverted", value: this.colorInverted });
  }

  sendCommand(command) {
    this.sendMessage({ type: "command", command });
  }

  getDiskFingerprint() {
    return this.refreshController.getDiskFingerprint();
  }

  onDidDispose(callback) {
    this.disposables.add(new Disposable(callback));
  }

  updateTitle() {
    this.onDidChangeTitleCallbacks.forEach((callback) => callback());
  }

  onDidChangeTitle(callback) {
    this.onDidChangeTitleCallbacks.add(callback);
    return new Disposable(() => {
      this.onDidChangeTitleCallbacks.delete(callback);
    });
  }

  observeOutline(callback) {
    if (this.outlineLoaded) {
      callback(this.outline);
    }
    this.observeOutlineCallbacks.add(callback);
    return new Disposable(() => {
      this.observeOutlineCallbacks.delete(callback);
    });
  }

  observeVisible(callback) {
    if (this.visibleDestHashes) {
      callback(this.visibleDestHashes);
    }
    this.observeVisibleCallbacks.add(callback);
    return new Disposable(() => {
      this.observeVisibleCallbacks.delete(callback);
    });
  }

  observeScrollMapData(callback) {
    if (this.scrollMapData) {
      callback(this.scrollMapData);
    }
    this.observeScrollMapDataCallbacks.add(callback);
    return new Disposable(() => {
      this.observeScrollMapDataCallbacks.delete(callback);
    });
  }

  redispatchKeyboardEvent(originalEvent) {
    const event = new KeyboardEvent(originalEvent.type, {
      bubbles: true,
      cancelable: true,
      key: originalEvent.key,
      code: originalEvent.code,
      location: originalEvent.location,
      ctrlKey: originalEvent.ctrlKey,
      shiftKey: originalEvent.shiftKey,
      altKey: originalEvent.altKey,
      metaKey: originalEvent.metaKey,
      repeat: originalEvent.repeat,
      isComposing: originalEvent.isComposing,
    });
    this.element.dispatchEvent(event);
    return event.defaultPrevented;
  }

  async handleSynctex(data) {
    const filePath = this.filePath;
    const version = this.documentVersion;
    const latexTools = this.getLatexTools?.() ?? (await this.requestLatexTools?.());
    if (this.destroyed || version !== this.documentVersion) return;
    if (!latexTools?.syncToSource) {
      if (this.debug) {
        console.error("pdf-view: latex-tools not available for synctex");
      }
      return;
    }

    const result = await latexTools.syncToSource(filePath, data.pageNo, data.x, data.y);
    if (this.destroyed || version !== this.documentVersion) return;

    if (!result || !result.file) {
      return;
    }

    if (!fs.existsSync(result.file)) {
      if (this.debug) {
        console.error(`pdf-view: cannot open "${result.file}", file does not exist`);
      }
      return;
    }

    lumine.workspace.open(result.file, {
      split: "left",
      initialLine: result.line - 1,
      initialColumn: result.column,
      searchAllPanes: true,
    });
  }

  /**
   * Triggers compilation for this PDF's source file.
   * Tries .typ (typst-tools) first, then .tex (latex-tools).
   */
  async compile() {
    const filePath = this.filePath;
    const version = this.documentVersion;
    const isCurrent = () => !this.destroyed && version === this.documentVersion;
    const editors = lumine.workspace.getTextEditors();

    // Try Typst source first
    const typFile = filePath.replace(/\.pdf$/i, ".typ");
    const typEditor = editors.find((editor) => editor.getPath() === typFile);
    const typstTools =
      (typEditor || fs.existsSync(typFile)) &&
      (this.getTypstTools?.() ?? (await this.requestTypstTools?.()));
    if (!isCurrent()) return;
    if ((typEditor || fs.existsSync(typFile)) && typstTools?.compile) {
      if (typEditor && typEditor.getFileState() !== "unmodified") {
        await typEditor.save();
      }
      if (!isCurrent()) return;
      if (fs.existsSync(typFile)) {
        if (this.debug) {
          console.log(`[pdf-view] Compiling ${path.basename(typFile)}`);
        }
        return typstTools.compile(typFile);
      }
    }

    // Fall back to LaTeX source
    const texFile = filePath.replace(/\.pdf$/i, ".tex");
    const texEditor = editors.find((editor) => editor.getPath() === texFile);
    if (!texEditor && !fs.existsSync(texFile)) {
      if (this.debug) {
        console.log(`[pdf-view] No source file found for ${path.basename(this.filePath)}`);
      }
      lumine.notifications.addWarning(
        `pdf-view: No source file found for ${path.basename(this.filePath)}`,
      );
      return;
    }

    const latexTools = this.getLatexTools?.() ?? (await this.requestLatexTools?.());
    if (!isCurrent()) return;
    if (!latexTools?.compile) {
      if (this.debug) {
        console.log("[pdf-view] latex-tools not available");
      }
      lumine.notifications.addWarning("pdf-view: latex-tools not available");
      return;
    }

    if (texEditor && texEditor.getFileState() !== "unmodified") {
      await texEditor.save();
    }
    if (!isCurrent()) return;
    if (!fs.existsSync(texFile)) return;

    if (this.debug) {
      console.log(`[pdf-view] Compiling ${path.basename(texFile)}`);
    }
    return latexTools.compile(texFile);
  }

  /**
   * Opens the corresponding source file (.typ or .tex).
   */
  openTex() {
    // Try .typ first, then .tex
    const typFile = this.filePath.replace(/\.pdf$/i, ".typ");
    if (fs.existsSync(typFile)) {
      if (this.debug) {
        console.log(`[pdf-view] Opening ${path.basename(typFile)}`);
      }
      lumine.workspace.open(typFile, { split: "left", searchAllPanes: true });
      return;
    }

    const texFile = this.filePath.replace(/\.pdf$/i, ".tex");
    if (!fs.existsSync(texFile)) {
      if (this.debug) {
        console.log(`[pdf-view] No source file found for ${path.basename(this.filePath)}`);
      }
      lumine.notifications.addWarning(
        `pdf-view: No source file found for ${path.basename(this.filePath)}`,
      );
      return;
    }

    if (this.debug) {
      console.log(`[pdf-view] Opening ${path.basename(texFile)}`);
    }
    lumine.workspace.open(texFile, { split: "left", searchAllPanes: true });
  }

  scrollToPosition(page, x, y) {
    this.sendMessage({ type: "setposition", page: page, x: x, y: y });
  }

  scrollToDestination(item) {
    this.sendMessage({ type: "setdestination", dest: item.dest });
    // Claim the target as the visible entry right away — the iframe cannot
    // answer before it has scrolled. Same array shape the iframe reports, so
    // observers never have to handle two.
    this.visibleDestHashes = item.destHash ? [item.destHash] : [];
    this.observeVisibleCallbacks.forEach((callback) => callback(this.visibleDestHashes));
  }

  showOutlineList() {
    if (this.destroyed) return;
    this.outlineList ||= new (require("./outline-list"))(this);
    return this.outlineList.show();
  }

  currentdest() {
    this.sendMessage({ type: "currentdest" });
  }

  activatePane() {
    let pane = lumine.workspace.paneForItem(this);
    if (pane) {
      pane.activateItem(this);
      pane.activate();
    }
  }

  focusEvent() {
    this.activatePane();
  }

  mousedownEvent() {
    // Focus the element when clicked to ensure pane activation
    this.frame.focus();
  }

  messageEvent(message) {
    if (message.source !== this.frame.contentWindow) {
      return;
    }

    const data = message.data;
    if (this.documentReplacement.handleMessage(data)) return;
    if (
      data?.type !== "ready" &&
      data?.type !== "click" &&
      !this.refreshController.isCurrentRequest(data?.requestId)
    )
      return;
    const handler = this.messageHandlers[data?.type];
    if (handler) {
      return handler(data);
    }
  }

  handleClickMessage() {
    this.frame.focus();
    this.activatePane();
    this.currentdest();
  }

  handleOutlineMessage(data) {
    this.outlineLoaded = true;
    this.outline = data.outline;
    this.observeOutlineCallbacks.forEach((callback) => callback(this.outline));
  }

  handleVisibleMessage(data) {
    this.visibleDestHashes = data.destHash;
    this.observeVisibleCallbacks.forEach((callback) => callback(this.visibleDestHashes));
  }

  handleReadyMessage(data) {
    if (!this.refreshController.onReady(data)) return;
    this.ready = true;
    this.readyCallbacks.forEach((resolve) => resolve());
    this.readyCallbacks.clear();

    if (this.colorInverted !== undefined) {
      this.sendMessage({ type: "set-color-inverted", value: this.colorInverted });
    }
  }

  handleLoadErrorMessage(data) {
    this.refreshController.onLoadError(data);
  }

  /**
   * Returns a promise that resolves when the viewer is ready.
   */
  whenReady() {
    if (this.ready) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.readyCallbacks.add(resolve);
    });
  }

  clearNavigationState() {
    this.outlineLoaded = false;
    this.outline = null;
    this.visibleDestHashes = null;
    this.scrollMapData = null;
    this.observeOutlineCallbacks.forEach((callback) => callback(this.outline));
    this.observeVisibleCallbacks.forEach((callback) => callback(this.visibleDestHashes));
    this.observeScrollMapDataCallbacks.forEach((callback) => callback(this.scrollMapData));
  }

  /**
   * Emits scrollmap data to observers.
   * @param {Object} data - Scrollmap data from iframe
   */
  emitScrollmapData(data) {
    this.scrollMapData = data;
    this.observeScrollMapDataCallbacks.forEach((callback) => callback(data));
  }
};
