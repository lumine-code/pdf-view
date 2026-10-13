const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createPdf } = require("./helpers/pdf-fixture");

describe("pdf-view lifecycle", () => {
  let main, directory;

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = null;
    await lumine.packages.deactivatePackage("pdf-view");
    const pack = lumine.packages.loadPackage("pdf-view");
    pack.requireMainModule();
    main = pack.mainModule;
    main.deactivate();
  });

  afterEach(async () => {
    const observations = Array.from(main.viewers || [], (viewer) => viewer.file);
    main.deactivate();
    await Promise.all(observations.map((observation) => observation.closed));
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("restores a viewer without publishing the active scope", () => {
    const restored = { restored: true };
    spyOn(main, "createViewer").and.returnValue(restored);

    const result = main.deserialize({ filePath: __filename, hash: "#page=2" });

    expect(result).toBe(restored);
    expect(main.createViewer).toHaveBeenCalledWith(__filename, "#page=2", undefined);
    expect(main.active).toBeFalsy();
    expect(main.disposables).toBeNull();
  });

  it("opens a file URI with a named-destination fragment", async () => {
    const filePath = path.join(__dirname, "manual.pdf");
    const uri = pathToFileURL(filePath);
    uri.hash = "nameddest=MAT";
    const viewer = { viewer: true };
    spyOn(main, "createViewer").and.returnValue(viewer);
    main.activate();

    const result = await lumine.workspace.createItemForURI(uri.href);

    expect(result).toBe(viewer);
    expect(main.createViewer).toHaveBeenCalledWith(filePath, "#nameddest=MAT");
  });

  it("preserves a file URI fragment supplied with its normalized path", async () => {
    const filePath = path.join(__dirname, "manual.pdf");
    const viewer = { viewer: true };
    spyOn(main, "createViewer").and.returnValue(viewer);
    main.activate();

    expect(await lumine.workspace.createItemForURI(filePath, { uriFragment: "#page=3" })).toBe(
      viewer,
    );
    expect(main.createViewer).toHaveBeenCalledWith(filePath, "#page=3");
  });

  it("allows an explicit fragment to override a raw path destination", async () => {
    const filePath = path.join(__dirname, "manual.pdf");
    const viewer = { viewer: true };
    spyOn(main, "createViewer").and.returnValue(viewer);
    main.activate();

    expect(
      await lumine.workspace.createItemForURI(`${filePath}#page=2`, { uriFragment: "#page=3" }),
    ).toBe(viewer);
    expect(main.createViewer).toHaveBeenCalledWith(filePath, "#page=3");
  });

  it("reuses matching file URL destinations and keeps distinct destination viewers", async () => {
    directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-url-destination-")),
    );
    const filePath = path.join(directory, "document.pdf");
    fs.writeFileSync(filePath, createPdf({ pages: 3 }));
    const uri = pathToFileURL(filePath);
    main.activate();

    uri.hash = "page=2";
    const secondPage = await lumine.workspace.open(uri.href);
    expect(secondPage.getURI()).toBe(`${filePath}#page=2`);
    expect(await lumine.workspace.open(uri.href)).toBe(secondPage);

    uri.hash = "page=3";
    const thirdPage = await lumine.workspace.open(uri.href);
    expect(thirdPage).not.toBe(secondPage);
    expect(thirdPage.getURI()).toBe(`${filePath}#page=3`);
    expect(await lumine.workspace.open(`${filePath}#page=3`)).toBe(thirdPage);
    expect(await lumine.workspace.open(uri.href, { opener: "pdf-view" })).toBe(thirdPage);
  });

  it("keeps pane copies in the package lifecycle and services", async () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-copy-")));
    const filePath = path.join(directory, "document.pdf");
    fs.writeFileSync(filePath, createPdf({ pages: 2 }));
    main.initialize();
    const service = main.providePdfView();
    const observed = [];
    const observer = service.observeViewers((viewer) => observed.push(viewer));
    const scrollmap = {
      addViewer: jasmine.createSpy("addViewer"),
      removeViewer: jasmine.createSpy("removeViewer"),
      destroy: jasmine.createSpy("destroy"),
    };
    main.outlineScrollmap = scrollmap;
    main.latexTools = { latex: true };
    main.typstTools = { typst: true };
    const original = main.createViewer(filePath, "#page=2&build-output");

    const copy = original.copy();

    expect(copy).not.toBe(original);
    expect(copy.hash).toBe("#page=2");
    expect(service.getViewers().has(copy)).toBe(true);
    expect(observed).toEqual([original, copy]);
    expect(scrollmap.addViewer).toHaveBeenCalledWith(copy);
    expect(copy.getLatexTools()).toBe(main.latexTools);
    expect(copy.getTypstTools()).toBe(main.typstTools);
    expect(typeof copy.requestLatexTools).toBe("function");
    expect(typeof copy.requestTypstTools).toBe("function");

    const observation = copy.file;
    copy.destroy();
    await observation.closed;
    expect(service.getViewers().has(copy)).toBe(false);
    expect(scrollmap.removeViewer).toHaveBeenCalledWith(copy);
    observer.dispose();
  });
});
