const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { pipeline } = require("stream/promises");

const PACKAGE_DIR = path.join(__dirname, "..");
const GITHUB_API = "https://api.github.com/repos/mozilla/pdf.js/releases/latest";
const ADAPTER_SCRIPTS = ["../../../lib/pdfjs/navigation.js", "../../../lib/pdfjs/viewer.js"];
const OPTION_PATCHES = [
  { name: "supportsPrinting", from: "true", to: "false" },
  { name: "verbosity", from: "1", to: "0" },
];

function requestHttps(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error(`Only HTTPS downloads are supported: ${parsed.protocol}`));
      return;
    }
    const request = https.get(parsed, { headers: { "User-Agent": "pdf-view-updater" } }, (res) => {
      res.on("error", reject);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (!res.headers.location || redirects >= 5) {
          reject(new Error("Download redirect is missing its destination or exceeded the limit"));
          return;
        }
        try {
          requestHttps(new URL(res.headers.location, parsed), redirects + 1).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      } else if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Request failed with HTTP status ${res.statusCode}`));
      } else {
        resolve(res);
      }
    });
    request.setTimeout(30000, () => request.destroy(new Error("Download timed out")));
    request.on("error", reject);
  });
}

async function fetchJSON(url) {
  const response = await requestHttps(url);
  let data = "";
  for await (const chunk of response) data += chunk;
  return JSON.parse(data);
}

async function downloadFile(url, destination) {
  try {
    await pipeline(await requestHttps(url), fs.createWriteStream(destination));
  } catch (error) {
    fs.rmSync(destination, { force: true });
    throw error;
  }
}

function replaceRequired(content, pattern, replacement, label) {
  const matches = Array.from(content.matchAll(pattern));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} anchor, found ${matches.length}`);
  }
  return content.replace(pattern, replacement);
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeOwnedResource(content, resource, element) {
  const source = escapePattern(resource);
  const references = Array.from(content.matchAll(new RegExp(`(?:src|href)="${source}"`, "g")));
  if (references.length > 1) throw new Error(`Duplicate viewer resource: ${resource}`);
  if (!references.length) return content;
  const attribute = element === "script" ? "src" : "href";
  const end = element === "script" ? "></script>" : "\\s*/?>";
  const pattern = new RegExp(
    `^[ \\t]*<${element}\\b[^>]*\\b${attribute}="${source}"[^>]*${end}[ \\t]*(?:\\r?\\n|$)`,
    "gm",
  );
  return replaceRequired(content, pattern, "", resource);
}

function patchViewerHtml(content) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  content = removeOwnedResource(content, "../../custom/viewer.css", "link");
  for (const resource of [...ADAPTER_SCRIPTS, "../../custom/viewer.js"]) {
    content = removeOwnedResource(content, resource, "script");
  }
  content = replaceRequired(
    content,
    /^([ \t]*)(<link rel="stylesheet" href="viewer\.css"\s*\/?>)[ \t]*$/gm,
    (_, indent, link) =>
      `${indent}${link}${newline}${indent}<link rel="stylesheet" href="../../custom/viewer.css">`,
    "viewer.css stylesheet",
  );
  return replaceRequired(
    content,
    /^([ \t]*)(<script src="viewer\.mjs" type="module"><\/script>)[ \t]*$/gm,
    (_, indent, script) =>
      [
        ...ADAPTER_SCRIPTS.map((resource) => `${indent}<script src="${resource}"></script>`),
        `${indent}${script}`,
      ].join(newline),
    "viewer.mjs module script",
  );
}

function patchViewerMjs(content) {
  for (const { name, from, to } of OPTION_PATCHES) {
    const pattern = new RegExp(
      `((?:\\["${name}",|\\b${name}:)\\s*\\{\\s*value:\\s*)(?:${from}|${to})\\b`,
      "g",
    );
    content = replaceRequired(content, pattern, (_, prefix) => prefix + to, `${name} option`);
  }
  // The constructor patch enabled borderless full-width pages, without changing
  // PDF.js's scale calculations or assuming the host's scrollbar width.
  content = replaceRequired(
    content,
    /const pdfViewer = this\.pdfViewer = new PDFViewer\(\{[\s\S]*?\r?\n[ \t]*\}\);/g,
    (constructor) => {
      if (/\bremovePageBorders\s*:/.test(constructor)) {
        replaceRequired(
          constructor,
          /\bremovePageBorders: true,/g,
          "$&",
          "removePageBorders option",
        );
        if (Array.from(constructor.matchAll(/\bremovePageBorders\s*:/g)).length !== 1) {
          throw new Error("Duplicate removePageBorders option");
        }
        return constructor;
      }
      return replaceRequired(
        constructor,
        /(container,\r?\n([ \t]*)viewer,)(\r?\n)/g,
        (_, prefix, indent, newline) =>
          `${prefix}${newline}${indent}removePageBorders: true,${newline}`,
        "PDFViewer container and viewer",
      );
    },
    "PDFViewer constructor",
  );
  return replaceRequired(
    content,
    /(\bif \(evt\.pageNumber === pageNumber\) \{\r?\n[ \t]*)(?:\/\/ )?evt\.source\.textLayer\.div\.focus\(\);/g,
    "$1// evt.source.textLayer.div.focus();",
    "destination text-layer focus",
  );
}

function extractZip(archive, destination, platform = process.platform, run = execFileSync) {
  fs.mkdirSync(destination, { recursive: true });
  if (platform === "win32") {
    run(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:PDF_VIEW_UPDATE_ARCHIVE -DestinationPath $env:PDF_VIEW_UPDATE_DESTINATION -Force",
      ],
      {
        stdio: "inherit",
        windowsHide: true,
        env: {
          ...process.env,
          PDF_VIEW_UPDATE_ARCHIVE: path.resolve(archive),
          PDF_VIEW_UPDATE_DESTINATION: path.resolve(destination),
        },
      },
    );
  } else {
    run("unzip", ["-o", "-q", path.resolve(archive), "-d", path.resolve(destination)], {
      stdio: "inherit",
    });
  }
}

