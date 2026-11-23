// Records a Browser page in real time for the AI (MCP browser_record): the
// frames Chromium paints, so animations, typing and carousels can be read
// frame by frame instead of guessed from screenshots taken seconds apart.
//
// Frames come from the DevTools screencast (Page.startScreencast), which
// sends a frame only when the page paints something new. When the page's
// debugger is unavailable (a paused off-screen page), it falls back to
// capturePage at the asked rate. On stop, each region is cropped from the
// frames, frames that look like the one before are dropped, and the kept
// "keyframes" come back as JPEG crops. All frames are also saved to disk
// (userData/recordings/<id>/frames) for deeper analysis.
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeImage } from "electron";

// browser_record asks for 30 s at most; flow_tests films a whole flow.
const MAX_MS = 120_000;
const MAX_FRAMES = 900;
const KEEP_RECORDINGS = 12;
/** A recording nobody stopped is dropped this long after it ended. */
const FORGET_MS = 120_000;
const THUMB_WIDTH = 48;
const CROP_WIDTH = 480;

/** Mean colour difference of two BGRA bitmaps, 0 (same) to 1. */
export function bitmapDifference(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4)
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / ((a.length / 4) * 3 * 255);
}

/**
 * Picks the frames worth looking at: the first, every frame that differs
 * from the last kept one by more than threshold, and the last if it moved.
 * More than max keyframes are thinned evenly over time.
 * @param {number} count frames
 * @param {(i: number, j: number) => number} difference
 */
export function pickKeyframes(count, difference, threshold, max) {
  if (!count) return [];
  const kept = [{ index: 0, change: 1 }];
  for (let i = 1; i < count; i++) {
    const change = difference(i, kept[kept.length - 1].index);
    if (change > threshold) kept.push({ index: i, change });
  }
  const last = count - 1;
  if (kept[kept.length - 1].index !== last) {
    const change = difference(last, kept[kept.length - 1].index);
    if (change > threshold / 3) kept.push({ index: last, change });
  }
  if (kept.length <= max) return kept;
  if (max < 2) return kept.slice(0, Math.max(1, max));
  const picked = [];
  for (let k = 0; k < max; k++) {
    const item = kept[Math.round((k * (kept.length - 1)) / (max - 1))];
    if (picked[picked.length - 1] !== item) picked.push(item);
  }
  return picked;
}

/** A page capture on white: pages without a background are transparent,
 * which JPEG turns black. Chromium bitmaps are premultiplied BGRA. */
