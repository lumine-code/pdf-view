const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Emitter, CompositeDisposable } = require("lumine");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF viewer ownership and service lifetimes", () => {
  let main, directory, file, subscriptions, observations;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-native-lifetime-"));
    file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 3 }));
    subscriptions = new CompositeDisposable();
    observations = new Set();
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
  });

  afterEach(async () => {
    subscriptions.dispose();
    await lumine.packages.deactivatePackage("pdf-view");
    await Promise.all([...observations].map((observation) => observation.closed));
    const parent = path.resolve(os.tmpdir());
    const relative = path.relative(parent, path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("Unsafe PDF lifecycle fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function createViewer() {
    const viewer = main.createViewer(file);
    observations.add(viewer.fileObservation);
    return viewer;
  }

  function buildService() {
    const emitter = new Emitter();
    const jobs = new Map();
    subscriptions.add(emitter);
    return {
      id: "fixture",
      name: "Fixture compiler",
      resolveSource: async () => null,
      canBuild: () => false,
      build: () => null,
      canToggleCompileOnSave: () => false,
      isCompileOnSaveEnabled: () => false,
      toggleCompileOnSave: () => null,
      isBuilding: (pdfPath) =>
        [...jobs.values()].some((job) =>
          job.artifacts.some((artifact) => artifact.path === pdfPath),
        ),
      onDidChangeBuilds: (callback) => emitter.on("builds", callback),
      onDidChangeSources: (callback) => emitter.on("sources", callback),
      start(id, artifactPaths = [file]) {
        const job = {
          id,
          state: "running",
          artifacts: artifactPaths.map((artifactPath) => ({ path: artifactPath, kind: "pdf" })),
        };
        jobs.set(id, job);
        emitter.emit("builds");
        return job;
      },
      change(job, changes) {
        Object.assign(job, changes);
        emitter.emit("builds");
      },
      finish(job, state = "passed") {
        job.state = state;
        jobs.delete(job.id);
        emitter.emit("builds");
      },
    };
  }

  it("restores the page, zoom and rotation saved by the previous iframe viewer", async () => {
    const viewer = main.deserialize({
      filePath: file,
      hash: "",
      viewState: { page: 2, zoom: "1.25", rotation: 90, left: 15, top: 30 },
    });
    observations.add(viewer.fileObservation);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    expect(viewer.getCurrentPage()).toBe(2);
    expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.25, 5);
    expect(viewer.pdfViewer.pagesRotation).toBe(90);
    expect(viewer.element.querySelector("iframe")).toBeNull();
  });

  it("tracks a split copy in commands, adapters, viewer observers and package teardown", async () => {
    const original = createViewer();
    original.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(original);
    await original.whenReady();
    original.goToPage(2);
    original.setScale(1.25);
    const observed = jasmine.createSpy("observe viewers");
    const viewers = main.viewers;
    subscriptions.add(main.observeViewers(observed));
    const result = await lumine.workspace.copyPaneItem(original, { splitDirection: "right" });
    const copy = result.item;
    observations.add(copy.fileObservation);
    copy.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    copy.layoutChanged();
    await copy.whenReady();
    expect(copy).not.toBe(original);
    expect(copy.pdfDocument).not.toBe(original.pdfDocument);
    expect(copy.getCurrentPage()).toBe(2);
    expect(copy.pdfViewer.currentScale).toBeCloseTo(1.25, 2);
    expect(viewers.has(copy)).toBe(true);
    expect(observed).toHaveBeenCalledWith(copy);
    expect(main.viewerForTarget(copy.viewport)).toBe(copy);
    expect(main.provideNavigationAdapter().handlesItem(copy)).toBe(true);
    expect(main.provideSearchAdapter().handlesItem(copy)).toBe(true);
    expect(copy.getSyncTex).toEqual(jasmine.any(Function));
    await lumine.packages.deactivatePackage("pdf-view");
    expect(copy.destroyed).toBe(true);
    expect(viewers.size).toBe(0);
  });

  it("keeps build coordination until the shared payload's last edge retires", () => {
    const viewer = createViewer();
    const service = buildService();
    const first = main.consumePdfBuildProvider(service);
    const second = main.consumePdfBuildProvider(service);
    subscriptions.add(first, second);
    const job = service.start("document");
    expect(viewer.builds.size).toBe(1);
    first.dispose();
    expect(viewer.builds.size).toBe(1);
    service.finish(job);
    expect(viewer.builds.size).toBe(0);
    second.dispose();
  });

  it("keeps refresh paused until a provider finishes all work on that PDF", () => {
    const viewer = createViewer();
    const refresh = spyOn(viewer, "scheduleRefresh");
    const service = buildService();
    subscriptions.add(main.consumePdfBuildProvider(service));
    const unrelated = service.start("unrelated", [path.join(directory, "elsewhere.pdf")]);
    expect(viewer.builds.size).toBe(0);
    const first = service.start("latex-custom-output");
    const second = service.start("typst-custom-output");
    expect(viewer.builds.size).toBe(1);
    service.change(first, { state: "collecting" });
    expect(viewer.builds.size).toBe(1);
    service.finish(first, "failed");
    expect(viewer.builds.size).toBe(1);
    service.finish(unrelated);
    expect(viewer.builds.size).toBe(1);
    service.finish(second, "cancelled");
    expect(viewer.builds.size).toBe(0);
    expect(refresh).toHaveBeenCalled();
  });

  it("attaches active jobs when the service arrives and when a viewer opens later", () => {
    const viewer = createViewer();
    const service = buildService();
    const job = service.start("already-running");
    subscriptions.add(main.consumePdfBuildProvider(service));
    expect(viewer.builds.size).toBe(1);
    const copy = createViewer();
    expect(copy.builds.size).toBe(1);
    service.finish(job);
    expect(viewer.builds.size).toBe(0);
    expect(copy.builds.size).toBe(0);
  });

  it("attaches and releases jobs when the viewed PDF path changes", () => {
    const viewer = createViewer();
    const service = buildService();
    subscriptions.add(main.consumePdfBuildProvider(service));
    const other = path.join(directory, "other.pdf");
    service.start("other", [other]);
    expect(viewer.builds.size).toBe(0);
    viewer.setPath(other);
    expect(viewer.builds.size).toBe(1);
    viewer.setPath(file);
    expect(viewer.builds.size).toBe(0);
  });

  it("keeps SyncTeX until the shared payload's last edge retires", () => {
    const viewer = createViewer();
    const service = { syncToSource() {}, syncToPdf() {} };
    const first = main.consumeLatexSyncTex(service);
    const second = main.consumeLatexSyncTex(service);
    subscriptions.add(first, second);
    expect(viewer.getSyncTex()).toBe(service);
    first.dispose();
    expect(viewer.getSyncTex()).toBe(service);
    second.dispose();
    expect(viewer.getSyncTex()).toBeUndefined();
  });

  it("restores the latest surviving SyncTeX provider in A-B-A registration order", () => {
    const viewer = createViewer();
    const a = { syncToSource() {}, syncToPdf() {} };
    const b = { syncToSource() {}, syncToPdf() {} };
    const first = main.consumeLatexSyncTex(a);
    const middle = main.consumeLatexSyncTex(b);
    const last = main.consumeLatexSyncTex(a);
    subscriptions.add(first, middle, last);
    expect(viewer.getSyncTex()).toBe(a);
    last.dispose();
    expect(viewer.getSyncTex()).toBe(b);
    middle.dispose();
    expect(viewer.getSyncTex()).toBe(a);
  });

  it("discards an in-flight inverse search when its SyncTeX service disappears", async () => {
    const viewer = createViewer();
    let resolve;
    const service = {
      syncToSource: () => new Promise((done) => (resolve = done)),
      syncToPdf() {},
    };
    const lease = main.consumeLatexSyncTex(service);
    subscriptions.add(lease);
    viewer.contextPosition = { page: 1, x: 10, y: 20 };
    const open = spyOn(lumine.workspace, "open");
    const search = viewer.syncToSource();
    lease.dispose();
    resolve({ file: path.join(directory, "source.tex"), line: 2, column: 0 });
    await search;
    expect(open).not.toHaveBeenCalled();
  });

  it("does not let a retired viewer-observer lease remove the new generation's callback", async () => {
    const previousViewers = main.viewers;
    const callback = jasmine.createSpy("observe viewers");
    const previousLease = main.observeViewers(callback);
    subscriptions.add(previousLease);
    await lumine.packages.deactivatePackage("pdf-view");
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    subscriptions.add(main.observeViewers(callback));
    previousLease.dispose();
    const viewer = createViewer();
    expect(callback).toHaveBeenCalledWith(viewer);
    expect(previousViewers.size).toBe(0);
  });

  it("declines retained service operations and adapters after package reactivation", async () => {
    const previous = main.providePdfView();
    const previousNavigation = main.provideNavigationAdapter();
    const previousSearch = main.provideSearchAdapter();
    await lumine.packages.deactivatePackage("pdf-view");
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    const open = spyOn(lumine.workspace, "open");
    expect(await previous.open(file)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    const viewer = createViewer();
    expect(previousNavigation.handlesItem(viewer)).toBe(false);
    expect(previousSearch.handlesItem(viewer)).toBe(false);
    expect(previousSearch.getAdapterForItem(viewer)).toBeNull();
  });

  it("cancels an in-flight placement before retiring the viewer generation", async () => {
    const previous = main.providePdfView();
    subscriptions.add(main.observeViewers((viewer) => observations.add(viewer.fileObservation)));
    const workspaceOpen = lumine.workspace.open.bind(lumine.workspace);
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    spyOn(lumine.workspace, "open").and.callFake(async (...args) => {
      await gate;
      return workspaceOpen(...args);
    });
    const pending = previous.open(file);
    const viewer = [...main.viewers][0];
    await lumine.packages.deactivatePackage("pdf-view");
    release();
    expect(await pending).toBeNull();
    expect(viewer.destroyed).toBe(true);
    expect(lumine.workspace.getPaneItems()).not.toContain(viewer);
  });
});
