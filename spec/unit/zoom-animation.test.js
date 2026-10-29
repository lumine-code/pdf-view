const test = require("node:test");
const assert = require("node:assert/strict");
const ZoomAnimation = require("../../lib/zoom-animation");

function fixture(initialTime = 1000) {
  let now = initialTime;
  let nextFrame = 1;
  const frames = new Map();
  const applied = [];
  let refreshes = 0;
  const window = {
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const view = {
    destroyed: false,
    pdfDocument: {},
    element: { ownerDocument: { defaultView: window } },
    pdfViewer: {
      currentScale: 1,
      refresh: () => refreshes++,
    },
    layoutChanged() {},
    showError: (error) => assert.fail(error),
  };
  const animation = new ZoomAnimation(view);
  animation.captureAnchor = (origin) => ({ origin });
  animation.apply = (scale, final) => {
    applied.push({ time: now, scale, final });
    view.pdfViewer.currentScale = scale;
  };
  return {
    animation,
    view,
    applied,
    setTime(time) {
      assert.ok(time >= now, "The test clock must move forwards");
      now = time;
    },
    frame(time) {
      this.setTime(time);
      assert.equal(frames.size, 1, "Exactly one animation frame should be pending");
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
    get pendingFrames() {
      return frames.size;
    },
    get refreshes() {
      return refreshes;
    },
  };
}

test("wheel retargets keep scaling while requested targets accumulate", async () => {
  const clock = fixture();
  let requestedScale = 1;
  let completion;
  let lastInputTime;
  for (let index = 1; index <= 30; index++) {
    const frameTime = 1000 + index * 16.7;
    lastInputTime = frameTime - 0.1;
    clock.setTime(lastInputTime);
    requestedScale *= 1.1;
    const promise = clock.animation.to(requestedScale);
    completion ??= promise;
    assert.equal(promise, completion, "Retargeting should preserve the active completion");
    assert.equal(clock.animation.targetScale, requestedScale);
    const beforeFrame = clock.view.pdfViewer.currentScale;
    clock.frame(frameTime);
    assert.ok(
      clock.view.pdfViewer.currentScale > beforeFrame,
      `Zoom must visibly advance during wheel input ${index}`,
    );
    assert.ok(clock.view.pdfViewer.currentScale < requestedScale);
  }
  assert.ok(requestedScale > 17, "Wheel targets should accumulate independently of drawn scale");
  assert.ok(clock.view.pdfViewer.currentScale > 1.05);
  assert.equal(clock.applied.length, 30);
  assert.ok(clock.applied.every(({ final }) => !final));

  clock.frame(lastInputTime + 150);
  assert.equal(clock.view.pdfViewer.currentScale, requestedScale);
  assert.equal(await completion, requestedScale);
  assert.equal(clock.animation.active, false);
  assert.equal(clock.pendingFrames, 0);
});

test("zoom starts at the input time and finishes after 150 ms without an empty frame", async () => {
  const clock = fixture(1250);
  let completions = 0;
  const completion = clock.animation.to(2, { onComplete: () => completions++ });

  clock.frame(1290);
  assert.ok(clock.view.pdfViewer.currentScale > 1);
  assert.ok(clock.view.pdfViewer.currentScale < 2);
  assert.equal(clock.applied[0].final, false);

  clock.frame(1400);
  assert.equal(await completion, 2);
  assert.equal(clock.view.pdfViewer.currentScale, 2);
  assert.equal(clock.applied.at(-1).final, true);
  assert.equal(completions, 1);
  assert.equal(clock.animation.active, false);
  assert.equal(clock.pendingFrames, 0);
});

test("cancellation resolves completion and clears the active animation", async () => {
  const clock = fixture();
  let completions = 0;
  const completion = clock.animation.to(2, { onComplete: () => completions++ });
  clock.frame(1040);
  const interruptedScale = clock.view.pdfViewer.currentScale;

  clock.animation.cancel();

  assert.equal(await completion, undefined);
  assert.equal(clock.animation.active, false);
  assert.equal(clock.animation.targetScale, null);
  assert.equal(clock.pendingFrames, 0);
  assert.equal(clock.view.pdfViewer.currentScale, interruptedScale);
  assert.equal(clock.refreshes, 1);
  assert.equal(completions, 0);
});
