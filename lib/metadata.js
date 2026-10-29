const { getLibrary } = require("./pdfjs");

async function getMetadata(view, { signal } = {}) {
  signal?.throwIfAborted();
  if (view.destroyed) return [];
  if (!view.pdfDocument) await wait(view.whenReady(), signal);
  signal?.throwIfAborted();
  const document = view.pdfDocument;
  const generation = view.generation;
  if (view.destroyed || !document) return [];
  const { info = {}, metadata } = await wait(document.getMetadata(), signal);
  signal?.throwIfAborted();
  if (view.destroyed || view.pdfDocument !== document || view.generation !== generation) return [];
  const rows = [{ id: "pages", label: "Pages", value: document.numPages }];
  const fields = [
    ["version", "PDF version", "PDFFormatVersion"],
    ["title", "Title", "Title", "dc:title"],
    ["author", "Author", "Author", "dc:creator"],
    ["subject", "Subject", "Subject", "dc:description"],
    ["keywords", "Keywords", "Keywords", "pdf:keywords"],
    ["creator", "Creator", "Creator", "xmp:creatortool"],
    ["producer", "Producer", "Producer", "pdf:producer"],
  ];
  for (const [id, label, key, xmp] of fields) {
    let value = info[key] || (xmp && metadata?.get(xmp));
    if (Array.isArray(value)) value = value.filter((entry) => typeof entry === "string").join(", ");
    if (typeof value === "string" && value) rows.push({ id, label, value });
  }
  for (const [id, label, key, xmp] of [
    ["created", "Created", "CreationDate", "xmp:createdate"],
    ["modified", "Modified", "ModDate", "xmp:modifydate"],
  ]) {
    const raw = info[key] || metadata?.get(xmp);
    if (typeof raw !== "string" || !raw) continue;
    const date = info[key] ? getLibrary().PDFDateString.toDateObject(raw) : new Date(raw);
    rows.push(
      date && Number.isFinite(date.getTime())
        ? { id, label, value: date.toISOString(), format: "date" }
        : { id, label, value: raw },
    );
  }
  if (typeof info.IsLinearized === "boolean")
    rows.push({ id: "linearized", label: "Linearized", value: info.IsLinearized });
  return [{ id: "pdf", title: "PDF", rows }];
}

function wait(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

module.exports = { getMetadata };
