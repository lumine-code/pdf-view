const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const VENDORS_DIR = path.join(__dirname, "..", "vendors");
const PDFJS_DIR = path.join(VENDORS_DIR, "pdfjs-dist");
const PACKAGE_JSON = path.join(__dirname, "..", "package.json");
const GITHUB_API = "https://api.github.com/repos/mozilla/pdf.js/releases/latest";

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "pdf-view-updater" } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https
        .get(url, { headers: { "User-Agent": "pdf-view-updater" } }, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            return follow(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`Download failed with status ${res.statusCode}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
          file.on("error", (err) => {
            fs.unlink(dest, () => {});
            reject(err);
          });
        })
        .on("error", reject);
    };
    follow(url);
  });
}

function patchViewerHtml() {
  const viewerPath = path.join(PDFJS_DIR, "web", "viewer.html");
  let html = fs.readFileSync(viewerPath, "utf8");
  let changed = false;

  if (html.includes('    <style id="viewer-less"></style>\n')) {
    html = html.replace('    <style id="viewer-less"></style>\n', "");
    changed = true;
  }

  // Check if already patched
  if (html.includes("../../custom/viewer.css")) {
    if (changed) {
      fs.writeFileSync(viewerPath, html);
    }
    console.log("viewer.html already patched");
    return;
  }

  // Add custom CSS after viewer.css
  html = html.replace(
    '<link rel="stylesheet" href="viewer.css" />',
    '<link rel="stylesheet" href="viewer.css" />\n' +
      '    <link rel="stylesheet" href="../../custom/viewer.css">',
  );

  // Add custom JS after viewer.mjs (before </head>)
  html = html.replace(
    '<script src="viewer.mjs" type="module"></script>\n  </head>',
    '<script src="viewer.mjs" type="module"></script>\n' +
      '    <script src="../../custom/viewer.js"></script>\n  </head>',
  );

  // Reaching here always means the CSS/JS links were absent, so always write.
  fs.writeFileSync(viewerPath, html);
  console.log("Patched viewer.html with custom CSS/JS");
}

// Default values of AppOptions entries to rewrite in viewer.mjs.
const OPTION_PATCHES = [
  // Printing is unsupported: the print buttons are hidden when this is false.
  { name: "supportsPrinting", from: "true", to: "false", label: "supportsPrinting set to false" },
  // Suppress noisy PDF.js warnings from malformed embedded fonts.
  { name: "verbosity", from: "1", to: "0", label: "default verbosity set to errors only" },
];

// The entries changed shape in PDF.js 6.2: the `defaultOptions` object literal
// (`verbosity: { value: 1,`) became a Map of pairs (`["verbosity", { value: 1,`).
// Match either spelling so the patch survives a revert.
function optionValuePattern(name, value) {
  return new RegExp(`((?:\\["${name}",|\\b${name}:)\\s*\\{\\s*value:\\s*)${value}\\b`);
}

function patchOption(content, { name, from, to, label }) {
  const pattern = optionValuePattern(name, from);
  if (pattern.test(content)) {
    console.log(`Patched viewer.mjs: ${label}`);
    return { content: content.replace(pattern, (_, prefix) => prefix + to), changed: true };
  }
  if (optionValuePattern(name, to).test(content)) {
    console.log(`viewer.mjs already patched: ${name} is ${to}`);
  } else {
    console.warn(`Warning: Could not find ${name} pattern in viewer.mjs`);
  }
  return { content, changed: false };
}

function patchViewerMjs() {
  const viewerPath = path.join(PDFJS_DIR, "web", "viewer.mjs");
  let content = fs.readFileSync(viewerPath, "utf8");
  let changed = false;

  for (const patch of OPTION_PATCHES) {
    const result = patchOption(content, patch);
    content = result.content;
    changed = changed || result.changed;
  }

  // Suppress textLayer focus after destination navigation to prevent keyboard focus
  // steal when the viewer is opened without activating its pane (activatePane=false).
  const focusPattern =
    /(\bif \(evt\.pageNumber === pageNumber\) \{\n\s*)evt\.source\.textLayer\.div\.focus\(\);/;
  if (focusPattern.test(content)) {
    content = content.replace(focusPattern, "$1// evt.source.textLayer.div.focus();");
    changed = true;
    console.log("Patched viewer.mjs: suppressed textLayer focus after destination navigation");
  } else if (content.includes("// evt.source.textLayer.div.focus();")) {
    console.log("viewer.mjs already patched: textLayer focus suppressed");
  } else {
    console.warn("Warning: Could not find textLayer focus pattern in viewer.mjs");
  }

  if (changed) {
    fs.writeFileSync(viewerPath, content);
  }
}

function patchFirstPagePromiseTDZ() {
  const viewerPath = path.join(PDFJS_DIR, "web", "viewer.mjs");
  let content = fs.readFileSync(viewerPath, "utf8");

  // Fix TDZ error: firstPagePromise is referenced in getDownloadInfo().then()
  // before its const declaration. Move getDownloadInfo block after destructuring.
  const tdzPattern =
    /(pdfDocument\.getDownloadInfo\(\)\.then\(\(\{[\s\S]*?\}\);)\s*(const pageLayoutPromise[\s\S]*?const \{\s*firstPagePromise,\s*onePageRendered,\s*pagesPromise\s*\} = pdfViewer;)/;

  if (tdzPattern.test(content)) {
    content = content.replace(tdzPattern, (_, getDownloadBlock, restBlock) => {
      return `${restBlock}\n    ${getDownloadBlock}`;
    });
    fs.writeFileSync(viewerPath, content);
    console.log("Patched viewer.mjs: fixed firstPagePromise TDZ issue");
  } else if (content.indexOf("const pageLayoutPromise") < content.indexOf("getDownloadInfo")) {
    console.log("viewer.mjs already patched: firstPagePromise TDZ fix applied");
  } else {
    console.warn("Warning: Could not find firstPagePromise TDZ pattern in viewer.mjs");
  }
}

function extractZip(zipPath) {
  if (fs.existsSync(PDFJS_DIR)) {
    fs.rmSync(PDFJS_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PDFJS_DIR, { recursive: true });

  if (process.platform === "win32") {
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PDFJS_DIR}' -Force"`,
      { stdio: "inherit" },
    );
  } else {
    execSync(`unzip -o -q "${zipPath}" -d "${PDFJS_DIR}"`, { stdio: "inherit" });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const forceUpdate =
    args.includes("--force") || args.includes("-f") || process.env.npm_config_force === "true";

  console.log("Fetching latest PDF.js release...");
  const release = await fetchJSON(GITHUB_API);

  if (release.message) {
    throw new Error(`GitHub API error: ${release.message}`);
  }

  const version = release.tag_name.replace("v", "");
  const asset = release.assets.find((a) => a.name === `pdfjs-${version}-dist.zip`);

  if (!asset) {
    throw new Error(`Could not find pdfjs-${version}-dist.zip in release assets`);
  }

  // Check current version
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  const currentVersion = pkg.pdfjsVersion;

  if (currentVersion === version && !forceUpdate) {
    console.log(`Already at latest version ${version}`);
    return;
  }

  console.log(`Updating from ${currentVersion || "unknown"} to ${version}...`);

  // Download
  const zipPath = path.join(VENDORS_DIR, asset.name);
  console.log(`Downloading ${asset.name}...`);
  await downloadFile(asset.browser_download_url, zipPath);
  console.log("Download complete.");

  // Extract
  console.log("Extracting...");
  extractZip(zipPath);

  // Patch viewer.html to include custom CSS/JS
  patchViewerHtml();

  // Patch viewer.mjs to disable printing
  patchViewerMjs();

  // Patch viewer.mjs to fix firstPagePromise TDZ error in Electron 30
  patchFirstPagePromiseTDZ();

  // Clean up zip
  fs.unlinkSync(zipPath);

  // Update package.json
  pkg.pdfjsVersion = version;
  fs.writeFileSync(PACKAGE_JSON, JSON.stringify(pkg, null, 2) + "\n");

  console.log(`\nUpdated to PDF.js ${version}`);
  console.log("Don't forget to test the viewer before committing!");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
