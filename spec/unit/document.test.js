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
