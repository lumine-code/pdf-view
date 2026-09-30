const navigation = require("../lib/pdfjs/navigation");

describe("PDF.js navigation geometry", () => {
  const viewBox = [10, 20, 210, 420];
  const destination = (name, ...args) => [0, { name }, ...args];

  it("interprets PDF destination types and retains valid zero coordinates", () => {
    expect(navigation.destinationPoint(destination("FitH", 350), viewBox)).toEqual([10, 350]);
    expect(navigation.destinationPoint(destination("FitBH", null), viewBox)).toEqual([10, 420]);
    expect(navigation.destinationPoint(destination("Fit"), viewBox)).toEqual([10, 420]);
    expect(navigation.destinationPoint(destination("FitV", 75), viewBox)).toEqual([75, 420]);
    expect(navigation.destinationPoint(destination("XYZ", 0, 0, null), viewBox)).toEqual([0, 0]);
    expect(navigation.destinationPoint(destination("FitR", 30, 50, 170, 380), viewBox)).toEqual([
      30, 380,
    ]);
    expect(navigation.destinationPoint(destination("Unknown"), viewBox)).toBeNull();
  });

  it("transforms a destination rectangle through the actual rotated viewport", () => {
    const viewport = { viewBox, convertToViewportPoint: (x, y) => [2 * (y - 20), 2 * (x - 10)] };
    expect(navigation.viewportDestination(destination("FitR", 30, 50, 170, 380), viewport)).toEqual(
      [60, 40],
    );
  });

  it("uses crop-box coordinates and the inverse viewport transform to determine visibility", () => {
    // A cropped, rotated page rendered at scale two: PDF's top-to-bottom axis
    // runs horizontally on screen. Only its right half is visible here.
    const viewport = {
      viewBox,
      width: 800,
      height: 400,
      convertToPdfPoint: (x, y) => [y / 2 + 10, x / 2 + 20],
    };
    const page = { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 };
    expect(
      navigation.visiblePageRange(page, { left: 400, top: 0, right: 800, bottom: 400 }, viewport),
    ).toEqual({ start: 0, end: 0.5 });
    expect(
      navigation.visiblePageRange(page, { left: 900, top: 0, right: 1000, bottom: 400 }, viewport),
    ).toBeNull();
  });

  it("ignores off-screen pages in horizontal and spread layouts while retaining spanning sections", () => {
    const positions = [
      { page: 0, progress: 0, item: { destHash: "#intro" } },
      { page: 1, progress: 0.5, item: { destHash: "#second" } },
      { page: 2, progress: 0, item: { destHash: "#third" } },
    ];
    expect(navigation.visibleSections(positions, [{ index: 1, start: 0, end: 0.4 }])).toEqual([
      "#intro",
    ]);
    expect(navigation.visibleSections(positions, [{ index: 1, start: 0.6, end: 1 }])).toEqual([
      "#second",
    ]);
    expect(navigation.visibleSections(positions, [{ index: 2, start: 0, end: 1 }])).toEqual([
      "#third",
    ]);
  });

  it("preserves a one-page numeric zoom and offsets while clamping a page after a rebuild", () => {
    expect(navigation.viewHash({ page: 8, zoom: "2.5", left: 12.2, top: 300.7 }, 1)).toBe(
      "page=1&zoom=250,12,301",
    );
    expect(navigation.viewHash({ page: 2, zoom: "page-width", left: 0, top: 420 }, 5)).toBe(
      "page=2&zoom=page-width,0,420",
    );
  });

  it("rejects invalid page indices instead of scheduling repeated load listeners", () => {
    expect(navigation.pageIndex(-1, 3)).toBeNull();
    expect(navigation.pageIndex(3, 3)).toBeNull();
    expect(navigation.pageIndex(1.5, 3)).toBeNull();
    expect(navigation.pageIndex(2, 3)).toBe(2);
  });
});
