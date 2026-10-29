const { CompositeDisposable, Disposable, Emitter, watchFile } = require("lumine");
const path = require("node:path");
const fs = require("node:fs");
const { getRuntime, assetURL, acquireStyles } = require("./pdfjs");
const PdfDocument = require("./document");
const PdfSearchAdapter = require("./search");
const Toolbar = require("./toolbar");
const ZoomAnimation = require("./zoom-animation");
const ScrollAnimation = require("./scroll-animation");
const ZOOM_LEVELS = require("./zoom-levels");
const SCALE_PRESETS = new Set(["auto", "page-actual", "page-width", "page-height", "page-fit"]);
const PACKAGE_NAME = require("../package.json").name;

function replacementCancelled() {
  const error = new Error("PDF opening was cancelled.");
  error.name = "AbortError";
  return error;
}

class PdfView {
  constructor(filePath, hash = "", state = {}) {
    this.filePath = filePath;
    this.hash = hash;
    this.integrationTag = state.integrationTag ?? null;
    this.initialState = state;
    this.generation = 0;
    this.destinationRevision = 0;
    this.destinations = new WeakMap();
    this.destroyed = false;
    this.loading = false;
    this.zoomMode = state.zoomMode === "auto-width" ? "auto-width" : null;
    this.zoomUpdateRevision = 0;
    this.tool = "select";
    this.fileOperationDepth = 0;
    this.builds = new Set();
    this.fileRevision = 0;
    this.loadedFileRevision = 0;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable(this.emitter);
    this.element = document.createElement("div");
    this.element.className = "pdf-view";
    this.element.tabIndex = -1;
    this.element.setAttribute("aria-label", "PDF document");
    this.viewport = document.createElement("div");
    this.viewport.className = "pdf-view-container";
    this.viewport.tabIndex = -1;
    this.pagesElement = document.createElement("div");
    this.pagesElement.className = "pdfViewer";
    this.viewport.append(this.pagesElement);
    this.element.append(this.viewport);
    this.scrollAnimation = new ScrollAnimation(this);
    this.statusElement = document.createElement("div");
    this.statusElement.className = "pdf-view-status";
    this.statusElement.setAttribute("role", "status");
    this.element.append(this.statusElement);
    this.toolbar = new Toolbar(this);
    this.element.append(this.toolbar.element);
    this.layoutWaiters = new Set();
    this.abortController = new AbortController();
    this.styleLease = acquireStyles(this.element.ownerDocument);
    this.resizeObserver = new ResizeObserver(() => this.layoutChanged());
    this.resizeObserver.observe(this.element);
    this.resizeObserver.observe(this.viewport);
    this.disposables.add(
      new Disposable(() => this.resizeObserver.disconnect()),
      new Disposable(() => this.styleLease?.dispose()),
      lumine.workspace.registerFileDocument({
        owner: this,
        getPath: () => this.filePath,
        setPath: (nextPath) => this.setPath(nextPath),
        beginFileOperation: () => {
          this.cancelPendingReplacement();
          this.fileOperationDepth++;
        },
        endFileOperation: () => {
          this.fileOperationDepth--;
          this.scheduleRefresh();
        },
      }),
      lumine.views.addWindowParticipant(this.element, this),
    );
    const options = { signal: this.abortController.signal };
    this.element.addEventListener("mousedown", (event) => this.activate(event), options);
    this.element.addEventListener("contextmenu", (event) => this.captureContext(event), options);
    this.element.ownerDocument.addEventListener(
      "selectionchange",
      () => {
        if (this.element.contains(this.element.ownerDocument.activeElement))
          lumine.commands.invalidateAvailability();
      },
      options,
    );
    this.viewport.addEventListener("wheel", (event) => this.handleWheel(event), {
      ...options,
      passive: false,
    });
    this.viewport.addEventListener("pointerdown", (event) => this.startPan(event), options);
    this.viewport.addEventListener("pointermove", (event) => this.movePan(event), options);
    this.viewport.addEventListener("pointerup", () => this.endPan(), options);
    this.viewport.addEventListener("pointercancel", () => this.endPan(), options);
    this.observeFile();
    this.openPromise = this.load(state);
    this.openPromise.catch(() => {});
  }

