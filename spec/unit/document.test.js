const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const PdfDocument = require("../../lib/document");
const { createPdf } = require("../helpers/pdf-fixture");

test("reads real PDF pages through disk ranges and releases the snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-ranges-"));
  const file = path.join(directory, "document.pdf");
  await fs.writeFile(file, createPdf({ pages: 4 }));
  const document = new PdfDocument(file);
  let snapshot;
  try {
    const pdf = await document.open();
    snapshot = document.snapshotDirectory;
    assert.ok(snapshot);
    const stat = await fs.stat(file);
    assert.equal(document.fingerprint, `${stat.size}:${stat.mtimeMs}:${stat.ino}`);
    assert.equal(pdf.numPages, 4);
    const page = await pdf.getPage(4);
    const text = await page.getTextContent();
    assert.match(text.items.map((item) => item.str).join(" "), /page 4/);
    assert.ok(document.rangesRead >= 1);
  } finally {
    await document.destroy();
    assert.equal(document.handle, null);
    assert.equal(document.snapshotDirectory, null);
    if (snapshot) await assert.rejects(fs.stat(snapshot), { code: "ENOENT" });
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

for (const change of ["truncate", "overwrite", "replace", "remove"]) {
  test(`keeps unread PDF ranges available after source ${change}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-rebuild-"));
    const file = path.join(directory, "document.pdf");
    const original = createPdf({ pages: 6, pagePadding: 1024 * 1024, pageTreeGroupSize: 1 });
    await fs.writeFile(file, original);
    const document = new PdfDocument(file);
    try {
      const pdf = await document.open();
      assert.ok(document.bytesRead < original.length, "middle page data should still be unread");
      const reads = document.rangesRead;
      if (change === "truncate") await fs.truncate(file, 0);
      else if (change === "remove") await fs.unlink(file);
      else if (change === "overwrite") await fs.writeFile(file, Buffer.alloc(original.length, 32));
      else {
        await fs.rename(file, path.join(directory, "previous.pdf"));
        await fs.writeFile(file, createPdf({ pages: 2 }));
      }
      const page = await pdf.getPage(3);
      const text = await page.getTextContent();
      assert.match(text.items.map((item) => item.str).join(" "), /page 3/);
      assert.ok(document.rangesRead > reads, "must load data beyond PDF.js's cached ranges");
      assert.equal(document.closed, false);
    } finally {
      await document.destroy();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

for (const outcome of ["cancel", "change", "fail"]) {
  test(`cleans up a snapshot when copying ends with ${outcome}`, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-copy-"));
    const file = path.join(directory, "document.pdf");
    await fs.writeFile(file, createPdf());
    const copied = Promise.withResolvers();
    const release = Promise.withResolvers();
    const copyFile = fs.copyFile.bind(fs);
    context.mock.method(fs, "copyFile", async (...args) => {
      await copyFile(...args);
      copied.resolve();
      await release.promise;
      if (outcome === "fail") throw new Error("Snapshot copy failed");
    });
    const document = new PdfDocument(file);
    const opening = document.open();
    // Observe rejection immediately, including when destroy races opening.
    const rejected = assert.rejects(opening, /cancelled|changed|copy failed/);
    try {
      await withTimeout(copied.promise, "Snapshot copy did not start");
      const snapshot = document.snapshotDirectory;
      if (outcome === "cancel") void document.destroy();
      else if (outcome === "change") await fs.truncate(file, 0);
      release.resolve();
      await rejected;
      await document.destroy();
      assert.equal(document.handle, null);
      assert.equal(document.snapshotDirectory, null);
      await assert.rejects(fs.stat(snapshot), { code: "ENOENT" });
    } finally {
      release.resolve();
      await opening.catch(() => {});
      await document.destroy();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
}

test("retiring a detached document finishes its outstanding page before closing the snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-retire-"));
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
    const page = pdf.getPage(2);
    await withTimeout(rangeStarted.promise, "The middle page did not request a disk range");
    const retired = document.retire();
    assert.equal(document.closed, false);
    releaseRange.resolve();
    assert.equal((await page).pageNumber, 2);
    await withTimeout(retired, "Document retirement did not finish");
    assert.equal(document.closed, true);
    assert.equal(document.handle, null);
    assert.equal(document.snapshotDirectory, null);
  } finally {
    releaseRange.resolve();
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
