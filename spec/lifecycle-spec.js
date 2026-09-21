const main = require("../lib/main");
const path = require("path");
const { pathToFileURL } = require("url");

describe("pdf-view lifecycle", () => {
  beforeEach(async () => {
    await lumine.packages.deactivatePackage("pdf-view");
    main.deactivate();
  });

  afterEach(() => main.deactivate());

  it("restores a viewer without publishing the active scope", () => {
    const restored = { restored: true };
    spyOn(main, "createViewer").and.returnValue(restored);

    const result = main.deserialize({ filePath: __filename, hash: "#page=2" });

    expect(result).toBe(restored);
    expect(main.createViewer).toHaveBeenCalledWith(__filename, "#page=2");
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
});