function onWhite(image) {
  const size = image.getSize();
  const pixels = Buffer.from(image.toBitmap());
  for (let i = 0; i < pixels.length; i += 4) {
    const gap = 255 - pixels[i + 3];
    if (!gap) continue;
    pixels[i] = Math.min(255, pixels[i] + gap);
    pixels[i + 1] = Math.min(255, pixels[i + 1] + gap);
    pixels[i + 2] = Math.min(255, pixels[i + 2] + gap);
    pixels[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, size);
}

const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const number = (value, fallback, low, high) =>
  typeof value === "number" && Number.isFinite(value) ? clamp(value, low, high) : fallback;

/**
 * @param {{ folder: string, isPaused: (guestId: number) => boolean }} options
 */
export function setupPageRecorder({ folder, isPaused }) {
  /** @type {Map<string, any>} */
  const recordings = new Map();
  /** A page's screencast still being stopped: the next recording waits for it,
   * or the old session's detach would end the new one. */
  const stopping = new Map();
  const root = join(folder, "recordings");

  function finishCollecting(rec, reason) {
    if (!rec.collecting) return;
    rec.collecting = false;
    rec.endedAt = Date.now();
    rec.ended = reason;
    clearTimeout(rec.limit);
    clearInterval(rec.poll);
    rec.detach?.();
    rec.forget = setTimeout(() => recordings.delete(rec.id), FORGET_MS);
  }

  function addFrame(rec, data, at) {
    if (!rec.collecting) return;
    // Keep to the asked rate: a frame that comes too soon after the last kept
    // one replaces it, so the final state of a burst is never lost.
    const previous = rec.frames[rec.frames.length - 1];
    if (previous && at - previous.slot < rec.interval) {
      previous.data = data;
      previous.t = at;
    } else rec.frames.push({ t: at, slot: at, data });
    rec.lastFrameAt = at;
    if (rec.frames.length >= MAX_FRAMES) finishCollecting(rec, "frame limit");
  }

  async function startScreencast(guest, rec) {
    const debug = guest.debugger;
    await stopping.get(guest.id);
    let owned = false;
    if (!debug.isAttached()) {
      debug.attach("1.3");
      owned = true;
    }
    const onMessage = (_event, method, params) => {
      if (method !== "Page.screencastFrame") return;
      void debug.sendCommand("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
      const seconds = params.metadata?.timestamp;
      addFrame(rec, Buffer.from(params.data, "base64"), typeof seconds === "number" ? seconds * 1000 : Date.now());
    };
    const onDetach = () => finishCollecting(rec, "page debugger closed");
    debug.on("message", onMessage);
    debug.on("detach", onDetach);
    rec.detach = () => {
      debug.removeListener("message", onMessage);
      debug.removeListener("detach", onDetach);
      if (guest.isDestroyed() || !debug.isAttached()) return;
      const done = (async () => {
        await debug.sendCommand("Emulation.setDefaultBackgroundColorOverride", {}).catch(() => undefined);
        await debug.sendCommand("Page.stopScreencast", {}).catch(() => undefined);
        if (owned && !guest.isDestroyed() && debug.isAttached()) {
          try { debug.detach(); } catch {}
        }
      })();
      stopping.set(guest.id, done);
      void done.finally(() => {
        if (stopping.get(guest.id) === done) stopping.delete(guest.id);
      });
    };
    try {
      // Pages without a background would come out black in JPEG.
      await debug.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 255, g: 255, b: 255, a: 1 } }).catch(() => undefined);
      await debug.sendCommand("Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        maxWidth: rec.maxWidth,
        maxHeight: 4000,
        everyNthFrame: 1,
      });
    } catch (error) {
      rec.detach();
      rec.detach = undefined;
      throw error;
    }
  }

  function startPolling(guest, rec) {
    let busy = false;
    const grab = async () => {
      if (busy || !rec.collecting || guest.isDestroyed()) return;
      busy = true;
      try {
        const image = await guest.capturePage();
        if (!image.isEmpty()) {
          const { width } = image.getSize();
          const scaled = width > rec.maxWidth ? image.resize({ width: rec.maxWidth }) : image;
          addFrame(rec, onWhite(scaled).toJPEG(75), Date.now());
        }
      } catch {
        // A navigation in between; the next tick tries again.
      } finally {
        busy = false;
      }
    };
    void grab();
    rec.poll = setInterval(grab, rec.interval);
  }

  async function start(guest, op) {
    for (const other of recordings.values())
      if (other.guestId === guest.id && other.collecting) finishCollecting(other, "replaced by a new recording");
    const fps = number(op.fps, 8, 1, 15);
    const rec = {
      id: randomUUID().slice(0, 8),
      guestId: guest.id,
      startedAt: Date.now(),
      interval: 1000 / fps,
      maxWidth: number(op.maxWidth, 1280, 320, 1920),
      frames: [],
      collecting: true,
      mode: "screencast",
      lastFrameAt: 0,
    };
    recordings.set(rec.id, rec);
    const paused = isPaused(guest.id);
    try {
      if (paused) throw Error("paused");
      await startScreencast(guest, rec);
    } catch {
      rec.mode = "capture";
      startPolling(guest, rec);
    }
    rec.limit = setTimeout(() => finishCollecting(rec, "time limit"), number(op.maxMs, MAX_MS, 500, MAX_MS));
    guest.once("destroyed", () => finishCollecting(rec, "page closed"));
    return {
      recordingId: rec.id,
      mode: rec.mode,
      startedAt: rec.startedAt,
      ...(paused ? { warning: "The page is paused off-screen: its scripts do not run, so only CSS animations and video move. Show the tab to record it live." } : {}),
    };
  }

  function recordingOf(guest, id) {
    const rec = typeof id === "string" ? recordings.get(id) : undefined;
    if (!rec || rec.guestId !== guest.id) throw Error("No such recording on this page (recordings are kept 2 minutes after they end).");
    return rec;
  }

  function status(guest, op) {
    const rec = recordingOf(guest, op.recordingId);
    return {
      recordingId: rec.id,
      recording: rec.collecting,
      frames: rec.frames.length,
      elapsedMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
      lastFrameMs: rec.lastFrameAt ? Math.max(0, rec.lastFrameAt - rec.startedAt) : undefined,
      ...(rec.ended ? { ended: rec.ended } : {}),
    };
  }

  function prune() {
    try {
      const old = readdirSync(root)
        .map((name) => ({ name, at: statSync(join(root, name)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
        .slice(KEEP_RECORDINGS);
      for (const item of old) rmSync(join(root, item.name), { recursive: true, force: true });
    } catch {}
  }

  async function stop(guest, op) {
    const rec = recordingOf(guest, op.recordingId);
    finishCollecting(rec, rec.ended ?? "stopped");
    clearTimeout(rec.forget);
    recordings.delete(rec.id);
    // A page that painted nothing new while recording: one picture of it.
    if (!rec.frames.length && !guest.isDestroyed()) {
      try {
        const image = await guest.capturePage();
        if (!image.isEmpty()) {
          const { width } = image.getSize();
          rec.frames.push({ t: Date.now(), data: onWhite(width > rec.maxWidth ? image.resize({ width: rec.maxWidth }) : image).toJPEG(75) });
        }
      } catch {}
    }
    const frames = rec.frames;
    const t0 = rec.startedAt;
    const viewport = op.viewport && op.viewport.width > 0 ? op.viewport : undefined;
    const regions = Array.isArray(op.regions) && op.regions.length ? op.regions : [undefined];
    const threshold = number(op.threshold, 0.012, 0.001, 0.5);
    const max = Math.round(number(op.maxKeyframes, 16, 1, 40));

    // Decode each frame once; crop a small thumbnail per region to compare.
    const thumbs = regions.map(() => []);
    const crops = regions.map(() => []);
    for (const [i, frame] of frames.entries()) {
      const image = nativeImage.createFromBuffer(frame.data);
      const size = image.getSize();
      for (const [r, region] of regions.entries()) {
        const rect = cropRect(region, viewport, size);
        crops[r][i] = rect;
        if (!rect) continue;
        thumbs[r][i] = image.crop(rect).resize({ width: THUMB_WIDTH, quality: "good" }).toBitmap();
      }
    }

    const saved = op.save === false ? undefined : join(root, `${new Date(t0).toISOString().replace(/[:.]/g, "-")}-${rec.id}`);
    const result = {
      recordingId: rec.id,
      mode: rec.mode,
      ended: rec.ended,
      startedAt: t0,
      durationMs: (rec.endedAt ?? Date.now()) - t0,
      frames: frames.length,
      regions: [],
    };
    for (const [r, region] of regions.entries()) {
      const usable = frames.map((_, i) => i).filter((i) => crops[r][i]);
      const picks = pickKeyframes(
        usable.length,
        (a, b) => bitmapDifference(thumbs[r][usable[a]], thumbs[r][usable[b]]),
        threshold,
        max,
      ).map((pick) => ({ ...pick, index: usable[pick.index] }));
      const keyframes = picks.map((pick, k) => {
        const frame = frames[pick.index];
        const next = picks[k + 1] ? frames[picks[k + 1].index].t : (rec.endedAt ?? frame.t);
        let crop = nativeImage.createFromBuffer(frame.data).crop(crops[r][pick.index]);
        if (crop.getSize().width > CROP_WIDTH) crop = crop.resize({ width: CROP_WIDTH, quality: "good" });
        return {
          frame: pick.index,
          ms: Math.max(0, Math.round(frame.t - t0)),
          holdMs: Math.max(0, Math.round(next - frame.t)),
          change: Math.round(pick.change * 1000) / 1000,
          image: crop.toJPEG(80).toString("base64"),
          size: crop.getSize(),
        };
      });
      result.regions.push({ index: r, keyframes });
    }

    if (saved) {
      try {
        mkdirSync(join(saved, "frames"), { recursive: true });
        for (const [i, frame] of frames.entries())
          writeFileSync(join(saved, "frames", `${String(i).padStart(4, "0")}-${Math.max(0, Math.round(frame.t - t0))}ms.jpg`), frame.data);
        writeFileSync(join(saved, "recording.json"), JSON.stringify({
          recordingId: rec.id,
          url: guest.isDestroyed() ? undefined : guest.getURL(),
          startedAt: new Date(t0).toISOString(),
          durationMs: result.durationMs,
          mode: rec.mode,
          viewport,
          regions: op.regions,
          frames: frames.map((frame, i) => ({ file: `frames/${String(i).padStart(4, "0")}-${Math.max(0, Math.round(frame.t - t0))}ms.jpg`, ms: Math.max(0, Math.round(frame.t - t0)) })),
          keyframes: result.regions.map((region) => region.keyframes.map(({ image: _image, ...rest }) => rest)),
        }, null, 2));
        result.folder = saved;
        prune();
      } catch (error) {
        result.saveWarning = `Frames were not saved: ${error.message}`;
      }
    }
    return result;
  }

  /** The region in frame pixels, inside the frame, or undefined if empty. */
  function cropRect(region, viewport, size) {
    if (!region || !viewport) return { x: 0, y: 0, width: size.width, height: size.height };
    const scale = size.width / viewport.width;
    const x = clamp(Math.round(region.x * scale), 0, size.width);
    const y = clamp(Math.round(region.y * scale), 0, size.height);
    const width = clamp(Math.round(region.width * scale), 0, size.width - x);
    const height = clamp(Math.round(region.height * scale), 0, size.height - y);
    return width >= 2 && height >= 2 ? { x, y, width, height } : undefined;
  }

  return {
    /** Handles record-start, record-status and record-stop page operations. */
    handle(guest, op) {
      if (op.type === "record-start") return start(guest, op);
      if (op.type === "record-status") return status(guest, op);
      if (op.type === "record-stop") return stop(guest, op);
      throw Error("Unknown page action.");
    },
  };
}
