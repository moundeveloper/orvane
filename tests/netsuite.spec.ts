import { test, expect } from "./fixtures";

test("SuiteCloud can connect with a certificate before an auth ID exists", async ({ page }, info) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [{ id: "https://1964539.app.netsuite.com", label: "Dev", status: "ready", count: 1 }],
        run: async () => ({ rows: [] }),
      },
    };
  });
  const status = { accountId: "1964539", available: false, cli: "3.1.3", authIds: [] as string[], authId: null as string | null, created: false };
  const connections: unknown[] = [];
  const valid = { notBefore: "2020-01-01T00:00:00Z", notAfter: "2090-01-01T00:00:00Z", archived: false };
  await page.route("**/__orvane/certificates/list", (route) => route.fulfill({ json: {
    environments: [{ id: "dev", accountId: "1964539" }, { id: "prod", accountId: "100" }],
    certificates: [
      { id: "dev-pair", name: "SuiteCloud dev", environmentId: "dev", ...valid },
      { id: "prod-pair", name: "SuiteCloud production", environmentId: "prod", ...valid },
    ],
  } }));
  await page.route("**/__orvane/netsuite-workspace", (route) => {
    const request = route.request().postDataJSON();
    if (request.action === "suitecloud-connect") {
      connections.push(request);
      if (connections.length === 1) return route.fulfill({ status: 400, json: { error: "Certificate ID does not match." } });
      Object.assign(status, { available: true, authId: "orvane-1964539", authIds: ["orvane-1964539"], created: true });
    }
    const response = request.action === "task-runs" ? { runs: [] }
      : request.action === "suitecloud-tree" ? { files: [{ path: "deploy.xml", size: 12 }] }
      : status;
    return route.fulfill({ json: response });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const app = page.locator(".ns-workspace");
  await app.getByRole("button", { name: /^SuiteCloud Agent SDF workspace/ }).click();
  const suiteCloud = app.locator(".sc-view");
  await expect(suiteCloud.getByRole("button", { name: "Preview deploy" })).toBeDisabled();
  await expect(suiteCloud.getByRole("combobox", { name: "Certificate pair" })).toHaveText("SuiteCloud dev");
  const certificateId = suiteCloud.getByRole("textbox", { name: "NetSuite certificate ID" });
  await certificateId.fill("sample-cert-id");
  await suiteCloud.screenshot({ path: info.outputPath("certificate-connection.png") });
  await certificateId.press("Enter");
  await expect(suiteCloud.getByRole("alert")).toHaveText("Certificate ID does not match.");
  await expect(certificateId).toHaveValue("sample-cert-id");
  await suiteCloud.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(suiteCloud.getByText("orvane-1964539", { exact: true })).toBeVisible();
  await expect(suiteCloud.getByRole("button", { name: "deploy.xml" })).toBeVisible();
  await expect(suiteCloud.getByRole("button", { name: "Preview deploy" })).toBeEnabled();
  expect(connections).toEqual(Array.from({ length: 2 }, () => ({
    action: "suitecloud-connect", account: "1964539", certificatePairId: "dev-pair", certificateId: "sample-cert-id",
  })));
});

