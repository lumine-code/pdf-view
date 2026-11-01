const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPdf } = require("./helpers/pdf-fixture");

describe("PDF disk range cancellation", () => {
  let directory, document, releaseRange;

  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("pdf-view");
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-worker-range-"));
  });

  afterEach(async () => {
    releaseRange?.();
    await document?.destroy();
    await lumine.packages.deactivatePackage("pdf-view");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("terminates the worker while a page is waiting for an unfinished disk range", async () => {
    const file = path.join(directory, "document.pdf");
    fs.writeFileSync(file, createPdf({ pages: 4, pagePadding: 1024 * 1024, pageTreeGroupSize: 1 }));
    const PdfDocument = require("../lib/document");
    document = new PdfDocument(file);
    const pdf = await document.open();
    expect(Object.prototype.toString.call(document.task._worker.port)).toBe("[object Worker]");
    const read = document.read.bind(document);
    let rangeStarted = false;
    const blocked = new Promise((resolve) => (releaseRange = resolve));
    document.read = async (...args) => {
      rangeStarted = true;
      await blocked;
      return read(...args);
    };
    const pageResult = pdf.getPage(2).then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    );
    await conditionPromise(() => rangeStarted, "middle page disk range", 2000);
    expect(document.pageRequests.size).toBe(1);

    let destroyed = false;
    document.destroy().then(() => (destroyed = true));
    await conditionPromise(
      () => destroyed,
      "document cancellation with an outstanding range",
      2000,
    );
    const result = await pageResult;
    expect(result.resolved).toBeUndefined();
    expect(result.error?.message || "").toMatch(/terminated|destroyed|cancelled|aborted/i);
    expect(document.pageRequests.size).toBe(0);
    expect(document.handle).toBeNull();
  });
});
