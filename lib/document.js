const fs = require("node:fs/promises");
const path = require("node:path");
const { getLibrary, assetURL } = require("./pdfjs");

const CHUNK_SIZE = 256 * 1024;

// Disk ranges go directly to PDF.js's worker. Opening a large file neither
// reads its entire contents nor makes a second renderer-sized byte copy.
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
    const pdfjs = getLibrary();
    const handle = await fs.open(this.filePath, "r");
    this.handle = handle;
    if (this.closed) {
      await handle.close();
      throw new Error("PDF loading was cancelled");
    }
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) throw new Error("The PDF file is empty or unavailable");
    this.size = stat.size;
    this.fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
    const initialData = await this.read(0, Math.min(CHUNK_SIZE, stat.size));
    const owner = this;
    this.transport = new (class extends pdfjs.PDFDataRangeTransport {
      constructor() {
        super(stat.size, initialData, true, path.basename(owner.filePath));
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
        ]);
      } finally {
        await this.closeHandle();
      }
    })();
    return this.destroyPromise;
  }
}

module.exports = PdfDocument;