test("NetSuite views browse data and save queries", async ({ page }, info) => {
  // A cold dev server compiles the NetSuite app (and its CodeMirror editors) on first use.
  test.setTimeout(150_000);
  const editorErrors: string[] = [];
  page.on("pageerror", error => editorErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && message.text().includes("Invalid position")) editorErrors.push(message.text());
  });
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).netSuiteCalls = [];
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          {
            id: "https://123.app.netsuite.com",
            label: "123.app.netsuite.com",
            status: "ready",
            count: 2,
          },
        ],
        run: async (_id: string, op: string, args: any) => {
          (window as any).netSuiteCalls.push({ op, args });
          if (op === "scripts")
            return {
              rows: [
                {
                  id: 2,
                  name: "Order script",
                  scriptid: "customscript_order",
                  scripttype: "USEREVENT",
                  owner: "Alice",
                  scriptfile: "order.js",
                  fileid: 11,
                  deployments: 1,
                  deployed: 1,
                },
                {
                  id: 3,
                  name: "Invoice script",
                  scriptid: "customscript_invoice",
                  scripttype: "SCRIPTED",
                  owner: "Bob",
                  scriptfile: "invoice.js",
                  deployments: 1,
                  deployed: 1,
                },
              ],
            };
          if (op === "deployments")
            return {
              rows: [
                {
                  primarykey: args.id === 3 ? 4 : 3,
                  deploymentid: 1,
                  scriptid:
                    args.id === 3
                      ? "customdeploy_invoice"
                      : "customdeploy_order",
                  status: args.id === 3 ? "NOTSCHEDULED" : "RELEASED",
                  loglevel: "DEBUG",
                  recordtype: args.id === 3 ? null : "SALESORDER",
                  isdeployed: "T",
                },
              ],
            };
          if (op === "log-search")
            return {
              rows: [
                {
                  id: 1,
                  datetime: new Date().toISOString(),
                  level: "ERROR",
                  title: "Sample log",
                  detail: "Details",
                  deploymentId: 3,
                  deploymentScriptId: "customdeploy_order",
                },
              ],
              totalCount: 1,
            };
          if (op === "run-task")
            return { deploymentId: args.deploymentId, submittedAt: new Date().toISOString() };
          if (op === "task-status")
            return {
              instances: [
                { status: "Processing", percent: "40", stage: null, created: new Date().toISOString() },
              ],
            };
          if (op === "deployment-parameters")
            return {
              deploymentId: args.deploymentId,
              parameters: [
                { id: "custscript_batch", label: "Batch size", type: "integer", value: 50, text: "50" },
              ],
            };
          if (op === "save-deployment-parameters") {
            if ((window as any).failNextSave) {
              (window as any).failNextSave = false;
              throw Error("NetSuite rejected the parameter.");
            }
            return { deploymentId: args.deploymentId, saved: Object.keys(args.values) };
          }
          if (op === "script-logs")
            return {
              rows: [
                {
                  internalid: "1",
                  date: "2026-10-30",
                  time: "10:00",
                  type: "ERROR",
                  title: "Sample log",
                  detail: "Details",
                },
              ],
              totalCount: 1,
            };
          if (op === "folders")
            return { rows: [{ id: 10, name: "SuiteScripts" }] };
          if (op === "folder")
            return {
              folders: [],
              files: [
                {
                  id: 11,
                  name: "order.js",
                  filetype: "JAVASCRIPT",
                  filesize: 20,
                },
              ],
            };
          if (op === "file")
            return {
              id: 11,
              name: "order.js",
              content: "define([], function() {});",
              base64: btoa("define([], function() {});"),
            };
          if (op === "search-files")
            return { folders: [], files: [{ id: 11, name: "order.js" }] };
          if (op === "tables")
            return { data: [{ id: "Customer", label: "Customer" }] };
          if (op === "table-detail")
            return {
              data: {
                fields: [{ id: "entityid", label: "Name", dataType: "TEXT" }],
                joins: [],
              },
            };
          if (op === "create-folder" || op === "upload-file") return { id: 50 };
          if (op === "save-file") return { id: args.id, content: args.content };
          if (op === "query")
            return {
              rows: [{ id: args.offset + 1, name: args.sql }],
              totalCount: 101,
              offset: args.offset,
            };
          return { name: "Alice", account: "123", role: 3 };
        },
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const app = page.locator(".ns-workspace");
  await app.getByRole("button", { name: "Dashboards", exact: true }).click();
  await app.getByRole("button", { name: "Create dashboard" }).click();
  await app
    .getByRole("textbox", { name: "Dashboard title" })
    .fill("Operations");
  await app.getByRole("button", { name: "Add widget" }).click();
  await app.getByRole("textbox", { name: "Widget title" }).fill("Files");
  await app.getByRole("button", { name: "Done", exact: true }).click();
  await app.getByRole("button", { name: "Pin dashboard to Home" }).click();
  await app.getByRole("button", { name: "Home", exact: true }).click();
  await expect(
    app.locator(".ns-home").getByText("Pinned dashboards"),
  ).toBeVisible();
  await app
    .locator(".ns-home")
    .getByRole("button", { name: /Operations/ })
    .filter({ hasText: "Operations" })
    .click();
  await app
    .locator(".dash-widget")
    .getByRole("button", { name: "Refresh" })
    .click();
  await expect(app.locator(".dash-widget")).toContainText(
    "SELECT id, name FROM file",
  );
  await app.getByRole("button", { name: "Apps menu" }).click();
  await app
    .getByRole("region", { name: "Apps menu" })
    .getByRole("button", { name: /Scripts/ })
    .filter({ hasText: "Scripts" })
    .click();
  // Scripts: the table, deployments inline, the selected script's logs beside it.
  const orderScript = app.getByRole("row", { name: /Order script/ });
  await orderScript.getByRole("button", { name: "Show deployments" }).click();
  await expect(app.getByText("customdeploy_order")).toBeVisible();
  await expect(app.locator(".sc-drow").filter({ hasText: "customdeploy_order" })).toContainText("SALESORDER");
  const scriptSide = app.getByRole("complementary", { name: "Selected script" });
  await expect(scriptSide.getByText("Sample log")).toBeVisible();
  // Map/Reduce and Scheduled deployments run from here and show their state.
  const invoice = app.getByRole("row", { name: /Invoice script/ });
  await invoice.getByRole("button", { name: "Show deployments" }).click();
  const invoiceDeployment = app.locator(".sc-drow").filter({ hasText: "customdeploy_invoice" });
  await invoiceDeployment.getByRole("button", { name: "Run" }).click();
  await expect(invoiceDeployment.getByRole("status")).toContainText("Processing", { timeout: 10_000 });
  await page.screenshot({ path: info.outputPath("scripts-table.png") });
  // Parameters: edit and save with Ctrl+S.
  await invoiceDeployment.getByRole("button", { name: "Parameters" }).click();
  const parameters = page.getByRole("dialog", { name: "Deployment parameters" });
  const batch = parameters.getByRole("textbox");
  await expect(batch).toHaveValue("50");
  await batch.fill("75");
  // A failed save keeps the edit on screen, so it can be retried.
  await page.evaluate(() => ((window as any).failNextSave = true));
  await batch.press("Control+s");
  await expect(parameters.getByRole("alert")).toContainText("NetSuite rejected the parameter.");
  await expect(batch).toHaveValue("75");
  await batch.press("Control+s");
  await expect
    .poll(() => page.evaluate(() => (window as any).netSuiteCalls.filter((c: any) => c.op === "save-deployment-parameters").map((c: any) => c.args)))
    .toEqual([
      { deploymentId: 4, values: { custscript_batch: 75 } },
      { deploymentId: 4, values: { custscript_batch: 75 } },
    ]);
  await expect(parameters.getByRole("alert")).toHaveCount(0);
  await batch.press("Escape");
  await expect(parameters).toHaveCount(0);
  // Type chips filter the list.
  await app.getByRole("group", { name: "Script types" }).getByRole("button", { name: /Scheduled/ }).click();
  await expect(orderScript).toHaveCount(0);
  await app.getByRole("group", { name: "Script types" }).getByRole("button", { name: /Scheduled/ }).click();
  // Opening a script turns the table into the workbench; Esc goes back.
  await orderScript.dblclick();
  const scriptEditor = app.getByRole("region", { name: "Script", exact: true });
  await expect(scriptEditor.getByRole("tab", { name: /order\.js/ })).toBeVisible();
  await expect(scriptEditor.locator(".cm-content")).toContainText("define([], function() {});");
  await expect(scriptSide.getByText("customdeploy_order")).toBeVisible();
  await page.screenshot({ path: info.outputPath("scripts-workbench.png") });
  // The related-file search opens above the editor, not clipped inside the
  // tab strip: its field is the topmost element where it is drawn.
  await scriptEditor.getByRole("button", { name: "Add related file" }).click();
  const addFile = page.getByRole("dialog", { name: "Add related file" });
  const addField = addFile.getByRole("textbox");
  await expect(addField).toBeFocused();
  expect(await addField.evaluate((field) => {
    const box = field.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === field;
  })).toBe(true);
  expect((await addFile.boundingBox())!.height).toBeGreaterThan(40);
  await addField.press("Escape");
  await expect(addFile).toHaveCount(0);
  await app.getByRole("listbox", { name: "Scripts" }).getByRole("option", { name: /Order script/ }).press("Escape");
  await expect(scriptEditor).toHaveCount(0);
  await expect(orderScript).toHaveAttribute("aria-selected", "true");
  await app.getByRole("button", { name: "Apps menu" }).click();
  await app
    .getByRole("region", { name: "Apps menu" })
    .getByRole("button", { name: /File Cabinet/ })
    .filter({ hasText: "File Cabinet" })
    .click();
  const suiteScripts = app
    .locator(".fc-content")
    .getByRole("row", { name: "SuiteScripts" });
  await suiteScripts.click();
  await expect(app.locator(".fc-detail")).toContainText("Internal ID");
  await expect(suiteScripts).toHaveAttribute("aria-selected", "true");
  await suiteScripts.dblclick();
  await expect(app.locator(".fc-status")).toContainText("0 folders, 1 file");
  await app.getByRole("button", { name: "New folder" }).click();
  await app.getByRole("textbox", { name: "New folder name" }).fill("Examples");
  await app
    .getByRole("dialog", { name: "New Folder" })
    .getByRole("button", { name: "Create" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).netSuiteCalls.some(
          (c: any) =>
            c.op === "create-folder" &&
            c.args.name === "Examples" &&
            c.args.folderId === 10,
        ),
      ),
    )
    .toBe(true);
  await app.locator(".fc-workspace input[type=file]").setInputFiles({
    name: "hello.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello"),
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).netSuiteCalls.some(
          (c: any) => c.op === "upload-file" && c.args.name === "hello.txt",
        ),
      ),
    )
    .toBe(true);
  await app.getByRole("button", { name: "Bookmark folder" }).click();
  await expect(app.locator(".fc-sidebar")).toContainText("SuiteScripts");
  const order = app.locator(".fc-content").getByRole("row", { name: /orders?\.js/ });
  await order.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Add Bookmark" }).click();
  await expect(app.locator(".fc-sidebar")).toContainText("order.js");
  await order.click();
  await app.locator(".fc-content").press("F2");
  await app.getByRole("textbox", { name: "New name" }).fill("orders.js");
  await app.getByRole("textbox", { name: "New name" }).press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).netSuiteCalls.some(
          (c: any) =>
            c.op === "rename-item" &&
            c.args.kind === "file" &&
            c.args.id === 11 &&
            c.args.name === "orders.js",
        ),
      ),
    )
    .toBe(true);
  await order.click({ button: "right" });
  await app.getByRole("menuitem", { name: "Delete" }).click();
  await app
    .getByRole("dialog", { name: "Delete" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).netSuiteCalls.some(
          (c: any) =>
            c.op === "delete-items" &&
            c.args.folderId === 10 &&
            c.args.fileIds.includes(11),
        ),
      ),
    )
    .toBe(true);
  await app.locator(".fc-sidebar").getByRole("button", { name: /Trash/ }).click();
  await expect(app.locator(".fc-trash")).toContainText("orders.js");
  await order.dblclick();
  await expect(app.getByRole("textbox", { name: "File content" })).toHaveText(
    "define([], function() {});",
  );
  await expect(
    app.getByRole("textbox", { name: "File content" }),
  ).toHaveAttribute("contenteditable", "false");
  await app.locator(".fc-switch").click();
  await app
    .getByRole("textbox", { name: "File content" })
    .fill("updated content");
  await app.getByRole("textbox", { name: "File content" }).press("Control+s");
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).netSuiteCalls.some(
          (c: any) =>
            c.op === "save-file" && c.args.content === "updated content",
        ),
      ),
    )
    .toBe(true);
  await expect(app.getByText("Unsaved draft", { exact: false })).toHaveCount(0);
  await app.getByRole("button", { name: "Apps menu" }).click();
  await app
    .getByRole("region", { name: "Apps menu" })
    .getByRole("button", { name: /SuiteQL/ })
    .filter({ hasText: "SuiteQL" })
    .click();
  await app.getByRole("textbox", { name: "Query name" }).fill("Customers");
  await app
    .getByRole("textbox", { name: "SuiteQL editor" })
    .fill("SELECT id FROM customer");
  await app
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query" })
    .click();
  await expect(app.locator(".ns-result-row")).toContainText(
    "SELECT id FROM customer",
  );
  await app
    .locator(".ns-query-limits")
    .getByRole("button", { name: "25", exact: true })
    .click();
  await app
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query" })
    .click();
  await expect(app.getByRole("button", { name: "Next" })).toBeDisabled();
  await app
    .locator(".ns-query-limits")
    .getByRole("button", { name: "1K", exact: true })
    .click();
  await app
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Run query" })
    .click();
  await app
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Trace" })
    .click();
  await expect(app.locator(".ns-trace")).toContainText("success", {
    timeout: 15000,
  });
  await app.getByRole("button", { name: "Results", exact: true }).click();
  await app
    .locator(".ns-query-toolbar")
    .getByRole("button", { name: "Schema" })
    .click();
  await app
    .getByRole("button", { name: /Customer/ })
    .last()
    .click();
  await expect(app.getByRole("button", { name: /entityid/ })).toBeVisible();
  await app.getByRole("button", { name: "Close schema" }).click();
  await app.getByRole("button", { name: "Next" }).click();
  await expect(app.locator(".ns-result-row")).toContainText("101");
  await app.getByRole("button", { name: "New query tab" }).click();
  await app.getByRole("tab", { name: "Customers" }).click();
  await expect(app.locator(".ns-result-row")).toContainText("101");
  await app.getByRole("button", { name: "Close Untitled query tab" }).click();
  await expect(app.getByRole("tab", { name: "Untitled query" })).toHaveCount(0);
  await app
    .locator(".ns-query-list")
    .getByRole("button", { name: "Untitled query" })
    .click();
  await expect(app.getByRole("tab", { name: "Untitled query" })).toBeVisible();
  const editor = app.getByRole("textbox", { name: "SuiteQL editor" });
  await editor.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" -- untitled edit");
  await app.getByRole("tab", { name: "Customers" }).click();
  await expect(editor).toHaveText("SELECT id FROM customer");
  await editor.click();
  await page.keyboard.press("Control+z");
  // Undo belongs to Customers even after switching files. Its original SQL
  // predates the replacement above; the other tab's edit stays independent.
  await expect(editor).toHaveText(
    "SELECT id, entityid FROM customer WHERE ROWNUM <= 20",
  );
  await page.keyboard.press("Control+y");
  await expect(editor).toHaveText("SELECT id FROM customer");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" WHERE entit");
  await expect(
    app.locator(".cm-tooltip-autocomplete").getByText("entityid"),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await app.getByRole("tab", { name: "Untitled query" }).click();
  await expect(editor).toContainText("-- untitled edit");
  await app.getByRole("tab", { name: "Customers" }).click();
  await page.locator('main[data-saved="true"]').waitFor();
  await page.reload();
  const restored = page.locator(".ns-workspace");
  await restored.getByRole("button", { name: "Dashboards" }).click();
  await expect(restored.locator(".dash-sidebar")).toContainText("Operations");
  await restored.getByRole("button", { name: "Apps menu" }).click();
  await restored
    .getByRole("region", { name: "Apps menu" })
    .getByRole("button", { name: /SuiteQL/ })
    .filter({ hasText: "SuiteQL" })
    .click();
  await expect(
    restored.getByRole("textbox", { name: "Query name" }),
  ).toHaveValue("Customers");
  await expect(
    restored.getByRole("textbox", { name: "SuiteQL editor" }),
  ).toHaveText("SELECT id FROM customer WHERE entit");
  expect(editorErrors).toEqual([]);
});

