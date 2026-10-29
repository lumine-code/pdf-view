const DURATION = 120;

class ScrollAnimation {
  constructor(view) {
    this.view = view;
    this.active = false;
  }

  by({ left = 0, top = 0 }, { fractional = false } = {}) {
    if (this.view.destroyed || !this.view.hasLayout()) return Promise.resolve();
    const viewport = this.view.viewport;
    this.window = viewport.ownerDocument.defaultView;
    this.startLeft = viewport.scrollLeft;
    this.startTop = viewport.scrollTop;
    this.targetLeft = clamp(
      (this.active ? this.targetLeft : this.startLeft) + left,
      viewport.scrollWidth - viewport.clientWidth,
      fractional,
    );
    this.targetTop = clamp(
      (this.active ? this.targetTop : this.startTop) + top,
      viewport.scrollHeight - viewport.clientHeight,
      fractional,
    );
    this.startedAt = this.window.performance.now();
    if (!this.active) {
      this.active = true;
      this.promise = new Promise((resolve) => {
        this.resolve = resolve;
      });
    }
    const promise = this.promise;
    if (
      this.window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      (this.startLeft === this.targetLeft && this.startTop === this.targetTop)
    ) {
      this.apply(this.targetLeft, this.targetTop);
      this.cancel();
    } else if (!this.frame) {
      this.frame = this.window.requestAnimationFrame((time) => this.tick(time));
    }
    return promise;
  }

  tick(time) {
    this.frame = null;
    if (!this.active || this.view.destroyed || !this.view.hasLayout()) return this.cancel();
    const progress = Math.min(1, Math.max(0, (time - this.startedAt) / DURATION));
    const eased = 1 - (1 - progress) ** 3;
    this.apply(
      this.startLeft + (this.targetLeft - this.startLeft) * eased,
      this.startTop + (this.targetTop - this.startTop) * eased,
    );
    if (progress === 1) this.cancel();
    else this.frame = this.window.requestAnimationFrame((next) => this.tick(next));
  }

  apply(left, top) {
    this.view.viewport.scrollTo({ left, top, behavior: "instant" });
  }

  cancel() {
    if (this.frame) this.window.cancelAnimationFrame(this.frame);
    this.frame = null;
    this.active = false;
    this.targetLeft = this.targetTop = null;
    this.resolve?.();
    this.resolve = null;
  }
}

function clamp(value, maximum, fractional) {
  const bounded = Math.max(0, Math.min(Math.max(0, maximum), value));
  return fractional ? bounded : Math.round(bounded);
}

module.exports = ScrollAnimation;
