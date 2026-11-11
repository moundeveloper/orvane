// The performance runtime every code app receives as `window.orvane`, ahead
// of its own code. Plain JavaScript on purpose: it is injected verbatim into
// the app's sandboxed frame (see appRuntime.ts), so it must not depend on the
// bundler. The host only tells it whether the app is on screen.
//
// Enforced without the app's cooperation:
// - setInterval slows to once a second while the app is off screen (the
//   browser already stops requestAnimationFrame there) and returns to its
//   own cadence when the app is back.
// - Tasks that block the app's thread for SLOW_TASK_MS or more are reported
//   to the host, which shows them to the author in Build mode.
//
// Offered so apps need not reinvent them: visibility, frame-coalesced
// writes, debounce/throttle, idle work, cleanup and a windowed list.
// Documented for authors in APP_PERFORMANCE.md.
(function (slowTaskMs) {
  let visible = true;
  const watchers = new Set();
  const cleanups = new Set();

  // Intervals keep their ids and schedule, but tick at most once a second
  // while nobody can see the app.
  const nativeTimeout = window.setTimeout.bind(window),
    nativeClearTimeout = window.clearTimeout.bind(window),
    nativeInterval = window.setInterval.bind(window),
    nativeClearInterval = window.clearInterval.bind(window);
  const intervals = new Map();
  let nextInterval = 0;
  const arm = (id) => {
    const entry = intervals.get(id);
    if (!entry) return;
    const every = visible ? entry.every : Math.max(entry.every, 1000);
    const now = performance.now();
    // Keep the original phase while visible so counting clocks do not drift.
    if (entry.due <= now) entry.due = now + every;
    entry.timer = nativeTimeout(
      entry.run,
      visible ? entry.due - now : Math.max(entry.due - now, every),
    );
  };
  window.setInterval = (handler, delay = 0, ...args) => {
    if (typeof handler !== "function")
      return nativeInterval(handler, delay, ...args);
    const id = -++nextInterval;
    const every = Math.max(4, Number(delay) || 0);
    intervals.set(id, {
      timer: 0,
      every,
      due: performance.now() + every,
      run() {
        const entry = intervals.get(id);
        if (!entry) return;
        entry.due += entry.every;
        arm(id);
        handler(...args);
      },
    });
    arm(id);
    return id;
  };
  const clear = (native) => (id) => {
    const entry = id === undefined ? undefined : intervals.get(id);
    if (!entry) return native(id);
    nativeClearTimeout(entry.timer);
    intervals.delete(id);
  };
  window.clearInterval = clear(nativeClearInterval);
  window.clearTimeout = clear(nativeClearTimeout);

  addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      typeof event.data?.orvaneVisible !== "boolean" ||
      event.data.orvaneVisible === visible
    )
      return;
    visible = event.data.orvaneVisible;
    for (const [id, entry] of intervals) {
      nativeClearTimeout(entry.timer);
      arm(id);
    }
    for (const watcher of [...watchers]) watcher(visible);
    dispatchEvent(new CustomEvent("orvane:visibility", { detail: { visible } }));
  });
  addEventListener("pagehide", () => {
    for (const cleanup of [...cleanups]) cleanup();
    cleanups.clear();
  });
  try {
    new PerformanceObserver((list) => {
      const longest = Math.max(...list.getEntries().map((entry) => entry.duration));
      if (longest >= slowTaskMs)
        parent.postMessage({ orvaneCodeSlow: Math.round(longest) }, "*");
    }).observe({ type: "longtask" });
  } catch {
    // Long-task timing is unavailable; the app still runs.
  }

  const frameWork = new Set();
  let frameQueued = false;
  const api = {
    /** Whether the app is currently on screen. */
    get visible() {
      return visible;
    },
    /** Calls back when the app enters or leaves the screen. */
    onVisibility(watcher) {
      watchers.add(watcher);
      return () => watchers.delete(watcher);
    },
    /** Runs DOM writes once in the next frame; repeat calls with the same function collapse. */
    frame(work) {
      frameWork.add(work);
      if (frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(() => {
        frameQueued = false;
        const batch = [...frameWork];
        frameWork.clear();
        for (const item of batch) item();
      });
    },
    /** Runs after input has been quiet for `wait` ms. */
    debounce(work, wait = 150) {
      let timer = 0;
      return (...args) => {
        nativeClearTimeout(timer);
        timer = nativeTimeout(() => work(...args), wait);
      };
    },
    /** Runs at most once per `wait` ms, always with the latest arguments. */
    throttle(work, wait = 100) {
      let last = -Infinity,
        timer = 0,
        latest;
      return (...args) => {
        latest = args;
        const remaining = last + wait - performance.now();
        if (remaining <= 0) {
          last = performance.now();
          work(...latest);
        } else if (!timer)
          timer = nativeTimeout(() => {
            timer = 0;
            last = performance.now();
            work(...latest);
          }, remaining);
      };
    },
    /** Runs non-urgent work when the app's thread is free. */
    idle(work) {
      if ("requestIdleCallback" in window)
        requestIdleCallback(() => work(), { timeout: 2000 });
      else nativeTimeout(work, 50);
    },
    /** Registers teardown for when the app is reloaded or closed. */
    onCleanup(cleanup) {
      cleanups.add(cleanup);
      return () => cleanups.delete(cleanup);
    },
    /**
     * A windowed list: only the rows in view exist in the DOM, whatever the
     * count. `container` needs a fixed height; rows share `rowHeight`.
     */
    list(options) {
      const { container, rowHeight, render } = options;
      const overscan = options.overscan ?? 6;
      let count = options.count,
        first = -1,
        last = -1;
      const extent = document.createElement("div"),
        rows = document.createElement("div");
      extent.style.cssText = "position:relative;contain:layout style";
      rows.style.cssText = "position:absolute;left:0;right:0;top:0;will-change:transform";
      extent.append(rows);
      container.style.overflowY ||= "auto";
      container.replaceChildren(extent);
      const draw = (force = false) => {
        const from = Math.max(0, Math.floor(container.scrollTop / rowHeight) - overscan),
          to = Math.min(
            count,
            Math.ceil((container.scrollTop + container.clientHeight) / rowHeight) + overscan,
          );
        if (!force && from === first && to === last) return;
        first = from;
        last = to;
        const fragment = document.createDocumentFragment();
        for (let index = from; index < to; index++) {
          const made = render(index);
          let row;
          if (typeof made === "string") {
            row = document.createElement("div");
            row.textContent = made;
          } else if (made instanceof HTMLElement) row = made;
          else {
            row = document.createElement("div");
            row.append(made);
          }
          row.style.height = `${rowHeight}px`;
          row.style.boxSizing = "border-box";
          fragment.append(row);
        }
        rows.style.transform = `translateY(${from * rowHeight}px)`;
        rows.replaceChildren(fragment);
      };
      const size = () => {
        extent.style.height = `${count * rowHeight}px`;
        draw(true);
      };
      const scrolled = () => api.frame(draw);
      container.addEventListener("scroll", scrolled, { passive: true });
      const resized = new ResizeObserver(() => api.frame(draw));
      resized.observe(container);
      const destroy = () => {
        container.removeEventListener("scroll", scrolled);
        resized.disconnect();
        cleanups.delete(destroy);
      };
      cleanups.add(destroy);
      size();
      return {
        /** Re-renders the rows in view, optionally with a new row count. */
        update(next = count) {
          count = next;
          size();
        },
        destroy,
      };
    },
  };
  Object.defineProperty(window, "orvane", { value: Object.freeze(api) });
})(SLOW_TASK_MS);