test("Home and navigation menu share preferred apps and an environment trail", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          {
            id: "https://123-sb1.app.netsuite.com",
            label: "123-sb1.app.netsuite.com",
            status: "ready",
            count: 2,
          },
          {
            id: "https://123-sb2.app.netsuite.com",
            label: "123-sb2.app.netsuite.com",
            status: "ready",
            count: 1,
          },
        ],
        run: async () => ({ rows: [] }),
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const workspace = page.locator(".ns-workspace");
  const home = workspace.locator(".ns-home").first();
  await workspace
    .getByRole("combobox", { name: "NetSuite environment" })
    .click();
  await page.getByRole("option", { name: /123-sb1/ }).click();
  await expect(home.getByText("All Features")).toBeVisible();
  await home.getByRole("button", { name: "Add Scripts to preferred" }).click();
  await expect(home.getByText("Preferred", { exact: true })).toBeVisible();
  await home.getByRole("button", { name: /Scripts and deployments/ }).click();
  await workspace.getByRole("button", { name: "Apps menu" }).click();
  const menu = workspace.getByRole("region", { name: "Apps menu" });
  await expect(
    menu.getByRole("button", { name: "Remove Scripts from preferred" }),
  ).toBeVisible();
  await menu.getByRole("textbox", { name: "Search apps" }).fill("suite");
  await expect(
    menu.getByRole("button", { name: "SuiteQL", exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole("button", { name: "Scripts", exact: true }),
  ).toHaveCount(0);
  await workspace.getByRole("button", { name: "Close apps menu" }).click();
  await workspace.getByRole("button", { name: "Home", exact: true }).click();
  await expect(home.getByText("Workspace Trail")).toBeVisible();
  await expect(home.getByText("123_SB1")).toBeVisible();
  await workspace
    .getByRole("combobox", { name: "NetSuite environment" })
    .click();
  await page.getByRole("option", { name: /123-sb2/ }).click();
  await expect(home.getByText("Workspace Trail")).toHaveCount(0);
  await workspace
    .getByRole("combobox", { name: "NetSuite environment" })
    .click();
  await page.getByRole("option", { name: /123-sb1/ }).click();
  await expect(home.getByText("Workspace Trail")).toBeVisible();
  await page.locator('main[data-saved="true"]').waitFor();
  await page.reload();
  const restored = page.locator(".ns-workspace .ns-home").first();
  await page
    .locator(".ns-workspace")
    .getByRole("combobox", { name: "NetSuite environment" })
    .click();
  await page.getByRole("option", { name: /123-sb1/ }).click();
  await expect(
    restored.getByRole("button", { name: "Remove Scripts from preferred" }),
  ).toBeVisible();
  await expect(restored.getByText("Workspace Trail")).toBeVisible();
  await restored.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(restored.getByText("Workspace Trail")).toHaveCount(0);
});

