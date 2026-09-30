// Small, structurally complete documents for tests that exercise the real parser.
function createPdf({ pages = 1, outline = [], rotation = 0, prefix = "", tail = "" } = {}) {
  const objects = ["", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const add = (object) => objects.push(object);
  const literal = (value) => `(${String(value).replace(/[\\()]/g, "\\$&")})`;
  const pageRefs = [];
  for (let index = 0; index < pages; index++) {
    const contents = `BT /F1 14 Tf 72 720 Td ${literal(`PDF integration page ${index + 1}`)} Tj ET`;
    const stream = add(
      `<< /Length ${Buffer.byteLength(contents)} >>\nstream\n${contents}\nendstream`,
    );
    pageRefs.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate ${rotation} /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pages} >>`;
  let catalog = "<< /Type /Catalog /Pages 2 0 R";
  if (outline.length) {
    const rootRef = add("");
    const itemRefs = outline.map(() => add(""));
    const names = [];
    outline.forEach((item, index) => {
      const pageRef = pageRefs[item.page ?? 0];
      const destination = `[${pageRef} 0 R /${item.mode ?? "FitH"} ${item.coordinates ?? item.top ?? 700}]`;
      if (item.dest) names.push(`${literal(item.dest)} ${destination}`);
      objects[itemRefs[index] - 1] =
        `<< /Title ${literal(item.title ?? "Section")} /Parent ${rootRef} 0 R /Dest ${item.dest ? literal(item.dest) : destination}${index ? ` /Prev ${itemRefs[index - 1]} 0 R` : ""}${index + 1 < itemRefs.length ? ` /Next ${itemRefs[index + 1]} 0 R` : ""} >>`;
    });
    objects[rootRef - 1] =
      `<< /Type /Outlines /First ${itemRefs[0]} 0 R /Last ${itemRefs.at(-1)} 0 R /Count ${itemRefs.length} >>`;
    catalog += ` /Outlines ${rootRef} 0 R`;
    if (names.length) catalog += ` /Names << /Dests << /Names [${names.join(" ")}] >> >>`;
  }
  objects[0] = `${catalog} >>`;
  let document = `${prefix}%PDF-1.7\n`;
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n${tail}`;
  return Buffer.from(document);
}

module.exports = { createPdf };
