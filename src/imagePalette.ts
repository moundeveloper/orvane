// Palette from image: read an image's mood (its main colour groups) and build
// a calm UI palette that goes with it. The image's colours are never copied:
// each token gets a fixed lightness and a small amount of colour, the way the
// built-in palettes are made, and only the hues come from the image.

export type ImageSwatch = { hex: string; weight: number };
export type PaletteStrength = "quiet" | "balanced" | "vivid";
type Lch = { l: number; c: number; h: number };
type Palette = { canvas: string; app: string; text: string; accent: string; run: string };

const STRENGTH: Record<PaletteStrength, number> = { quiet: 0.6, balanced: 1, vivid: 1.6 };
// Lightness and colour per token at Balanced. Canvas and windows follow the
// image's key hue (the colour it is "about"); text, accent and working follow
// its shadow hue, so the palette reads as a pair instead of one flat tint.
const TARGETS = {
  canvas: { l: 0.925, c: 0.014, from: "key" },
  app: { l: 0.985, c: 0.005, from: "key" },
  text: { l: 0.43, c: 0.03, from: "shade" },
  accent: { l: 0.6, c: 0.06, from: "shade" },
  run: { l: 0.45, c: 0.08, from: "shade" },
} as const;
const GREY = 0.03; // below this chroma a colour group counts as grey

// --- colour maths (OKLab / OKLCH, sRGB) ------------------------------------

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r / 255), toLinear(g / 255), toLinear(b / 255)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function hexToLch(hex: string): Lch {
  const n = Number.parseInt(hex.slice(1), 16);
  const [L, a, b] = rgbToLab(n >> 16 & 255, n >> 8 & 255, n & 255);
  return { l: L, c: Math.hypot(a, b), h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 };
}

function labHex(L: number, a: number, b: number) {
  return "#" + labToLinear(L, a, b)
    .map((v) => Math.round(Math.min(1, Math.max(0, toGamma(Math.max(0, v)))) * 255).toString(16).padStart(2, "0"))
    .join("");
}

/** OKLCH to hex, lowering chroma until the colour fits in sRGB. */
export function lchHex({ l, c, h }: Lch) {
  const rad = h * Math.PI / 180;
  for (let chroma = c; ; chroma *= 0.92) {
    const a = chroma * Math.cos(rad), b = chroma * Math.sin(rad);
    if (chroma < 0.001 || labToLinear(l, a, b).every((v) => v >= -0.0005 && v <= 1.0005)) return labHex(l, a, b);
  }
}

function luminance(hex: string) {
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16 & 255, n >> 8 & 255, n & 255].map((v) => toLinear(v / 255));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

// --- reading the image -------------------------------------------------------

/**
 * Group an image's pixels (RGBA, e.g. from a 64 px canvas) into up to
 * `count` colours with k-means in OKLab. Returns them heaviest first, with
 * weights that add up to 1. Transparent pixels are ignored. Deterministic.
 */
export function readSwatches(pixels: ArrayLike<number>, count = 5): ImageSwatch[] {
  const points: [number, number, number][] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4)
    if (pixels[i + 3]! >= 128) points.push(rgbToLab(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!));
  if (!points.length) return [];
  // Farthest-point start: the first centre is the pixel nearest the average,
  // each next one the pixel farthest from the centres so far. Deterministic,
  // and distinct colours of similar lightness (violet hills, teal water) each
  // get their own group.
  const distance = (p: number[], c: number[]) => (p[0]! - c[0]!) ** 2 + (p[1]! - c[1]!) ** 2 + (p[2]! - c[2]!) ** 2;
  const mean = [0, 1, 2].map((d) => points.reduce((sum, p) => sum + p[d]!, 0) / points.length);
  let centres: [number, number, number][] = [[...points.reduce((a, p) => distance(p, mean) < distance(a, mean) ? p : a)]];
  const nearest = points.map((p) => distance(p, centres[0]!));
  while (centres.length < count) {
    let far = 0;
    nearest.forEach((d, i) => { if (d > nearest[far]!) far = i; });
    if (nearest[far]! < 1e-6) break;
    const centre: [number, number, number] = [...points[far]!];
    centres.push(centre);
    points.forEach((p, i) => { nearest[i] = Math.min(nearest[i]!, distance(p, centre)); });
  }
  const owner = new Int32Array(points.length).fill(-1);
  for (let round = 0; round < 16; round++) {
    let moved = false;
    points.forEach((p, i) => {
      let best = 0, bestDistance = Infinity;
      centres.forEach((c, j) => {
        const d = distance(p, c);
        if (d < bestDistance) { bestDistance = d; best = j; }
      });
      if (owner[i] !== best) { owner[i] = best; moved = true; }
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      const s = sums[owner[i]!]!;
      s[0]! += p[0]; s[1]! += p[1]; s[2]! += p[2]; s[3]!++;
    });
    centres = centres.map((c, j): [number, number, number] => {
      const s = sums[j]!;
      return s[3] ? [s[0]! / s[3], s[1]! / s[3], s[2]! / s[3]] : c;
    });
    if (!moved && round) break;
  }
  const sizes = centres.map(() => 0);
  for (const o of owner) sizes[o]!++;
  const merged = new Map<string, number>();
  centres.forEach((c, j) => {
    if (!sizes[j]) return;
    const hex = labHex(...c);
    merged.set(hex, (merged.get(hex) ?? 0) + sizes[j]! / points.length);
  });
  return [...merged].map(([hex, weight]) => ({ hex, weight: Math.round(weight * 1000) / 1000 }))
    .sort((x, y) => y.weight - x.weight);
}

