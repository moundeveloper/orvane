import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test("dropping folders on the canvas compares contents and copies individual files", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const left = info.outputPath("left"),
    right = info.outputPath("right");
  await Promise.all([
    mkdir(join(left, "nested"), { recursive: true }),
    mkdir(right, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(left, "changed.txt"), "north\n"),
    writeFile(join(right, "changed.txt"), "south\n"),
    writeFile(join(left, "nested", "missing.txt"), "copy me"),
  ]);
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const dataTransfer = await page.evaluateHandle(
    ({ left, right }) => {
      const transfer = new DataTransfer();
      transfer.setData(
        "application/x-orvane-files",
        JSON.stringify({ paths: [left, right], dirs: [left, right] }),
      );
      return transfer;
    },
    { left, right },
  );
  await page
    .locator(".canvas-background")
    .dispatchEvent("drop", { dataTransfer, clientX: 720, clientY: 460 });
  const comparison = page.getByRole("region", {
    name: "Folder comparison",
    exact: true,
  });
  await expect(comparison).toContainText("2 differences", { timeout: 15000 });
  const changed = comparison
    .getByRole("row")
    .filter({ hasText: "changed.txt" });
  await changed.getByRole("button", { name: "Open diff" }).click();
  const diff = comparison.getByRole("region", { name: "File diff" });
  await expect(diff).toBeInViewport();
  await expect(diff).toContainText("-north");
  await expect(diff).toContainText("+south");
  await diff.getByRole("button", { name: "Close diff" }).click();
  await changed.getByRole("button", { name: "Copy right" }).click();
  expect(await readFile(join(right, "changed.txt"), "utf8")).toBe("south\n");
  await comparison.getByRole("button", { name: "Replace file" }).click();
  await expect(comparison).toContainText("1 difference");
  expect(await readFile(join(right, "changed.txt"), "utf8")).toBe("north\n");
  await comparison
    .getByRole("row")
    .filter({ hasText: "nested/missing.txt" })
    .getByRole("button", { name: "Copy right" })
    .click();
  await expect(comparison).toContainText("0 differences");
  expect(await readFile(join(right, "nested", "missing.txt"), "utf8")).toBe(
    "copy me",
  );
});

test("Terminal creates a Playwright card with source links and targeted reruns", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const project = info.outputPath("sample-project");
  const spec = join(project, "checkout.spec.ts");
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, "playwright.config.ts"),
    "export default { testDir: '.', workers: 1 };",
  );
  const source = `import { test, expect } from '@playwright/test';
test("checkout total", () => {
  expect(1).toBe(2);
});
test("shipping estimate", () => {
  expect("slow").toBe("fast");
});`;
  await writeFile(spec, source);
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Terminal", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Pin Playwright results", exact: true })
    .click();
  const card = page.getByRole("region", {
    name: "Playwright test results",
    exact: true,
  });
  await card.getByRole("textbox", { name: "Project folder" }).fill(project);
  await card.getByRole("button", { name: "Run suite" }).click();
  const failures = card.getByRole("list", { name: "Failed tests" });
  await expect(failures.getByRole("listitem")).toHaveCount(2, {
    timeout: 40000,
  });
  const checkout = failures
    .getByRole("listitem")
    .filter({ hasText: "checkout total" });
  await checkout.getByRole("button", { name: /^checkout\.spec\.ts:/ }).click();
  await expect(card.getByRole("region", { name: "Test source" })).toContainText(
    "expect(1).toBe(2)",
  );
  await expect(card.locator("code.target")).toContainText("expect(1).toBe(2)");
  await expect(card.locator("code.target")).toBeInViewport();
  await card.getByRole("button", { name: "Close source" }).click();
  await writeFile(
    spec,
    source.replace("expect(1).toBe(2)", "expect(1).toBe(1)"),
  );
  await checkout.getByRole("button", { name: "Rerun test" }).click();
  await expect(card.getByRole("status")).toHaveText("The test passed.", {
    timeout: 40000,
  });
  await expect(failures.getByRole("listitem")).toHaveCount(1);
  await expect(failures).toContainText("shipping estimate");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByRole("list", { name: "Failed tests" })).toContainText(
    "shipping estimate",
  );
});
