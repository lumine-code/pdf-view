const test = require("node:test");
const assert = require("node:assert/strict");
const { getMetadata } = require("../../lib/metadata");

test("reads semantic PDF metadata from the existing document without fetching pages", async () => {
  const pdfDocument = {
    numPages: 12,
    getMetadata: async () => ({
      info: { PDFFormatVersion: "1.7", Title: "Live document", IsLinearized: false },
      metadata: {
        get: (key) =>
          ({
            "dc:creator": ["First author", "Second author"],
            "xmp:createdate": "2026-10-29T10:00:00Z",
          })[key],
      },
    }),
    getPage: () => assert.fail("Metadata must not render or inspect every page"),
  };
  const [section] = await getMetadata({ pdfDocument, generation: 1 });
  const row = (id) => section.rows.find((entry) => entry.id === id);
  assert.equal(section.id, "pdf");
  assert.equal(row("pages").value, 12);
  assert.equal(row("title").value, "Live document");
  assert.equal(row("author").value, "First author, Second author");
  assert.equal(row("created").format, "date");
  assert.equal(row("created").value, "2026-10-29T10:00:00.000Z");
  assert.equal(row("linearized").value, false);
});

test("rejects aborted reads and discards results from replaced documents", async () => {
  let release;
  const pdfDocument = {
    numPages: 1,
    getMetadata: () => new Promise((resolve) => (release = resolve)),
  };
  const view = { pdfDocument, generation: 1 };
  const reading = getMetadata(view);
  view.pdfDocument = { numPages: 2 };
  release({});
  assert.deepEqual(await reading, []);
  view.pdfDocument = pdfDocument;
  const controller = new AbortController();
  const cancelled = getMetadata(view, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  release({});
});

test("waits for initial document readiness before reading and handles closed viewers", async () => {
  const view = {
    generation: 1,
    whenReady: async () => {
      view.pdfDocument = { numPages: 3, getMetadata: async () => ({}) };
    },
  };
  assert.equal((await getMetadata(view))[0].rows[0].value, 3);
  view.destroyed = true;
  assert.deepEqual(await getMetadata(view), []);
});
