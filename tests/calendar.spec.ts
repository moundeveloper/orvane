import { expect, test } from "./fixtures";

test("Calendar jumps to a month and accepts a time from the keyboard", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create Calendar" }).click();

  const month = page.getByRole("button", { name: "Choose month and year" });
  await month.click();
  const monthPicker = page.getByRole("dialog", {
    name: "Choose month and year",
  });
  await monthPicker.getByRole("button", { name: "Mar", exact: true }).click();
  await expect(month).toContainText("March");
  await expect(monthPicker).toBeHidden();

  const time = page.getByRole("button", {
    name: "Time (optional; adds a reminder)",
  });
  await time.press("Enter");
  const timePicker = page.getByRole("dialog", {
    name: "Time (optional; adds a reminder)",
  });
  await timePicker
    .getByRole("listbox", { name: "Hour" })
    .getByRole("option", { name: "14", exact: true })
    .press("Enter");
  await expect(time).toContainText("14:00");
  await timePicker
    .getByRole("listbox", { name: "Minute" })
    .getByRole("option", { name: "35", exact: true })
    .press("Enter");
  await expect(timePicker).toBeHidden();
  await expect(time).toBeFocused();
  await expect(time).toContainText("14:35");
});
