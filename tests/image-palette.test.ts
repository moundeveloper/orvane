import test from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, imageMood, paletteFromSwatches, readSwatches } from "../src/imagePalette.ts";

// A sunset: orange sky, yellow sun, violet hills, teal water, deep night.
const sunset = [
  { hex: "#f98f3a", weight: 0.34 }, { hex: "#6a3f86", weight: 0.22 }, { hex: "#1c7e92", weight: 0.18 },
  { hex: "#2e274e", weight: 0.14 }, { hex: "#f9d46b", weight: 0.12 },
];

function pixels(colours: [number, number, number, number][]) {
  return Uint8ClampedArray.from(colours.flat());
}

test("readSwatches groups pixels into weighted colours, heaviest first", () => {
  const data = pixels([
    ...Array(60).fill([249, 143, 58, 255]),
    ...Array(30).fill([106, 63, 134, 255]),
    ...Array(10).fill([28, 126, 146, 255]),
    ...Array(20).fill([0, 0, 0, 0]), // transparent: ignored
  ]);
  const swatches = readSwatches(data, 3);
  assert.deepEqual(swatches.map((s) => s.hex), ["#f98f3a", "#6a3f86", "#1c7e92"]);
  assert.deepEqual(swatches.map((s) => s.weight), [0.6, 0.3, 0.1]);
  assert.deepEqual(readSwatches(pixels([[0, 0, 0, 0]])), []);
});

test("a sunset gives a calm warm palette with violet text, not its own colours", () => {
  const { palette, why } = paletteFromSwatches(sunset);
  assert.deepEqual(palette, { canvas: "#eee4de", app: "#fdf9f7", text: "#554b5c", accent: "#8b769b", run: "#634876" });
  for (const swatch of sunset) assert.ok(!Object.values(palette).includes(swatch.hex));
  assert.ok(contrastRatio(palette.text, palette.app) >= 4.5);
  assert.ok(contrastRatio(palette.run, "#ffffff") >= 4.5);
  assert.equal(why.canvas, "orange, almost grey");
  assert.equal(why.text, "violet, dark");
  assert.deepEqual(imageMood(sunset), ["Warm", "Violet shadows", "Mid light", "Busy"]);
});

test("strength only changes how much colour; a grey image stays grey", () => {
  const quiet = paletteFromSwatches(sunset, "quiet").palette;
  const vivid = paletteFromSwatches(sunset, "vivid").palette;
  assert.notEqual(quiet.accent, vivid.accent);
  const grey = paletteFromSwatches([{ hex: "#808080", weight: 0.7 }, { hex: "#202020", weight: 0.3 }], "vivid");
  for (const hex of Object.values(grey.palette)) {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
    assert.ok(Math.max(r!, g!, b!) - Math.min(r!, g!, b!) <= 2, hex);
  }
  assert.deepEqual(imageMood([{ hex: "#808080", weight: 1 }]), ["Muted", "Mid light", "Calm"]);
});
