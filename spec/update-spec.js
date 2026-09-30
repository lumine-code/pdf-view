const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
const {
  ADAPTER_SCRIPTS,
  patchViewerHtml,
  patchViewerMjs,
  extractZip,
  installDistribution,
  requestHttps,
  downloadFile,
} = require("../scripts/update");

const HTML = `<head>
    <link rel="stylesheet" href="viewer.css" />
    <script src="viewer.mjs" type="module"></script>
</head>`;
const VIEWER = `const options = new Map([
  ["supportsPrinting", { value: true }],
  ["verbosity", { value: 1 }],
]);
const pdfViewer = this.pdfViewer = new PDFViewer({
  container,
  viewer,
});
if (evt.pageNumber === pageNumber) {
  evt.source.textLayer.div.focus();
}`;

function writeDistribution(directory, version) {
  const files = {
    "build/pdf.mjs": `/* pdfjsVersion = ${version} */`,
    "build/pdf.worker.mjs": `/* pdfjsVersion = ${version} */`,
    "web/viewer.mjs": `/* pdfjsVersion = ${version} */\n${VIEWER}`,
    "web/viewer.html": HTML,
    "web/viewer.css": "",
    "web/locale/locale.json": "{}",
    LICENSE: "Test distribution",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(directory, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  for (const relative of ["web/cmaps", "web/standard_fonts", "web/wasm"]) {
    fs.mkdirSync(path.join(directory, relative), { recursive: true });
  }
}

describe("PDF.js update patches", () => {
  it("is idempotent on the committed distribution and puts adapters before PDF.js", () => {
    const root = path.join(__dirname, "..", "vendors", "pdfjs-dist", "web");
    const html = patchViewerHtml(fs.readFileSync(path.join(root, "viewer.html"), "utf8"));
    const viewer = fs.readFileSync(path.join(root, "viewer.mjs"), "utf8");

    expect(patchViewerHtml(html)).toBe(html);
    expect(patchViewerMjs(viewer)).toBe(viewer);
    expect(ADAPTER_SCRIPTS).toEqual([
      "../../../lib/pdfjs/navigation.js",
      "../../../lib/pdfjs/viewer.js",
    ]);
    expect(html.indexOf(ADAPTER_SCRIPTS[0])).toBeLessThan(html.indexOf(ADAPTER_SCRIPTS[1]));
    expect(html.indexOf(ADAPTER_SCRIPTS[1])).toBeLessThan(html.indexOf('src="viewer.mjs"'));
    expect(html).not.toContain("../../custom/viewer.js");
  });

  it("rejects missing or duplicate HTML anchors instead of leaving a partial patch", () => {
    expect(() => patchViewerHtml(HTML.replace("viewer.css", "changed.css"))).toThrowError(
      /viewer.css stylesheet anchor, found 0/,
    );
    expect(() =>
      patchViewerHtml(`${HTML}\n<link rel="stylesheet" href="viewer.css" />`),
    ).toThrowError(/viewer.css stylesheet anchor, found 2/);
    expect(() => patchViewerHtml(HTML.replace("viewer.mjs", "changed.mjs"))).toThrowError(
      /viewer.mjs module script anchor, found 0/,
    );
    expect(() =>
      patchViewerHtml(`${HTML}\n<script src="viewer.mjs" type="module"></script>`),
    ).toThrowError(/viewer.mjs module script anchor, found 2/);
  });

  it("rejects duplicated adapter links", () => {
    const adapter = `<script src="${ADAPTER_SCRIPTS[0]}"></script>`;
    expect(() => patchViewerHtml(`${HTML}\n${adapter}\n${adapter}`)).toThrowError(
      /Duplicate viewer resource/,
    );
  });

  it("rejects missing or duplicate required JavaScript anchors", () => {
    for (const [source, label] of [
      [VIEWER.replace('"supportsPrinting"', '"changedOption"'), "supportsPrinting option"],
      [`${VIEWER}\n["supportsPrinting", { value: true }]`, "supportsPrinting option"],
      [VIEWER.replace("new PDFViewer", "new ChangedViewer"), "PDFViewer constructor"],
      [
        `${VIEWER}\nconst pdfViewer = this.pdfViewer = new PDFViewer({\n});`,
        "PDFViewer constructor",
      ],
      [
        VIEWER.replace("evt.source.textLayer.div.focus()", "changedFocus()"),
        "destination text-layer focus",
      ],
      [
        `${VIEWER}\nif (evt.pageNumber === pageNumber) {\n  evt.source.textLayer.div.focus();\n}`,
        "destination text-layer focus",
      ],
    ]) {
      expect(() => patchViewerMjs(source)).toThrowError(new RegExp(`${label} anchor, found [02]`));
    }
  });
});

describe("PDF.js update transaction", () => {
  let directory, manifestPath, originalManifest, live;
  const version = "1.2.3";

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-update-")));
    manifestPath = path.join(directory, "package.json");
    originalManifest = '{ "name": "test-pdf-view", "pdfjsVersion": "1.0.0" }\n';
    fs.writeFileSync(manifestPath, originalManifest);
    live = path.join(directory, "vendors", "pdfjs-dist");
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, "previous.txt"), "old distribution");
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function options(overrides = {}) {
    return {
      packageDir: directory,
      version,
      url: "https://example.invalid/distribution.zip",
      download: async (_url, archive) => fs.writeFileSync(archive, "test archive"),
      extract: (_archive, destination) => writeDistribution(destination, version),
      ...overrides,
    };
  }

  function expectPreviousDistribution() {
    expect(fs.readFileSync(path.join(live, "previous.txt"), "utf8")).toBe("old distribution");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(originalManifest);
    expect(fs.readdirSync(path.join(directory, "vendors"))).toEqual(["pdfjs-dist"]);
  }

  it("prepares and validates the distribution before replacing the live files", async () => {
    await installDistribution(
      options({
        extract: (_archive, destination) => {
          expectPreviousDistributionDuringPreparation();
          writeDistribution(destination, version);
        },
      }),
    );

    expect(fs.existsSync(path.join(live, "previous.txt"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).pdfjsVersion).toBe(version);
    expect(fs.readFileSync(path.join(live, "web", "viewer.html"), "utf8")).toContain(
      ADAPTER_SCRIPTS[0],
    );
    expect(fs.readdirSync(path.join(directory, "vendors"))).toEqual(["pdfjs-dist"]);
  });

  function expectPreviousDistributionDuringPreparation() {
    expect(fs.readFileSync(path.join(live, "previous.txt"), "utf8")).toBe("old distribution");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(originalManifest);
  }

  it("leaves the live distribution and manifest intact when bundle versions disagree", async () => {
    await expectAsync(
      installDistribution(
        options({
          extract: (_archive, destination) => {
            writeDistribution(destination, version);
            fs.writeFileSync(
              path.join(destination, "build", "pdf.worker.mjs"),
              "/* pdfjsVersion = 9.9.9 */",
            );
          },
        }),
      ),
    ).toBeRejectedWithError(/version mismatch in build\/pdf.worker.mjs/);

    expectPreviousDistribution();
  });

  it("leaves live files intact when an upstream patch anchor changes", async () => {
    await expectAsync(
      installDistribution(
        options({
          extract: (_archive, destination) => {
            writeDistribution(destination, version);
            fs.writeFileSync(
              path.join(destination, "web", "viewer.html"),
              HTML.replace("viewer.mjs", "changed.mjs"),
            );
          },
        }),
      ),
    ).toBeRejectedWithError(/viewer.mjs module script anchor, found 0/);

    expectPreviousDistribution();
  });

  it("restores both live files and the exact manifest after a manifest commit failure", async () => {
    await expectAsync(
      installDistribution(
        options({
          commitManifest: (_source, target) => {
            fs.writeFileSync(target, "partially written manifest");
            throw new Error("Manifest commit failed");
          },
        }),
      ),
    ).toBeRejectedWithError("Manifest commit failed");

    expectPreviousDistribution();
  });

  it("passes Windows extraction paths as literal environment values", () => {
    const archive = path.join(directory, "archive ' $(Write-Host unsafe).zip");
    const destination = path.join(directory, "extracted ' content");
    const run = jasmine.createSpy("run");

    extractZip(archive, destination, "win32", run);

    const [command, args, commandOptions] = run.calls.mostRecent().args;
    expect(command).toBe("powershell.exe");
    expect(args.at(-1)).toContain("-LiteralPath $env:PDF_VIEW_UPDATE_ARCHIVE");
    expect(args.at(-1)).not.toContain(archive);
    expect(commandOptions.windowsHide).toBe(true);
    expect(commandOptions.env.PDF_VIEW_UPDATE_ARCHIVE).toBe(archive);
    expect(commandOptions.env.PDF_VIEW_UPDATE_DESTINATION).toBe(destination);
  });
});

describe("PDF.js update downloads", () => {
  function requestStub() {
    const request = new EventEmitter();
    request.setTimeout = jasmine.createSpy("setTimeout").and.returnValue(request);
    request.destroy = (error) => request.emit("error", error);
    return request;
  }

  function response(status, headers = {}) {
    const stream = Readable.from([]);
    stream.statusCode = status;
    stream.headers = headers;
    return stream;
  }

  it("rejects non-success HTTP statuses", async () => {
    spyOn(https, "get").and.callFake((_url, _options, callback) => {
      callback(response(404));
      return requestStub();
    });

    await expectAsync(requestHttps("https://example.invalid/archive.zip")).toBeRejectedWithError(
      /HTTP status 404/,
    );
  });

  it("resolves relative redirects and enforces the redirect limit", async () => {
    const get = spyOn(https, "get").and.callFake((_url, _options, callback) => {
      callback(response(302, { location: "/redirected.zip" }));
      return requestStub();
    });

    await expectAsync(requestHttps("https://example.invalid/archive.zip")).toBeRejectedWithError(
      /exceeded the limit/,
    );
    expect(get.calls.count()).toBe(6);
    expect(get.calls.mostRecent().args[0].href).toBe("https://example.invalid/redirected.zip");
  });

  it("rejects redirects to a protocol other than HTTPS", async () => {
    spyOn(https, "get").and.callFake((_url, _options, callback) => {
      callback(response(302, { location: "http://example.invalid/archive.zip" }));
      return requestStub();
    });

    await expectAsync(requestHttps("https://example.invalid/archive.zip")).toBeRejectedWithError(
      /Only HTTPS downloads/,
    );
  });

  it("aborts timed-out requests", async () => {
    const request = requestStub();
    spyOn(https, "get").and.returnValue(request);
    const pending = requestHttps("https://example.invalid/archive.zip");

    request.setTimeout.calls.mostRecent().args[1]();

    await expectAsync(pending).toBeRejectedWithError("Download timed out");
  });

  it("removes partial downloads when the response stream aborts", async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pdf-view-download-")));
    const archive = path.join(directory, "archive.zip");
    const stream = new Readable({
      read() {
        this.destroy(new Error("Response aborted"));
      },
    });
    stream.statusCode = 200;
    stream.headers = {};
    spyOn(https, "get").and.callFake((_url, _options, callback) => {
      callback(stream);
      return requestStub();
    });

    try {
      await expectAsync(
        downloadFile("https://example.invalid/archive.zip", archive),
      ).toBeRejectedWithError("Response aborted");
      expect(fs.existsSync(archive)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