test("File Cabinet tabs reopen and restore their folders", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          {
            id: "https://123.app.netsuite.com",
            label: "123.app.netsuite.com",
            status: "ready",
            count: 1,
          },
        ],
        run: async (_id: string, op: string) =>
          op === "folders"
            ? { rows: [{ id: 10, name: "SuiteScripts" }] }
            : op === "folder"
              ? { folders: [], files: [] }
              : {},
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const app = page.locator(".ns-workspace");
  await app
    .locator(".ns-home .home-open")
    .filter({ hasText: "File Cabinet" })
    .click();
  const cabinet = app.getByRole("region", { name: "File Cabinet" });
  await cabinet
    .locator(".fc-content")
    .getByRole("row", { name: "SuiteScripts" })
    .dblclick();
  await cabinet.getByRole("button", { name: "New File Cabinet tab" }).click();
  await expect(cabinet.getByRole("tab")).toHaveCount(2);
  await expect(cabinet.locator(".fc-content:visible")).toContainText(
    "SuiteScripts",
  );
  // Split: both groups render side by side and survive leaving the app.
  await cabinet
    .getByRole("tab", { name: "SuiteScripts" })
    .click({ button: "right" });
  await cabinet.getByRole("menuitem", { name: "Open in right split" }).click();
  await expect(cabinet.getByRole("tablist")).toHaveCount(2);
  await expect(cabinet.locator(".fc-pane:visible")).toHaveCount(2);
  const handle = cabinet.getByRole("separator", { name: "Resize split" });
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect(handle).toHaveAttribute("aria-valuenow", "45");
  await page.locator('main[data-saved="true"]').waitFor();
  await app.getByRole("button", { name: "Home", exact: true }).click();
  await app
    .locator(".ns-home .home-open")
    .filter({ hasText: "File Cabinet" })
    .click();
  await expect(cabinet.locator(".fc-pane:visible")).toHaveCount(2);
  await expect(
    cabinet.getByRole("separator", { name: "Resize split" }),
  ).toHaveAttribute("aria-valuenow", "45");
  // Dragging the only right-hand tab back to the left group unsplits.
  await cabinet
    .getByRole("tab", { name: "SuiteScripts" })
    .click({ button: "right" });
  await cabinet.getByRole("menuitem", { name: "Open in left split" }).click();
  await expect(cabinet.getByRole("tablist")).toHaveCount(1);
  await cabinet.getByRole("tab", { name: "SuiteScripts" }).click();
  await cabinet.getByRole("tab", { name: "File Cabinet", exact: true }).click({ button: "middle" });
  await cabinet
    .getByRole("button", { name: "Reopen closed File Cabinet tab" })
    .click();
  await expect(cabinet.getByRole("tab")).toHaveCount(2);
  await page.locator('main[data-saved="true"]').waitFor();
  await app.getByRole("button", { name: "Home", exact: true }).click();
  await app
    .locator(".ns-home .home-open")
    .filter({ hasText: "File Cabinet" })
    .click();
  await expect(cabinet.getByRole("tab")).toHaveCount(2);
  await expect(
    cabinet.getByRole("tab", { name: "SuiteScripts" }),
  ).toBeVisible();
});

