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

function patchViewerMjs() {
  const viewerPath = path.join(PDFJS_DIR, "web", "viewer.mjs");
  let content = fs.readFileSync(viewerPath, "utf8");
  let changed = false;

  // Disable printing by setting supportsPrinting to false
  const printPattern = /supportsPrinting:\s*\{\s*value:\s*true,/g;
  if (printPattern.test(content)) {
    content = content.replace(printPattern, "supportsPrinting: {\n    value: false,");
    changed = true;
    console.log("Patched viewer.mjs: supportsPrinting set to false");
  } else if (/supportsPrinting:\s*\{\s*value:\s*false,/.test(content)) {
    console.log("viewer.mjs already patched: supportsPrinting is false");
  } else {
    console.warn("Warning: Could not find supportsPrinting pattern in viewer.mjs");
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

  // Suppress noisy PDF.js warnings from malformed embedded fonts.
  const verbosityPattern = /verbosity:\s*\{\s*value:\s*1,\s*kind:\s*OptionKind\.API\s*\}/;
  if (verbosityPattern.test(content)) {
    content = content.replace(
      verbosityPattern,
      "verbosity: {\n    value: 0,\n    kind: OptionKind.API\n  }",
    );
    changed = true;
    console.log("Patched viewer.mjs: default verbosity set to errors only");
  } else if (/verbosity:\s*\{\s*value:\s*0,\s*kind:\s*OptionKind\.API\s*\}/.test(content)) {
    console.log("viewer.mjs already patched: default verbosity is errors only");
  } else {
    console.warn("Warning: Could not find verbosity pattern in viewer.mjs");
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

function patchPolyfills() {
  const importLine = 'import "../../custom/api-fix.js";\n';
  const files = [
    path.join(PDFJS_DIR, "build", "pdf.mjs"),
    path.join(PDFJS_DIR, "build", "pdf.worker.mjs"),
    path.join(PDFJS_DIR, "web", "viewer.mjs"),
  ];

  for (const filePath of files) {
    const file = path.basename(filePath);
    let content = fs.readFileSync(filePath, "utf8");
    if (content.includes("custom/api-fix.js")) {
      console.log(`${file} already imports api-fix.js`);
      continue;
    }
    // Insert import after the license/version comment block
    content = content.replace(/^(\/\*\*[\s\S]*?\*\/\n)/, "$1" + importLine);
    fs.writeFileSync(filePath, content);
    console.log(`Patched ${file} with api-fix.js import`);
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

  // Patch pdf.mjs and pdf.worker.mjs with polyfills for Electron 30
  patchPolyfills();

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
