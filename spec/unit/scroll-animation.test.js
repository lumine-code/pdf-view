const test = require("node:test");
const assert = require("node:assert/strict");
const ScrollAnimation = require("../../lib/scroll-animation");

function fixture() {
  let now = 1000;
  let nextFrame = 0;
  const frames = new Map();
  const ownerWindow = {
    performance: { now: () => now },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame(callback) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const viewport = {
    ownerDocument: { defaultView: ownerWindow },
    scrollLeft: 150,
    scrollTop: 200,
    scrollWidth: 2000,
    scrollHeight: 3000,
    clientWidth: 650,
    clientHeight: 420,
    scrollTo({ left, top, behavior }) {
      assert.equal(behavior, "instant");
      this.scrollLeft = left;
      this.scrollTop = top;
    },
  };
  const view = { viewport, destroyed: false, hasLayout: () => true };
  const animation = new ScrollAnimation(view);
  return {
    animation,
    ownerWindow,
    view,
    viewport,
    setTime(time) {
      assert.ok(time >= now, "The input clock must move forwards");
      now = time;
    },
    frame(callbackTime, timestamp = callbackTime) {
      this.setTime(callbackTime);
      assert.equal(frames.size, 1, "Exactly one animation frame should be pending");
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback(timestamp);
    },
    get pendingFrames() {
      return frames.size;
    },
  };
}

test("lagging frame timestamps cannot move either axis backwards or prove elapsed animation time", async () => {
  const clock = fixture();
  const completion = clock.animation.by({ left: 100, top: 80 });
  assert.equal(clock.animation.window, clock.ownerWindow);

  // Callback execution time and its frame timestamp are distinct. Two RAFs
  // do not guarantee a timestamp strictly between input and the 120ms end.
  clock.frame(1001, 999);
  clock.frame(1002, 1000);
  assert.equal(clock.viewport.scrollLeft, 150);
  assert.equal(clock.viewport.scrollTop, 200);
  assert.equal(clock.animation.active, true);

  clock.frame(1030);
  assert.ok(clock.viewport.scrollLeft > 150 && clock.viewport.scrollLeft < 250);
  assert.ok(clock.viewport.scrollTop > 200 && clock.viewport.scrollTop < 280);
  clock.frame(1120);
  await completion;
  assert.equal(clock.viewport.scrollLeft, 250);
  assert.equal(clock.viewport.scrollTop, 280);
  assert.equal(clock.animation.active, false);
  assert.equal(clock.pendingFrames, 0);
});

test("held inputs retarget the drawn position while accumulating both outstanding distances", async () => {
  const clock = fixture();
  const completion = clock.animation.by({ top: 42 });
  for (let index = 0; index < 3; index++)
    assert.equal(clock.animation.by({ left: 65 }), completion);
  assert.equal(clock.animation.targetLeft, 345);
  assert.equal(clock.animation.targetTop, 242);
  clock.frame(1030);
  const left = clock.viewport.scrollLeft;
  const top = clock.viewport.scrollTop;
  assert.ok(left > 150 && left < 345);
  assert.ok(top > 200 && top < 242);

  clock.setTime(1040);
  assert.equal(clock.animation.by({ left: -20, top: 10 }), completion);
  assert.equal(clock.viewport.scrollLeft, left);
  assert.equal(clock.viewport.scrollTop, top);
  assert.equal(clock.animation.targetLeft, 325);
  assert.equal(clock.animation.targetTop, 252);
  clock.frame(1070);
  assert.ok(clock.viewport.scrollLeft > left && clock.viewport.scrollLeft < 325);
  assert.ok(clock.viewport.scrollTop > top && clock.viewport.scrollTop < 252);
  clock.frame(1160);
  await completion;
  assert.equal(clock.viewport.scrollLeft, 325);
  assert.equal(clock.viewport.scrollTop, 252);
  assert.equal(clock.pendingFrames, 0);
});

test("cancellation resolves the current completion and removes its owning-window frame", async () => {
  const clock = fixture();
  const completion = clock.animation.by({ left: 100, top: 100 });
  clock.frame(1040);
  const position = [clock.viewport.scrollLeft, clock.viewport.scrollTop];
  clock.animation.cancel();
  await completion;
  assert.deepEqual([clock.viewport.scrollLeft, clock.viewport.scrollTop], position);
  assert.equal(clock.pendingFrames, 0);
  assert.equal(clock.animation.frame, null);
  assert.equal(clock.animation.active, false);
});

for (const invalidation of ["destroyed", "no-layout"]) {
  test(`a frame stops and resolves its completion when the view becomes ${invalidation}`, async () => {
    const clock = fixture();
    const completion = clock.animation.by({ top: 100 });
    if (invalidation === "destroyed") clock.view.destroyed = true;
    else clock.view.hasLayout = () => false;
    clock.frame(1030);
    await completion;
    assert.equal(clock.viewport.scrollTop, 200);
    assert.equal(clock.animation.active, false);
    assert.equal(clock.pendingFrames, 0);
  });
}
