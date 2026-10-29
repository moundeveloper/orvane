import type { Page } from "@playwright/test";
import type { Workspace } from "../src/model";
export async function readStored(page: Page): Promise<Workspace> {
  return page.evaluate(async () => {
    const response = await fetch("/__orvane/storage/state");
    if (!response.ok) throw Error("Could not read the test database.");
    return (await response.json()).data;
  });
}