function validateDistribution(directory, version) {
  for (const relative of ["build/pdf.mjs", "build/pdf.worker.mjs", "web/viewer.mjs"]) {
    const content = fs.readFileSync(path.join(directory, relative), "utf8");
    const versions = Array.from(content.matchAll(/pdfjsVersion\s*=\s*(\d+\.\d+\.\d+)/g));
    if (versions.length !== 1 || versions[0][1] !== version) {
      throw new Error(`PDF.js version mismatch in ${relative}: expected ${version}`);
    }
  }
  for (const relative of [
    "LICENSE",
    "web/viewer.html",
    "web/viewer.css",
    "web/locale/locale.json",
  ]) {
    if (!fs.statSync(path.join(directory, relative)).isFile()) {
      throw new Error(`Required PDF.js asset is not a file: ${relative}`);
    }
  }
  for (const relative of ["web/cmaps", "web/standard_fonts", "web/wasm"]) {
    if (!fs.statSync(path.join(directory, relative)).isDirectory()) {
      throw new Error(`Required PDF.js asset is not a directory: ${relative}`);
    }
  }
}

function assertChildPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Update path is outside its parent directory: ${child}`);
  }
}

async function installDistribution({
  packageDir = PACKAGE_DIR,
  version,
  url,
  download = downloadFile,
  extract = extractZip,
  commitManifest = (source, destination) => fs.renameSync(source, destination),
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid PDF.js version: ${version}`);
  const packagePath = path.join(packageDir, "package.json");
  const originalManifest = fs.readFileSync(packagePath, "utf8");
  const manifest = JSON.parse(originalManifest);
  const vendors = path.join(packageDir, "vendors");
  const live = path.join(vendors, "pdfjs-dist");
  fs.mkdirSync(vendors, { recursive: true });
  const staging = fs.mkdtempSync(path.join(vendors, ".pdfjs-update-"));
  assertChildPath(vendors, staging);
  assertChildPath(vendors, live);
  const prepared = path.join(staging, "pdfjs-dist");
  const backup = path.join(staging, "previous-pdfjs-dist");
  const preparedManifest = path.join(staging, "package.json");
  const backupManifest = path.join(staging, "previous-package.json");
  let previousMoved = false;
  let installed = false;
  let retainBackup = false;
  try {
    const archive = path.join(staging, "pdfjs-dist.zip");
    await download(url, archive);
    await extract(archive, prepared);
    validateDistribution(prepared, version);
    const htmlPath = path.join(prepared, "web", "viewer.html");
    const viewerPath = path.join(prepared, "web", "viewer.mjs");
    fs.writeFileSync(htmlPath, patchViewerHtml(fs.readFileSync(htmlPath, "utf8")));
    fs.writeFileSync(viewerPath, patchViewerMjs(fs.readFileSync(viewerPath, "utf8")));
    validateDistribution(prepared, version);
    manifest.pdfjsVersion = version;
    fs.writeFileSync(preparedManifest, JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(backupManifest, originalManifest);
    if (fs.existsSync(live)) {
      fs.renameSync(live, backup);
      previousMoved = true;
    }
    fs.renameSync(prepared, live);
    installed = true;
    commitManifest(preparedManifest, packagePath);
  } catch (error) {
    if (previousMoved || installed) {
      try {
        if (installed)
          fs.rmSync(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
        if (previousMoved) fs.renameSync(backup, live);
        fs.renameSync(backupManifest, packagePath);
      } catch (rollbackError) {
        retainBackup = true;
        throw new AggregateError(
          [error, rollbackError],
          `Update rollback failed; backups remain in ${staging}`,
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    if (!retainBackup)
      fs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function main(args = process.argv.slice(2)) {
  const force =
    args.includes("--force") || args.includes("-f") || process.env.npm_config_force === "true";
  console.log("Fetching latest PDF.js release...");
  const release = await fetchJSON(GITHUB_API);
  const version = release.tag_name?.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("GitHub release has no valid PDF.js version");
  const asset = release.assets?.find((entry) => entry.name === `pdfjs-${version}-dist.zip`);
  if (!asset) throw new Error(`Could not find pdfjs-${version}-dist.zip in release assets`);
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"));
  if (manifest.pdfjsVersion === version && !force) {
    console.log(`Already at latest version ${version}`);
    return;
  }
  console.log(`Preparing PDF.js ${version}...`);
  await installDistribution({ version, url: asset.browser_download_url });
  console.log(`Updated to PDF.js ${version}. Test the viewer before committing.`);
}

module.exports = {
  ADAPTER_SCRIPTS,
  patchViewerHtml,
  patchViewerMjs,
  extractZip,
  validateDistribution,
  installDistribution,
  requestHttps,
  downloadFile,
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Error:", error.message);
    process.exitCode = 1;
  });
}
