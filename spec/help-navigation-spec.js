const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF help navigation integration", () => {
  let main,
    directory,
    source,
    sourceElement,
    sourcePane,
    service,
    viewer,
    observations,
    textRenders;
  let viewerSubscription, workspaceOpen, openWorkspace, workspaceStyle;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-help-navigation-"));
    observations = new Set();
    textRenders = new Map();
    main = (await lumine.packages.activatePackage("pdf-view")).mainModule;
    lumine.config.set("pdf-view.autoRefresh", false);
    jasmine.attachToDOM(lumine.workspace.getElement());
    workspaceStyle = lumine.workspace.getElement().style.cssText;
    lumine.workspace.getElement().style.cssText = "width:1400px;height:850px";
    const sourcePath = path.join(directory, "source.dat");
    fs.writeFileSync(sourcePath, "+PROG AQUA\nHEAD Manual navigation\nEND\n");
    source = await lumine.workspace.open(sourcePath);
    sourceElement = lumine.views.getView(source);
    sourcePane = lumine.workspace.paneForItem(source);
    sourceElement.focus();
    service = main.providePdfView();
    viewerSubscription = main.observeViewers((item) => {
      viewer = item;
      observations.add(item.fileObservation);
      item.element.style.cssText = "position:absolute;width:600px;height:650px;top:0;left:0";
      let observedBus;
      const observeRuntime = () => {
        if (item.eventBus === observedBus) return;
        observedBus = item.eventBus;
        observedBus.on("textlayerrendered", ({ source: pageView }) => {
          textRenders.set(pageView, (textRenders.get(pageView) || 0) + 1);
        });
      };
      if (item.eventBus) observeRuntime();
      else {
        // A fresh viewer yields before initializing its runtime. Subscribe
        // immediately after that initialization, before the first PDF opens.
        const initializeRuntime = item.initializeRuntime.bind(item);
        spyOn(item, "initializeRuntime").and.callFake(() => {
          initializeRuntime();
          observeRuntime();
        });
      }
    });
    spyOn(service, "open").and.callThrough();
    openWorkspace = lumine.workspace.open.bind(lumine.workspace);
    workspaceOpen = spyOn(lumine.workspace, "open").and.callThrough();
  });

  afterEach(async () => {
    viewerSubscription?.dispose();
    if (viewer?.fileObservation) observations.add(viewer.fileObservation);
    await lumine.packages.deactivatePackage("pdf-view");
    await Promise.all([...observations].map((observation) => observation.closed));
    source?.destroy();
    lumine.workspace.getElement().style.cssText = workspaceStyle;
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("Unsafe PDF help fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    viewer = null;
  });

  function manual(name) {
    const file = path.join(directory, `${name}.pdf`);
    fs.writeFileSync(
      file,
      createPdf({
        pages: 3,
        outline: [
          { title: "First command", page: 0, dest: "first", mode: "FitH", top: 700 },
          {
            title: "Current command",
            page: 2,
            dest: "command",
            mode: "XYZ",
            coordinates: "10 650 2.5",
          },
        ],
      }),
    );
    return file;
  }

  async function help(file, destination) {
    // Explicit test orchestration selects the actual SOFiSTiK consumer without
    // activating the package or requiring an installed SOFiSTiK environment.
    const { getViewer } = require(
      path.join(lumine.packages.resolvePackagePath("sofistik-tools"), "lib", "manual-navigation"),
    );
    viewer = await getViewer.call({ pdfViewService: service }, file, destination, true);
    expect(viewer).not.toBeNull();
    return viewer;
  }

  async function frames() {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  async function rendered(pageNumber = viewer.getCurrentPage(), afterTextRender = 0) {
    await conditionPromise(
      () => {
        const page = viewer.pdfViewer.getPageView(pageNumber - 1);
        return (
          viewer.getCurrentPage() === pageNumber &&
          page?.renderingState === 3 &&
          page.canvas &&
          (textRenders.get(page) || 0) > afterTextRender
        );
      },
      "help PDF canvas and late text layer",
      15000,
    );
    await frames();
  }

  function expectSourceFocus() {
    expect(lumine.workspace.getActivePane()).toBe(sourcePane);
    expect(sourceElement.contains(document.activeElement)).toBe(true);
  }

  function expectPageTop(pageNumber) {
    const page = viewer.pdfViewer.getPageView(pageNumber - 1).div.getBoundingClientRect();
    const viewport = viewer.viewport.getBoundingClientRect();
    expect(Math.abs(page.top - viewport.top)).toBeLessThan(1.1);
  }

  async function helpPicker(file) {
    const launcher = (await lumine.packages.activatePackage("launcher")).mainModule;
    const HelpList = require(
      path.join(lumine.packages.resolvePackagePath("sofistik-tools"), "lib", "help-list"),
    );
    const list = new HelpList({
      isActive: () => true,
      pdfViewService: service,
      launcherService: launcher.provideLauncher(),
    });
    return list.performAction({ filePath: file }, "choose-opener", "command");
  }

  function pickerManual() {
    const file = path.join(directory, "picker-help.pdf");
    fs.writeFileSync(
      file,
      createPdf({
        pages: 3,
        outline: [
          { title: "First command", page: 0, dest: "FIRST" },
          {
            title: "Current command",
            page: 2,
            dest: "COMMAND",
            mode: "XYZ",
            coordinates: "10 650 2.5",
          },
        ],
      }),
    );
    return file;
  }

  it("opens the PDF choice from the real help picker through the service at the destination's page top", async () => {
    const file = pickerManual();
    await help(file, "FIRST");
    await viewer.setScale(1.25);
    await rendered(1);
    const original = viewer;
    const pdf = viewer.pdfDocument;
    const host = await helpPicker(file);
    try {
      const list = host.getModel();
      await list.selectItemById(service.openerId);
      const opensBefore = service.open.calls.count();
      const workspaceBefore = workspaceOpen.calls.count();
      expect(list.getAvailableActions().map(({ command }) => command)).not.toContain(
        "launcher:open-new-window",
      );

      expect((await list.runAction("launcher:open-current")).status).toBe("success");
      expect(service.open.calls.count()).toBe(opensBefore + 1);
      const [openedPath, options] = service.open.calls.mostRecent().args;
      expect(openedPath).toBe(file);
      expect(options.dest).toBe("COMMAND");
      expect(options.destinationMode).toBe("page");
      expect(options.activatePane).toBe(true);
      expect(options.pane).toBe(sourcePane);
      expect(
        workspaceOpen.calls
          .allArgs()
          .slice(workspaceBefore)
          .every(([item]) => item === original),
      ).toBe(true);
      expect(viewer).toBe(original);
      expect(viewer.pdfDocument).toBe(pdf);
      await rendered(3);
      expectPageTop(3);
      expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.25, 5);
      expect(lumine.workspace.getActivePane()).toBe(lumine.workspace.paneForItem(viewer));
    } finally {
      await host.destroy();
      await lumine.packages.deactivatePackage("launcher");
    }
  }, 30000);

  it("keeps the help picker's text-editor choice on the ordinary opener path", async () => {
    const file = pickerManual();
    const host = await helpPicker(file);
    try {
      const list = host.getModel();
      await list.selectItemById("text-editor");
      const opensBefore = service.open.calls.count();
      expect(list.getAvailableActions().map(({ command }) => command)).toContain(
        "launcher:open-new-window",
      );
      expect((await list.runAction("launcher:open-current")).status).toBe("success");
      expect(service.open.calls.count()).toBe(opensBefore);
      const [openedPath, options] = workspaceOpen.calls.mostRecent().args;
      expect(openedPath).toBe(file);
      expect(options.opener).toBe("text-editor");
      expect(options.uriFragment).toBe("nameddest=COMMAND");
      expect(sourcePane.getActiveItem().getPath()).toBe(file);
    } finally {
      await host.destroy();
      for (const editor of lumine.workspace.getTextEditors()) {
        if (editor.getPath() === file) editor.destroy();
      }
      await lumine.packages.deactivatePackage("launcher");
    }
  }, 30000);

  for (const scale of ["page-width", 1.25]) {
    it(`keeps source focus and ${scale} when a reused help viewer changes manuals`, async () => {
      const first = manual("aqua");
      const second = manual("ase");
      await help(first, "first");
      await rendered(1);
      expectSourceFocus();
      expect(lumine.workspace.paneForItem(viewer)).not.toBe(sourcePane);
      await viewer.setScale(scale);
      const original = viewer;
      const previousDocument = viewer.pdfDocument;
      await help(second, "command");
      await rendered(3);
      expectPageTop(3);
      expect(viewer).toBe(original);
      expect(viewer.pdfDocument).not.toBe(previousDocument);
      expect(viewer.getPath()).toBe(second);
      expect(viewer.getViewState().scaleValue).toBe(String(scale));
      expect(viewer.getViewState().zoomMode).toBeNull();
      if (typeof scale === "number") expect(viewer.pdfViewer.currentScale).toBeCloseTo(scale, 5);
      expectSourceFocus();
      const [openedPath, options] = service.open.calls.mostRecent().args;
      expect(openedPath).toBe(second);
      expect(options.dest).toBe("command");
      expect(options.tag).toBe("SOFiSTiK");
      expect(options.destinationMode).toBe("page");
    }, 30000);
  }

  it("repeats the current help address without replacing its rendered canvas or stealing focus", async () => {
    const file = manual("current-help");
    await help(file, "command");
    await rendered(3);
    expectPageTop(3);
    await viewer.setScale(1.25);
    await rendered(3);
    const pdf = viewer.pdfDocument;
    const page = viewer.pdfViewer.getPageView(2);
    const canvas = page.canvas;
    const renderCount = textRenders.get(page);
    const draw = spyOn(page, "draw").and.callThrough();
    const clear = spyOn(viewer.pdfViewer, "setDocument").and.callThrough();
    for (let index = 0; index < 3; index++) {
      await help(file, "command");
      await frames();
      expect(viewer.pdfDocument).toBe(pdf);
      expect(page.canvas).toBe(canvas);
      expect(page.renderingState).toBe(3);
      expect(viewer.pdfViewer.currentScale).toBeCloseTo(1.25, 5);
      expectPageTop(3);
      expectSourceFocus();
    }
    expect(clear).not.toHaveBeenCalled();
    expect(textRenders.get(page)).toBe(renderCount);
    expect(draw).not.toHaveBeenCalled();
    // PDF.js can leave a one-shot text-layer focus listener after navigating
    // to an already rendered page. Force a later real layer render to catch it.
    await viewer.setScale(1.5);
    await rendered(3, renderCount);
    expectSourceFocus();
  }, 30000);

  it("keeps an identical open request rendered and resolves its live tab icon from the path", async () => {
    const first = manual("first-manual");
    const second = manual("second-manual");
    await help(first, "command");
    await rendered(3);
    const icon = document.createElement("span");
    viewer.element.append(icon);
    const binding = lumine.icons.applyTo(icon, { item: viewer });
    try {
      expect(icon.dataset.name).toBe("first-manual.pdf");
      expect(icon.dataset.path).toBe(first);
      const pdf = viewer.pdfDocument;
      const page = viewer.pdfViewer.getPageView(2);
      const canvas = page.canvas;
      const clear = spyOn(viewer.pdfViewer, "setDocument").and.callThrough();
      expect(
        await service.open(first, {
          tag: "SOFiSTiK",
          dest: "command",
          destinationMode: "page",
        }),
      ).toBe(viewer);
      await frames();
      expect(viewer.pdfDocument).toBe(pdf);
      expect(page.canvas).toBe(canvas);
      expect(page.renderingState).toBe(3);
      expect(clear).not.toHaveBeenCalled();
      expectSourceFocus();
      await help(second, "command");
      await rendered(3);
      expect(icon.dataset.name).toBe("second-manual.pdf");
      expect(icon.dataset.path).toBe(second);
      expectSourceFocus();
    } finally {
      binding.dispose();
      icon.remove();
    }
  }, 30000);

  it("ignores an obsolete destination failure after replacing its manual", async () => {
    await help(manual("old-help"), "first");
    await rendered(1);
    let rejectDestination;
    const delayed = new Promise((_resolve, reject) => {
      rejectDestination = reject;
    });
    const prototype = Object.getPrototypeOf(viewer.pdfDocument);
    const original = prototype.getDestination;
    spyOn(prototype, "getDestination").and.callFake(function (name) {
      return name === "delayed" ? delayed : original.call(this, name);
    });
    const pending = service.open(viewer.getPath(), {
      tag: "SOFiSTiK",
      dest: "delayed",
      destinationMode: "page",
    });
    await conditionPromise(
      () => prototype.getDestination.calls.allArgs().some(([name]) => name === "delayed"),
      "obsolete help destination lookup",
      5000,
    );
    const next = manual("new-help");
    await help(next, "command");
    rejectDestination(new Error("Obsolete PDF worker"));
    expect(await pending).toBeNull();
    await rendered(3);
    expect(viewer.getPath()).toBe(next);
    expectSourceFocus();
  }, 30000);

  it("coalesces concurrent opens with the same tag and follows the latest destination", async () => {
    const oldFile = manual("parallel-old-help");
    const file = manual("parallel-help");
    const options = { tag: "SOFiSTiK", destinationMode: "page" };
    const first = service.open(oldFile, { ...options, dest: "first" });
    const second = service.open(file, { ...options, dest: "command" });
    const [obsolete, current] = await Promise.all([first, second]);
    expect(obsolete).toBeNull();
    expect(current).not.toBeNull();
    viewer = current;
    await rendered(3);
    expectPageTop(3);
    expect(viewer.getPath()).toBe(file);
    expect([...main.viewers]).toEqual([current]);
    expectSourceFocus();
  }, 30000);

  it("keeps the newest same-file request after an older destination resolves", async () => {
    const file = manual("overlapping-help");
    await help(file, "first");
    await rendered(1);
    const pdf = viewer.pdfDocument;
    const prototype = Object.getPrototypeOf(pdf);
    const original = prototype.getDestination;
    let releaseDestination;
    const delayed = new Promise((resolve) => {
      releaseDestination = resolve;
    });
    const lookup = spyOn(prototype, "getDestination").and.callFake(function (name) {
      return name === "delayed" ? delayed : original.call(this, name);
    });
    const pending = service.open(file, {
      tag: "SOFiSTiK",
      dest: "delayed",
      destinationMode: "page",
    });
    await conditionPromise(
      () => lookup.calls.allArgs().some(([name]) => name === "delayed"),
      "delayed same-file help destination",
      5000,
    );
    await help(file, "command");
    releaseDestination(await original.call(pdf, "first"));
    expect(await pending).toBeNull();
    await rendered(3);
    expectPageTop(3);
    expect(viewer.pdfDocument).toBe(pdf);
    expectSourceFocus();
  }, 30000);

  it("opens separate viewers when reuse is disabled for the same tag", async () => {
    const file = manual("separate-help");
    const first = await service.open(file, { tag: "SOFiSTiK", reuse: false });
    const second = await service.open(file, { tag: "SOFiSTiK", reuse: false });
    expect(second).not.toBe(first);
    expect([...main.viewers]).toEqual([first, second]);
    expect(lumine.workspace.paneForItem(first)).not.toBeNull();
    expect(lumine.workspace.paneForItem(second)).not.toBeNull();
    expectSourceFocus();
  }, 30000);

  it("reuses a file without a tag and activates its pane only when requested", async () => {
    const file = manual("file-reuse-help");
    await help(file, "first");
    const original = viewer;
    await rendered(1);
    viewer = await service.open(file, {
      dest: "command",
      destinationMode: "page",
      activatePane: true,
    });
    expect(viewer).toBe(original);
    expect([...main.viewers]).toEqual([original]);
    expect(lumine.workspace.getActivePane()).toBe(lumine.workspace.paneForItem(original));
    expect(sourceElement.contains(document.activeElement)).toBe(false);
    await rendered(3);
    expectPageTop(3);
  }, 30000);

  it("restores a reusable tag from session state and leaves split copies independent", async () => {
    const file = manual("restored-help");
    await help(file, "first");
    await rendered(1);
    const original = viewer;
    const state = original.serialize();
    expect(state.tag).toBe("SOFiSTiK");
    expect(original.getURI()).toBe(file);
    await original.destroy();
    const restored = main.deserialize(state);
    await lumine.workspace.open(restored, { split: "right", activatePane: false });
    await restored.whenReady();
    const { item: copy } = await lumine.workspace.copyPaneItem(restored, {
      splitDirection: "right",
      activatePane: false,
    });
    await copy.whenReady();
    expect(copy.serialize().tag).toBeNull();
    expect(copy).not.toBe(restored);
    viewer = await service.open(file, {
      tag: "SOFiSTiK",
      dest: "command",
      destinationMode: "page",
    });
    expect(viewer).toBe(restored);
    expect(restored.getURI()).toBe(file);
    await rendered(3);
    expectPageTop(3);
    expectSourceFocus();
  }, 30000);

  it("preserves the current scroll position when a reused request has no destination", async () => {
    const file = manual("positioned-help");
    await help(file, "command");
    await rendered(3);
    viewer.viewport.scrollTop -= 150;
    await frames();
    const position = viewer.viewport.scrollTop;
    const pdf = viewer.pdfDocument;
    const canvas = viewer.pdfViewer.getPageView(2).canvas;
    expect(await service.open(file, { tag: "SOFiSTiK", dest: "" })).toBe(viewer);
    await frames();
    expect(viewer.viewport.scrollTop).toBeCloseTo(position, 1);
    expect(viewer.pdfDocument).toBe(pdf);
    expect(viewer.pdfViewer.getPageView(2).canvas).toBe(canvas);
    expectSourceFocus();
  }, 30000);

  it("removes a newly opened viewer when its request is aborted before presentation", async () => {
    let releaseOpen;
    const delayed = new Promise((resolve) => {
      releaseOpen = resolve;
    });
    workspaceOpen.and.callFake(async (item, options) => {
      await delayed;
      return openWorkspace(item, options);
    });
    const controller = new AbortController();
    const operation = service.open(manual("aborted-help"), {
      tag: "SOFiSTiK",
      signal: controller.signal,
    });
    const result = operation.catch((error) => error);
    await conditionPromise(() => Boolean(viewer), "aborted help viewer creation", 5000);
    const canceledViewer = viewer;
    controller.abort();
    releaseOpen();
    expect((await result).name).toBe("AbortError");
    await frames();
    expect(canceledViewer.destroyed).toBe(true);
    expect(main.viewers.has(canceledViewer)).toBe(false);
    expect(lumine.workspace.getPaneItems()).not.toContain(canceledViewer);
    expectSourceFocus();
  }, 30000);

  it("finishes a refused workspace open without waiting for an unattached PDF to become ready", async () => {
    workspaceOpen.and.resolveTo(undefined);
    let outcome;
    service.open(manual("refused-help"), { tag: "SOFiSTiK" }).then(
      (value) => (outcome = { value }),
      (error) => (outcome = { error }),
    );
    const refused = viewer;
    expect(refused.element.isConnected).toBe(false);
    expect(refused.hasLayout()).toBe(false);
    await conditionPromise(() => Boolean(outcome), "refused PDF request cleanup", 5000);
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBeNull();
    expect(refused.destroyed).toBe(true);
    expect(main.viewers.size).toBe(0);
    expect(lumine.workspace.getPaneItems()).not.toContain(refused);
    expectSourceFocus();
  }, 10000);

  it("opens a live replacement when a tagged request follows an abort before its cleanup", async () => {
    let releaseOpen;
    const delayed = new Promise((resolve) => {
      releaseOpen = resolve;
    });
    let firstPlacement = true;
    workspaceOpen.and.callFake(async (item, options) => {
      if (firstPlacement) {
        firstPlacement = false;
        await delayed;
      }
      return openWorkspace(item, options);
    });
    const file = manual("replacement-help");
    const controller = new AbortController();
    const first = service.open(file, { tag: "SOFiSTiK", signal: controller.signal });
    const canceled = viewer;
    controller.abort();
    const second = service.open(file, {
      tag: "SOFiSTiK",
      dest: "command",
      destinationMode: "page",
    });
    let outcomes;
    Promise.allSettled([first, second]).then((results) => (outcomes = results));
    releaseOpen();
    await conditionPromise(() => Boolean(outcomes), "replacement PDF request cleanup", 5000);
    expect(outcomes[0].status).toBe("rejected");
    expect(outcomes[0].reason.name).toBe("AbortError");
    expect(outcomes[1].status).toBe("fulfilled");
    viewer = outcomes[1].value;
    expect(viewer).not.toBeNull();
    expect(viewer.destroyed).toBe(false);
    expect([...main.viewers]).toEqual([viewer]);
    expect(
      lumine.workspace.getPaneItems().filter((item) => item === canceled || item === viewer),
    ).toEqual([viewer]);
    await rendered(3);
    expectPageTop(3);
    expectSourceFocus();
  }, 15000);

  it("keeps an existing viewer in place when aborted navigation resolves late", async () => {
    const file = manual("aborted-navigation");
    await help(file, "first");
    await rendered(1);
    const pdf = viewer.pdfDocument;
    const prototype = Object.getPrototypeOf(pdf);
    const original = prototype.getDestination;
    let releaseDestination;
    const delayed = new Promise((resolve) => {
      releaseDestination = resolve;
    });
    const lookup = spyOn(prototype, "getDestination").and.callFake(function (name) {
      return name === "delayed" ? delayed : original.call(this, name);
    });
    const controller = new AbortController();
    const operation = service.open(file, {
      tag: "SOFiSTiK",
      dest: "delayed",
      destinationMode: "page",
      signal: controller.signal,
    });
    const result = operation.catch((error) => error);
    await conditionPromise(
      () => lookup.calls.allArgs().some(([name]) => name === "delayed"),
      "abortable help destination lookup",
      5000,
    );
    controller.abort();
    expect((await result).name).toBe("AbortError");
    releaseDestination(await original.call(pdf, "command"));
    await frames();
    expect(viewer.destroyed).toBe(false);
    expect(main.viewers.has(viewer)).toBe(true);
    expect(lumine.workspace.paneForItem(viewer)).not.toBeNull();
    expect(viewer.getCurrentPage()).toBe(1);
    expectPageTop(1);
    expectSourceFocus();
  }, 30000);
});