test("NetSuite workspace tabs keep separate views, split and restore", async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          {
            id: "https://123.app.netsuite.com",
            label: "123.app.netsuite.com",
            status: "ready",
            count: 1,
          },
        ],
        run: async (_id: string, op: string) =>
          op === "folders"
            ? { rows: [{ id: 10, name: "SuiteScripts" }] }
            : op === "folder"
              ? { folders: [], files: [] }
              : { rows: [] },
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const app = page.locator(".ns-workspace");
  const strip = app.getByRole("tablist", { name: "NetSuite" });
  await app.locator(".ns-home .home-open").filter({ hasText: "Scripts" }).click();
  await expect(strip.getByRole("tab", { name: "Scripts" })).toBeVisible();
  await app.getByRole("button", { name: "New NetSuite tab" }).click();
  await expect(strip.getByRole("tab", { name: "Home" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await app
    .locator(".ns-home .home-open:visible")
    .filter({ hasText: "SuiteQL" })
    .click();
  await expect(strip.getByRole("tab")).toHaveCount(2);
  await expect(app.locator(".ns-query:visible")).toHaveCount(1);
  await expect(app.locator(".ns-panel:visible")).toHaveCount(0);
  // Drag the SuiteQL tab onto the right split zone.
  const query = strip.getByRole("tab", { name: "SuiteQL" });
  const box = (await app.locator(".ns-tabs > .st-panes").boundingBox())!;
  await query.hover();
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(app.getByRole("tablist", { name: "NetSuite (left)" })).toBeVisible();
  await expect(app.getByRole("tablist", { name: "NetSuite (right)" })).toContainText(
    "SuiteQL",
  );
  await expect(app.locator(".ns-query:visible")).toHaveCount(1);
  await expect(app.locator(".ns-panel:visible")).toHaveCount(1);
  // Closing the only tab of a group collapses the split; reopen restores it.
  await app.getByRole("tab", { name: "SuiteQL", exact: true }).click({ button: "middle" });
  await expect(app.getByRole("tablist", { name: "NetSuite" })).toBeVisible();
  await app.getByRole("button", { name: "Reopen closed NetSuite tab" }).click();
  await expect(strip.getByRole("tab", { name: "SuiteQL" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await strip.getByRole("tab", { name: "SuiteQL" }).click({ button: "right" });
  await app
    .locator(".ns-tabs > .st-menu")
    .getByRole("menuitem", { name: "Open in right split" })
    .click();
  await expect(app.getByRole("tablist", { name: "NetSuite (right)" })).toContainText(
    "SuiteQL",
  );
  await page.locator('main[data-saved="true"]').waitFor();
  await page.reload();
  const restored = page.locator(".ns-workspace");
  await expect(
    restored.getByRole("tablist", { name: "NetSuite (left)" }),
  ).toContainText("Scripts");
  await expect(
    restored.getByRole("tablist", { name: "NetSuite (right)" }),
  ).toContainText("SuiteQL");
  await expect(restored.locator(".ns-query:visible")).toHaveCount(1);
});

test("File Cabinet drafts survive reload outside the workspace JSON", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          {
            id: "https://123.app.netsuite.com",
            label: "123.app.netsuite.com",
            status: "ready",
            count: 1,
          },
        ],
        run: async (_id: string, op: string) =>
          op === "folders"
            ? { rows: [{ id: 10, name: "SuiteScripts" }] }
            : op === "folder"
              ? {
                  folders: [],
                  files: [
                    { id: 11, name: "a.js", filetype: "JAVASCRIPT", filesize: 9 },
                  ],
                }
              : op === "file"
                ? { id: 11, name: "a.js", filetype: "JAVASCRIPT", content: "original" }
                : { rows: [] },
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const app = page.locator(".ns-workspace");
  await app.locator(".ns-home .home-open").filter({ hasText: "File Cabinet" }).click();
  await app.locator(".fc-content:visible").getByRole("row", { name: "SuiteScripts" }).dblclick();
  await app.locator(".fc-content:visible").getByRole("row", { name: "a.js" }).dblclick();
  await app.locator(".fc-switch").click();
  await app.getByRole("textbox", { name: "File content" }).fill("edited draft");
  await expect(app.getByText("Unsaved draft", { exact: false })).toBeVisible();
  await page.locator('main[data-saved="true"]').waitFor();
  const saved = await page.evaluate(() =>
    fetch("/__orvane/storage/state").then((r) => r.text()),
  );
  expect(saved).toContain("SuiteScripts");
  expect(saved).not.toContain("edited draft");
  await page.waitForTimeout(400);
  await page.reload();
  const restored = page.locator(".ns-workspace");
  await expect(
    restored.getByRole("textbox", { name: "File content" }),
  ).toHaveText("edited draft");
  await expect(
    restored.getByText("Unsaved draft", { exact: false }),
  ).toBeVisible();
});

test("SuiteQL renders only the visible result rows", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("orvane.examples.v1", "installed");
    (window as any).orvaneDesktop = {
      netsuite: {
        tabs: async () => [
          {
            id: "https://123.app.netsuite.com",
            label: "123.app.netsuite.com",
            status: "ready",
            count: 1,
          },
        ],
        run: async (_id: string, op: string) =>
          op === "query"
            ? {
                rows: Array.from({ length: 2000 }, (_, i) => ({
                  id: i + 1,
                  name: `Row ${i + 1}`,
                })),
                totalCount: 2000,
                offset: 0,
              }
            : { rows: [] },
      },
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page.getByRole("button", { name: "Create NetSuite app" }).click();
  const app = page.locator(".ns-workspace");
  await app.locator(".ns-home .home-open").filter({ hasText: "SuiteQL" }).click();
  await app.locator(".ns-query-toolbar").getByRole("button", { name: "Run query" }).click();
  await expect(app.locator(".ns-result-row").first()).toContainText("Row 1");
  expect(await app.locator(".ns-result-row").count()).toBeLessThan(120);
  await app.locator(".ns-result-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  // The default limit is 1,000 rows.
  await expect(app.locator(".ns-result-row").last()).toContainText("Row 1000");
  expect(await app.locator(".ns-result-row").count()).toBeLessThan(120);
});
