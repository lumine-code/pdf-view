const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CompositeDisposable, Emitter } = require("lumine");
const { createPdf } = require("./helpers/pdf-fixture");

describe("Native PDF pending pane item reuse", () => {
  let main, PdfDocument, directory, subscriptions, observations, gates, operations;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-pending-"));
    subscriptions = new CompositeDisposable();
    observations = new Set();
    gates = [];
    operations = new Set();
    lumine.config.set("core.allowPendingPaneItems", true);
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    await activate();
  });

  afterEach(async () => {
    for (const gate of gates) gate.release();
    for (const viewer of main.viewers || []) observations.add(viewer.fileObservation);
    await lumine.packages.deactivatePackage("pdf-view");
    await Promise.allSettled([...operations]);
    subscriptions.dispose();
    await Promise.all([...observations].map((observation) => observation.closed));
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("Unsafe PDF pending fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function activate() {
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    // Package teardown retires module identities; spies must use this generation.
    PdfDocument = require("../lib/document");
    subscriptions.add(
      main.observeViewers((viewer) => {
        viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
        observations.add(viewer.fileObservation);
        subscriptions.add(viewer.onDidChangePath(() => observations.add(viewer.fileObservation)));
      }),
    );
  }

  function fixture(name, options = {}) {
    const file = path.join(directory, name);
    fs.writeFileSync(file, createPdf(options));
    return file;
  }

  function track(operation) {
    operations.add(operation);
    operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  }

  async function open(file, options = {}) {
    const viewer = await track(lumine.workspace.open(file, { pending: true, ...options }));
    await viewer.whenReady();
    await conditionPromise(
      () => viewer.pagesElement.querySelector(".page canvas"),
      "native PDF canvas",
      15000,
    );
    return viewer;
  }

  function holdLoadedDocument(file) {
    let release;
    const released = new Promise((resolve) => (release = resolve));
    const gate = { release, document: null };
    gates.push(gate);
    const original = PdfDocument.prototype.open;
    spyOn(PdfDocument.prototype, "open").and.callFake(async function (...args) {
      const pdf = await original.apply(this, args);
      if (this.filePath === file && !gate.document) {
        gate.document = this;
        await released;
      }
      return pdf;
    });
    return gate;
  }

  async function waitForCandidate(gate) {
    await conditionPromise(() => gate.document, "parsed replacement PDF before commit", 15000);
  }

  it("retains the pane, tab position and native surface while updating the document address", async () => {
    const first = fixture("first.pdf", { pages: 4 });
    const second = fixture("second.pdf", { pages: 2 });
    const viewer = await open(first);
    const pane = lumine.workspace.paneForItem(viewer);
    const index = pane.getItems().indexOf(viewer);
    const { element, viewport, pagesElement, toolbar, pdfViewer, linkService } = viewer;
    const previousDocument = viewer.document;
    const previousObservation = viewer.fileObservation;
    await previousObservation.ready;
    const titleChanged = jasmine.createSpy("PDF title changed");
    const pathChanged = jasmine.createSpy("PDF path changed");
    const uriChanged = jasmine.createSpy("workspace PDF URI changed");
    subscriptions.add(
      viewer.onDidChangeTitle(titleChanged),
      viewer.onDidChangePath(pathChanged),
      lumine.workspace.onDidChangePaneItemURI(uriChanged),
    );

    expect(await open(second)).toBe(viewer);

    expect(lumine.workspace.paneForItem(viewer)).toBe(pane);
    expect(pane.getItems().indexOf(viewer)).toBe(index);
    expect(pane.getPendingItem()).toBe(viewer);
    expect(pane.getActiveItem()).toBe(viewer);
    expect(viewer.element).toBe(element);
    expect(viewer.viewport).toBe(viewport);
    expect(viewer.pagesElement).toBe(pagesElement);
    expect(viewer.toolbar).toBe(toolbar);
    expect(viewer.pdfViewer).toBe(pdfViewer);
    expect(viewer.linkService).toBe(linkService);
    expect(element.isConnected).toBe(true);
    expect(viewer.getPath()).toBe(second);
    expect(viewer.getURI()).toBe(second);
    expect(viewer.getTitle()).toBe("second.pdf");
    expect(viewer.getPageCount()).toBe(2);
    expect(previousDocument.closed).toBe(true);
    expect(viewer.fileObservation).not.toBe(previousObservation);
    await previousObservation.closed;
    await viewer.fileObservation.ready;
    expect(viewer.fileObservation.path).toBe(second);
    expect(titleChanged).toHaveBeenCalledTimes(1);
    expect(pathChanged).toHaveBeenCalledWith(second);
    expect(uriChanged).toHaveBeenCalledWith({ item: viewer, pane, oldURI: first, newURI: second });
    expect(Object.prototype.toString.call(viewer.document.task._worker.port)).toBe(
      "[object Worker]",
    );
    expect(element.querySelector("iframe")).toBeNull();
  }, 30000);

  it("keeps existing search, navigation and build-service ownership on the reused item", async () => {
    const first = fixture("first.pdf", {
      pages: 4,
      outline: [{ title: "Old bookmark", page: 3 }],
    });
    const second = fixture("second.pdf", {
      pages: 2,
      outline: [{ title: "New bookmark", page: 1, dest: "new" }],
    });
    const viewer = await open(first);
    const observed = jasmine.createSpy("new PDF viewer");
    const navigation = main.provideNavigationAdapter();
    const searchFactory = main.provideSearchAdapter();
    const search = searchFactory.getAdapterForItem(viewer);
    let headers = [];
    const buildEvents = new Emitter();
    const buildService = {
      onDidStartBuild: (callback) => buildEvents.on("start", callback),
      onDidFinishBuild: (callback) => buildEvents.on("finish", callback),
    };
    subscriptions.add(
      buildEvents,
      main.consumeLatexTools(buildService),
      main.observeViewers(observed),
      navigation.observeHeaders(viewer, (value) => (headers = value)),
    );
    await search.search({ findPattern: "integration" });
    expect(search.getResultCount()).toBe(4);
    await conditionPromise(() => headers[0]?.text === "Old bookmark", "old PDF outline", 10000);

    expect(await open(second)).toBe(viewer);

    expect(main.viewers.size).toBe(1);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(main.viewerForTarget(viewer.viewport)).toBe(viewer);
    expect(navigation.handlesItem(viewer)).toBe(true);
    expect(searchFactory.getAdapterForItem(viewer)).toBe(search);
    await conditionPromise(
      () => !search.isPending() && search.getResultCount() === 2,
      "retained search adapter on the replacement document",
      10000,
    );
    await conditionPromise(() => headers[0]?.text === "New bookmark", "new PDF outline", 10000);
    expect(headers[0].filePath).toBe(second);
    await navigation.navigateTo(viewer, headers[0], { focus: false });
    expect(viewer.getCurrentPage()).toBe(2);
    expect(viewer.getLatexTools()).toBe(buildService);
    buildEvents.emit("start", { file: first.replace(/\.pdf$/, ".tex") });
    expect(viewer.builds.size).toBe(0);
    buildEvents.emit("start", { file: second.replace(/\.pdf$/, ".tex") });
    expect(viewer.builds.size).toBe(1);
    buildEvents.emit("finish", { file: second.replace(/\.pdf$/, ".tex") });
    expect(viewer.builds.size).toBe(0);
  }, 30000);

  it("preserves zoom and rotation preferences and starts a new file on its first page", async () => {
    const viewer = await open(fixture("first.pdf", { pages: 5 }));
    viewer.setScale(1.25);
    lumine.commands.dispatch(viewer.viewport, "pdf-view:rotate-clockwise");
    viewer.goToPage(4);
    expect(viewer.getCurrentPage()).toBe(4);

    expect(await open(fixture("second.pdf", { pages: 3 }))).toBe(viewer);

    expect(viewer.getCurrentPage()).toBe(1);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.25, 5);
    expect(viewer.pdfViewer.pagesRotation).toBe(90);
    expect(viewer.viewport.scrollTop).toBeLessThan(2);
  }, 30000);

  it("applies a new file URL's named destination rather than the previous scroll position", async () => {
    const viewer = await open(fixture("first.pdf", { pages: 5 }));
    viewer.setScale(1.25);
    viewer.goToPage(4);
    const second = fixture("second file.pdf", {
      pages: 4,
      outline: [
        { title: "Target", page: 2, dest: "target", mode: "XYZ", coordinates: "40 210 null" },
      ],
    });
    const address = pathToFileURL(second);
    address.hash = "nameddest=target";

    expect(await open(address.href)).toBe(viewer);

    expect(viewer.getURI()).toBe(`${second}#nameddest=target`);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.25, 5);
    await conditionPromise(
      () => viewer.location?.pageNumber === 3 && Math.abs(viewer.location.top - 210) < 2,
      "new PDF destination coordinates",
      10000,
    );
  }, 30000);

  it("recognizes the same normalized file URL and explicit fragment without reparsing it", async () => {
    const file = fixture("document with spaces.pdf", { pages: 4 });
    const address = pathToFileURL(file);
    address.hash = "page=3";
    const options = { opener: "pdf-view", uriFragment: "#page=2" };
    const viewer = await open(address.href, options);
    const pdf = viewer.pdfDocument;
    const observation = viewer.fileObservation;
    const parse = spyOn(PdfDocument.prototype, "open").and.callThrough();
    const reuse = spyOn(viewer, "reusePendingDocument").and.callThrough();

    expect(await open(address.href, options)).toBe(viewer);

    expect(viewer.getURI()).toBe(`${file}#page=2`);
    expect(viewer.getCurrentPage()).toBe(2);
    expect(viewer.pdfDocument).toBe(pdf);
    expect(viewer.fileObservation).toBe(observation);
    expect(parse).not.toHaveBeenCalled();
    expect(reuse).not.toHaveBeenCalled();
  }, 30000);

  it("keeps a permanent tab intact when another PDF is previewed", async () => {
    const first = fixture("permanent.pdf");
    const viewer = await open(first, { pending: false });
    const pane = lumine.workspace.paneForItem(viewer);

    const preview = await open(fixture("preview.pdf"));

    expect(preview).not.toBe(viewer);
    expect(viewer.destroyed).toBe(false);
    expect(viewer.getPath()).toBe(first);
    expect(pane.getItems()).toContain(viewer);
    expect(pane.getPendingItem()).toBe(preview);
  }, 30000);

  for (const [label, options] of [
    ["split", { split: "right" }],
    ["background", { activateItem: false }],
    ["permanent", { pending: false }],
  ]) {
    it(`constructs a separate native viewer for a ${label} opening`, async () => {
      const first = fixture("first.pdf");
      const viewer = await open(first);
      const pane = lumine.workspace.paneForItem(viewer);
      const reuse = spyOn(viewer, "reusePendingDocument").and.callThrough();
      const second = fixture("second.pdf", { pages: 2 });

      const next = await track(lumine.workspace.open(second, { pending: true, pane, ...options }));

      expect(next).not.toBe(viewer);
      expect(reuse).not.toHaveBeenCalled();
      expect(viewer.getPath()).toBe(first);
      if (label === "split") {
        expect(lumine.workspace.paneForItem(next)).not.toBe(pane);
        expect(viewer.destroyed).toBe(false);
      }
      lumine.workspace.paneForItem(next).activateItem(next);
      next.layoutChanged();
      await next.whenReady();
      expect(next.getPageCount()).toBe(2);
      expect(next.element.querySelector("iframe")).toBeNull();
    }, 30000);
  }

  it("leaves the original document, address and watcher usable when the replacement PDF is invalid", async () => {
    const first = fixture("first.pdf", { pages: 3 });
    const viewer = await open(first);
    const pane = lumine.workspace.paneForItem(viewer);
    const previousDocument = viewer.pdfDocument;
    const previousObservation = viewer.fileObservation;
    const invalid = path.join(directory, "invalid.pdf");
    fs.writeFileSync(invalid, "not a PDF document");
    const uriChanged = jasmine.createSpy("PDF URI changed");
    subscriptions.add(viewer.onDidChangeURI(uriChanged));

    await expectAsync(track(lumine.workspace.open(invalid, { pending: true }))).toBeRejected();

    expect(viewer.pdfDocument).toBe(previousDocument);
    expect(viewer.getPath()).toBe(first);
    expect(viewer.getURI()).toBe(first);
    expect(viewer.getTitle()).toBe("first.pdf");
    expect(viewer.fileObservation).toBe(previousObservation);
    expect(uriChanged).not.toHaveBeenCalled();
    expect(pane.getPendingItem()).toBe(viewer);
    expect(viewer.pagesElement.querySelector("canvas")).not.toBeNull();
    lumine.commands.dispatch(viewer.viewport, "pdf-view:last-page");
    expect(viewer.getCurrentPage()).toBe(3);
    await viewer.getSearchAdapter().search({ findPattern: "integration" });
    expect(viewer.getSearchAdapter().getResultCount()).toBe(3);
    expect(await open(fixture("recovery.pdf", { pages: 2 }))).toBe(viewer);
    expect(viewer.getPageCount()).toBe(2);
  }, 30000);

  it("keeps the original PDF usable when the native viewer rejects installation", async () => {
    const first = fixture("first.pdf", { pages: 3 });
    const second = fixture("second.pdf", { pages: 2 });
    const viewer = await open(first);
    const pane = lumine.workspace.paneForItem(viewer);
    const previousDocument = viewer.document;
    const previousPdf = viewer.pdfDocument;
    const previousObservation = viewer.fileObservation;
    const previousCanvas = viewer.pagesElement.querySelector("canvas");
    const error = new Error("Native PDF installation failed");
    const install = viewer.pdfViewer.setDocument.bind(viewer.pdfViewer);
    const installation = spyOn(viewer.pdfViewer, "setDocument").and.callFake((pdf) => {
      if (pdf && pdf !== previousPdf) throw error;
      return install(pdf);
    });
    const uriChanged = jasmine.createSpy("failed installation URI change");
    subscriptions.add(viewer.onDidChangeURI(uriChanged));

    await expectAsync(track(lumine.workspace.open(second, { pending: true }))).toBeRejectedWith(
      error,
    );

    expect(viewer.document).toBe(previousDocument);
    expect(viewer.pdfDocument).toBe(previousPdf);
    expect(previousDocument.closed).toBe(false);
    expect(viewer.getPath()).toBe(first);
    expect(viewer.getTitle()).toBe("first.pdf");
    expect(viewer.fileObservation).toBe(previousObservation);
    expect(viewer.pagesElement.querySelector("canvas")).toBe(previousCanvas);
    expect(pane.getPendingItem()).toBe(viewer);
    expect(uriChanged).not.toHaveBeenCalled();
    lumine.commands.dispatch(viewer.viewport, "pdf-view:last-page");
    expect(viewer.getCurrentPage()).toBe(3);
    await viewer.getSearchAdapter().search({ findPattern: "integration" });
    expect(viewer.getSearchAdapter().getResultCount()).toBe(3);
    installation.and.callThrough();
    expect(await open(second)).toBe(viewer);
    expect(viewer.getPageCount()).toBe(2);
  }, 30000);

  it("commits the newest PDF when an earlier parsed replacement finishes later", async () => {
    const first = fixture("first.pdf", { pages: 4 });
    const second = fixture("second.pdf", { pages: 2 });
    const third = fixture("third.pdf", { pages: 3 });
    const viewer = await open(first);
    const previousCanvas = viewer.pagesElement.querySelector("canvas");
    const previousObservation = viewer.fileObservation;
    const gate = holdLoadedDocument(second);
    const uriChanged = jasmine.createSpy("PDF URI changed");
    subscriptions.add(viewer.onDidChangeURI(uriChanged));
    const earlier = track(lumine.workspace.open(second, { pending: true }));
    await waitForCandidate(gate);
    expect(viewer.getPath()).toBe(first);
    expect(viewer.getPageCount()).toBe(4);
    expect(viewer.pagesElement.querySelector("canvas")).toBe(previousCanvas);
    expect(viewer.fileObservation).toBe(previousObservation);
    lumine.commands.dispatch(viewer.viewport, "pdf-view:last-page");
    expect(viewer.getCurrentPage()).toBe(4);

    expect(await open(third)).toBe(viewer);
    gate.release();

    expect(await earlier).toBeUndefined();
    expect(viewer.getPath()).toBe(third);
    expect(viewer.getPageCount()).toBe(3);
    expect(uriChanged).toHaveBeenCalledTimes(1);
    expect(gate.document.closed).toBe(true);
    expect(main.viewers.size).toBe(1);
    expect(viewer.fileObservation.path).toBe(third);
  }, 30000);

  it("replaces an initial preview whose first worker result is still pending", async () => {
    const first = fixture("first.pdf", { pages: 3 });
    const second = fixture("second.pdf", { pages: 2 });
    const gate = holdLoadedDocument(first);
    const viewer = await track(lumine.workspace.open(first, { pending: true }));
    const initialReady = track(viewer.whenReady());
    const pane = lumine.workspace.paneForItem(viewer);
    const element = viewer.element;
    await waitForCandidate(gate);
    expect(viewer.pdfDocument).toBeUndefined();
    let settled = false;
    const replacement = track(lumine.workspace.open(second, { pending: true }));
    replacement.then(
      () => (settled = true),
      () => (settled = true),
    );

    await conditionPromise(
      () => settled,
      "replacement PDF opens without waiting for the obsolete initial load",
      10000,
    );
    expect(await replacement).toBe(viewer);
    await viewer.whenReady();
    expect(viewer.getPath()).toBe(second);
    expect(viewer.getPageCount()).toBe(2);
    expect(lumine.workspace.paneForItem(viewer)).toBe(pane);
    expect(viewer.element).toBe(element);
    expect(pane.getPendingItem()).toBe(viewer);
    const pdf = viewer.pdfDocument;
    gate.release();
    await initialReady;
    expect(gate.document.closed).toBe(true);
    expect(viewer.pdfDocument).toBe(pdf);
    expect(viewer.getPath()).toBe(second);
  }, 30000);

  it("retires service navigation when a core preview replaces the same loading viewer", async () => {
    const first = fixture("first.pdf", {
      pages: 3,
      outline: [{ title: "Original target", page: 2, dest: "target" }],
    });
    const second = fixture("second.pdf", {
      pages: 3,
      outline: [{ title: "Different target", page: 1, dest: "target" }],
    });
    const pane = lumine.workspace.getActivePane();
    const gate = holdLoadedDocument(first);
    const serviceOpening = track(
      main.providePdfView().open(first, { pending: true, pane, dest: "target" }),
    );
    await waitForCandidate(gate);
    const viewer = [...main.viewers][0];
    const initialReady = track(viewer.whenReady());
    const navigate = spyOn(viewer, "scrollToDestination").and.callThrough();
    await conditionPromise(
      () => lumine.workspace.paneForItem(viewer) === pane && pane.getPendingItem() === viewer,
      "service's initial pending PDF placement",
      10000,
    );
    let settled = false;
    const replacement = track(lumine.workspace.open(second, { pending: true, pane }));
    replacement.then(
      () => (settled = true),
      () => (settled = true),
    );

    await conditionPromise(() => settled, "core preview replaces the service's loading PDF", 10000);
    expect(await replacement).toBe(viewer);
    await viewer.whenReady();
    expect(viewer.getPath()).toBe(second);
    expect(viewer.getCurrentPage()).toBe(1);
    const pdf = viewer.pdfDocument;
    gate.release();

    expect(await serviceOpening).toBeNull();
    await initialReady;
    expect(navigate).not.toHaveBeenCalled();
    expect(viewer.pdfDocument).toBe(pdf);
    expect(viewer.getPath()).toBe(second);
    expect(viewer.getCurrentPage()).toBe(1);
    expect(viewer.destroyed).toBe(false);
  }, 30000);

  it("settles an aborted layout wait and releases its waiter without a layout change", async () => {
    const first = fixture("first.pdf", { pages: 3 });
    const second = fixture("second.pdf", { pages: 2 });
    const viewer = await open(first);
    const pdf = viewer.pdfDocument;
    const observation = viewer.fileObservation;
    const controller = new AbortController();
    viewer.element.style.display = "none";
    const pending = track(
      lumine.workspace.open(second, { pending: true, signal: controller.signal }),
    );
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    try {
      await conditionPromise(
        () => viewer.layoutWaiters.size > 0,
        "replacement PDF waiting for a visible layout",
        15000,
      );

      controller.abort();

      await conditionPromise(() => settled, "aborted PDF layout wait settles", 3000);
      expect(await pending).toBeUndefined();
      expect(viewer.layoutWaiters.size).toBe(0);
      expect(viewer.pdfDocument).toBe(pdf);
      expect(viewer.getPath()).toBe(first);
      expect(viewer.fileObservation).toBe(observation);
    } finally {
      viewer.element.style.display = "";
      viewer.layoutChanged();
    }
  }, 30000);

  for (const action of ["keep", "close", "abort"]) {
    it(`cancels a parsed preview before commit when the user chooses ${action}`, async () => {
      const first = fixture("first.pdf", { pages: 3 });
      const second = fixture("second.pdf", { pages: 2 });
      const viewer = await open(first);
      const pane = lumine.workspace.paneForItem(viewer);
      const previousDocument = viewer.pdfDocument;
      const gate = holdLoadedDocument(second);
      const controller = new AbortController();
      const uriChanged = jasmine.createSpy("cancelled PDF URI changed");
      subscriptions.add(viewer.onDidChangeURI(uriChanged));
      const pending = track(
        lumine.workspace.open(second, { pending: true, signal: controller.signal }),
      );
      await waitForCandidate(gate);

      if (action === "keep") pane.clearPendingItem();
      else if (action === "close") await pane.destroyItem(viewer);
      else controller.abort();
      gate.release();

      expect(await pending).toBeUndefined();
      expect(uriChanged).not.toHaveBeenCalled();
      expect(viewer.getURI()).toBe(first);
      expect(gate.document.closed).toBe(true);
      if (action === "close") {
        expect(viewer.destroyed).toBe(true);
        expect(lumine.workspace.getPaneItems()).not.toContain(viewer);
      } else {
        expect(viewer.pdfDocument).toBe(previousDocument);
        expect(viewer.destroyed).toBe(false);
        lumine.commands.dispatch(viewer.viewport, "pdf-view:last-page");
        expect(viewer.getCurrentPage()).toBe(3);
      }
    }, 30000);
  }

  for (const action of ["reload", "setFile"]) {
    it(`rejects superseded viewer-owned reuse with AbortError when ${action} takes over`, async () => {
      const first = fixture("first.pdf", { pages: 3 });
      const second = fixture("second.pdf", { pages: 2 });
      const third = fixture("third.pdf", { pages: 4 });
      const viewer = await open(first);
      const gate = holdLoadedDocument(second);
      const pending = track(
        viewer.reusePendingDocument(second, "", { signal: new AbortController().signal }),
      );
      const rejection = expectAsync(pending).toBeRejectedWith(
        jasmine.objectContaining({ name: "AbortError" }),
      );
      await waitForCandidate(gate);

      await (action === "reload" ? viewer.reload() : viewer.setFile(third, "#page=2"));
      gate.release();

      await rejection;
      expect(viewer.getPath()).toBe(action === "reload" ? first : third);
      expect(viewer.getPageCount()).toBe(action === "reload" ? 3 : 4);
      expect(viewer.getCurrentPage()).toBe(action === "reload" ? 1 : 2);
      expect(gate.document.closed).toBe(true);
    }, 30000);
  }

  it("offers reuse from the active package generation after deactivation and reactivation", async () => {
    await lumine.packages.deactivatePackage("pdf-view");
    await activate();
    const viewer = await open(fixture("first.pdf"));

    expect(await open(fixture("second.pdf", { pages: 2 }))).toBe(viewer);

    expect(main.viewers.has(viewer)).toBe(true);
    expect(viewer.getPageCount()).toBe(2);
  }, 30000);
});
