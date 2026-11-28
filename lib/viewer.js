const { CompositeDisposable, Disposable, Emitter, watchFile } = require("lumine");
const path = require("node:path");
const fs = require("node:fs");
const { getRuntime, assetURL, acquireStyles } = require("./pdfjs");
const PdfDocument = require("./document");
const PdfSearchAdapter = require("./search");
const Toolbar = require("./toolbar");
const ZoomAnimation = require("./zoom-animation");
const { AdaptiveZoom, adaptiveMode } = require("./adaptive-zoom");
const PageLayout = require("./page-layout");
const ScrollAnimation = require("./scroll-animation");
const ZOOM_LEVELS = require("./zoom-levels");
const { ZOOM_MODES } = require("./zoom-state");
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
    this.buildTarget =
      typeof state.buildTarget?.providerId === "string" &&
      state.buildTarget.providerId &&
      typeof state.buildTarget.filePath === "string" &&
      state.buildTarget.filePath
        ? { providerId: state.buildTarget.providerId, filePath: state.buildTarget.filePath }
        : null;
    this.initialState = state;
    this.generation = 0;
    this.destinationRevision = 0;
    this.destinations = new WeakMap();
    this.destroyed = false;
    this.loading = false;
    this.tool = "select";
    this.fileOperationDepth = 0;
    this.builds = new Set();
    this.retiringDocuments = new Set();
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
    this.pageFrames = document.createElement("div");
    this.pageFrames.className = "pdf-view-page-frames";
    this.pageFrames.setAttribute("aria-hidden", "true");
    this.viewport.append(this.pagesElement, this.pageFrames);
    this.element.append(this.viewport);
    this.scrollAnimation = new ScrollAnimation(this);
    this.pageLayout = new PageLayout(this);
    this.adaptiveZoom = new AdaptiveZoom(this);
    this.statusElement = document.createElement("div");
    this.statusElement.className = "pdf-view-status";
    this.statusElement.setAttribute("role", "status");
    this.element.append(this.statusElement);
    this.toolbar = new Toolbar(this);
    this.element.append(this.toolbar.element);
    this.layoutWaiters = new Set();
    this.abortController = new AbortController();
    this.styleLease = acquireStyles(this.element.ownerDocument);
    this.onWindowResize = () => this.layoutChanged();
    this.observeLayout(this.element.ownerDocument.defaultView);
    this.disposables.add(
      new Disposable(() => this.resizeObserver.disconnect()),
      new Disposable(() => this.pageFrameObserver.disconnect()),
      new Disposable(() => this.resizeWindow.removeEventListener("resize", this.onWindowResize)),
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
    this.viewport.addEventListener(
      "scroll",
      () => {
        this.finishHorizontalScrollGesture();
        this.pageLayout.didScroll();
        this.adaptiveZoom.didScroll();
      },
      options,
    );
    this.viewport.addEventListener("pointerdown", (event) => this.startPan(event), options);
    this.viewport.addEventListener("pointermove", (event) => this.movePan(event), options);
    this.viewport.addEventListener("pointerup", () => this.endPan(), options);
    this.viewport.addEventListener("pointercancel", () => this.endPan(), options);
    // Scrollbar chrome is a sibling of the viewport and handles its own pointer events.
    for (const name of ["pointerdown", "pointermove", "pointerup"]) {
      this.element.addEventListener(name, (event) => this.handleScrollbarGesture(event), {
        ...options,
        capture: true,
      });
    }
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
        if (event === "scalechanging" || event === "rotationchanging")
          this.pageLayout.rememberMiddle();
        if (event === "rotationchanging") {
          this.adaptiveZoom.invalidate();
          this.zoomAnimation.cancel();
          this.adaptiveZoom.schedule();
        }
        if (data.location) this.location = data.location;
        this.toolbar.update();
        this.emitter.emit("did-change-view", data);
      });
    }
    this.eventBus.on("pagerender", () => {
      if (this.destroyed || this.loading) return;
      this.pageLayout.adjustToWidth();
      this.pageLayout.revealVisibleRow();
    });
    this.eventBus.on("pagerendered", ({ pageNumber, error, cssTransform }) => {
      if (this.destroyed) return;
      if (error) return this.showError(error);
      if (!cssTransform && !this.firstPaintAt) {
        this.firstPaintAt = performance.now();
        this.emitter.emit("did-first-render", { pageNumber });
      }
    });
  }

  async load(state = this.captureView(), prepared, { captureLatestView = false } = {}) {
    prepared?.assertCurrent();
    this.cancelPendingReplacement(prepared?.operation);
    this.clearMiddleScrollGesture();
    this.destinationRevision++;
    this.scrollAnimation.cancel();
    this.zoomAnimation?.cancel({ redraw: false });
    this.adaptiveZoom.invalidate();
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
    let previousDocument, previousView, previousLocation, previousScroll, previousScale;
    let installed = false;
    let published = false;
    const publish = () => {
      this.searchAdapter.setDocument(candidate.pdf);
      this.loading = false;
      this.diskFingerprint = candidate.fingerprint;
      this.loadedFileRevision = fileRevision;
      this.closePassword();
      this.updateStatus();
      published = true;
      this.emitter.emit("did-load", candidate.pdf);
      this.emitter.emit("did-change-view", { location: this.location });
    };
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
      previousView = this.captureView();
      previousScale = this.pdfViewer.currentScale;
      previousLocation = this.location;
      previousScroll = { left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
      if (captureLatestView) state = previousView;
      prepared?.assertCurrent();
      previousDocument = old;
      this.document = candidate;
      this.candidate = null;
      this.pdfDocument = pdf;
      this.location = null;
      this.pageLayout.middle = null;
      installed = true;
      const initialized = this.waitForInitialization();
      this.linkService.setDocument(pdf);
      this.pdfViewer.setDocument(pdf);
      prepared?.assertCurrent();
      prepared?.commit()?.();
      if (!(await initialized.promise)) return;
      if (this.destroyed || generation !== this.generation) return;
      const pageNumber = Math.max(1, Math.min(state.page || 1, pdf.numPages));
      const hasViewPosition = state.left !== undefined || state.top !== undefined;
      const positionPage = Math.max(1, Math.min(state.positionPage || pageNumber, pdf.numPages));
      await this.ensurePageGeometry(pageNumber);
      if (hasViewPosition && positionPage !== pageNumber)
        await this.ensurePageGeometry(positionPage);
      if (this.destroyed || generation !== this.generation) return;
      this.pdfViewer.pagesRotation = state.rotation || 0;
      const scaleValue =
        state.scaleValue || lumine.config.get(`${PACKAGE_NAME}.defaultZoom`) || "auto";
      this.adaptiveZoom.setMode(adaptiveMode(state.zoomMode || scaleValue), pageNumber);
      this.pageLayout.scrollToPage(pageNumber);
      if (this.adaptiveZoom.mode) await this.adaptiveZoom.update();
      else this.pdfViewer.currentScaleValue = Number(scaleValue) || 1;
      if (this.destroyed || generation !== this.generation) return;
      if (!hasViewPosition && this.hash) await this.applyHash(this.hash);
      if (this.destroyed || generation !== this.generation) return;
      if (hasViewPosition) {
        this.pdfViewer.scrollPageIntoView({
          pageNumber: positionPage,
          destArray: [null, { name: "XYZ" }, state.left ?? 0, state.top ?? 0, null],
          allowNegativeOffset: true,
        });
      } else if (!this.hash) this.pageLayout.alignPage(pageNumber);
      this.pageLayout.rememberMiddle();
      this.adaptiveZoom.rememberScroll();
      this.pdfViewer.update();
      publish();
      await this.retireDocument(old);
      this.scheduleRefresh();
      return this;
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      this.initializationWait?.cancel();
      this.loading = false;
      this.candidate = null;
      if (installed && !published && !prepared?.operation.committed) {
        // Installation and initial positioning are one transaction. A reload
        // failure must not leave the native viewer attached to a dead worker.
        this.document = previousDocument;
        this.pdfDocument = previousDocument?.pdf ?? null;
        this.location = previousLocation;
        this.linkService.setDocument(this.pdfDocument);
        if (this.pdfViewer.pdfDocument !== this.pdfDocument) {
          const restored = previousDocument ? this.waitForInitialization() : null;
          this.pdfViewer.setDocument(this.pdfDocument);
          if (restored) await restored.promise;
          if (!this.destroyed && generation === this.generation && previousDocument) {
            this.adaptiveZoom.setMode(
              adaptiveMode(previousView.zoomMode || previousView.scaleValue),
              previousView.page,
            );
            this.pdfViewer.pagesRotation = previousView.rotation;
            this.pdfViewer.currentScaleValue = previousScale;
            this.pdfViewer.currentPageNumber = previousView.page;
            this.viewport.scrollTo({ ...previousScroll, behavior: "instant" });
            this.adaptiveZoom.rememberScroll();
            this.pdfViewer.update();
          }
        }
        this.searchAdapter.setDocument(this.pdfDocument);
      } else if (installed && !published) {
        // A pending-tab replacement has already published its new address and
        // watcher. Keep that document alive even if initial positioning fails.
        publish();
      }
      if (this.destroyed || generation !== this.generation) return;
      if (
        !prepared ||
        this.pendingReplacement === prepared.operation ||
        prepared.operation.committed
      )
        this.closePassword();
      if (this.document !== candidate)
        await (installed ? this.retireDocument(candidate) : candidate.destroy());
      if (this.destroyed || generation !== this.generation) return;
      if (this.pdfDocument) this.openPromise = Promise.resolve(this);
      if (error.name !== "AbortError" && (!prepared || prepared.operation.committed))
        this.showError(error);
      if (this.fileRevision !== fileRevision) this.scheduleRefresh();
      throw error;
    } finally {
      if (previousDocument && previousDocument !== this.document)
        await this.retireDocument(previousDocument);
      if (this.document !== candidate)
        await (installed ? this.retireDocument(candidate) : candidate.destroy());
    }
  }

  async retireDocument(document) {
    if (!document) return;
    if (this.destroyed) return document.destroy();
    this.retiringDocuments.add(document);
    try {
      await document.retire();
    } finally {
      this.retiringDocuments.delete(document);
    }
  }

  reload() {
    this.openPromise = this.load(this.captureView(), undefined, { captureLatestView: true });
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
              this.buildTarget = null;
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
    this.pageLayout.adjustToWidth();
    for (const resolve of this.layoutWaiters) resolve();
    this.layoutWaiters.clear();
    const dimensions = `${this.viewport.offsetWidth}:${this.viewport.offsetHeight}`;
    if (this.layoutDimensions && this.layoutDimensions !== dimensions) {
      this.scrollAnimation.cancel();
      this.adaptiveZoom.invalidate();
      this.zoomAnimation?.cancel();
    }
    this.layoutDimensions = dimensions;
    if (this.pdfDocument) {
      this.adaptiveZoom.schedule();
      this.pdfViewer.update();
      this.emitter.emit("did-change-view", { location: this.location });
    }
  }

  observeLayout(window) {
    if (this.resizeWindow === window) return;
    this.resizeObserver?.disconnect();
    this.pageFrameObserver?.disconnect();
    this.resizeWindow?.removeEventListener("resize", this.onWindowResize);
    this.resizeWindow = window;
    this.resizeObserver = new window.ResizeObserver((entries) => {
      if (entries.some(({ target }) => target !== this.pagesElement)) this.layoutChanged();
      else if (this.hasLayout()) {
        this.pageLayout.adjustToWidth();
        this.adaptiveZoom.schedule();
      }
    });
    this.resizeObserver.observe(this.element);
    this.resizeObserver.observe(this.viewport);
    this.resizeObserver.observe(this.pagesElement);
    this.pageFrameObserver = new window.MutationObserver(() => this.updatePageFrames());
    this.pageFrameObserver.observe(this.pagesElement, { childList: true });
    this.updatePageFrames();
    // Native resizing must not wait for the pane's ResizeObserver delivery.
    window.addEventListener("resize", this.onWindowResize);
  }

  updatePageFrames() {
    // PDF.js attaches and detaches page elements as it changes the scroll mode.
    const pages = this.pagesElement.querySelectorAll(":scope > .page, :scope > .spread > .page");
    const document = this.pageFrames.ownerDocument;
    const frames = document.createDocumentFragment();
    for (const page of pages) {
      const anchor = `--pdf-view-page-${page.dataset.pageNumber}`;
      page.style.anchorName = anchor;
      const frame = document.createElement("div");
      frame.className = "pdf-view-page-frame";
      frame.style.positionAnchor = anchor;
      frames.append(frame);
    }
    this.pageFrames.replaceChildren(frames);
  }

  didAttachToWindow({ document }) {
    this.observeLayout(document.defaultView);
    this.styleLease?.dispose();
    this.styleLease = acquireStyles(document);
    this.layoutChanged();
  }

  prepareWindowChange() {
    this.cancelPendingReplacement();
    this.clearMiddleScrollGesture();
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
        this.emitter.emit("did-change-file", {
          filePath: this.filePath,
          revision: this.fileRevision,
        });
        this.scheduleRefresh();
      }),
      observation.onDidInvalidate(() => {
        this.fileRevision++;
        this.emitter.emit("did-change-file", {
          filePath: this.filePath,
          revision: this.fileRevision,
        });
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
    this.buildTarget = null;
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
    const buildTarget = this.getBuildTarget?.() ?? this.buildTarget;
    return {
      page: this.getCurrentPage(),
      scaleValue:
        this.adaptiveZoom.mode || this.pdfViewer?.currentScaleValue || this.initialState.scaleValue,
      zoomMode: this.zoomMode,
      rotation: this.pdfViewer?.pagesRotation || 0,
      positionPage: this.location?.pageNumber,
      left: this.location?.left,
      top: this.location?.top,
      buildTarget: buildTarget
        ? { providerId: buildTarget.providerId, filePath: buildTarget.filePath }
        : null,
    };
  }

  getViewState() {
    return {
      page: this.getCurrentPage(),
      pageCount: this.getPageCount(),
      scale: this.pdfViewer?.currentScale || 1,
      displayScale: this.zoomAnimation?.targetScale ?? this.pdfViewer?.currentScale ?? 1,
      scaleValue: this.adaptiveZoom.mode || this.pdfViewer?.currentScaleValue || "auto-width",
      zoomMode: this.zoomMode,
      rotation: this.pdfViewer?.pagesRotation || 0,
      loading: this.loading,
      error: this.error,
      tool: this.tool,
    };
  }

  getCurrentPage() {
    return this.adaptiveZoom.pageNumber ?? (this.pdfViewer?.currentPageNumber || 1);
  }

  get zoomMode() {
    return this.adaptiveZoom.mode === "auto-width" ? "auto-width" : null;
  }
  getPageCount() {
    return this.pdfDocument?.numPages || 0;
  }
  getMetadata(options) {
    return require("./metadata").getMetadata(this, options);
  }
  onDidChangeMetadata(callback) {
    const invalidate = () => callback();
    return new CompositeDisposable(this.onDidLoad(invalidate), this.onDidChangePath(invalidate));
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
  onDidChangeFile(callback) {
    return this.emitter.on("did-change-file", callback);
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
    const pdf = this.pdfDocument;
    const pageNumber = Math.max(1, Math.min(value, pdf.numPages));
    const pageView = this.pdfViewer.getPageView(pageNumber - 1);
    if (!pageView) return;
    this.scrollAnimation.cancel();
    const revision = ++this.destinationRevision;
    this.interruptZoom();
    this.adaptiveZoom.selectPage(pageNumber);
    const offset = this.pageLayout.scrollToPage(pageNumber);
    this.adaptiveZoom.rememberScroll();
    if (this.adaptiveZoom.mode) {
      // A manual zoom can supersede a fit while the page geometry is pending.
      // Publish the jump before PDF.js reuses its location on the next scale.
      this.pdfViewer.update();
      return this.adaptiveZoom.update()?.catch((error) => this.showError(error));
    }
    const { scrollLeft, scrollTop } = this.viewport;
    const valid = () =>
      !this.destroyed && this.pdfDocument === pdf && this.destinationRevision === revision;
    // Scroll immediately to the placeholder. When the real size arrives, use
    // the horizontal offset from before the jump if the user is still there.
    const position = pageView.pdfPage
      ? undefined
      : pdf
          .getPage(pageNumber)
          .then((pdfPage) => {
            if (!valid()) return;
            const stayed =
              this.viewport.scrollTop === scrollTop && this.viewport.scrollLeft === scrollLeft;
            if (!pageView.pdfPage) pageView.setPdfPage(pdfPage);
            if (!stayed || this.zoomAnimation.active || this.scrollAnimation.active) return;
            this.pageLayout.adjustToWidth();
            this.pageLayout.alignPage(pageNumber, this.pageLayout.middle + offset);
            this.pdfViewer.update();
          })
          .catch((error) => {
            if (valid()) this.showError(error);
          });
    this.pdfViewer.update();
    return position;
  }

  async ensurePageGeometry(pageNumber) {
    const view = this.pdfViewer.getPageView(pageNumber - 1);
    if (!view || view.pdfPage) return view?.pdfPage;
    const page = await this.pdfDocument.getPage(pageNumber);
    if (view !== this.pdfViewer.getPageView(pageNumber - 1)) return;
    if (!view.pdfPage) view.setPdfPage(page);
    return page;
  }

  setScale(value, { smooth = false, origin } = {}) {
    if (!this.pdfDocument || this.destroyed) return;
    const mode = adaptiveMode(value);
    const scale = value === "page-actual" ? 1 : Number(value);
    if (!mode && (!Number.isFinite(scale) || scale < 0.1 || scale > 10)) return;
    this.scrollAnimation.cancel();
    this.preservePageFocus();
    if (mode || !smooth) this.zoomAnimation.cancel({ redraw: false });
    this.adaptiveZoom.setMode(mode, this.getCurrentPage(), { followingFocus: Boolean(mode) });
    let result;
    if (mode) result = this.adaptiveZoom.update({ smooth, recenter: true });
    else if (smooth) result = this.zoomAnimation.to(scale, { origin });
    else this.pdfViewer.currentScaleValue = scale;
    this.toolbar.update();
    this.emitter.emit("did-change-view", { zoomMode: this.zoomMode });
    return result;
  }

  setAutoWidth(options) {
    return this.setScale("auto-width", options);
  }

  stopAdaptiveZoom() {
    if (!this.pdfDocument || this.destroyed || !this.adaptiveZoom.mode) return;
    this.clearMiddleScrollGesture();
    this.adaptiveZoom.setMode(null);
    this.zoomAnimation.cancel();
    this.toolbar.update();
    this.emitter.emit("did-change-view", { zoomMode: null });
  }

  canScrollHorizontally(delta) {
    if (!Number.isFinite(delta) || delta === 0) return false;
    const { scrollLeft, scrollWidth, clientWidth } = this.viewport;
    return delta < 0 ? scrollLeft > 0 : scrollLeft < scrollWidth - clientWidth;
  }

  watchHorizontalScrollGesture() {
    this.finishHorizontalScrollGesture();
    if (!this.adaptiveZoom.mode) return;
    this.clearHorizontalScrollGesture();
    const window = this.viewport.ownerDocument.defaultView;
    const gesture = {
      left: this.viewport.scrollLeft,
      revision: this.adaptiveZoom.revision,
      window,
    };
    this.horizontalScrollGesture = gesture;
    // Native wheel movement may arrive after the first visual frame.
    gesture.timeout = window.setTimeout(() => {
      if (this.horizontalScrollGesture === gesture) this.horizontalScrollGesture = null;
    }, 250);
  }

  clearHorizontalScrollGesture() {
    const gesture = this.horizontalScrollGesture;
    if (!gesture) return;
    gesture.window.clearTimeout(gesture.timeout);
    this.horizontalScrollGesture = null;
  }

  finishHorizontalScrollGesture() {
    const gesture = this.horizontalScrollGesture;
    if (!gesture) return;
    if (this.destroyed || gesture.revision !== this.adaptiveZoom.revision) {
      this.clearHorizontalScrollGesture();
      return;
    }
    if (this.viewport.scrollLeft === gesture.left) return;
    this.clearHorizontalScrollGesture();
    this.stopAdaptiveZoom();
  }

  watchMiddleScrollGesture(event) {
    this.clearMiddleScrollGesture();
    const document = this.viewport.ownerDocument;
    const controller = new AbortController();
    this.middleScrollController = controller;
    const options = { capture: true, signal: controller.signal };
    const { pointerId, clientX } = event;
    const { scrollLeft, scrollTop } = this.viewport;
    let released = false;
    const finish = () => {
      this.finishHorizontalScrollGesture();
      this.clearMiddleScrollGesture();
    };

    // Chromium can keep autoscrolling after the first middle-button release.
    // Observe later pointer moves because native autoscroll sends no wheel events.
    document.addEventListener(
      "pointermove",
      (move) => {
        if (move.pointerId === pointerId && this.canScrollHorizontally(move.clientX - clientX))
          this.watchHorizontalScrollGesture();
      },
      options,
    );
    document.addEventListener("pointerdown", finish, options);
    document.addEventListener(
      "pointerup",
      (up) => {
        if (up.pointerId !== pointerId) return;
        if (
          up.button !== 1 ||
          released ||
          this.viewport.scrollLeft !== scrollLeft ||
          this.viewport.scrollTop !== scrollTop
        )
          finish();
        else released = true;
      },
      options,
    );
    document.addEventListener("pointercancel", finish, options);
    document.addEventListener(
      "keydown",
      (key) => {
        if (key.key === "Escape") finish();
      },
      options,
    );
    document.defaultView.addEventListener("blur", finish, { signal: controller.signal });
  }

  clearMiddleScrollGesture() {
    this.middleScrollController?.abort();
    this.middleScrollController = null;
  }

  executeCommand(command) {
    if (command === "refresh") return this.reload();
    if (command === "synctex") return this.syncToSource();
    if (command === "copy") return this.copyText();
    if (!this.pdfDocument) return;
    const preset = ZOOM_MODES.find((candidate) => candidate.command === command);
    if (preset) {
      if (this.adaptiveZoom.mode !== preset.value)
        return this.setScale(preset.value, { smooth: true });
      return;
    }
    const previousTool = this.tool;
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
      case "zoom-100":
        return this.setScale(1, { smooth: true });
      case "rotate-clockwise":
        return this.rotate(90);
      case "rotate-counterclockwise":
        return this.rotate(270);
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
    if (this.tool !== previousTool) this.emitter.emit("did-change-view", { tool: this.tool });
  }

  handleWheel(event) {
    if (!event.ctrlKey && !event.metaKey) {
      this.finishHorizontalScrollGesture?.();
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
      if (!event.defaultPrevented && this.adaptiveZoom?.mode) {
        const horizontal =
          event.deltaX || (event.shiftKey && process.platform !== "darwin" ? event.deltaY : 0);
        if (this.canScrollHorizontally(horizontal)) this.watchHorizontalScrollGesture();
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
    if (this.adaptiveZoom.mode && this.canScrollHorizontally(delta.left)) this.stopAdaptiveZoom();
    this.preservePageFocus();
    return this.scrollAnimation.by(delta, options);
  }

  interruptZoom() {
    const interruptedFit = this.adaptiveZoom.mode && this.zoomAnimation?.active;
    this.adaptiveZoom.invalidate();
    this.zoomAnimation?.cancel();
    if (interruptedFit) this.adaptiveZoom.schedule();
  }

  rotate(increment) {
    this.scrollAnimation.cancel();
    this.interruptZoom();
    const pageNumber = this.getCurrentPage();
    const page = this.pdfViewer.getPageView(pageNumber - 1);
    const anchor =
      this.adaptiveZoom.mode && page?.pdfPage
        ? this.adaptiveZoom.captureAnchor(page, pageNumber)
        : null;
    this.pdfViewer.pagesRotation = (this.pdfViewer.pagesRotation + increment) % 360;
    if (anchor) this.zoomAnimation.restoreAnchor(anchor);
    this.adaptiveZoom.rememberScroll();
    return this.adaptiveZoom.update();
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
    if (
      event.button === 1 &&
      this.adaptiveZoom.mode &&
      !event.defaultPrevented &&
      !event.target.closest("a, button, input, select, textarea, [contenteditable]")
    )
      this.watchMiddleScrollGesture(event);
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
    const previousLeft = this.viewport.scrollLeft;
    this.viewport.scrollLeft = this.pan.left + this.pan.x - event.clientX;
    this.viewport.scrollTop = this.pan.top + this.pan.y - event.clientY;
    if (this.viewport.scrollLeft !== previousLeft) this.stopAdaptiveZoom();
  }

  handleScrollbarGesture(event) {
    if (!this.adaptiveZoom.mode) return;
    const track = event.target.closest?.(".lumine-scrollbar.horizontal");
    if (
      !track ||
      (event.type === "pointerdown" ? event.button !== 0 : !track.classList.contains("is-dragging"))
    )
      return;
    this.watchHorizontalScrollGesture();
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
    return Boolean(this.contextPosition && this.getSyncTex?.()?.syncToSource);
  }

  async syncToSource() {
    const position = this.contextPosition;
    const service = this.getSyncTex?.();
    if (!position || !service?.syncToSource) return;
    const generation = this.generation;
    const result = await service.syncToSource(this.filePath, position.page, position.x, position.y);
    if (
      !result?.file ||
      this.destroyed ||
      generation !== this.generation ||
      this.getSyncTex?.() !== service
    )
      return;
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
    if (params.has("zoom") || params.has("page")) {
      const pdf = this.pdfDocument;
      const revision = ++this.destinationRevision;
      const pageNumber = params.has("page")
        ? Number(params.get("page")) | 0 || 1
        : this.getCurrentPage();
      if (pageNumber > 0 && pageNumber <= this.getPageCount())
        await this.ensurePageGeometry(pageNumber);
      if (this.destroyed || this.pdfDocument !== pdf || this.destinationRevision !== revision)
        return;
      this.interruptZoom();
      const explicitZoom = params.has("zoom");
      if (explicitZoom) this.adaptiveZoom.setMode(null);
      else if (pageNumber > 0 && pageNumber <= this.getPageCount())
        this.adaptiveZoom.selectPage(pageNumber);
      this.pageLayout.adjustToWidth();
      const { scrollLeft } = this.viewport;
      this.linkService.setHash(params.toString());
      if (!explicitZoom) this.pageLayout.alignPage(pageNumber, scrollLeft);
      this.adaptiveZoom.rememberScroll();
      await this.adaptiveZoom.update();
      if (this.destroyed || this.pdfDocument !== pdf || this.destinationRevision !== revision)
        return;
      this.pdfViewer.update();
    }
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
      await this.ensurePageGeometry(pageNumber);
      if (!valid()) return false;
      this.pageLayout.adjustToWidth();
      if (this.adaptiveZoom.mode) {
        this.adaptiveZoom.selectPage(pageNumber);
        this.pageLayout.scrollToPage(pageNumber);
        this.adaptiveZoom.rememberScroll();
        await this.adaptiveZoom.update();
        if (!valid()) return false;
      } else if (destinationMode === "page") this.pageLayout.scrollToPage(pageNumber);
      if (destinationMode !== "page") {
        this.pdfViewer.scrollPageIntoView({
          pageNumber,
          destArray: explicit,
          ignoreDestinationZoom: true,
        });
        if (this.adaptiveZoom.mode && this.adaptiveZoom.mode !== "page-height")
          this.pageLayout.alignPage(pageNumber);
      }
      this.adaptiveZoom.rememberScroll();
      this.pdfViewer.update();
      return valid();
    } catch (error) {
      if (valid()) throw error;
      return false;
    }
  }

  scrollToPosition(page, x, y) {
    if (!Number.isInteger(page) || page < 1) return;
    return this.scrollToDestination([page - 1, { name: "XYZ" }, x, y, null]);
  }

  showPassword(updatePassword, reason, cancelOpening) {
    this.closePassword();
    const doc = this.element.ownerDocument;
    const form = doc.createElement("form");
    form.className = "pdf-view-password";
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-label", "PDF password");
    const dialog = doc.createElement("div");
    dialog.className = "pdf-view-password-dialog dialog-form";
    const header = doc.createElement("header");
    header.className = "dialog-header";
    const title = doc.createElement("h2");
    title.className = "dialog-title";
    title.textContent = "PDF Password";
    header.append(title);
    const status = doc.createElement("div");
    status.className = `dialog-status${reason === 2 ? " text-error" : ""}`;
    status.setAttribute("role", reason === 2 ? "alert" : "status");
    status.textContent =
      reason === 2 ? "Incorrect password. Try again." : "Enter the document password.";
    const field = doc.createElement("div");
    field.className = "dialog-field";
    const label = doc.createElement("label");
    label.className = "dialog-label";
    label.textContent = "Document password";
    const editor = lumine.workspace.buildTextEditor({ mini: true });
    const input = editor.getElement();
    input.setAttribute("aria-label", "Document password");
    const updateMask = () => {
      input.style.webkitTextSecurity = editor.getBuffer().getLength() > 0 ? "disc" : "none";
    };
    updateMask();
    label.addEventListener("click", () => input.focus());
    field.append(label, input);
    const footer = doc.createElement("div");
    footer.className = "dialog-footer dialog-actions";
    const submit = doc.createElement("button");
    submit.className = "btn btn-primary";
    submit.textContent = "Open";
    submit.type = "submit";
    const cancel = doc.createElement("button");
    cancel.className = "btn";
    cancel.textContent = "Cancel";
    cancel.type = "button";
    const cancelPassword = () => {
      if (this.passwordElement !== form) return;
      if (cancelOpening) cancelOpening();
      else void this.candidate?.destroy();
      this.closePassword();
    };
    const confirmPassword = () => {
      if (this.passwordElement !== form) return;
      const password = editor.getText();
      this.closePassword();
      updatePassword(password);
    };
    cancel.addEventListener("click", cancelPassword);
    footer.append(cancel, submit);
    dialog.append(header, status, field, footer);
    form.append(dialog);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      confirmPassword();
    });
    this.passwordElement = form;
    this.passwordEditor = editor;
    this.passwordDisposables = new CompositeDisposable(
      lumine.textEditors.add(editor, { role: "input" }),
      editor.getBuffer().onDidChangeText(updateMask),
      lumine.commands.add(form, {
        "core:confirm": (event) => {
          event.stopPropagation();
          confirmPassword();
        },
        "core:cancel": (event) => {
          event.stopPropagation();
          cancelPassword();
        },
      }),
    );
    this.element.append(form);
    input.focus();
    return form;
  }

  closePassword() {
    this.passwordDisposables?.dispose();
    this.passwordDisposables = null;
    this.passwordEditor?.destroy();
    this.passwordEditor = null;
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
    this.clearMiddleScrollGesture();
    this.clearHorizontalScrollGesture();
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
      ...[...this.retiringDocuments].map((document) => document.destroy()),
      pending && !pending.committed ? pending.candidate.destroy({ abort: true }) : null,
      pending?.installPromise?.catch(() => {}),
      pending && !pending.committed ? pending.observation?.closed : null,
    ]).then(() => {});
    return this.destroyPromise;
  }
}

module.exports = PdfView;