  initializeRuntime() {
    if (this.pdfViewer) return;
    const pdfjs = getRuntime();
    this.eventBus = new pdfjs.EventBus();
    this.linkService = new pdfjs.PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: pdfjs.LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer nofollow",
      ignoreDestinationZoom: true,
    });
    this.findController = this.searchAdapter = new PdfSearchAdapter(this);
    this.pdfViewer = new pdfjs.PDFViewer({
      container: this.viewport,
      viewer: this.pagesElement,
      eventBus: this.eventBus,
      linkService: this.linkService,
      findController: this.findController,
      annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      textLayerMode: 1,
      removePageBorders: true,
      maxCanvasPixels: lumine.config.get(`${PACKAGE_NAME}.maxCanvasPixels`) || 8 * 1024 * 1024,
      enableDetailCanvas: false,
      imageResourcesPath: assetURL("web/images/"),
      abortSignal: this.abortController.signal,
    });
    this.linkService.setViewer(this.pdfViewer);
    this.zoomAnimation = new ZoomAnimation(this);
    this.linkService.goToDestination = (destination) => this.navigateToDestination(destination);
    const refresh = this.pdfViewer.refresh.bind(this.pdfViewer);
    this.pdfViewer.refresh = (noUpdate, options) =>
      refresh(
        noUpdate,
        this.zoomAnimation.drawingDelay == null
          ? options
          : {
              ...options,
              drawingDelay: this.zoomAnimation.drawingDelay,
            },
      );
    const queue = this.pdfViewer.renderingQueue;
    const renderView = queue.renderView.bind(queue);
    queue.renderView = (pageView) => {
      // A completed asynchronous page request can outlive setDocument(null).
      // Only views belonging to the current document may enter the queue.
      if (this.destroyed || this.pdfViewer.getPageView(pageView.id - 1) !== pageView) return false;
      if (this.zoomAnimation.active || this.zoomAnimation.drawingDelay != null) return false;
      return renderView(pageView);
    };
    for (const event of ["pagechanging", "scalechanging", "rotationchanging", "updateviewarea"]) {
      this.eventBus.on(event, (data) => {
        if (this.destroyed) return;
        if (event === "scalechanging" && !this.zoomAnimation.applying)
          this.scalePreset = SCALE_PRESETS.has(data.presetValue) ? data.presetValue : null;
        if (event === "rotationchanging") {
          this.zoomUpdateRevision++;
          this.zoomAnimation.cancel();
        }
        if (data.location) this.location = data.location;
        if (event === "pagechanging") this.scheduleAutoWidth();
        if (event === "rotationchanging") this.scheduleAutoWidth(data.pageNumber);
        this.toolbar.update();
        this.emitter.emit("did-change-view", data);
      });
    }
    this.eventBus.on("pagerendered", ({ pageNumber, error, cssTransform }) => {
      if (this.destroyed) return;
      if (error) return this.showError(error);
      if (pageNumber === this.getCurrentPage()) this.scheduleAutoWidth();
      if (!cssTransform && !this.firstPaintAt) {
        this.firstPaintAt = performance.now();
        this.emitter.emit("did-first-render", { pageNumber });
      }
    });
  }

  async load(state = this.captureView(), prepared) {
    prepared?.assertCurrent();
    this.cancelPendingReplacement(prepared?.operation);
    this.destinationRevision++;
    this.scrollAnimation.cancel();
    this.zoomAnimation?.cancel({ redraw: false });
    this.zoomUpdateRevision++;
    this.initializationWait?.cancel();
    const generation = ++this.generation;
    const fileRevision = prepared ? 0 : this.fileRevision;
    this.loading = true;
    this.error = null;
    this.startedAt = performance.now();
    this.firstPaintAt = null;
    this.updateStatus();
    this.closePassword();
    const previousCandidate = this.candidate;
    const candidate = prepared?.candidate ?? new PdfDocument(this.filePath);
    this.candidate = candidate;
    await previousCandidate?.destroy({ abort: Boolean(prepared && !this.pdfDocument) });
    let previousDocument;
    try {
      this.initializeRuntime();
      const pdf =
        prepared?.pdf ??
        (await candidate.open((updatePassword, reason) => {
          if (generation === this.generation) this.showPassword(updatePassword, reason);
        }));
      if (!prepared) await pdf.getPage(1);
      await this.waitForLayout(prepared?.operation.controller.signal);
      if (this.destroyed || generation !== this.generation) return;
      const old = this.document;
      const previousView = this.captureView();
      const previousLocation = this.location;
      const previousScroll = { left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
      prepared?.assertCurrent();
      previousDocument = old;
      this.document = candidate;
      this.candidate = null;
      this.pdfDocument = pdf;
      this.location = null;
      const initialized = this.waitForInitialization();
      try {
        this.linkService.setDocument(pdf);
        this.pdfViewer.setDocument(pdf);
        prepared?.assertCurrent();
        prepared?.commit()?.();
      } catch (error) {
        initialized.cancel();
        if (prepared && !prepared.operation.committed) {
          // A native setter can fail before accepting the prepared document.
          // Keep its previous worker, address and watcher, restoring the old
          // runtime only if the setter had already reset it.
          this.document = old;
          this.pdfDocument = old?.pdf;
          this.location = previousLocation;
          this.linkService.setDocument(old?.pdf ?? null);
          if (this.pdfViewer.pdfDocument !== (old?.pdf ?? null)) {
            const restored = old ? this.waitForInitialization() : null;
            this.pdfViewer.setDocument(old?.pdf ?? null);
            if (restored) await restored.promise;
            if (!this.destroyed && generation === this.generation && old) {
              this.zoomMode = previousView.zoomMode;
              this.pdfViewer.pagesRotation = previousView.rotation;
              this.pdfViewer.currentScaleValue = previousView.scaleValue || 1;
              this.pdfViewer.currentPageNumber = previousView.page;
              this.viewport.scrollTo({ ...previousScroll, behavior: "instant" });
              this.pdfViewer.update();
              this.searchAdapter.setDocument(old.pdf);
            }
          }
        }
        throw error;
      }
      if (!(await initialized.promise)) return;
      if (this.destroyed || generation !== this.generation) return;
      this.pdfViewer.pagesRotation = state.rotation || 0;
      const scaleValue =
        state.scaleValue || lumine.config.get(`${PACKAGE_NAME}.defaultZoom`) || "auto";
      this.zoomMode =
        state.zoomMode === "auto-width" || scaleValue === "auto" ? "auto-width" : null;
      this.scalePreset = null;
      this.zoomUpdateRevision++;
      if (this.zoomMode !== "auto-width") this.pdfViewer.currentScaleValue = scaleValue;
      this.pdfViewer.currentPageNumber = Math.max(1, Math.min(state.page || 1, pdf.numPages));
      if (this.zoomMode === "auto-width") {
        this.pdfViewer.update();
        await this.updateAutoWidth();
      }
      if (this.destroyed || generation !== this.generation) return;
      if (state.left !== undefined || state.top !== undefined) {
        this.linkService.setHash(
          `page=${this.getCurrentPage()}&zoom=${this.pdfViewer.currentScale * 100},${state.left || 0},${state.top || 0}`,
        );
        if (this.zoomMode !== "auto-width" && SCALE_PRESETS.has(state.scaleValue))
          this.pdfViewer.currentScaleValue = state.scaleValue;
      } else if (this.hash) {
        if (/(?:^#?|&)zoom=/i.test(this.hash)) this.zoomMode = null;
        await this.applyHash(this.hash);
      }
      if (this.destroyed || generation !== this.generation) return;
      if (this.zoomMode === "auto-width") await this.updateAutoWidth();
      else if (SCALE_PRESETS.has(scaleValue) && !/(?:^#?|&)zoom=/i.test(this.hash))
        this.pdfViewer.currentScaleValue = scaleValue;
      if (this.destroyed || generation !== this.generation) return;
      this.searchAdapter.setDocument(pdf);
      this.loading = false;
      this.diskFingerprint = candidate.fingerprint;
      this.loadedFileRevision = fileRevision;
      this.closePassword();
      this.updateStatus();
      this.emitter.emit("did-load", pdf);
      this.emitter.emit("did-change-view", { location: this.location });
      await old?.destroy();
      this.scheduleRefresh();
      return this;
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      this.initializationWait?.cancel();
      this.loading = false;
      this.candidate = null;
      if (
        !prepared ||
        this.pendingReplacement === prepared.operation ||
        prepared.operation.committed
      )
        this.closePassword();
      await candidate.destroy();
      if (error.name !== "AbortError" && (!prepared || prepared.operation.committed))
        this.showError(error);
      if (this.fileRevision !== fileRevision) this.scheduleRefresh();
      throw error;
    } finally {
      if (previousDocument && previousDocument !== this.document) await previousDocument.destroy();
      if (this.document !== candidate) await candidate.destroy();
    }
  }

  reload() {
    this.openPromise = this.load(this.captureView());
    this.openPromise.catch(() => {});
    return this.openPromise;
  }

  whenReady() {
    return this.openPromise;
  }

  cancelPendingReplacement(except) {
    const pending = this.pendingReplacement;
    if (pending && pending !== except && !pending.committed) pending.controller.abort();
  }

  async reusePendingDocument(filePath, hash = "", { signal } = {}) {
    if (this.destroyed || this.fileOperationDepth) return false;
    this.cancelPendingReplacement();
    clearTimeout(this.refreshTimer);
    const operation = {
      controller: new AbortController(),
      candidate: new PdfDocument(filePath),
      committed: false,
    };
    this.pendingReplacement = operation;
    const { controller, candidate } = operation;
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    let rejectAbort;
    const aborted = new Promise((_, reject) => (rejectAbort = reject));
    const abort = () => {
      void candidate.destroy({ abort: true }).catch(() => {});
      operation.observation?.dispose();
      rejectAbort(replacementCancelled());
    };
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    const assertCurrent = () => {
      if (
        controller.signal.aborted ||
        this.destroyed ||
        this.pendingReplacement !== operation ||
        this.fileOperationDepth
      )
        throw replacementCancelled();
    };
    const wait = (promise) => Promise.race([promise, aborted]);
    const previousReady = this.whenReady();
    try {
      // The current document, canvas and file subscription remain live until
      // the replacement's worker, first page and file watcher are ready.
      const pdf = await wait(
        candidate.open((updatePassword, reason) => {
          if (controller.signal.aborted || this.destroyed || this.pendingReplacement !== operation)
            return;
          operation.passwordElement = this.showPassword(updatePassword, reason, forwardAbort);
        }),
      );
      await wait(
        Promise.all([
          pdf.getPage(1),
          pdf.getPermissions(),
          pdf.getOptionalContentConfig({ intent: "display" }),
        ]),
      );
      const fragment = hash.replace(/^#/, "");
      const params = new URLSearchParams(fragment);
      const named = fragment.includes("=") ? params.get("nameddest") : decodeURIComponent(fragment);
      let explicit;
      if (named) {
        explicit = await wait(pdf.getDestination(named));
        this.destinations.set(pdf, new Map([[named, Promise.resolve(explicit)]]));
      }
      let pageNumber = Number(params.get("page"));
      if (Array.isArray(explicit)) {
        const reference = explicit[0];
        pageNumber = Number.isInteger(reference)
          ? reference + 1
          : pdf.cachedPageNumber(reference) || (await wait(pdf.getPageIndex(reference))) + 1;
      }
      if (Number.isInteger(pageNumber) && pageNumber > 1 && pageNumber <= pdf.numPages)
        await wait(pdf.getPage(pageNumber));
      assertCurrent();
      operation.observation = watchFile(filePath);
      await wait(operation.observation.ready);
      if (this.pdfDocument) await wait(previousReady.catch(() => {}));
      await this.waitForLayout(controller.signal);
      assertCurrent();
      const { scaleValue, zoomMode, rotation } = this.captureView();
      operation.installPromise = Promise.resolve().then(() => {
        assertCurrent();
        return this.load(
          { scaleValue, zoomMode, rotation },
          {
            operation,
            assertCurrent,
            candidate,
            pdf,
            commit: () => {
              assertCurrent();
              operation.committed = true;
              signal?.removeEventListener("abort", forwardAbort);
              const oldURI = this.getURI();
              this.filePath = filePath;
              this.hash = hash;
              this.contextPosition = null;
              this.integrationTag = null;
              this.builds.clear();
              this.fileRevision = 0;
              this.observeFile(operation.observation);
              this.openPromise = operation.installPromise;
              return () => {
                this.emitter.emit("did-change-path", filePath);
                this.emitter.emit("did-change-title");
                this.emitter.emit("did-change-uri", { oldURI, newURI: this.getURI() });
              };
            },
          },
        );
      });
      await operation.installPromise;
      if (this.destroyed || (!operation.committed && controller.signal.aborted))
        throw replacementCancelled();
      return this;
    } catch (error) {
      if (
        !operation.committed &&
        (controller.signal.aborted || this.pendingReplacement !== operation)
      )
        throw replacementCancelled();
      throw error;
    } finally {
      signal?.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", abort);
      if (!operation.committed) {
        operation.observation?.dispose();
        void candidate.destroy({ abort: true }).catch(() => {});
      }
      if (operation.passwordElement && this.passwordElement === operation.passwordElement)
        this.closePassword();
      if (this.pendingReplacement === operation) {
        this.pendingReplacement = null;
        if (!this.destroyed) this.scheduleRefresh();
      }
    }
  }

  waitForInitialization() {
    let complete;
    const promise = new Promise((resolve) => {
      complete = resolve;
    });
    const finish = (ready) => {
      this.eventBus.off("pagesinit", onInitialized);
      complete(ready);
      if (this.initializationWait === wait) this.initializationWait = null;
    };
    const onInitialized = () => finish(true);
    const wait = { promise, cancel: () => finish(false) };
    this.initializationWait = wait;
    this.eventBus.on("pagesinit", onInitialized);
    return wait;
  }

  waitForLayout(signal) {
    if (signal?.aborted) return Promise.reject(replacementCancelled());
    if (this.destroyed || this.hasLayout()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.layoutWaiters.delete(finish);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.layoutWaiters.delete(finish);
        reject(replacementCancelled());
      };
      this.layoutWaiters.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  hasLayout() {
    return (
      this.element.isConnected && this.viewport.clientWidth > 0 && this.viewport.clientHeight > 0
    );
  }

  layoutChanged() {
    if (!this.hasLayout() || this.destroyed) return;
    for (const resolve of this.layoutWaiters) resolve();
    this.layoutWaiters.clear();
    const dimensions = `${this.viewport.offsetWidth}:${this.viewport.offsetHeight}`;
    const available = `${this.viewport.clientWidth}:${this.viewport.clientHeight}`;
    const changed = this.availableDimensions !== available;
    if (this.layoutDimensions && this.layoutDimensions !== dimensions) {
      this.scrollAnimation.cancel();
      this.zoomUpdateRevision++;
      this.zoomAnimation?.cancel();
    }
    this.layoutDimensions = dimensions;
    this.availableDimensions = available;
    if (this.pdfDocument) {
      if (changed && this.zoomAnimation.active) {
        const mode = this.zoomMode === "auto-width" ? "auto-width" : this.scalePreset;
        const page = this.pdfViewer.getPageView(this.getCurrentPage() - 1)?.pdfPage;
        if (mode && page) this.zoomAnimation.retarget(this.getPresetScaleForPage(mode, page));
      }
      if (
        (changed || this.fitLayoutPending) &&
        !this.loading &&
        this.zoomMode !== "auto-width" &&
        this.scalePreset
      ) {
        if (this.zoomAnimation.active) {
          this.fitLayoutPending = true;
          return;
        }
        this.fitLayoutPending = false;
        this.scrollAnimation.cancel();
        this.preservePageFocus();
        this.pdfViewer.currentScaleValue = this.scalePreset;
        // Fitting can remove a scrollbar and change the available client box
        // without producing another ResizeObserver entry in Chromium.
        if (
          available !== `${this.viewport.clientWidth}:${this.viewport.clientHeight}` &&
          !this.fitLayoutScheduled
        ) {
          this.fitLayoutScheduled = true;
          queueMicrotask(() => {
            this.fitLayoutScheduled = false;
            this.layoutChanged();
          });
        }
      }
      this.scheduleAutoWidth();
      this.pdfViewer.update();
      this.emitter.emit("did-change-view", { location: this.location });
    }
  }

  didAttachToWindow({ document }) {
    this.styleLease?.dispose();
    this.styleLease = acquireStyles(document);
    this.layoutChanged();
  }

  prepareWindowChange() {
    this.cancelPendingReplacement();
    this.scrollAnimation.cancel();
    return this.captureView();
  }

  didChangeWindow() {
    this.didAttachToWindow({ document: this.element.ownerDocument });
  }

  observeFile(observation = watchFile(this.filePath)) {
    const previous = this.fileSubscriptions;
    this.fileObservation = observation;
    this.fileSubscriptions = new CompositeDisposable(
      observation,
      observation.onDidChange(() => {
        this.fileRevision++;
        this.scheduleRefresh();
      }),
      observation.onDidInvalidate(() => {
        this.fileRevision++;
        this.scheduleRefresh();
      }),
      observation.onDidError((error) => this.showError(error)),
    );
    previous?.dispose();
    observation.ready.then(
      () => {
        if (observation === this.fileObservation) this.scheduleRefresh();
      },
      () => {},
    );
  }

  getDiskFingerprint() {
    try {
      const stat = fs.statSync(this.filePath);
      return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    } catch {
      return null;
    }
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (this.destroyed || !lumine.config.get(`${PACKAGE_NAME}.autoRefresh`)) return;
    if (this.fileOperationDepth || this.builds.size || this.loading || this.pendingReplacement)
      return;
    const fingerprint = this.getDiskFingerprint();
    if (fingerprint === this.diskFingerprint && this.fileRevision === this.loadedFileRevision)
      return;
    this.refreshTimer = setTimeout(() => {
      if (this.getDiskFingerprint() !== fingerprint) return this.scheduleRefresh();
      if (fingerprint) void this.reload().catch(() => {});
      else {
        this.emitter.emit("did-change-file-state", "removed");
        this.statusElement.textContent =
          "The PDF file was removed. The loaded document remains open.";
        this.statusElement.hidden = false;
      }
    }, 400);
  }

  setPath(nextPath) {
    this.cancelPendingReplacement();
    if (this.filePath === nextPath) return;
    this.filePath = nextPath;
    this.observeFile();
    this.emitter.emit("did-change-path", nextPath);
    this.emitter.emit("did-change-title");
    this.emitter.emit("did-change-uri");
  }

  isSameFile(nextPath) {
    return process.platform === "win32"
      ? path.resolve(this.filePath).toLowerCase() === path.resolve(nextPath).toLowerCase()
      : path.resolve(this.filePath) === path.resolve(nextPath);
  }

  setFile(nextPath, hash = "") {
    this.cancelPendingReplacement();
    const samePath = this.isSameFile(nextPath);
    const previousHash = this.hash;
    const { scaleValue, zoomMode, rotation } = this.captureView();
    this.hash = hash;
    if (samePath) {
      if (hash === previousHash) return this.whenReady();
      this.emitter.emit("did-change-uri");
      return this.whenReady().then(() => this.applyHash(hash));
    }
    this.setPath(nextPath);
    this.openPromise = this.load({ scaleValue, zoomMode, rotation });
    this.openPromise.catch(() => {});
    return this.openPromise;
  }

  captureView() {
    return {
      page: this.getCurrentPage(),
      scaleValue:
        this.scalePreset || this.pdfViewer?.currentScaleValue || this.initialState.scaleValue,
      zoomMode: this.zoomMode,
      rotation: this.pdfViewer?.pagesRotation || 0,
      left: this.location?.left,
      top: this.location?.top,
    };
  }

  getViewState() {
    return {
      page: this.getCurrentPage(),
      pageCount: this.getPageCount(),
      scale: this.pdfViewer?.currentScale || 1,
      displayScale: this.zoomAnimation?.targetScale ?? this.pdfViewer?.currentScale ?? 1,
      scaleValue: this.scalePreset || this.pdfViewer?.currentScaleValue || "page-width",
      zoomMode: this.zoomMode,
      rotation: this.pdfViewer?.pagesRotation || 0,
      loading: this.loading,
      error: this.error,
      tool: this.tool,
    };
  }

  getCurrentPage() {
    return this.pdfViewer?.currentPageNumber || 1;
  }
  getPageCount() {
    return this.pdfDocument?.numPages || 0;
  }
  getPath() {
    return this.filePath;
  }
  getURI() {
    return `${this.filePath}${this.hash}`;
  }
  getTitle() {
    return path.basename(this.filePath);
  }
  getElement() {
    return this.element;
  }
  getFileState() {
    return this.getDiskFingerprint() ? "unmodified" : "removed";
  }
  isModified() {
    return false;
  }
  getPaneItemCopyState() {
    return { ...this.serialize(), tag: null };
  }
  copy() {
    return this.createCopy
      ? this.createCopy(this.captureView())
      : new PdfView(this.filePath, this.hash, this.captureView());
  }
  serialize() {
    return {
      deserializer: "pdf-view",
      filePath: this.filePath,
      hash: this.hash,
      tag: this.integrationTag,
      state: this.captureView(),
    };
  }
  onDidLoad(callback) {
    return this.emitter.on("did-load", callback);
  }
  onDidChangeView(callback) {
    return this.emitter.on("did-change-view", callback);
  }
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }
  onDidDispose(callback) {
    return this.onDidDestroy(callback);
  }
  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }
  onDidChangePath(callback) {
    return this.emitter.on("did-change-path", callback);
  }
  onDidChangeURI(callback) {
    return this.emitter.on("did-change-uri", callback);
  }
  onDidChangeFileState(callback) {
    return this.emitter.on("did-change-file-state", callback);
  }
  getSearchAdapter() {
    this.initializeRuntime();
    return this.searchAdapter;
  }

  focus() {
    this.viewport.focus({ preventScroll: true });
  }

  preservePageFocus() {
    // PDF.js replaces focused text and annotation layers while scaling.
    // Keep document focus on the stable viewport before removing those nodes.
    if (this.pagesElement.contains(this.element.ownerDocument.activeElement)) this.focus();
  }

  activate(event) {
    const pane = lumine.workspace.paneForItem(this);
    pane?.activate();
    pane?.activateItem(this);
    if (!event.target.closest("button, input, select, textarea, a")) this.focus();
  }

  goToPage(page) {
    const value = Number(page);
    if (!this.pdfDocument || !Number.isInteger(value)) return;
    this.scrollAnimation.cancel();
    this.zoomUpdateRevision++;
    this.zoomAnimation?.cancel();
    this.pdfViewer.currentPageNumber = Math.max(1, Math.min(value, this.getPageCount()));
    this.pdfViewer.update();
  }

  setScale(value, { smooth = false, origin } = {}) {
    if (!this.pdfDocument) return;
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0.1 || value > 10)) return;
    this.scrollAnimation.cancel();
    this.preservePageFocus();
    this.zoomMode = null;
    this.autoWidthTargetPage = null;
    this.zoomUpdateRevision++;
    const revision = this.zoomUpdateRevision;
    if (!smooth || typeof value !== "number") this.zoomAnimation.cancel({ redraw: false });
    this.scalePreset = SCALE_PRESETS.has(value) ? value : null;
    this.fitLayoutPending = false;
    let result;
    if (smooth && typeof value === "number") result = this.zoomAnimation.to(value, { origin });
    else if (smooth) {
      result = this.getPresetScale(value)
        .then((scale) => {
          if (this.destroyed || revision !== this.zoomUpdateRevision || scale == null) return;
          return this.zoomAnimation.to(scale, {
            origin,
            onComplete: () => {
              if (!this.destroyed && revision === this.zoomUpdateRevision)
                this.pdfViewer.currentScaleValue = value;
            },
          });
        })
        .catch((error) => {
          if (!this.destroyed && revision === this.zoomUpdateRevision) throw error;
        });
    } else this.pdfViewer.currentScaleValue = value;
    this.toolbar.update();
    this.emitter.emit("did-change-view", { zoomMode: this.zoomMode });
    return result;
  }

  async getPresetScale(value) {
    const pdf = this.pdfDocument;
    const page = await pdf.getPage(this.getCurrentPage());
    return this.getPresetScaleForPage(value, page);
  }

  getPresetScaleForPage(value, page) {
    const size = page.getViewport({
      scale: 96 / 72,
      rotation: (page.rotate + this.pdfViewer.pagesRotation) % 360,
    });
    const width = this.viewport.clientWidth / size.width;
    const height = this.viewport.clientHeight / size.height;
    switch (value) {
      case "auto-width":
        return Math.min(1, width);
      case "page-actual":
        return 1;
      case "page-width":
        return width;
      case "page-height":
        return height;
      case "page-fit":
        return Math.min(width, height);
      case "auto":
        return Math.min(1.25, size.width <= size.height ? width : Math.min(width, height));
      default:
        return null;
    }
  }

  setAutoWidth({ smooth = false } = {}) {
    if (!this.pdfDocument || this.destroyed) return;
    this.scrollAnimation.cancel();
    this.preservePageFocus();
    this.zoomMode = "auto-width";
    this.scalePreset = null;
    this.fitLayoutPending = false;
    this.zoomAnimation.cancel({ redraw: false });
    const result = this.updateAutoWidth({ smooth });
    this.toolbar.update();
    this.emitter.emit("did-change-view", { zoomMode: this.zoomMode });
    return result;
  }

  scheduleAutoWidth(preferredPage = null) {
    if (
      this.zoomMode !== "auto-width" ||
      this.destroyed ||
      this.loading ||
      this.zoomAnimation?.active
    )
      return;
    // Rotation carries the page captured before PDF.js refreshes its scroll
    // anchor, which can briefly refer to the page visited beforehand.
    if (preferredPage != null) this.autoWidthTargetPage = preferredPage;
    if (this.autoWidthScheduled) return;
    this.autoWidthScheduled = true;
    // PDF.js dispatches pagechanging before finishing its own page scroll.
    // Adapt after that operation instead of re-entering its scale setter.
    queueMicrotask(() => {
      this.autoWidthScheduled = false;
      if (this.zoomAnimation?.active) return;
      const target = this.autoWidthTargetPage;
      this.autoWidthTargetPage = null;
      if (this.zoomMode !== "auto-width" || this.destroyed || this.loading) return;
      if (target && this.getCurrentPage() !== target) {
        this.pdfViewer.currentPageNumber = target;
        this.pdfViewer.update();
      }
      this.updateAutoWidth().catch((error) => {
        if (!this.destroyed && this.zoomMode === "auto-width") this.showError(error);
      });
    });
  }

  updateAutoWidth({ smooth = false } = {}) {
    const pdf = this.pdfDocument;
    const generation = this.generation;
    const revision = ++this.zoomUpdateRevision;
    const pageNumber = this.getCurrentPage();
    if (!pdf || this.zoomMode !== "auto-width" || this.destroyed || !this.hasLayout())
      return Promise.resolve();
    const apply = (page) => {
      if (
        this.destroyed ||
        this.pdfDocument !== pdf ||
        this.generation !== generation ||
        this.zoomUpdateRevision !== revision ||
        this.zoomMode !== "auto-width" ||
        this.getCurrentPage() !== pageNumber
      )
        return;
      const rotation = (page.rotate + this.pdfViewer.pagesRotation) % 360;
      const width = page.getViewport({ scale: 96 / 72, rotation }).width;
      // PDFViewer uses exactly this width ratio with removePageBorders=true
      // and one page per row. Height never participates in this mode.
      const scale = Math.min(1, this.viewport.clientWidth / width);
      if (!Number.isFinite(scale) || scale <= 0) return;
      if (Math.abs(scale - this.pdfViewer.currentScale) > 1e-8) this.scrollAnimation?.cancel();
      if (smooth)
        return this.zoomAnimation.to(scale, { onComplete: () => this.scheduleAutoWidth() });
      this.zoomAnimation?.cancel({ redraw: false });
      this.preservePageFocus();
      this.pdfViewer.currentScaleValue = scale;
      // A numeric scale setter may reuse the preceding page's scroll anchor.
      // Keep the page whose geometry this operation deliberately fitted.
      if (this.getCurrentPage() !== pageNumber) {
        this.pdfViewer.currentPageNumber = pageNumber;
        this.pdfViewer.update();
      }
      return scale;
    };
    const page = this.pdfViewer.getPageView(pageNumber - 1)?.pdfPage;
    if (page) return Promise.resolve(apply(page));
    // Only the active page's geometry is needed; do not fetch or render the
    // rest of a document just to accommodate mixed page sizes.
    return pdf.getPage(pageNumber).then(apply, (error) => {
      if (
        this.destroyed ||
        this.pdfDocument !== pdf ||
        this.generation !== generation ||
        this.zoomUpdateRevision !== revision ||
        this.zoomMode !== "auto-width"
      )
        return;
      throw error;
    });
  }

  executeCommand(command) {
    if (command === "refresh") return this.reload();
    if (command === "synctex") return this.syncToSource();
    if (command === "copy") return this.copyText();
    if (!this.pdfDocument) return;
    switch (command) {
      case "previous-page":
        return this.goToPage(this.getCurrentPage() - 1);
      case "next-page":
        return this.goToPage(this.getCurrentPage() + 1);
      case "first-page":
        return this.goToPage(1);
      case "last-page":
        return this.goToPage(this.getPageCount());
      case "zoom-in":
        return this.zoomBy(1.1);
      case "zoom-out":
        return this.zoomBy(1 / 1.1);
      case "zoom-next-level":
        return this.zoomToLevel(1);
      case "zoom-previous-level":
        return this.zoomToLevel(-1);
      case "automatic-zoom":
        return this.setAutoWidth({ smooth: true });
      case "fit-width":
        return this.setScale("page-width", { smooth: true });
      case "fit-to-view":
        return this.setScale("page-fit", { smooth: true });
      case "zoom-100":
        return this.setScale(1, { smooth: true });
      case "rotate-clockwise":
        this.scrollAnimation.cancel();
        this.pdfViewer.pagesRotation = (this.pdfViewer.pagesRotation + 90) % 360;
        break;
      case "rotate-counterclockwise":
        this.scrollAnimation.cancel();
        this.pdfViewer.pagesRotation = (this.pdfViewer.pagesRotation + 270) % 360;
        break;
      case "select-tool":
        this.tool = "select";
        break;
      case "hand-tool":
        this.tool = "hand";
        break;
      case "scroll-up":
        return this.scrollBy({ top: -this.viewport.clientHeight / 10 });
      case "scroll-down":
        return this.scrollBy({ top: this.viewport.clientHeight / 10 });
      case "scroll-left":
        return this.scrollBy({ left: -this.viewport.clientWidth / 10 });
      case "scroll-right":
        return this.scrollBy({ left: this.viewport.clientWidth / 10 });
      case "page-up":
        this.interruptZoom();
        this.scrollAnimation.cancel();
        return this.viewport.scrollBy({ top: -this.viewport.clientHeight * 0.9 });
      case "page-down":
        this.interruptZoom();
        this.scrollAnimation.cancel();
        return this.viewport.scrollBy({ top: this.viewport.clientHeight * 0.9 });
    }
    this.element.dataset.tool = this.tool;
    this.toolbar.update();
  }

  handleWheel(event) {
    if (!event.ctrlKey && !event.metaKey) {
      this.interruptZoom?.();
      const multiplier = event.altKey
        ? (lumine.config.get("editor.altWheelScrollMultiplier") ?? 8)
        : 1;
      if (
        event.altKey &&
        multiplier > 1 &&
        event.cancelable &&
        !event.defaultPrevented &&
        this.pdfDocument &&
        !this.destroyed
      ) {
        return this.fastScroll(event, multiplier);
      }
      this.scrollAnimation?.cancel();
      return;
    }
    this.scrollAnimation?.cancel();
    if (!this.pdfDocument || this.destroyed) return;
    event.preventDefault();
    const pixels =
      event.deltaY *
      (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.viewport.clientHeight : 1);
    return this.zoomBy(Math.exp(-pixels * 0.002), [event.clientX, event.clientY]);
  }

  fastScroll(event, multiplier) {
    const viewport = this.viewport;
    let left = event.deltaX;
    let top = event.deltaY;
    if (event.deltaMode === 1) {
      left *= 16;
      top *= 16;
    } else if (event.deltaMode === 2) {
      left *= viewport.clientWidth;
      top *= viewport.clientHeight;
    }
    if (process.platform !== "darwin" && event.shiftKey) [left, top] = [top, left];
    const animation = this.scrollAnimation;
    const canScroll = (delta, position, target, maximum) =>
      (delta < 0 && (position > 0 || (animation.active && target > 0))) ||
      (delta > 0 && (position < maximum || (animation.active && target < maximum)));
    if (
      !canScroll(
        left,
        viewport.scrollLeft,
        animation.targetLeft,
        viewport.scrollWidth - viewport.clientWidth,
      ) &&
      !canScroll(
        top,
        viewport.scrollTop,
        animation.targetTop,
        viewport.scrollHeight - viewport.clientHeight,
      )
    ) {
      this.scrollAnimation.cancel();
      return;
    }
    event.preventDefault();
    return this.scrollBy({ left: left * multiplier, top: top * multiplier }, { fractional: true });
  }

  zoomBy(factor, origin) {
    const scale = this.zoomAnimation.targetScale ?? this.pdfViewer.currentScale;
    return this.setScale(Math.max(0.1, Math.min(10, scale * factor)), { smooth: true, origin });
  }

  scrollBy(delta, options) {
    this.interruptZoom();
    this.preservePageFocus();
    return this.scrollAnimation.by(delta, options);
  }

  interruptZoom() {
    this.zoomUpdateRevision++;
    this.zoomAnimation?.cancel();
  }

  zoomToLevel(direction) {
    const scale = this.zoomAnimation.targetScale ?? this.pdfViewer.currentScale;
    const next =
      direction > 0
        ? ZOOM_LEVELS.find((value) => value > scale + 1e-8)
        : ZOOM_LEVELS.findLast((value) => value < scale - 1e-8);
    if (next !== undefined) return this.setScale(next, { smooth: true });
  }

  startPan(event) {
    this.scrollAnimation.cancel();
    this.interruptZoom();
    if (event.button !== 0 || this.tool !== "hand" || event.target.closest("a, input, button"))
      return;
    event.preventDefault();
    this.pan = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: this.viewport.scrollLeft,
      top: this.viewport.scrollTop,
    };
    this.viewport.setPointerCapture(event.pointerId);
    this.element.classList.add("is-panning");
  }

  movePan(event) {
    if (!this.pan || this.pan.pointerId !== event.pointerId) return;
    this.viewport.scrollLeft = this.pan.left + this.pan.x - event.clientX;
    this.viewport.scrollTop = this.pan.top + this.pan.y - event.clientY;
  }

  endPan() {
    if (this.pan && this.viewport.hasPointerCapture(this.pan.pointerId))
      this.viewport.releasePointerCapture(this.pan.pointerId);
    this.pan = null;
    this.element.classList.remove("is-panning");
  }

  getSelectedText() {
    const selection = this.element.ownerDocument.getSelection();
    if (!selection?.anchorNode || !this.pagesElement.contains(selection.anchorNode)) return "";
    return selection.toString();
  }

  copyText() {
    const text = this.getSelectedText();
    if (text) lumine.clipboard.write(text);
  }

  captureContext(event) {
    this.contextPosition = null;
    const page = event.target.closest(".page[data-page-number]");
    if (!page || !this.pagesElement.contains(page)) return;
    const pageNumber = Number(page.dataset.pageNumber);
    const viewport = this.pdfViewer.getPageView(pageNumber - 1)?.viewport;
    if (!viewport) return;
    const bounds = page.getBoundingClientRect();
    const [x, y] = viewport.convertToPdfPoint(
      ((event.clientX - bounds.left) * viewport.width) / bounds.width,
      ((event.clientY - bounds.top) * viewport.height) / bounds.height,
    );
    this.contextPosition = {
      page: pageNumber,
      x: x - viewport.viewBox[0],
      y: viewport.viewBox[3] - y,
    };
    lumine.commands.invalidateAvailability();
  }

  canSyncToSource() {
    return Boolean(this.contextPosition && this.getLatexTools?.()?.syncToSource);
  }

  async syncToSource() {
    const position = this.contextPosition;
    const service = this.getLatexTools?.();
    if (!position || !service?.syncToSource) return;
    const generation = this.generation;
    const result = await service.syncToSource(this.filePath, position.page, position.x, position.y);
    if (!result?.file || this.destroyed || generation !== this.generation) return;
    return lumine.workspace.open(result.file, {
      split: "left",
      searchAllPanes: true,
      initialLine: Math.max(0, result.line - 1),
      initialColumn: Math.max(0, result.column || 0),
    });
  }

  scrollToDestination(destination, options) {
    const dest = destination?.dest ?? destination;
    const generation = this.generation;
    return this.whenReady().then(() => {
      if (this.destroyed || generation !== this.generation) return false;
      this.scrollAnimation.cancel();
      return this.navigateToDestination(dest, options);
    });
  }

  async applyHash(hash) {
    const value = hash.replace(/^#/, "");
    if (!value) return;
    if (!value.includes("=")) return this.navigateToDestination(decodeURIComponent(value));
    const params = new URLSearchParams(value);
    const destination = params.get("nameddest");
    params.delete("nameddest");
    if (params.has("zoom") || params.has("page")) this.linkService.setHash(params.toString());
    if (destination) return this.navigateToDestination(destination);
  }

  async navigateToDestination(destination, { destinationMode } = {}) {
    const pdf = this.pdfDocument;
    if (!pdf || this.destroyed) return false;
    const generation = this.generation;
    const revision = ++this.destinationRevision;
    const valid = () =>
      !this.destroyed &&
      this.pdfDocument === pdf &&
      this.generation === generation &&
      this.destinationRevision === revision;
    this.interruptZoom();
    this.scrollAnimation.cancel();
    try {
      let destinations = this.destinations.get(pdf);
      if (!destinations) this.destinations.set(pdf, (destinations = new Map()));
      let explicit;
      if (typeof destination === "string") {
        if (!destinations.has(destination))
          destinations.set(destination, pdf.getDestination(destination));
        explicit = await destinations.get(destination);
      } else explicit = await destination;
      if (!valid() || !Array.isArray(explicit)) return false;
      const reference = explicit[0];
      let pageNumber;
      if (Number.isInteger(reference)) pageNumber = reference + 1;
      else if (reference && typeof reference === "object")
        pageNumber = pdf.cachedPageNumber(reference) || (await pdf.getPageIndex(reference)) + 1;
      if (!valid() || !Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages)
        return false;
      const page = await pdf.getPage(pageNumber);
      if (!valid()) return false;
      const pageView = this.pdfViewer.getPageView(pageNumber - 1);
      if (pageView && !pageView.pdfPage) pageView.setPdfPage(page);
      if (destinationMode === "page") this.pdfViewer.scrollPageIntoView({ pageNumber });
      else
        this.pdfViewer.scrollPageIntoView({
          pageNumber,
          destArray: explicit,
          ignoreDestinationZoom: true,
        });
      this.pdfViewer.update();
      if (this.zoomMode === "auto-width") await this.updateAutoWidth();
      else if (this.scalePreset) this.pdfViewer.currentScaleValue = this.scalePreset;
      return valid();
    } catch (error) {
      if (valid()) throw error;
      return false;
    }
  }

  scrollToPosition(page, x, y) {
    return this.whenReady().then(() => {
      this.interruptZoom();
      this.scrollAnimation.cancel();
      return this.pdfViewer.scrollPageIntoView({
        pageNumber: page,
        destArray: [null, { name: "XYZ" }, x, y, null],
      });
    });
  }

  showPassword(updatePassword, reason, cancelOpening) {
    this.closePassword();
    const doc = this.element.ownerDocument;
    const form = doc.createElement("form");
    form.className = "pdf-view-password";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-label", "PDF password");
    const label = doc.createElement("label");
    label.textContent =
      reason === 2 ? "Incorrect password. Try again." : "Enter the document password.";
    const input = doc.createElement("input");
    input.type = "password";
    input.className = "input-text native-key-bindings";
    input.setAttribute("aria-label", "Document password");
    label.append(input);
    const submit = doc.createElement("button");
    submit.className = "btn btn-primary";
    submit.textContent = "Open";
    submit.type = "submit";
    const cancel = doc.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      if (this.passwordElement !== form) return;
      if (cancelOpening) cancelOpening();
      else void this.candidate?.destroy();
      this.closePassword();
    });
    form.append(label, submit, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.passwordElement !== form) return;
      const password = input.value;
      input.value = "";
      this.closePassword();
      updatePassword(password);
    });
    this.passwordElement = form;
    this.element.append(form);
    input.focus();
    return form;
  }

  closePassword() {
    this.passwordElement?.remove();
    this.passwordElement = null;
  }

  showError(error) {
    this.error = error;
    this.updateStatus();
  }

  updateStatus() {
    this.statusElement.textContent = this.error
      ? `Could not load PDF: ${this.error.message}`
      : this.loading && !this.pdfDocument
        ? "Loading PDF…"
        : "";
    this.statusElement.hidden = !this.statusElement.textContent;
    this.toolbar.update();
    lumine.commands.invalidateAvailability();
  }

  destroy() {
    if (this.destroyed) return this.destroyPromise;
    const pending = this.pendingReplacement;
    this.cancelPendingReplacement();
    this.destroyed = true;
    this.scrollAnimation.cancel();
    this.zoomAnimation?.cancel({ redraw: false });
    this.initializationWait?.cancel();
    ++this.generation;
    clearTimeout(this.refreshTimer);
    this.emitter.emit("did-destroy");
    for (const resolve of this.layoutWaiters) resolve();
    this.layoutWaiters.clear();
    this.closePassword();
    this.endPan();
    this.pdfViewer?.setDocument(null);
    this.linkService?.setDocument(null);
    this.searchAdapter?.dispose();
    this.abortController.abort();
    this.fileSubscriptions?.dispose();
    this.toolbar.destroy();
    this.disposables.dispose();
    this.element.remove();
    this.destroyPromise = Promise.all([
      this.candidate?.destroy(),
      this.document?.destroy(),
      pending && !pending.committed ? pending.candidate.destroy({ abort: true }) : null,
      pending?.installPromise?.catch(() => {}),
      pending && !pending.committed ? pending.observation?.closed : null,
    ]).then(() => {});
    return this.destroyPromise;
  }
}

module.exports = PdfView;
