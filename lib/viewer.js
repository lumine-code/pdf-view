const { CompositeDisposable, Disposable, Emitter, FileState, watchFile } = require("lumine");
const path = require("path");
const fs = require("fs");

module.exports = class Viewer {
  constructor(filePath, hash) {
    this.disposables = new CompositeDisposable();
    this.subscriptions = new CompositeDisposable();
    this.fileStateEmitter = new Emitter();
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
      viewState: (data) => this.handleViewStateMessage(data),
      viewStateRestored: (data) => this.handleViewStateRestoredMessage(data),
      ready: () => this.handleReadyMessage(),
      loadError: () => this.handleLoadErrorMessage(),
    };
    this.pdfjsPath = path.join(__dirname, "..", "vendors", "pdfjs-dist", "web", "viewer.html");
    // The item view is a wrapper rather than the iframe itself, so the pane's
    // show/hide and removal reach everything drawn beside the document (the
    // scrollmap strip) -- an iframe can hold no children. ViewRegistry caches
    // the item view once, so the wrapper is created here and never replaced.
    const document = globalThis.document;
    this.element = document.createElement("div");
    this.element.classList.add("pdf-view");
    this.element.setAttribute("tabindex", "-1");
    // The pane focuses the item view on activation; keystrokes belong to the
    // PDF.js document, so forward.
    this.element.focus = () => this.frame?.focus();
    this.frame = null;
    this.boundDocument = null;
    this.boundWindow = null;
    this.surfaceTransition = null;
    this.lastViewState = null;
    this.viewStateRequests = new Map();
    this.restoreViewStateRequests = new Map();
    this.createFrame(document);
    this.autoRefreshPausedByBuild = false;
    this.pendingRefresh = false;
    this.loadErrorRetries = 0;
    this.lastFailedDiskFingerprint = null;
    this.refreshTimeout = null;
    this.fileStableTimeout = null;
    this.readyCallbacks = new Set();
    this.getLatexTools = null; // Getter set by main module
    this.getTypstTools = null; // Getter set by main module
    this.setFile(filePath, hash);
    this.reload();
    this.disposables.add(
      lumine.config.observe("pdf-view.autoRefresh", (value) => {
        this.autoRefresh = value;
      }),
      lumine.config.observe("pdf-view.autoTime", (value) => {
        this.autoTime = value;
      }),
      lumine.config.observe("pdf-view.debug", (value) => {
        this.debug = value;
      }),
    );
    this.messageEventBinded = this.messageEvent.bind(this);
    this.focusEventBinded = this.focusEvent.bind(this);
    this.mousedownEventBinded = this.mousedownEvent.bind(this);
    this.dragStartBinded = this.dragStartHandler.bind(this);
    this.dragOverBinded = this.dragOverHandler.bind(this);
    this.dragEndBinded = this.dragEndHandler.bind(this);
    this.dropBinded = this.dropHandler.bind(this);
    this.bindRealm(document);
  }

  createFrame(document = this.element.ownerDocument) {
    const frame = document.createElement("iframe");
    frame.classList.add("pdf-view-frame");
    frame.setAttribute("tabindex", "-1");
    frame.pdfViewerRedispatchKeyboardEvent = (event) => this.redispatchKeyboardEvent(event);
    this.frame = frame;
    this.element.prepend(frame);
    return frame;
  }

  bindRealm(document = this.element.ownerDocument) {
    this.unbindRealm();
    const domWindow = document.defaultView;
    if (!domWindow) throw new Error("PDF view requires a live owner window");
    this.boundDocument = document;
    this.boundWindow = domWindow;
    domWindow.addEventListener("message", this.messageEventBinded);
    this.frame?.addEventListener("focus", this.focusEventBinded);
    this.element.addEventListener("mousedown", this.mousedownEventBinded);
    document.addEventListener("dragstart", this.dragStartBinded, true);
    document.addEventListener("dragover", this.dragOverBinded, true);
    document.addEventListener("dragend", this.dragEndBinded, true);
    document.addEventListener("drop", this.dropBinded, true);
  }

  unbindRealm() {
    this.boundWindow?.removeEventListener("message", this.messageEventBinded);
    this.frame?.removeEventListener("focus", this.focusEventBinded);
    this.element.removeEventListener("mousedown", this.mousedownEventBinded);
    this.boundDocument?.removeEventListener("dragstart", this.dragStartBinded, true);
    this.boundDocument?.removeEventListener("dragover", this.dragOverBinded, true);
    this.boundDocument?.removeEventListener("dragend", this.dragEndBinded, true);
    this.boundDocument?.removeEventListener("drop", this.dropBinded, true);
    this.boundDocument = null;
    this.boundWindow = null;
  }

  destroyFrame() {
    if (!this.frame) return;
    this.frame.removeEventListener("focus", this.focusEventBinded);
    delete this.frame.pdfViewerRedispatchKeyboardEvent;
    this.frame.remove();
    this.frame = null;
    this.ready = false;
  }

  frameSource(hash = this.hash) {
    return `${this.pdfjsPath}?file=${encodeURIComponent(this.filePath)}${hash || ""}`;
  }

  async beginWindowSurfaceTransition(context) {
    context.signal?.throwIfAborted?.();
    if (this.surfaceTransition) {
      throw new Error("A PDF window-surface transition is already in progress");
    }
    const state = {
      id: context.id,
      viewState: await this.requestViewState(),
      wasFocused:
        this.element.contains(this.element.ownerDocument.activeElement) ||
        this.element.ownerDocument.activeElement === this.frame,
    };
    context.signal?.throwIfAborted?.();
    this.surfaceTransition = state;
    this.unbindRealm();
    this.destroyFrame();

    const finish = async () => this.finishWindowSurfaceTransition(state);
    return { commit: finish, rollback: finish };
  }

  async finishWindowSurfaceTransition(state) {
    if (this.surfaceTransition !== state) return;
    const document = this.element.ownerDocument;
    this.unbindRealm();
    this.destroyFrame();
    this.createFrame(document);
    this.bindRealm(document);
    this.ready = false;
    this.frame.src = this.frameSource(state.viewState?.hash || this.hash);
    await this.whenReady();
    await this.restoreViewState(state.viewState);
    this.surfaceTransition = null;
    if (this.pendingRefresh) {
      this.pendingRefresh = false;
      this.refresh();
    }
    if (state.wasFocused) this.frame.focus();
  }

  async requestViewState(timeoutMs = 250) {
    if (!this.ready || !this.frame?.contentWindow) {
      return this.lastViewState || { hash: this.hash };
    }
    const requestId = `pdf-view-state-${Date.now()}-${Math.random()}`;
    const domWindow = this.frame.ownerDocument.defaultView;
    return await new Promise((resolve) => {
      const timer = domWindow.setTimeout(() => {
        this.viewStateRequests.delete(requestId);
        resolve(this.lastViewState || { hash: this.hash });
      }, timeoutMs);
      this.viewStateRequests.set(requestId, (state) => {
        domWindow.clearTimeout(timer);
        resolve(state);
      });
      this.sendMessage({ type: "get-view-state", requestId });
    });
  }

  handleViewStateMessage(data) {
    const state = data.state || data;
    this.lastViewState = state;
    const resolve = this.viewStateRequests.get(data.requestId);
    if (resolve) {
      this.viewStateRequests.delete(data.requestId);
      resolve(state);
    }
  }

  async restoreViewState(state, timeoutMs = 1000) {
    if (!state || !this.ready) return;
    const requestId = `pdf-view-restore-${Date.now()}-${Math.random()}`;
    const domWindow = this.frame.ownerDocument.defaultView;
    await new Promise((resolve) => {
      const timer = domWindow.setTimeout(() => {
        this.restoreViewStateRequests.delete(requestId);
        resolve();
      }, timeoutMs);
      this.restoreViewStateRequests.set(requestId, () => {
        domWindow.clearTimeout(timer);
        resolve();
      });
      this.sendMessage({ type: "restore-view-state", requestId, state });
    });
  }

  handleViewStateRestoredMessage(data) {
    const resolve = this.restoreViewStateRequests.get(data.requestId);
    if (resolve) {
      this.restoreViewStateRequests.delete(data.requestId);
      resolve();
    }
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
    // Only pause if auto-refresh is currently enabled
    if (this.autoRefresh && !this.autoRefreshPausedByBuild) {
      if (this.debug) {
        console.log(
          `[pdf-view] Pausing auto-refresh for ${path.basename(this.filePath)} during build`,
        );
      }
      this.autoRefreshPausedByBuild = true;
      this.savedAutoRefresh = this.autoRefresh;
      this.autoRefresh = false;
    }
  }

  resumeAutoRefresh() {
    // Only resume if we had paused it
    if (this.autoRefreshPausedByBuild) {
      if (this.debug) {
        console.log(
          `[pdf-view] Resuming auto-refresh for ${path.basename(this.filePath)} after build`,
        );
      }
      this.autoRefreshPausedByBuild = false;
      this.autoRefresh = this.savedAutoRefresh;
      // Trigger a refresh now that the build is complete
      if (this.autoRefresh) {
        if (this.ready) {
          this.refresh();
        } else {
          // Viewer is not ready (e.g., hidden tab), schedule refresh for when it becomes ready
          if (this.debug) {
            console.log(
              `[pdf-view] Viewer not ready, scheduling pending refresh for ${path.basename(
                this.filePath,
              )}`,
            );
          }
          this.pendingRefresh = true;
        }
      }
    }
  }

  setFile(filePath, hash) {
    if (this.fileStableTimeout) {
      clearTimeout(this.fileStableTimeout);
    }
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    // A CompositeDisposable stays disposed once disposed, so replace it with a
    // fresh one for the new watch — otherwise the `add()` calls below would be
    // silent no-ops after the first setFile, leaking the watcher.
    this.subscriptions.dispose();
    this.subscriptions = new CompositeDisposable();
    // The synchronous lumine `File` was removed from Lumine; `watchFile` is the
    // async replacement. It exposes the same change/delete/rename notifications
    // and `getPath()`, but owns a native watcher that must be disposed — hence
    // the extra Disposable below (the event subscriptions alone do not stop it).
    const file = watchFile(filePath);
    this.file = file;
    this.hash = hash ? hash : "";
    this.loadedDiskFingerprint = this.getDiskFingerprint();
    this.pendingDiskFingerprint = null;
    this.setFileState(this.loadedDiskFingerprint ? FileState.UNMODIFIED : FileState.REMOVED);
    this.fileStableTimeout = null;
    this.refreshTimeout = null;
    this.clearNavigationState();
    this.subscriptions.add(
      new Disposable(() => file.dispose()),
      file.onDidChange(() => {
        if (this.getDiskFingerprint()) this.setFileState(FileState.UNMODIFIED);
        if (this.autoRefresh && !this.autoRefreshPausedByBuild) {
          this.scheduleStableRefresh();
        }
      }),
      file.onDidDelete(() => {
        this.setFileState(FileState.REMOVED);
        clearTimeout(this.fileStableTimeout);
        clearTimeout(this.refreshTimeout);
        this.fileStableTimeout = null;
        this.refreshTimeout = null;
        this.pendingDiskFingerprint = null;
      }),
      file.onDidRename(() => {
        this.setFileState(FileState.UNMODIFIED);
        this.reload();
      }),
    );
  }

  sendMessage(data) {
    try {
      this.frame.contentWindow.postMessage(data);
    } catch (err) {
      if (this.debug) {
        console.error(`pdf-view: Cannot send message to PDFjs: ${err}`, data);
      }
    }
  }

  get filePath() {
    return this.file.getPath();
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
    this.frame?.focus();
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
    let pane = lumine.workspace.paneForItem(this);
    if (pane) {
      pane.destroyItem(this);
    }
    this.unbindRealm();
    this.destroyFrame();
    for (const resolve of this.viewStateRequests.values()) resolve(this.lastViewState || {});
    this.viewStateRequests.clear();
    for (const resolve of this.restoreViewStateRequests.values()) resolve();
    this.restoreViewStateRequests.clear();

    // Clean up file stability timeout
    if (this.fileStableTimeout) {
      clearTimeout(this.fileStableTimeout);
      this.fileStableTimeout = null;
    }
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }

    this.element.remove();
    this.disposables.dispose();
    this.subscriptions.dispose();
  }

  getTitle() {
    return path.basename(this.filePath);
  }

  reload() {
    if (this.fileStableTimeout) {
      clearTimeout(this.fileStableTimeout);
      this.fileStableTimeout = null;
    }
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    this.loadedDiskFingerprint = this.getDiskFingerprint();
    this.pendingDiskFingerprint = null;
    this.setFileState(this.loadedDiskFingerprint ? FileState.UNMODIFIED : FileState.REMOVED);
    this.loadErrorRetries = 0;
    this.lastFailedDiskFingerprint = null;
    this.ready = false;
    this.clearNavigationState();
    if (this.frame) this.frame.src = this.frameSource();
    this.updateTitle();
  }

  refresh() {
    if (!this.ready) {
      this.pendingRefresh = true;
      return;
    }
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = null;
      if (!this.ready) {
        return;
      }
      this.clearNavigationState();
      this.sendMessage({ type: "refresh", filePath: this.filePath });
    }, this.autoTime);
    return this.refreshTimeout;
  }

  refreshNow() {
    if (!this.ready) {
      this.pendingRefresh = true;
      return;
    }
    if (this.refreshTimeout) {
      clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    this.clearNavigationState();
    this.sendMessage({ type: "refresh", filePath: this.filePath });
  }

  toggleRefreshing() {
    this.autoRefresh = !this.autoRefresh;
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

  scheduleStableRefresh() {
    // Cancel any pending stability check
    if (this.fileStableTimeout) {
      clearTimeout(this.fileStableTimeout);
      this.fileStableTimeout = null;
    }

    const currentFingerprint = this.getDiskFingerprint();
    if (this.diskFingerprintsEqual(currentFingerprint, this.loadedDiskFingerprint)) {
      // File watchers may report an event while they are being armed, or for a
      // metadata access that did not change the PDF. The iframe already loaded
      // this exact disk fingerprint, so refreshing here only causes a visible flash.
      this.pendingDiskFingerprint = null;
      return;
    }

    this.pendingDiskFingerprint = currentFingerprint;
    this.fileStableTimeout = setTimeout(
      () => this.checkFileStability(),
      currentFingerprint?.size === 0 ? 100 : 200,
    );
  }

  checkFileStability() {
    this.fileStableTimeout = null;
    try {
      const currentFingerprint = this.getDiskFingerprint();

      if (!currentFingerprint) {
        throw new Error("File is not available");
      }

      if (currentFingerprint.size === 0) {
        // File is empty (being rewritten), wait and check again
        if (this.debug) {
          console.log(
            `[pdf-view] File is empty, waiting for content: ${path.basename(this.filePath)}`,
          );
        }
        this.fileStableTimeout = setTimeout(() => this.checkFileStability(), 100);
        return;
      }

      if (this.diskFingerprintsEqual(currentFingerprint, this.loadedDiskFingerprint)) {
        // A later watcher event resolved to the state that is already loaded.
        this.pendingDiskFingerprint = null;
        return;
      }

      if (!this.diskFingerprintsEqual(currentFingerprint, this.pendingDiskFingerprint)) {
        // The file changed during the quiet period and is still being written.
        if (this.debug) {
          console.log(
            `[pdf-view] File changed while waiting, checking again: ${path.basename(
              this.filePath,
            )}`,
          );
        }
        this.pendingDiskFingerprint = currentFingerprint;
        this.fileStableTimeout = setTimeout(() => this.checkFileStability(), 200);
        return;
      }

      // Size is stable, validate PDF header before refreshing
      if (this.isPdfValid()) {
        if (this.debug) {
          console.log(
            `[pdf-view] File stable and valid, refreshing: ${path.basename(this.filePath)}`,
          );
        }
        this.loadedDiskFingerprint = currentFingerprint;
        this.pendingDiskFingerprint = null;
        this.refresh();
      } else {
        // PDF header not valid yet, wait and check again
        if (this.debug) {
          console.log(`[pdf-view] PDF not valid yet, waiting: ${path.basename(this.filePath)}`);
        }
        this.fileStableTimeout = setTimeout(() => this.checkFileStability(), 200);
      }
    } catch (err) {
      // File might not exist or be locked, wait and retry
      if (this.debug) {
        console.log(`[pdf-view] Error checking file stability: ${err.message}`);
      }
      this.fileStableTimeout = setTimeout(() => this.checkFileStability(), 200);
    }
  }

  getDiskFingerprint() {
    // Deliberately no ctimeMs: on Windows it is NTFS ChangeTime, which the
    // iframe's own first read of the PDF bumps (via the last-access-time
    // update), and the directory watch reports that read as a change. A real
    // content change always moves mtimeMs, size, or ino.
    try {
      const stats = fs.statSync(this.filePath);
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ino: stats.ino,
      };
    } catch {
      return null;
    }
  }

  diskFingerprintsEqual(left, right) {
    return (
      left !== null &&
      right !== null &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ino === right.ino
    );
  }

  isPdfValid() {
    try {
      // Check PDF header (%PDF-) and trailer (%%EOF)
      const fd = fs.openSync(this.filePath, "r");
      try {
        // Check header
        const headerBuffer = Buffer.alloc(8);
        fs.readSync(fd, headerBuffer, 0, 8, 0);
        const header = headerBuffer.toString("ascii");
        if (!header.startsWith("%PDF-")) {
          return false;
        }

        // Check trailer - read last 1024 bytes to find %%EOF
        const stats = fs.fstatSync(fd);
        const tailSize = Math.min(1024, stats.size);
        const tailBuffer = Buffer.alloc(tailSize);
        fs.readSync(fd, tailBuffer, 0, tailSize, stats.size - tailSize);
        const tail = tailBuffer.toString("ascii");
        if (!tail.includes("%%EOF")) {
          return false;
        }

        return true;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return false;
    }
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
    const KeyboardEvent = this.element.ownerDocument.defaultView.KeyboardEvent;
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
    const latexTools = this.getLatexTools?.();
    if (!latexTools?.syncToSource) {
      if (this.debug) {
        console.error("pdf-view: latex-tools not available for synctex");
      }
      return;
    }

    const result = await latexTools.syncToSource(this.filePath, data.pageNo, data.x, data.y);

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
    const editors = lumine.workspace.getTextEditors();

    // Try Typst source first
    const typFile = this.filePath.replace(/\.pdf$/, ".typ");
    const typEditor = editors.find((editor) => editor.getPath() === typFile);
    const typstTools = this.getTypstTools?.();
    if ((typEditor || fs.existsSync(typFile)) && typstTools?.compile) {
      if (typEditor && typEditor.getFileState() !== FileState.UNMODIFIED) {
        await typEditor.save();
      }
      if (fs.existsSync(typFile)) {
        if (this.debug) {
          console.log(`[pdf-view] Compiling ${path.basename(typFile)}`);
        }
        return typstTools.compile(typFile);
      }
    }

    // Fall back to LaTeX source
    const texFile = this.filePath.replace(/\.pdf$/, ".tex");
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

    const latexTools = this.getLatexTools?.();
    if (!latexTools?.compile) {
      if (this.debug) {
        console.log("[pdf-view] latex-tools not available");
      }
      lumine.notifications.addWarning("pdf-view: latex-tools not available");
      return;
    }

    if (texEditor && texEditor.getFileState() !== FileState.UNMODIFIED) {
      await texEditor.save();
    }
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
    const typFile = this.filePath.replace(/\.pdf$/, ".typ");
    if (fs.existsSync(typFile)) {
      if (this.debug) {
        console.log(`[pdf-view] Opening ${path.basename(typFile)}`);
      }
      lumine.workspace.open(typFile, { split: "left", searchAllPanes: true });
      return;
    }

    const texFile = this.filePath.replace(/\.pdf$/, ".tex");
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

  currentdest() {
    this.sendMessage({ type: "currentdest" });
  }

  activatePane() {
    let pane = lumine.workspace.paneForItem(this);
    if (pane) {
      pane.activate();
      pane.activateItem(this);
    }
  }

  focusEvent() {
    this.activatePane();
  }

  mousedownEvent() {
    // Focus the element when clicked to ensure pane activation
    this.frame?.focus();
  }

  messageEvent(message) {
    if (!this.frame || message.source !== this.frame.contentWindow) {
      return;
    }

    const data = message.data;
    const handler = this.messageHandlers[data?.type];
    if (handler) {
      return handler(data);
    }
  }

  handleClickMessage() {
    this.frame?.focus();
    this.activatePane();
    this.currentdest();
  }

  handleOutlineMessage(data) {
    // pagesinit reached, so the document genuinely loaded and any recovery
    // budget spent getting here is settled.
    this.loadErrorRetries = 0;
    this.lastFailedDiskFingerprint = null;
    this.outlineLoaded = true;
    this.outline = data.outline;
    this.observeOutlineCallbacks.forEach((callback) => callback(this.outline));
  }

  handleVisibleMessage(data) {
    this.visibleDestHashes = data.destHash;
    this.observeVisibleCallbacks.forEach((callback) => callback(this.visibleDestHashes));
  }

  handleReadyMessage() {
    this.ready = true;
    this.readyCallbacks.forEach((resolve) => resolve());
    this.readyCallbacks.clear();

    if (this.colorInverted !== undefined) {
      this.sendMessage({ type: "set-color-inverted", value: this.colorInverted });
    }

    if (this.pendingRefresh && !this.surfaceTransition) {
      if (this.debug) {
        console.log(
          `[pdf-view] Viewer now ready, executing pending refresh for ${path.basename(
            this.filePath,
          )}`,
        );
      }
      this.pendingRefresh = false;
      this.refresh();
    }
  }

  handleLoadErrorMessage() {
    // PDF.js could not parse what it fetched. A restart can catch the file
    // mid-write, and the write that finishes it can beat the native watcher's
    // arming -- so a watcher event must not be the only way back. What is on
    // screen is not what is on disk: drop the loaded fingerprint and enter the
    // stability loop, which refreshes once the file is stable and reads as a
    // PDF. This deliberately bypasses the autoRefresh setting: recovering a
    // load that never succeeded is loading, not refreshing.
    const failedFingerprint = this.getDiskFingerprint();
    if (this.diskFingerprintsEqual(failedFingerprint, this.lastFailedDiskFingerprint)) {
      this.loadErrorRetries += 1;
    } else {
      // Different bytes failed, so the previous failure's budget does not apply.
      this.lastFailedDiskFingerprint = failedFingerprint;
      this.loadErrorRetries = 1;
    }
    if (this.loadErrorRetries > 3) {
      // Three recoveries of the same disk fingerprint have already failed: the file
      // itself is broken. Leave PDF.js's error on screen -- a real change still
      // recovers through the watcher, and F5 retries by hand.
      return;
    }
    this.loadedDiskFingerprint = null;
    this.scheduleStableRefresh();
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
