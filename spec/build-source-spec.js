const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CompositeDisposable, Emitter } = require("lumine");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF source builds through registered compiler providers", () => {
  let main, directory, subscriptions, observations, gates;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-source-build-")));
    subscriptions = new CompositeDisposable();
    observations = new Set();
    gates = [];
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    lumine.workspace.getBottomDock().hide();
  });
  afterEach(async () => {
    for (const release of gates) release(null);
    subscriptions.dispose();
    for (const viewer of main.viewers || []) observations.add(viewer.fileObservation);
    await lumine.packages.deactivatePackage("pdf-view");
    for (const editor of lumine.workspace.getTextEditors())
      if (editor.getPath()?.startsWith(directory + path.sep)) editor.destroy();
    await Promise.all([...observations].map((observation) => observation.closed));
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Unsafe PDF build fixture cleanup.");
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function source(name) {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, "source\n");
    return filePath;
  }
  function pdf(name = "document.pdf") {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, createPdf());
    return filePath;
  }
  function provider(id, entries = []) {
    const events = new Emitter(),
      sources = new Map(entries),
      building = new Set(),
      observed = new Set();
    subscriptions.add(events);
    return {
      id,
      name: id,
      sources,
      resolveSource: jasmine
        .createSpy("resolve source")
        .and.callFake(async (pdfPath) => sources.get(pdfPath) || null),
      canBuild: (sourcePath) =>
        [...sources.values()].includes(sourcePath) && !building.has(sourcePath),
      build: jasmine.createSpy("build source").and.callFake((sourcePath) => {
        building.add(sourcePath);
        events.emit("builds");
        return { sourcePath };
      }),
      canToggleCompileOnSave: (sourcePath) => [...sources.values()].includes(sourcePath),
      isCompileOnSaveEnabled: (sourcePath) => observed.has(sourcePath),
      toggleCompileOnSave: jasmine
        .createSpy("toggle compile on save")
        .and.callFake((sourcePath) => {
          if (observed.has(sourcePath)) observed.delete(sourcePath);
          else observed.add(sourcePath);
          events.emit("builds");
          return true;
        }),
      isBuilding: (pdfPath) => building.has(sources.get(pdfPath)),
      onDidChangeBuilds: jasmine
        .createSpy("observe builds")
        .and.callFake((callback) => events.on("builds", callback)),
      onDidChangeSources: (callback) => events.on("sources", callback),
      changed(pdfPath) {
        events.emit("sources", pdfPath ? { pdfPath } : undefined);
      },
      finish(sourcePath) {
        building.delete(sourcePath);
        events.emit("builds");
      },
    };
  }
  function register(payload) {
    const edge = main.consumePdfBuildProvider(payload);
    subscriptions.add(edge);
    return edge;
  }
  function createViewer(filePath, state = {}) {
    const viewer = main.createViewer(filePath, "", state);
    observations.add(viewer.fileObservation);
    return viewer;
  }
  async function open(filePath) {
    const viewer = createViewer(filePath);
    viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
    await lumine.workspace.open(viewer);
    await viewer.whenReady();
    await window.conditionPromise(
      () => viewer.pagesElement.querySelector(".page"),
      "a PDF page",
      15000,
    );
    await main.updateBuildSource(viewer);
    return viewer;
  }
  it("routes F12 and Alt-F12 to the inactive PDF's source without opening Tasks", async () => {
    const firstPath = pdf("first.pdf"),
      secondPath = pdf("second.pdf");
    const firstSource = source("first.tex"),
      secondSource = source("second.typ");
    const latex = provider("latex", [[firstPath, firstSource]]),
      typst = provider("typst", [[secondPath, secondSource]]);
    register(latex);
    register(typst);
    const first = await open(firstPath),
      second = await open(secondPath);
    const editor = await lumine.workspace.open(secondSource);
    editor.getElement().focus();
    const action = spyOn(main, "compileSource").and.callThrough();
    const observe = spyOn(main, "toggleCompileOnSave").and.callThrough();
    for (const [viewer, selected, other, expected] of [
      [first, latex, typst, firstSource],
      [second, typst, latex, secondSource],
    ]) {
      selected.resolveSource.calls.reset();
      other.resolveSource.calls.reset();
      selected.toggleCompileOnSave.calls.reset();
      other.toggleCompileOnSave.calls.reset();
      const target = viewer.pagesElement.querySelector(".page");
      lumine.keymaps.handleKeyboardEvent(
        lumine.keymaps.constructor.buildKeydownEvent("f12", { target }),
      );
      await action.calls.mostRecent().returnValue;
      expect(selected.build).toHaveBeenCalledOnceWith(expected);
      expect(selected.resolveSource).toHaveBeenCalled();
      expect(other.resolveSource).toHaveBeenCalled();
      expect(lumine.commands.canDispatch(target, "pdf-view:compile")).toBeFalse();
      const resolves = selected.resolveSource.calls.count();
      selected.finish(expected);
      expect(lumine.commands.canDispatch(target, "pdf-view:compile")).toBeTrue();
      expect(selected.resolveSource.calls.count()).toBe(resolves);
      for (const enabled of [true, false]) {
        lumine.keymaps.handleKeyboardEvent(
          lumine.keymaps.constructor.buildKeydownEvent("alt-f12", { target }),
        );
        await observe.calls.mostRecent().returnValue;
        expect(selected.toggleCompileOnSave).toHaveBeenCalledWith(expected);
        expect(
          lumine.commands.getCommandState("pdf-view:toggle-compile-on-save", { target }).checked,
        ).toBe(enabled);
        expect(other.toggleCompileOnSave).not.toHaveBeenCalled();
      }
      expect(lumine.commands.canDispatch(target, "pdf-view:build")).toBeFalse();
    }
    expect(lumine.workspace.getBottomDock().isVisible()).toBeFalse();
    expect(editor.getElement().contains(document.activeElement)).toBeTrue();
    expect(main.consumeTasks).toBeUndefined();
  });
  it("keeps availability pure and accepts provider-owned source discovery without rendered pages or history", async () => {
    const output = pdf(),
      sourcePath = source("unrelated-name.tex");
    const payload = provider("compiler", [[output, sourcePath]]);
    register(payload);
    const viewer = createViewer(output);
    await main.updateBuildSource(viewer);
    const resolves = payload.resolveSource.calls.count();
    expect(viewer.pdfDocument).toBeFalsy();
    for (let index = 0; index < 3; index++) {
      expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeTrue();
      expect(
        lumine.commands.canDispatch(viewer.viewport, "pdf-view:toggle-compile-on-save"),
      ).toBeTrue();
      expect(
        lumine.commands.getCommandState("pdf-view:toggle-compile-on-save", {
          target: viewer.viewport,
        }).checked,
      ).toBeFalse();
      expect(viewer.getBuildTarget()).toEqual({ providerId: payload.id, filePath: sourcePath });
    }
    expect(payload.resolveSource.calls.count()).toBe(resolves);
    expect(payload.build).not.toHaveBeenCalled();
    expect(payload.toggleCompileOnSave).not.toHaveBeenCalled();
    const refresh = spyOn(viewer, "scheduleRefresh");
    payload.changed(output);
    await main.updateBuildSource(viewer);
    expect(refresh).not.toHaveBeenCalled();
  });
  it("passes saved hints only to their matching provider and carries validated metadata through copy and restore", async () => {
    const output = pdf(),
      sourcePath = source("source.tex"),
      hint = { providerId: "latex", filePath: sourcePath };
    const viewer = createViewer(output, { buildTarget: hint });
    const other = provider("typst");
    register(other);
    await main.updateBuildSource(viewer);
    expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeFalse();
    expect(other.resolveSource.calls.mostRecent().args[1].sourcePath).toBeUndefined();
    const payload = provider("latex", [[output, sourcePath]]);
    register(payload);
    await main.updateBuildSource(viewer);
    expect(payload.resolveSource.calls.mostRecent().args[1].sourcePath).toBe(sourcePath);
    const copy = viewer.copy(),
      restored = main.deserialize(viewer.serialize());
    observations.add(copy.fileObservation);
    observations.add(restored.fileObservation);
    for (const item of [copy, restored]) {
      await main.updateBuildSource(item);
      expect(item.getBuildTarget()).toEqual(hint);
      expect(lumine.commands.canDispatch(item.viewport, "pdf-view:compile")).toBeTrue();
    }
    expect(payload.build).not.toHaveBeenCalled();
  });
  it("rejects ambiguous ownership and shares subscriptions across identical provider payload leases", async () => {
    const output = pdf(),
      first = provider("first", [[output, source("first.tex")]]),
      second = provider("second", [[output, source("second.typ")]]);
    const a = register(first),
      b = register(second),
      again = register(first),
      viewer = createViewer(output);
    await main.updateBuildSource(viewer);
    expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeFalse();
    expect(await main.compileSource(viewer)).toBeNull();
    expect(
      lumine.commands.canDispatch(viewer.viewport, "pdf-view:toggle-compile-on-save"),
    ).toBeFalse();
    expect(await main.toggleCompileOnSave(viewer)).toBeNull();
    expect(first.build).not.toHaveBeenCalled();
    expect(second.build).not.toHaveBeenCalled();
    expect(first.onDidChangeBuilds).toHaveBeenCalledTimes(1);
    again.dispose();
    b.dispose();
    await main.updateBuildSource(viewer);
    expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeTrue();
    a.dispose();
    await main.updateBuildSource(viewer);
    expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeFalse();
  });
  it("cancels an F12 query on a PDF path change and discards its late reply", async () => {
    const output = pdf(),
      other = pdf("other.pdf"),
      firstSource = source("first.tex"),
      otherSource = source("other.tex");
    const payload = provider("latex", [
      [output, firstSource],
      [other, otherSource],
    ]);
    register(payload);
    const viewer = createViewer(output);
    await main.updateBuildSource(viewer);
    const requests = [];
    payload.resolveSource.and.callFake(
      (pdfPath, options) =>
        new Promise((release) => {
          gates.push(release);
          requests.push({ pdfPath, signal: options.signal, release });
        }),
    );
    const pending = main.compileSource(viewer),
      old = requests[0];
    viewer.setPath(other);
    expect(old.signal.aborted).toBeTrue();
    old.release(firstSource);
    expect(await pending).toBeNull();
    requests.at(-1).release(otherSource);
    await window.conditionPromise(
      () => main.getBuildBinding(viewer)?.target.filePath === otherSource,
      "the replacement PDF's source",
    );
    expect(payload.build).not.toHaveBeenCalled();
  });
  it("cancels pending ownership on provider withdrawal and ignores stale source events", async () => {
    const output = pdf(),
      sourcePath = source("source.tex"),
      payload = provider("latex", [[output, sourcePath]]);
    const edge = register(payload),
      viewer = createViewer(output);
    await main.updateBuildSource(viewer);
    let release;
    payload.resolveSource.and.callFake(
      () =>
        new Promise((resolve) => {
          release = resolve;
          gates.push(resolve);
        }),
    );
    const pending = main.compileSource(viewer);
    edge.dispose();
    expect(await pending).toBeNull();
    release(sourcePath);
    payload.changed(output);
    await main.updateBuildSource(viewer);
    expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeFalse();
    expect(payload.build).not.toHaveBeenCalled();
  });

  it("rechecks ownership after actual PDF file changes while automatic refresh is disabled", async () => {
    const output = pdf(),
      sourcePath = source("source.tex");
    const payload = provider("latex", [[output, sourcePath]]);
    register(payload);
    const viewer = await open(output);
    await viewer.fileObservation.ready;
    payload.resolveSource.calls.reset();
    fs.writeFileSync(output, createPdf({ prefix: "changed" }));
    await window.conditionPromise(
      () => payload.resolveSource.calls.count() > 0,
      "a file change to recheck PDF ownership",
    );
    await main.updateBuildSource(viewer);
    expect(lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile")).toBeTrue();
    expect(payload.build).not.toHaveBeenCalled();
  });

  it("routes F12 and Alt-F12 through the actual LaTeX and Typst service registrations", async () => {
    const output = pdf(),
      tex = source("document.tex"),
      typ = source("document.typ");
    fs.writeFileSync(tex, "\\documentclass{article}\n\\begin{document}Text\\end{document}\n");
    const activate = async (name) => (await lumine.packages.activatePackage(name)).mainModule;
    const backend = await activate("tasks");
    try {
      const latex = await activate("latex-tools");
      const typst = await activate("typst-tools");
      const run = spyOn(backend.manager, "run").and.returnValue({});
      const action = spyOn(main, "compileSource").and.callThrough();
      const observe = spyOn(main, "toggleCompileOnSave").and.callThrough();
      for (const [tools, sourcePath, providerId] of [
        [latex, tex, "latex-tools"],
        [typst, typ, "typst-tools"],
      ]) {
        const viewer =
          tools === latex
            ? await tools._openPdfDirect(output, {}, sourcePath)
            : await tools._openPdfDirect(output, sourcePath);
        observations.add(viewer.fileObservation);
        viewer.element.style.cssText = "position:absolute;width:1000px;height:800px;top:0;left:0";
        await viewer.whenReady();
        await main.updateBuildSource(viewer);
        await window.conditionPromise(
          () =>
            main.getBuildBinding(viewer)?.target.providerId === providerId &&
            lumine.commands.canDispatch(viewer.viewport, "pdf-view:compile"),
          "the compiler's registered PDF ownership",
        );
        run.calls.reset();
        lumine.keymaps.handleKeyboardEvent(
          lumine.keymaps.constructor.buildKeydownEvent("f12", {
            target: viewer.pagesElement.querySelector(".page") || viewer.viewport,
          }),
        );
        await action.calls.mostRecent().returnValue;
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.calls.mostRecent().args[0].providerId).toBe(providerId);
        expect(run.calls.mostRecent().args[0].filePath).toBe(sourcePath);
        for (const enabled of [true, false]) {
          const requests = observe.calls.count();
          lumine.keymaps.handleKeyboardEvent(
            lumine.keymaps.constructor.buildKeydownEvent("alt-f12", { target: viewer.viewport }),
          );
          expect(observe.calls.count()).toBe(requests + 1);
          await observe.calls.mostRecent().returnValue;
          expect(tools.isCompileOnSaveEnabledForFile(sourcePath)).toBe(enabled);
          expect(
            backend.manager.getObserved({ providerId }).map((entry) => entry.filePath),
          ).toEqual(enabled ? [sourcePath] : []);
          expect(
            lumine.commands.getCommandState("pdf-view:toggle-compile-on-save", {
              target: viewer.viewport,
            }).checked,
          ).toBe(enabled);
        }
        expect(run).toHaveBeenCalledTimes(1);
        expect(lumine.workspace.getBottomDock().isVisible()).toBeFalse();
      }
    } finally {
      await lumine.packages.deactivatePackage("latex-tools");
      await lumine.packages.deactivatePackage("typst-tools");
      await lumine.packages.deactivatePackage("tasks");
    }
  }, 20000);
});
