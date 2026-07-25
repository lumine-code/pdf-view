const { enrichOutline, markOutlineState } = require("../lib/outline");

describe("enrichOutline", () => {
  const sample = () => [
    { title: "1 Intro", items: [{ title: "1.1 Motivation", items: [] }] },
    { title: "2 Body", items: [], resolvedDest: { pageIndex: 4 } },
  ];

  it("annotates text, children alias, 1-based level, and document-order rows", () => {
    const outline = enrichOutline(sample(), false);

    expect(outline[0].text).toBe("1 Intro");
    expect(outline[0].level).toBe(1);
    expect(outline[0].revel).toBe(1);
    expect(outline[0].children).toBe(outline[0].items);
    expect(outline[0].startPoint.row).toBe(0);

    const child = outline[0].children[0];
    expect(child.text).toBe("1.1 Motivation");
    expect(child.level).toBe(2);
    expect(child.startPoint.row).toBe(1);

    expect(outline[1].text).toBe("2 Body");
    expect(outline[1].startPoint.row).toBe(2);
  });

  it("strips leading section numbers when snoFilter is set", () => {
    const outline = enrichOutline(sample(), true);
    expect(outline[0].text).toBe("Intro");
    expect(outline[0].children[0].text).toBe("Motivation");
    expect(outline[1].text).toBe("Body");
  });

  it("exposes a 1-based page badge that tracks the resolved destination", () => {
    const outline = enrichOutline(sample(), false);
    expect(outline[1].badge).toBe(5); // pageIndex 4 -> page 5
    expect(outline[0].badge).toBe(null); // no resolved destination
  });

  it("returns an empty array for a missing outline", () => {
    expect(enrichOutline(null, false)).toEqual([]);
    expect(enrichOutline(undefined, true)).toEqual([]);
  });
});

describe("markOutlineState", () => {
  const sample = () => [
    { destHash: "#a", children: [{ destHash: "#b", children: [] }] },
    { destHash: "#c", children: [] },
  ];

  it("marks only entries whose destination hash is currently visible", () => {
    const headers = sample();
    const hasVisible = markOutlineState(headers, ["#b"]);

    expect(headers[0].visibility).toBe(0);
    expect(headers[0].children[0].visibility).toBe(1);
    expect(headers[1].visibility).toBe(0);
    expect(hasVisible).toBe(true); // a descendant is visible
  });

  it("resets currentCount and stackCount on every pass", () => {
    const headers = sample();
    headers[0].currentCount = 7;
    headers[0].stackCount = 3;

    markOutlineState(headers, ["#a"]);

    expect(headers[0].visibility).toBe(1);
    expect(headers[0].currentCount).toBe(0);
    expect(headers[0].stackCount).toBe(0);
  });

  it("reports no visibility for empty inputs", () => {
    expect(markOutlineState([], null)).toBe(false);
    expect(markOutlineState(sample(), [])).toBe(false);
  });
});
