const fs = require("fs");
const os = require("os");
const path = require("path");
const { Emitter, CompositeDisposable } = require("lumine");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF service lifetimes and source identity", () => {
  let main, directory, file, viewer, providers, emitters, observations;
  function provide(name, payload) {
    const lease = lumine.packages.serviceHub.provide(name, "1.0.0", payload);
    providers.push(lease);
    return lease;
  }
  function buildService() {
    const emitter = new Emitter();
    emitters.add(emitter);
    return {
      compile: jasmine.createSpy("compile").and.resolveTo(),
      onDidStartBuild: (callback) => emitter.on("start", callback),
      onDidFinishBuild: (callback) => emitter.on("finish", callback),
      onDidFailBuild: (callback) => emitter.on("fail", callback),
      start: (file) => emitter.emit("start", { file }),
      finish: (file) => emitter.emit("finish", { file }),
    };
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    providers = [];
    observations = [];
    emitters = new CompositeDisposable();
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-service-")));
    file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf());
    await lumine.packages.deactivatePackage("pdf-view");
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    viewer = await lumine.workspace.open(file);
    observations.push(viewer.file);
  });
  afterEach(async () => {
    for (const provider of providers) provider.dispose();
    await lumine.packages.deactivatePackage("pdf-view");
    emitters.dispose();
    await Promise.all(observations.map((observation) => observation.closed));
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Unsafe PDF fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  for (const [name, extension, getter] of [
    ["latex-tools", ".tex", "getLatexTools"],
    ["typst-tools", ".typ", "getTypstTools"],
  ]) {
    it(`keeps a shared ${name} payload until its last live edge`, () => {
      const payload = buildService();
      const first = provide(name, payload);
      const second = provide(name, payload);
      const source = file.replace(/\.pdf$/, extension);
      first.dispose();
      payload.start(source);
      expect(viewer[getter]()).toBe(payload);
      expect(viewer.autoRefreshPausedByBuild).toBe(true);
      payload.finish(source);
      expect(viewer.autoRefreshPausedByBuild).toBe(false);
      second.dispose();
      expect(viewer[getter]()).toBeNull();
    });

    it(`restores the newest surviving ${name} edge in A-B-A order`, () => {
      const a = buildService();
      const b = buildService();
      provide(name, a);
      const second = provide(name, b);
      const latest = provide(name, a);
      latest.dispose();
      expect(viewer[getter]()).toBe(b);
      b.start(file.replace(/\.pdf$/, extension));
      expect(viewer.autoRefreshPausedByBuild).toBe(true);
      b.finish(file.replace(/\.pdf$/, extension));
      second.dispose();
      expect(viewer[getter]()).toBe(a);
    });
  }

  it("keeps the actual scrollmap widget after a shared provider edge retires", async () => {
    const scrollmap = (await lumine.packages.activatePackage("scrollmap")).mainModule;
    const Widget = scrollmap.provideScrollmapWidget();
    const first = provide("scrollmap.widget", Widget);
    const second = provide("scrollmap.widget", Widget);
    viewer.emitScrollmapData({ items: [{ percent: 25, level: 0 }] });
    const strip = viewer.element.querySelector(".pdf-view-scrollmap");
    expect(strip).not.toBeNull();
    first.dispose();
    expect(viewer.element.querySelector(".pdf-view-scrollmap")).toBe(strip);
    second.dispose();
    // The package's own original widget edge is still alive.
    expect(viewer.element.querySelector(".pdf-view-scrollmap")).not.toBeNull();
  });

  it("does not let an old manual build lease erase a replacement activation", async () => {
    const payload = buildService();
    const oldLease = main.consumeTypstTools(payload);
    await lumine.packages.deactivatePackage("pdf-view");
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    viewer = await lumine.workspace.open(file);
    observations.push(viewer.file);
    main.consumeTypstTools(payload);
    oldLease.dispose();
    expect(viewer.getTypstTools()).toBe(payload);
    payload.start(file.replace(/\.pdf$/, ".typ"));
    expect(viewer.autoRefreshPausedByBuild).toBe(true);
  });

  it("releases captured payload references when manually consumed services retire", async () => {
    const owner = main.owner;
    const payload = buildService();
    main.consumeLatexTools(payload);
    main.consumeTypstTools(payload);
    const scrollmap = (await lumine.packages.activatePackage("scrollmap")).mainModule;
    const Widget = scrollmap.provideScrollmapWidget();
    main.consumeScrollmapWidget(Widget);
    await lumine.packages.deactivatePackage("pdf-view");
    for (const kind of ["latex", "typst", "widget"]) {
      expect(owner[`${kind}Records`].size).toBe(0);
      expect(owner[`${kind}Edges`].size).toBe(0);
    }
    expect(owner.currentWidget).toBeNull();
  });

  it("does not let an old viewer-observer lease remove the new subscription", async () => {
    const oldService = main.providePdfView();
    const callback = jasmine.createSpy("observe viewers");
    const oldLease = oldService.observeViewers(callback);
    await lumine.packages.deactivatePackage("pdf-view");
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    const current = main.providePdfView();
    const currentLease = current.observeViewers(callback);
    oldLease.dispose();
    viewer = await lumine.workspace.open(file);
    observations.push(viewer.file);
    expect(callback.calls.mostRecent().args[0]).toBe(viewer);
    expect(oldService.getViewers().size).toBe(0);
    currentLease.dispose();
  });

  it("declines a retained PDF opener from a retired service", async () => {
    const oldService = main.providePdfView();
    await lumine.packages.deactivatePackage("pdf-view");
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    await oldService.open(file);
    expect(open).not.toHaveBeenCalled();
  });

  it("compiles and opens the source beside an uppercase PDF through current commands", async () => {
    const uppercase = path.join(directory, "uppercase.PDF");
    const source = path.join(directory, "uppercase.typ");
    fs.writeFileSync(uppercase, createPdf());
    fs.writeFileSync(source, "Owned source");
    const upperViewer = await lumine.workspace.open(uppercase);
    observations.push(upperViewer.file);
    const payload = buildService();
    provide("typst-tools", payload);
    await lumine.commands.dispatch(upperViewer.element, "pdf-view:compile");
    expect(payload.compile).toHaveBeenCalledWith(source);
    const open = spyOn(lumine.workspace, "open").and.resolveTo();
    await lumine.commands.dispatch(upperViewer.element, "pdf-view:open-tex");
    expect(open).toHaveBeenCalledWith(source, { split: "left", searchAllPanes: true });
    expect(fs.readFileSync(source, "utf8")).toBe("Owned source");
  });
});
