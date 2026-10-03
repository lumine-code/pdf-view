const fs = require("fs");
const os = require("os");
const path = require("path");
const DocumentReplacement = require("../lib/document-replacement");
const RefreshController = require("../lib/refresh-controller");

describe("PDF document replacement protocol", () => {
  let directory, filePath, owner, replacement;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-replacement-"));
    filePath = path.join(directory, "next.pdf");
    fs.writeFileSync(filePath, "PDF bytes");
    owner = {
      ready: true,
      filePath: "previous.pdf",
      autoRefresh: false,
      fileOperationDepth: 0,
      destroyed: false,
      canReplaceDocument: () => true,
      sendMessage: jasmine.createSpy("sendMessage").and.returnValue(true),
      setFile: jasmine.createSpy("setFile").and.callFake((nextPath, hash) => {
        owner.filePath = nextPath;
        owner.hash = hash;
        owner.refreshController.resetForFile();
      }),
      messageHandlers: { pdfjsOutline: jasmine.createSpy("outline") },
    };
    owner.refreshController = new RefreshController(owner);
    replacement = new DocumentReplacement(owner);
    owner.documentReplacement = replacement;
    owner.refreshController.currentRequestId = 0;
  });

  afterEach(() => {
    replacement.destroy();
    owner.refreshController.destroy();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const message = (type, extra = {}) =>
    replacement.handleMessage({ type, requestId: owner.refreshController.nextRequestId, ...extra });

  it("publishes metadata and buffered navigation only after document initialization", async () => {
    const result = replacement.replace(filePath, "#page=2&new-tag");
    expect(owner.sendMessage).toHaveBeenCalledWith({
      type: "prepareDocument",
      filePath,
      hash: "#page=2&new-tag",
      requestId: 1,
    });
    message("documentPrepared");
    expect(owner.sendMessage).toHaveBeenCalledWith({ type: "commitDocument", requestId: 1 });
    message("documentLoaded");
    message("pdfjsOutline", { outline: ["new"] });
    expect(owner.setFile).not.toHaveBeenCalled();
    expect(owner.messageHandlers.pdfjsOutline).not.toHaveBeenCalled();
    message("documentCommitted");
    expect(await result).toBe(true);
    expect(owner.setFile).toHaveBeenCalledWith(filePath, "#page=2&new-tag", undefined);
    expect(owner.refreshController.currentRequestId).toBe(1);
    expect(owner.refreshController.loadedDiskFingerprint).not.toBeNull();
    expect(owner.messageHandlers.pdfjsOutline).toHaveBeenCalledTimes(1);
    expect(owner.sendMessage).toHaveBeenCalledWith({ type: "acceptDocument", requestId: 1 });
  });

  it("waits for cancellation recovery and ignores a late commit after abort", async () => {
    const controller = new AbortController();
    const result = replacement.replace(filePath, "", { signal: controller.signal });
    const error = result.catch((failure) => failure);
    message("documentPrepared");
    controller.abort();
    expect(owner.sendMessage).toHaveBeenCalledWith({ type: "cancelDocument", requestId: 1 });
    message("documentCommitted");
    expect(owner.setFile).not.toHaveBeenCalled();
    expect(replacement.pending).toBe(true);
    message("documentCancelled");
    expect((await error).name).toBe("AbortError");
    expect(replacement.pending).toBe(false);
    expect(owner.filePath).toBe("previous.pdf");
  });

  it("does not apply messages from a cancelled request during the next replacement", async () => {
    const controller = new AbortController();
    const first = replacement.replace(filePath, "#first", { signal: controller.signal });
    const cancelled = first.catch((error) => error);
    controller.abort();
    message("documentCancelled");
    await cancelled;
    const next = replacement.replace(filePath, "#next");
    expect(replacement.handleMessage({ type: "documentCommitted", requestId: 1 })).toBe(false);
    expect(owner.setFile).not.toHaveBeenCalled();
    message("documentPrepared");
    message("documentCommitted");
    expect(await next).toBe(true);
    expect(owner.hash).toBe("#next");
  });

  it("rejects preparation failures while preserving the previous URI", async () => {
    const result = replacement.replace(filePath, "#new");
    const error = result.catch((failure) => failure);
    message("documentReplacementError", { message: "Invalid PDF" });
    expect((await error).message).toBe("Invalid PDF");
    expect(owner.setFile).not.toHaveBeenCalled();
    expect(owner.filePath).toBe("previous.pdf");
    expect(replacement.pending).toBe(false);
  });

  it("queues the newest document behind cancelled preparation recovery", async () => {
    const controller = new AbortController();
    const first = replacement.replace(filePath, "#first", { signal: controller.signal });
    const cancelled = first.catch((error) => error);
    message("documentPrepared");
    controller.abort();
    const newest = replacement.replace(filePath, "#newest");
    expect(
      owner.sendMessage.calls.allArgs().filter(([data]) => data.type === "prepareDocument").length,
    ).toBe(1);
    message("documentCancelled");
    expect((await cancelled).name).toBe("AbortError");
    expect(owner.sendMessage.calls.mostRecent().args[0]).toEqual({
      type: "prepareDocument",
      filePath,
      hash: "#newest",
      requestId: 2,
    });
    message("documentPrepared");
    message("documentCommitted");
    expect(await newest).toBe(true);
    expect(owner.hash).toBe("#newest");
  });

  it("rejects failed acceptance without publishing replacement metadata", async () => {
    owner.sendMessage.and.callFake((data) => data.type !== "acceptDocument");
    const result = replacement.replace(filePath, "#new");
    const error = result.catch((failure) => failure);
    message("documentPrepared");
    message("documentCommitted");
    expect(owner.setFile).not.toHaveBeenCalled();
    message("documentCancelled");
    expect((await error).message).toContain("Unable to accept PDF");
    expect(owner.filePath).toBe("previous.pdf");
  });

  it("declines encrypted replacements so the ordinary opener can show its password dialog", async () => {
    const result = replacement.replace(filePath, "#new");
    message("documentReplacementDeclined");
    expect(await result).toBe(false);
    expect(owner.setFile).not.toHaveBeenCalled();
    expect(owner.filePath).toBe("previous.pdf");
    expect(replacement.pending).toBe(false);
  });

  it("restores the old document when the prepared file disappears before publication", async () => {
    const result = replacement.replace(filePath, "#new");
    const error = result.catch((failure) => failure);
    message("documentPrepared");
    fs.unlinkSync(filePath);
    message("documentCommitted");
    expect(owner.setFile).not.toHaveBeenCalled();
    expect(owner.sendMessage).toHaveBeenCalledWith({ type: "cancelDocument", requestId: 1 });
    message("documentCancelled");
    expect((await error).code).toBe("ENOENT");
    expect(owner.filePath).toBe("previous.pdf");
  });

  it("rejects a request aborted before preparation and releases work on destruction", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await replacement
          .replace(filePath, "", { signal: controller.signal })
          .catch((error) => error)
      ).name,
    ).toBe("AbortError");
    expect(owner.sendMessage).not.toHaveBeenCalled();
    const result = replacement.replace(filePath, "");
    const error = result.catch((failure) => failure);
    owner.destroyed = true;
    replacement.destroy();
    expect((await error).name).toBe("AbortError");
    expect(replacement.pending).toBe(false);
  });
});
