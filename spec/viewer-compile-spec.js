const fs = require("fs");
const os = require("os");
const path = require("path");
const Viewer = require("../lib/viewer");

describe("PDF source compilation", () => {
  let directory, pdfPath, viewer;

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-compile-")));
    pdfPath = path.join(directory, "document.pdf");
    fs.writeFileSync(pdfPath, "%PDF-1.7\n%%EOF\n");
    viewer = Object.create(Viewer.prototype);
    viewer.file = { getPath: () => pdfPath };
    viewer.debug = false;
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("waits for a conflicted Typst editor to save before compiling", async () => {
    const sourcePath = path.join(directory, "document.typ");
    fs.writeFileSync(sourcePath, "content");
    let finishSave;
    const editor = {
      getPath: () => sourcePath,
      getFileState: () => lumine.FileState.CONFLICTED,
      save: jasmine
        .createSpy("save")
        .and.callFake(() => new Promise((resolve) => (finishSave = resolve))),
    };
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);
    const typstTools = { compile: jasmine.createSpy("compile") };
    viewer.getTypstTools = () => typstTools;

    const compiling = viewer.compile();
    expect(editor.save).toHaveBeenCalled();
    expect(typstTools.compile).not.toHaveBeenCalled();

    finishSave();
    await compiling;
    expect(typstTools.compile).toHaveBeenCalledWith(sourcePath);
  });

  it("compiles an existing Typst source without an open editor", async () => {
    const sourcePath = path.join(directory, "document.typ");
    fs.writeFileSync(sourcePath, "content");
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([]);
    const typstTools = { compile: jasmine.createSpy("compile") };
    viewer.getTypstTools = () => typstTools;

    await viewer.compile();

    expect(typstTools.compile).toHaveBeenCalledWith(sourcePath);
  });

  it("waits for a removed LaTeX editor to save before compiling", async () => {
    const sourcePath = path.join(directory, "document.tex");
    let finishSave;
    const editor = {
      getPath: () => sourcePath,
      getFileState: () => lumine.FileState.REMOVED,
      save: jasmine.createSpy("save").and.callFake(
        () =>
          new Promise((resolve) => {
            finishSave = () => {
              fs.writeFileSync(sourcePath, "content");
              resolve();
            };
          }),
      ),
    };
    spyOn(lumine.workspace, "getTextEditors").and.returnValue([editor]);
    const latexTools = { compile: jasmine.createSpy("compile") };
    viewer.getLatexTools = () => latexTools;

    const compiling = viewer.compile();
    expect(editor.save).toHaveBeenCalled();
    expect(latexTools.compile).not.toHaveBeenCalled();

    finishSave();
    await compiling;
    expect(latexTools.compile).toHaveBeenCalledWith(sourcePath);
  });
});
