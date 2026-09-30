const path = require("path");

describe("pdf-view service", () => {
  let main, service;

  beforeEach(async () => {
    await lumine.packages.deactivatePackage("pdf-view");
    const pack = lumine.packages.loadPackage("pdf-view");
    pack.requireMainModule();
    main = pack.mainModule;
    main.initialize();
    service = main.providePdfView();
  });

  afterEach(() => main.deactivate());

  it("opens named destinations containing hash parameter characters", async () => {
    const filePath = path.join(__dirname, "manual.pdf");
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});

    for (const dest of ["A&B", "C++", "50% complete", "chapter=#2", "Rozdział pierwszy"]) {
      await service.open(filePath, { dest, tag: "build-output" });

      const [uri, options] = open.calls.mostRecent().args;
      const hash = uri.slice(filePath.length);
      expect(new URLSearchParams(hash.slice(1)).get("nameddest")).toBe(dest);
      expect(hash.endsWith("&build-output")).toBe(true);
      expect(options).toEqual({ split: "right", activatePane: false, searchAllPanes: true });
    }
  });

  it("encodes named destinations when retargeting an existing viewer", () => {
    const filePath = path.join(__dirname, "retargeted.pdf");
    const viewer = {
      setFile: jasmine.createSpy("setFile"),
      reload: jasmine.createSpy("reload"),
    };
    const dest = "A&B C++";

    service.setFile(viewer, filePath, dest, "build-output");

    const [actualPath, hash] = viewer.setFile.calls.mostRecent().args;
    expect(actualPath).toBe(filePath);
    expect(new URLSearchParams(hash.slice(1)).get("nameddest")).toBe(dest);
    expect(hash.endsWith("&build-output")).toBe(true);
    expect(viewer.reload).toHaveBeenCalledTimes(1);
  });

  it("preserves untagged and tag-only viewer identities", async () => {
    const filePath = path.join(__dirname, "manual.pdf");
    const open = spyOn(lumine.workspace, "open").and.resolveTo({});

    await service.open(filePath);
    expect(open.calls.mostRecent().args[0]).toBe(filePath);
    await service.open(filePath, { tag: "build-output", split: "left", activatePane: true });
    expect(open.calls.mostRecent().args).toEqual([
      `${filePath}#build-output`,
      { split: "left", activatePane: true, searchAllPanes: true },
    ]);
  });
});
