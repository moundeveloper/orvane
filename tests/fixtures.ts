import { test as base } from "@playwright/test";
import { randomUUID } from "node:crypto";
export * from "@playwright/test";
export const test = base.extend<{ _databaseNamespace: void }>({
  page: async ({ context }, use) => {
    const page = await context.newPage();
    const goto = page.goto.bind(page),
      reload = page.reload.bind(page);
    const ready = async () => {
      if (["/", "/index.html"].includes(new URL(page.url()).pathname))
        await page.locator('main[data-ready="true"]').waitFor();
    };
    page.goto = async (...args) => {
      const response = await goto(...args);
      await ready();
      return response;
    };
    page.reload = async (...args) => {
      if (await page.locator("main").count())
        await page.locator('main[data-saved="true"]').waitFor();
      const response = await reload(...args);
      await ready();
      return response;
    };
    try {
      await use(page);
    } finally {
      await page.close();
    }
  },
  _databaseNamespace: [
    async ({ context, browser }, use, info) => {
      const headers = { "x-orvane-test-workspace": randomUUID() };
      const cookie = {
        name: "orvane-test-workspace",
        value: headers["x-orvane-test-workspace"],
        url: info.project.use.baseURL!,
      };
      await context.setExtraHTTPHeaders(headers);
      await context.addCookies([cookie]);
      const original = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const created = await original({
          ...options,
          baseURL: options?.baseURL || info.project.use.baseURL,
          extraHTTPHeaders: { ...options?.extraHTTPHeaders, ...headers },
        });
        await created.addCookies([cookie]);
        return created;
      };
      try {
        await use();
      } finally {
        browser.newContext = original;
      }
    },
    { auto: true },
  ],
});