/** Draw an image at most 64 px wide or tall and read its colour groups. */
export function readImageSwatches(image: CanvasImageSource & { width: number; height: number }) {
  const scale = Math.min(1, 64 / Math.max(image.width, image.height, 1));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return [];
  context.drawImage(image, 0, 0, width, height);
  return readSwatches(context.getImageData(0, 0, width, height).data);
}

// --- building the palette ----------------------------------------------------

export function hueName(h: number) {
  const names: [number, string][] = [[15, "pink"], [45, "red"], [80, "orange"], [115, "yellow"], [165, "green"], [215, "teal"], [270, "blue"], [330, "violet"], [360, "pink"]];
  return names.find(([end]) => h < end)![1];
}

type Mood = { key: Lch; shade: Lch; colourful: number; light: number; busy: boolean };

function readMood(swatches: ImageSwatch[]): Mood {
  const colours = swatches.map((s) => ({ ...hexToLch(s.hex), weight: s.weight }));
  const fallback = { l: 0.6, c: 0, h: 235, weight: 1 };
  // Key: the colour the image is "about": area counts, colour counts more.
  const key = colours.reduce((best, c) =>
    c.weight * (c.c + 0.02) > best.weight * (best.c + 0.02) ? c : best, colours[0] ?? fallback);
  // Shade: a darker group with its own hue (hills under a sky, a jacket on a
  // wall). Without one, the key hue carries the whole palette.
  const others = colours.filter((c) => c !== key && c.c >= GREY && hueGap(c.h, key.h) > 30);
  const shade = others.reduce<(typeof colours)[number] | undefined>((best, c) =>
    !best || c.weight * (1.2 - c.l) * (c.c + 0.02) > best.weight * (1.2 - best.l) * (best.c + 0.02) ? c : best, undefined) ?? key;
  const strong = colours.filter((c) => c.c >= GREY && c.weight >= 0.12);
  return {
    key, shade,
    colourful: Math.max(0, ...colours.map((c) => c.c)),
    light: colours.reduce((sum, c) => sum + c.l * c.weight, 0),
    busy: strong.some((a) => strong.some((b) => hueGap(a.h, b.h) > 90)),
  };
}

/** Short words for what the image feels like, shown as tags. */
export function imageMood(swatches: ImageSwatch[]) {
  const mood = readMood(swatches);
  const tags: string[] = [];
  if (mood.colourful < GREY) tags.push("Muted");
  else {
    const h = mood.key.h;
    if (h < 110 || h >= 345) tags.push("Warm");
    else if (h >= 165 && h < 290) tags.push("Cool");
    if (mood.shade !== mood.key) tags.push(`${hueName(mood.shade.h)[0]!.toUpperCase()}${hueName(mood.shade.h).slice(1)} shadows`);
  }
  tags.push(mood.light > 0.72 ? "Bright" : mood.light < 0.45 ? "Dark" : "Mid light");
  tags.push(mood.busy ? "Busy" : "Calm");
  return tags;
}

/**
 * The palette that goes with an image, plus one line per token saying where
 * it came from. Text stays at 4.5:1 or more on windows, and white text on the
 * Working colour stays readable.
 */
export function paletteFromSwatches(swatches: ImageSwatch[], strength: PaletteStrength = "balanced") {
  const mood = readMood(swatches);
  // A grey image gives a grey palette: colour scales with how colourful it is.
  const amount = STRENGTH[strength] * Math.min(1, mood.colourful / GREY);
  const hue = { key: mood.key.h, shade: mood.shade.h };
  const palette = {} as Palette;
  for (const [token, target] of Object.entries(TARGETS) as [keyof Palette, (typeof TARGETS)[keyof Palette]][])
    palette[token] = lchHex({ l: target.l, c: target.c * amount, h: hue[target.from] });
  for (let l = TARGETS.text.l; contrastRatio(palette.text, palette.app) < 4.5 && l > 0.15; l -= 0.02)
    palette.text = lchHex({ l, c: TARGETS.text.c * amount, h: hue.shade });
  for (let l = TARGETS.run.l; contrastRatio(palette.run, "#ffffff") < 4.5 && l > 0.15; l -= 0.02)
    palette.run = lchHex({ l, c: TARGETS.run.c * amount, h: hue.shade });
  const grey = amount === 0;
  const keyName = hueName(hue.key);
  const shadeName = hueName(hue.shade);
  const warm = hue.key < 110 || hue.key >= 345;
  const cool = hue.key >= 165 && hue.key < 290;
  const why: Palette = grey
    ? { canvas: "grey image, neutral", app: "neutral near-white", text: "neutral, dark", accent: "neutral, mid", run: "accent, deeper" }
    : {
        canvas: `${keyName}, almost grey`,
        app: `${warm ? "warm" : cool ? "cool" : "soft"} near-white`,
        text: `${shadeName}, dark`,
        accent: `${shadeName}, softened`,
        run: "accent, deeper",
      };
  return { palette, why };
}
