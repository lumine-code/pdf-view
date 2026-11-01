const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const PdfDocument = require("../../lib/document");
const { createPdf } = require("../helpers/pdf-fixture");

test("reads real PDF pages through disk ranges and releases the source file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-ranges-"));
  const file = path.join(directory, "document.pdf");
  await fs.writeFile(file, createPdf({ pages: 4 }));
  const document = new PdfDocument(file);
  try {
    const pdf = await document.open();
    assert.equal(pdf.numPages, 4);
    const page = await pdf.getPage(4);
    const text = await page.getTextContent();
    assert.match(text.items.map((item) => item.str).join(" "), /page 4/);
    assert.ok(document.rangesRead >= 1);
  } finally {
    await document.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cancelling before the file handle opens does not leak that handle", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-cancel-"));
  const file = path.join(directory, "document.pdf");
  await fs.writeFile(file, createPdf());
  const document = new PdfDocument(file);
  try {
    const opening = document.open();
    await document.destroy();
    await assert.rejects(opening, /cancelled/);
  } finally {
    await document.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("destroying a document cancels a page blocked on an outstanding disk range", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-pending-range-"));
  const file = path.join(directory, "document.pdf");
  await fs.writeFile(file, createPdf({ pages: 4, pagePadding: 1024 * 1024, pageTreeGroupSize: 1 }));
  const document = new PdfDocument(file);
  const rangeStarted = Promise.withResolvers();
  const releaseRange = Promise.withResolvers();
  try {
    const pdf = await document.open();
    const read = document.read.bind(document);
    document.read = async (...args) => {
      rangeStarted.resolve();
      await releaseRange.promise;
      return read(...args);
    };
    const pageResult = pdf.getPage(2).then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    );
    await withTimeout(rangeStarted.promise, "The middle page did not request a disk range");
    assert.equal(document.pageRequests.size, 1);

    await withTimeout(document.destroy(), "Document destruction waited for the blocked range");
    const result = await pageResult;
    assert.equal(result.resolved, undefined);
    assert.match(result.error?.message || "", /terminated|destroyed|cancelled|aborted/i);
    assert.equal(document.pageRequests.size, 0);
    assert.equal(document.handle, null);
  } finally {
    // Let the baseline implementation finish too when the cancellation assertion fails.
    releaseRange.resolve();
    await document.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function withTimeout(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
