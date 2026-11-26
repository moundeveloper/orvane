import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("source tool and widget retain exact passages per tab on CSP pages", async ({}, info) => {
  test.setTimeout(120_000);
  const site = createServer((request, response) => {
    if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); return response.end("#first{margin-top:1000px}#second{margin-top:1100px}body{font:16px sans-serif;background:white;color:#273f50;padding-bottom:800px}"); }
    response.setHeader("content-type", "text/html");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'none'; style-src 'self'");
    if (request.url === "/other") return response.end("<!doctype html><title>Other page</title><p>Another document.</p>");
    response.end('<!doctype html><title>Source fixture</title><link rel="stylesheet" href="/style.css"><input id="draft" value="original"><p id="first">Verified source <em>text</em> is exact.</p><p id="second">A changed passage must be reported honestly.</p>');
  });
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
  const address = site.address(); if (!address || typeof address === "string") throw Error("No fixture port");
  const origin = `http://127.0.0.1:${address.port}`, data = info.outputPath("data");
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([,value]) => value !== undefined)) as Record<string,string>, ORVANE_DATA_DIR:data, ORVANE_MCP_STATE_DIR:data };
  const app = await electron.launch({args:["electron/main.mjs"],env:{...env,ORVANE_PORT:"5237",ORVANE_USER_DATA:info.outputPath("profile")}});
  const client = new Client({name:"source-widget-test",version:"1.0.0"});
  const transport = new StdioClientTransport({command:process.execPath,args:[resolve("server/launch.mjs")],env:{...env,ORVANE_MCP_PORT:"0",ORVANE_MCP_ORIGINS:"http://localhost:5237"},stderr:"pipe"});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({timeout:60_000});
    await page.getByRole("button",{name:"Workspace options"}).click();
    await page.getByRole("button",{name:"Create Browser",exact:true}).click();
    const browser = page.locator(".browser-view");
    await client.connect(transport);
    const raw = (name:string,args:Record<string,unknown>={}) => client.callTool({name,arguments:args});
    const call = async (name:string,args:Record<string,unknown>={}) => {const result=await raw(name,args);if(result.isError)throw Error(JSON.stringify(result.content));return (result.structuredContent as {result:any}).result;};
    await expect.poll(async()=>(await call("workspace_status")).sessions.length,{timeout:30_000}).toBe(1);
    const tabId = (await call("browser_open",{url:origin+"/source",purpose:"user"})).tabId;
    await call("browser_act",{tabId,action:"fill",selector:"#draft",value:"unsaved draft"});
    const marked = await call("browser_highlight",{tabId,action:"set",passages:[
      {quote:"Verified source text is exact.",label:"Exact text"},
      {quote:"A changed passage must be reported honestly.",label:"Missing text"},
      {quote:"An invented quotation is never a source."},
    ]});
    expect(marked.passages).toHaveLength(2);expect(marked.unmatched).toHaveLength(1);
    const read = async(expression:string)=>(await call("browser_act",{tabId,action:"eval",expression})).value;
    expect(await read("document.querySelector('#draft').value")).toBe("unsaved draft");
    expect(await read("CSS.highlights.get('orvane-source').size")).toBe(2);
    expect(await read("getComputedStyle(document.querySelector('#first'),'::highlight(orvane-source)').backgroundColor")).toBe("rgb(225, 238, 240)");
    expect(await read("document.querySelector('#first').getBoundingClientRect().top")).toBeGreaterThanOrEqual(0);
    await expect(browser.locator(".browser-sources")).toBeVisible();
    const panel = browser.getByRole("region",{name:"Source passages",exact:true});
    if (!await panel.isVisible()) await browser.getByRole("button",{name:"Source passages",exact:true}).click();
    await call("browser_control",{tabId,action:"release"});
    expect((await raw("browser_highlight",{tabId,action:"list"})).isError).toBe(true);
    await panel.getByRole("option").filter({hasText:"A changed passage"}).click();
    await call("browser_control",{tabId,action:"take"});
    expect((await call("browser_highlight",{tabId,action:"list"})).selected).toBe(marked.passages[1].id);
    const picture = (await raw("browser_screenshot", {tabId})).content.find((part) => part.type === "image");
    expect(picture?.type).toBe("image");
    if (picture?.type === "image") await writeFile(info.outputPath("highlighted-source-page.png"), Buffer.from(picture.data, "base64"));
    const nativePicture = await app.evaluate(async ({webContents}, url) => {
      const guest = webContents.getAllWebContents().find((item) => item.getType() === "webview" && item.getURL() === url)!;
      await Promise.race([guest.mainFrame.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))"),
        new Promise<never>((_, reject) => setTimeout(() => reject(Error("Visible source page did not paint")), 2000))]);
      const image = await guest.capturePage(), pixels = image.toBitmap();
      let fillPixels = 0;
      for (let i=0;i<pixels.length;i+=4) {
        const b=pixels[i]!,g=pixels[i+1]!,r=pixels[i+2]!;
        if(r>=190&&r<=202&&g>=216&&g<=225&&b>=227&&b<=239)fillPixels++;
      }
      return { png:image.toPNG().toString("base64"), fillPixels };
    }, origin+"/source");
    await writeFile(info.outputPath("highlighted-source-native.png"), Buffer.from(nativePicture.png,"base64"));
    expect(nativePicture.fillPixels).toBeGreaterThan(1000);
    await call("browser_act",{tabId,action:"eval",expression:"document.querySelector('#second').textContent='Changed wording';true"});
    if (!await panel.isVisible()) await browser.getByRole("button",{name:"Source passages",exact:true}).click();
    await expect(panel.getByText("No longer found",{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath("browser-source-widget.png")});
    await call("browser_act",{tabId,action:"navigate",url:"/other"});
    await expect(browser.locator(".browser-sources")).toHaveCount(0);
    expect((await call("browser_highlight",{tabId,action:"list"})).passages).toHaveLength(0);
    await call("browser_act",{tabId,action:"navigate",url:"back"});
    await expect(browser.locator(".browser-sources")).toBeVisible();
    expect((await call("browser_highlight",{tabId,action:"list"})).passages).toHaveLength(2);
    const other = (await call("browser_open",{url:origin+"/source"})).tabId;
    await expect(browser.locator(".browser-sources")).toHaveCount(0);
    expect((await call("browser_highlight",{tabId:other,action:"list"})).passages).toHaveLength(0);
    await call("browser_control",{tabId,action:"take"});
    await call("browser_highlight",{tabId,action:"clear"});
    await expect(browser.locator(".browser-sources")).toHaveCount(0);
    expect(await read("CSS.highlights.has('orvane-source')")).toBe(false);
  } finally { await client.close().catch(()=>undefined);await app.close();site.closeAllConnections();site.close(); }
});
