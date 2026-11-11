import { test, expect } from "./fixtures";
import {
  constants,
  createPrivateKey,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CertificateService } from "../server/certificates";
import type { CertificateData } from "../src/certificates";

test("certificate generation produces verified RSA-PSS X.509 and matching PKCS#8, validates paths and preserves renewals", async ({}, info) => {
  test.setTimeout(60000);
  const directory = info.outputPath("vault");
  let service = new CertificateService(directory);
  try {
    let data = (await service.invoke("environment-save", {
      name: "Acme Sandbox",
      accountId: "1234567_SB1",
    })) as CertificateData;
    const environmentId = data.environments[0]!.id;
    const settings = {
      name: "Agent Console",
      purpose: "OAuth integration",
      environmentId,
      commonName: "AgentConsole",
      bits: 4096,
      hash: "sha256",
      notBefore: "2026-11-04T10:00:00.000Z",
      notAfter: "2027-11-04T10:00:00.000Z",
      certFilename: "rsapss-cert.pem",
      keyFilename: "rsapss-key.pem",
    };
    data = (await service.invoke("generate", settings)) as CertificateData;
    const first = data.certificates[0]!;
    const certPem = await readFile(first.certPath, "utf8"),
      keyPem = await readFile(first.keyPath, "utf8");
    const cert = new X509Certificate(certPem),
      key = createPrivateKey(keyPem);
    expect(cert.subject).toBe("CN=AgentConsole");
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.ca).toBe(false);
    expect(cert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(4096);
    expect(cert.checkPrivateKey(key)).toBe(true);
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(new Date(cert.validTo).toISOString()).toBe(settings.notAfter);
    expect(keyPem).toContain("-----BEGIN PRIVATE KEY-----");
    const message = Buffer.from("NetSuite integration signing check");
    const signature = sign("sha256", message, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    });
    expect(
      verify(
        "sha256",
        message,
        {
          key: cert.publicKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
        signature,
      ),
    ).toBe(true);
    // Independent decoder verifies signature algorithm and critical extensions.
    if (process.platform === "win32") {
      const git = await promisify(execFile)("git", ["--exec-path"], {
        windowsHide: true,
      });
      const openssl = resolve(
        git.stdout.trim(),
        "../../..",
        "usr/bin/openssl.exe",
      );
      const { stdout } = await promisify(execFile)(
        openssl,
        ["x509", "-in", first.certPath, "-noout", "-text"],
        { windowsHide: true },
      );
      expect(stdout).toContain("rsassaPss");
      expect(stdout).toContain("sha256");
      expect(stdout).toContain("X509v3 Basic Constraints: critical");
      expect(stdout).toContain("CA:FALSE");
      expect(stdout).toContain("X509v3 Key Usage: critical");
      expect(stdout).toContain("Digital Signature");
      const acl = await promisify(execFile)("icacls.exe", [first.keyPath], {
        windowsHide: true,
      });
      expect(acl.stdout).not.toContain("S-1-1-0");
      expect(acl.stdout).toContain("(I)(F)");
    } else expect((await stat(first.keyPath)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(data)).not.toContain("BEGIN PRIVATE KEY");
    await expect(
      service.invoke("generate", { ...settings, keyFilename: "../escape.pem" }),
    ).rejects.toThrow();
    await expect(
      service.invoke("generate", {
        ...settings,
        keyFilename: "RSAPSS-CERT.pem",
      }),
    ).rejects.toThrow("filenames must differ");
    await expect(
      service.invoke("generate", { ...settings, notAfter: settings.notBefore }),
    ).rejects.toThrow("Expiry");
    await expect(
      service.invoke("generate", { ...settings, bits: 1024 }),
    ).rejects.toThrow();
    await expect(
      service.invoke("environment-save", {
        name: "Duplicate",
        accountId: "1234567_sb1",
      }),
    ).rejects.toThrow("already exists");
    data = (await service.invoke("generate", {
      ...settings,
      name: "Renewal",
      hash: "sha384",
      bits: 2048,
    })) as CertificateData;
    const second = data.certificates.find((c) => c.id !== first.id)!;
    expect(second.keyPath).not.toBe(first.keyPath);
    expect(await readFile(first.keyPath, "utf8")).toBe(keyPem);
    data = (await service.invoke("archive", {
      id: first.id,
      archived: true,
    })) as CertificateData;
    expect(data.certificates.find((c) => c.id === first.id)?.archived).toBe(
      true,
    );
    expect(await readFile(first.keyPath, "utf8")).toBe(keyPem);
    service.close();
    service = new CertificateService(directory);
    data = (await service.invoke("list", {})) as CertificateData;
    expect(data.certificates).toHaveLength(2);
    expect(await readdir(join(directory, "certificates"))).toHaveLength(2);
    if (process.platform === "win32") {
      const env = {
        ...process.env,
        ORVANE_TEST_PAIR_FOLDER: dirname(second.certPath),
      };
      const shellWindows = async (close = false) => {
        const script = `$shell = New-Object -ComObject Shell.Application; $matches = @($shell.Windows()) | Where-Object { $_.Document.Folder.Self.Path -eq $env:ORVANE_TEST_PAIR_FOLDER }; ${close ? "$matches | ForEach-Object { $_.Quit() }" : "ConvertTo-Json -Compress -InputObject @($matches | ForEach-Object { @{ visible=[bool]$_.Visible; selected=@($_.Document.SelectedItems() | ForEach-Object { $_.Path }) } })"}`;
        const result = await promisify(execFile)(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { env, windowsHide: true, timeout: 10000 },
        );
        return JSON.parse(result.stdout.trim() || "[]") as {
          visible: boolean;
          selected: string[];
        }[];
      };
      try {
        for (const file of ["certificate", "key", "folder"] as const) {
          await service.invoke("reveal", { id: second.id, file });
          const expected =
            file === "certificate" ? second.certPath : second.keyPath;
          // A successfully spawned process is insufficient: Explorer must
          // actually be visible and select the registered PEM.
          await expect
            .poll(
              async () =>
                (await shellWindows()).some(
                  (window) =>
                    window.visible &&
                    (file === "folder" || window.selected.includes(expected)),
                ),
              { timeout: 15000 },
            )
            .toBe(true);
        }
      } finally {
        await shellWindows(true);
      }
    }
    await expect(
      service.invoke("reveal", { id: "../../escape", file: "key" }),
    ).rejects.toThrow();
  } finally {
    service.close();
  }
});

test("manager creates tags, configures generation, searches, reveals, archives and reloads", async ({
  page,
}, info) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(120000);
  page.on("pageerror", (error) => console.log("Browser error:", error.message));
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Certificate manager", exact: true })
    .click();
  const app = page.locator(".certificate-manager");
  await expect(app.getByText("Your certificate pairs live here")).toBeVisible({
    timeout: 30000,
  });
  await app
    .getByRole("button", { name: "New certificate", exact: true })
    .click();
  const dialog = page.locator("dialog.cert-dialog[open]");
  await expect(dialog).toHaveAccessibleName("New certificate pair");
  await expect(
    dialog.getByRole("combobox", { name: "RSA key size" }),
  ).toHaveText("4096 bits");
  await expect(
    dialog.getByRole("combobox", { name: "Signature hash" }),
  ).toHaveText("SHA-256");
  await dialog
    .getByRole("textbox", { name: "Environment name", exact: true })
    .fill("Acme Sandbox");
  await dialog
    .getByRole("textbox", { name: "Account ID", exact: true })
    .fill("1234567_SB1");
  await dialog
    .getByRole("button", { name: "Save environment", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "Certificate environment" }),
  ).toContainText("Acme Sandbox");
  await dialog.getByLabel("Pair name", { exact: true }).fill("Agent Console");
  await dialog
    .getByLabel("Purpose", { exact: true })
    .fill("SuiteTalk automation");
  // Native dialog keeps custom selectors in its top-layer focus scope.
  await dialog.getByRole("combobox", { name: "RSA key size" }).click();
  await expect(
    page.getByRole("option", { name: "8192 bits", exact: true }),
  ).toBeVisible();
  await page.getByRole("listbox").press("Escape");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "RSA key size" }).click();
  await page.getByRole("option", { name: "2048 bits", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Validity preset" }).click();
  await page.getByRole("option", { name: "6 months", exact: true }).click();
  await page.screenshot({ path: info.outputPath("settings.png") });
  await dialog
    .getByRole("button", { name: "Generate & save pair", exact: true })
    .click();
  await expect(dialog).toHaveCount(0, { timeout: 30000 });
  await expect(app.locator(".cert-detail h2")).toHaveText("Agent Console");
  await expect(app.locator(".cert-metadata")).toContainText("2048 bits");
  await app
    .getByRole("textbox", { name: "Search certificates" })
    .fill("no match");
  await expect(app.getByText("No matching certificates")).toBeVisible();
  await app
    .getByRole("textbox", { name: "Search certificates" })
    .fill("1234567_SB1");
  await expect(app.locator(".cert-detail h2")).toHaveText("Agent Console");
  // Check all Explorer actions send the registered ID rather than arbitrary paths.
  const reveals: string[] = [];
  await page.route("**/__orvane/certificates/reveal", async (route) => {
    reveals.push(route.request().postDataJSON().file);
    await route.fulfill({ json: { revealed: true } });
  });
  await app
    .getByTitle("Reveal certificate in Explorer", { exact: true })
    .click();
  await expect(app.getByRole("status")).toContainText(
    "Opened Explorer for rsapss-cert.pem.",
  );
  await app
    .getByTitle("Reveal private key in Explorer", { exact: true })
    .click();
  await app
    .getByRole("button", { name: "Open pair folder", exact: true })
    .click();
  expect(reveals).toEqual(["certificate", "key", "folder"]);
  await app.getByRole("button", { name: "Archive pair", exact: true }).click();
  await app.getByRole("button", { name: "Active", exact: true }).click();
  await expect(app.locator(".cert-detail h2")).toHaveText("Agent Console");
  await app.getByRole("button", { name: "Restore pair", exact: true }).click();
  await app.getByRole("button", { name: "Archived", exact: true }).click();
  await page.reload();
  await expect(app.locator(".cert-detail h2")).toHaveText("Agent Console");
  await page.screenshot({ path: info.outputPath("manager.png") });
  await app
    .getByRole("button", { name: "Generate renewal", exact: true })
    .click();
  await expect(dialog.getByLabel("Purpose", { exact: true })).toHaveValue(
    "SuiteTalk automation",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("n");
  await expect(page.locator(".app-surface")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await app
    .getByRole("button", { name: "Manage environments", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Environment name", exact: true })
    .fill("Acme Production");
  await dialog
    .getByRole("textbox", { name: "Account ID", exact: true })
    .fill("1234567");
  await dialog
    .getByRole("button", { name: "Save environment", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await app
    .getByRole("navigation")
    .getByRole("button", { name: /Acme Production/ })
    .click();
  await expect(app.getByText("No matching certificates")).toBeVisible();
  await app
    .getByRole("navigation")
    .getByRole("button", { name: /Acme Sandbox/ })
    .click();
  await expect(app.locator(".cert-detail h2")).toHaveText("Agent Console");
  await page.screenshot({ path: info.outputPath("manager.png") });
  await page
    .getByRole("button", {
      name: "Options for Certificate manager",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Position & size", exact: true })
    .click();
  await page.getByLabel("Width", { exact: true }).fill("680");
  await page.getByLabel("Width", { exact: true }).press("Tab");
  await page.getByLabel("Height", { exact: true }).fill("650");
  await page.getByLabel("Height", { exact: true }).press("Tab");
  await page
    .getByRole("button", { name: "Close position controls", exact: true })
    .click();
  await expect(app.locator(".cert-workspace")).toHaveCSS(
    "flex-direction",
    "column",
  );
  await app.screenshot({ path: info.outputPath("narrow-manager.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".dock")
    .getByRole("button", { name: "Certificate manager", exact: true })
    .click();
  await app
    .getByRole("button", { name: "New certificate", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await dialog.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  await page.screenshot({ path: info.outputPath("mobile-settings-top.png") });
  await dialog
    .getByRole("button", { name: "Generate & save pair", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("mobile-settings-bottom.png"),
  });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("certificate API refuses cross-origin and non-JSON requests", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const wrongType = await fetch("/__orvane/certificates/list", {
      method: "POST",
      body: "{}",
    });
    const read = await fetch("/__orvane/certificates/list");
    return [wrongType.status, read.status];
  });
  expect(result).toEqual([415, 405]);
  const response = await page.request.post("/__orvane/certificates/list", {
    headers: { Origin: "https://untrusted.example" },
    data: {},
  });
  expect(response.status()).toBe(403);
});
