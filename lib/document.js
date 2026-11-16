const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { getLibrary, assetURL } = require("./pdfjs");

const CHUNK_SIZE = 256 * 1024;

// Each worker reads ranges from its own disk snapshot. Compilers may truncate
// or replace the source while unloaded pages still need the previous bytes.
// Copying on disk keeps those bytes without a document-sized renderer buffer.
class PdfDocument {
  constructor(filePath) {
    this.filePath = filePath;
    this.closed = false;
    this.bytesRead = 0;
    this.rangesRead = 0;
    this.pageRequests = new Set();
    this.startedAt = performance.now();
  }

  async open(onPassword) {
    try {
      return await this.openSnapshot(onPassword);
    } catch (error) {
      await this.destroy();
      throw this.error || error;
    }
  }

  async createSnapshot() {
    if (this.closed) throw new Error("PDF loading was cancelled");
    const source = await fs.stat(this.filePath);
    if (!source.isFile() || !source.size) throw new Error("The PDF file is empty or unavailable");
    this.snapshotDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-view-"));
    const snapshot = path.join(this.snapshotDirectory, "document.pdf");
    if (this.closed) throw new Error("PDF loading was cancelled");
    // Reflink where supported, otherwise copy; a hard link would still expose
    // in-place compiler writes to the document being displayed.
    await fs.copyFile(this.filePath, snapshot, fs.constants.COPYFILE_FICLONE);
    const current = await fs.stat(this.filePath);
    const copied = await fs.stat(snapshot);
    if (
      // ctime also tracks metadata changes unrelated to the PDF's contents.
      ["dev", "ino", "size", "mtimeMs"].some((key) => source[key] !== current[key]) ||
      copied.size !== source.size
    )
      throw new Error("The PDF changed while it was being copied");
    if (this.closed) throw new Error("PDF loading was cancelled");
    this.handle = await fs.open(snapshot, "r");
    this.size = source.size;
    // Refresh watches the original path, not the private snapshot's metadata.
    this.fingerprint = `${source.size}:${source.mtimeMs}:${source.ino}`;
  }

  async openSnapshot(onPassword) {
    const pdfjs = getLibrary();
    await (this.snapshotPromise = this.createSnapshot());
    const initialData = await this.read(0, Math.min(CHUNK_SIZE, this.size));
    const owner = this;
    this.transport = new (class extends pdfjs.PDFDataRangeTransport {
      constructor() {
        super(owner.size, initialData, true, path.basename(owner.filePath));
      }
      requestDataRange(begin, end) {
        owner.read(begin, end).then(
          (data) => {
            if (!owner.closed) this.onDataRange(begin, data);
          },
          (error) => {
            if (owner.closed) return;
            owner.error = error;
            void owner.task?.destroy();
          },
        );
      }
      abort() {
        void owner.closeHandle();
      }
    })();
    if (this.closed) throw new Error("PDF loading was cancelled");
    this.task = pdfjs.getDocument({
      range: this.transport,
      rangeChunkSize: CHUNK_SIZE,
      disableAutoFetch: true,
      disableStream: true,
      cMapUrl: assetURL("cmaps/"),
      cMapPacked: true,
      standardFontDataUrl: assetURL("standard_fonts/"),
      wasmUrl: assetURL("wasm/"),
      iccUrl: assetURL("iccs/"),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    this.task.onPassword = onPassword;
    try {
      const pdf = await this.task.promise;
      const getPage = (...args) => {
        const request = pdf.getPage(...args);
        this.pageRequests.add(request);
        request.finally(() => this.pageRequests.delete(request)).catch(() => {});
        return request;
      };
      // Retain outstanding page requests so teardown also waits for their
      // continuations after PDF.js cancels the worker's pending disk ranges.
      this.pdf = new Proxy(pdf, {
        get(target, key) {
          if (key === "getPage") return getPage;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      this.loadedAt = performance.now();
      return this.pdf;
    } catch (error) {
      throw this.error || error;
    }
  }

  async read(begin, end) {
    if (this.closed) throw new Error("PDF loading was cancelled");
    const data = new Uint8Array(end - begin);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await this.handle.read(
        data,
        offset,
        data.length - offset,
        begin + offset,
      );
      if (!bytesRead) throw new Error("The PDF changed while it was being read");
      offset += bytesRead;
    }
    this.bytesRead += data.length;
    this.rangesRead++;
    return data;
  }

  closeHandle() {
    const handle = this.handle;
    this.handle = null;
    return handle?.close().catch(() => {});
  }

  retire() {
    if (!this.retirePromise)
      this.retirePromise = (async () => {
        // Once detached, no new viewer requests should begin. Let the queued
        // page loads complete before terminating their worker: PDF.js reports
        // cancelled getPage calls as rendering errors even for detached views.
        while (!this.closed && this.pageRequests.size)
          await Promise.allSettled([...this.pageRequests]);
        await this.destroy();
      })();
    return this.retirePromise;
  }

  destroy({ abort = false } = {}) {
    if (this.destroyPromise) return this.destroyPromise;
    this.closed = true;
    this.destroyPromise = (async () => {
      try {
        // Cancel first: an outstanding page may be waiting for a disk range
        // that never arrives. PDF.js rejects those requests during teardown.
        await Promise.all([
          this.task?.destroy(),
          abort ? null : Promise.allSettled([...this.pageRequests]),
          this.snapshotPromise?.catch(() => {}),
        ]);
      } finally {
        await this.closeHandle();
        if (this.snapshotDirectory) {
          await fs.rm(this.snapshotDirectory, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
          });
          this.snapshotDirectory = null;
        }
      }
    })();
    return this.destroyPromise;
  }
}

module.exports = PdfDocument;
