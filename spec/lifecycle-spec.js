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
    subscriptions.add(emitter);
    return {
      onDidStartBuild: (callback) => emitter.on("start", callback),
      onDidFinishBuild: (callback) => emitter.on("finish", callback),
      onDidFailBuild: (callback) => emitter.on("fail", callback),
      start: (source) => emitter.emit("start", { file: source }),
      finish: (source) => emitter.emit("finish", { file: source }),
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
    expect(copy.getLatexTools).toEqual(jasmine.any(Function));
    await lumine.packages.deactivatePackage("pdf-view");
    expect(copy.destroyed).toBe(true);
    expect(viewers.size).toBe(0);
  });

  for (const [consume, getter, extension] of [
    ["consumeLatexTools", "getLatexTools", ".tex"],
    ["consumeTypstTools", "getTypstTools", ".typ"],
  ]) {
    it(`keeps ${extension} build coordination until the shared payload's last edge retires`, () => {
      const viewer = createViewer();
      const service = buildService();
      const first = main[consume](service);
      const second = main[consume](service);
      subscriptions.add(first, second);
      service.start(file.replace(/\.pdf$/i, extension));
      expect(viewer.builds.size).toBe(2);
      first.dispose();
      expect(viewer[getter]()).toBe(service);
      expect(viewer.builds.size).toBe(1);
      service.finish(file.replace(/\.pdf$/i, extension));
      expect(viewer.builds.size).toBe(0);
      second.dispose();
      expect(viewer[getter]()).not.toBe(service);
    });

    it(`restores the latest surviving ${extension} provider in A-B-A registration order`, () => {
      const viewer = createViewer();
      const a = buildService();
      const b = buildService();
      const first = main[consume](a);
      const middle = main[consume](b);
      const last = main[consume](a);
      subscriptions.add(first, middle, last);
      expect(viewer[getter]()).toBe(a);
      last.dispose();
      expect(viewer[getter]()).toBe(b);
      middle.dispose();
      expect(viewer[getter]()).toBe(a);
    });
  }

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
