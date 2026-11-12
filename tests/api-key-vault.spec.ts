import { test, expect } from "./fixtures";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveVaultKey,
  generateApiSecret,
  openVault,
  sealVault,
  toBase64,
  type ApiKeyRecord,
  type VaultState,
} from "../src/apiKeyVault";
import type { CertificateData } from "../src/certificates";
import { CertificateService } from "../server/certificates";

test("vault authenticates encryption, rejects wrong passwords/tampering and protects concurrent saves", async ({}, info) => {
  const password = "test-only-long-passphrase";
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveVaultKey(password, salt);
  expect(key.extractable).toBe(false);
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name: "Secret integration name",
    environmentId: randomUUID(),
    purpose: "Scheduled sync",
    secret: "test-only-sensitive-api-token-987654",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const encrypted = await sealVault(key, salt, [record]);
  const next = await sealVault(key, salt, [record]);
  const generatedSecret = generateApiSecret();
  expect(generatedSecret).toMatch(/^[A-Za-z0-9_-]{32}$/);
  const secretRecord: ApiKeyRecord = {
    ...record,
    id: randomUUID(),
    kind: "api-secret",
    secret: "abc",
  };
  const mixed = await sealVault(key, salt, [record, secretRecord]);
  expect((await openVault(password, mixed)).records).toEqual([
    record,
    secretRecord,
  ]);
  expect(next.iv).not.toBe(encrypted.iv);
  expect(JSON.stringify(encrypted)).not.toContain(record.secret);
  expect(JSON.stringify(encrypted)).not.toContain(record.name);
  expect((await openVault(password, encrypted)).records).toEqual([record]);
  await expect(openVault("incorrect-password", encrypted)).rejects.toThrow(
    "Could not unlock",
  );
  await expect(
    openVault(password, {
      ...encrypted,
      ciphertext:
        (encrypted.ciphertext[0] === "A" ? "B" : "A") +
        encrypted.ciphertext.slice(1),
    }),
  ).rejects.toThrow("Could not unlock");
  const directory = info.outputPath("vault-db");
  let service = new CertificateService(directory);
  try {
    expect(await service.invoke("vault-read", {})).toEqual({
      revision: 0,
      envelope: null,
    });
    const saved = (await service.invoke("vault-write", {
      expectedRevision: 0,
      envelope: encrypted,
    })) as VaultState;
    expect(saved.revision).toBe(1);
    await expect(
      service.invoke("vault-write", { expectedRevision: 0, envelope: next }),
    ).rejects.toThrow("changed in another window");
    await expect(
      service.invoke("vault-write", {
        expectedRevision: 1,
        envelope: { ...next, secret: record.secret },
      }),
    ).rejects.toThrow();
    await expect(
      service.invoke("vault-write", {
        expectedRevision: 1,
        envelope: next,
        password,
      }),
    ).rejects.toThrow();
    service.close();
    service = new CertificateService(directory);
    const reloaded = (await service.invoke("vault-read", {})) as VaultState;
    expect(
      (await openVault(password, reloaded.envelope!)).records[0]?.secret,
    ).toBe(record.secret);
    const db = await readFile(join(directory, "workspace.sqlite"));
    expect(db.includes(Buffer.from(record.secret))).toBe(false);
    expect(db.includes(Buffer.from(password))).toBe(false);
    expect(db.includes(Buffer.from(record.name))).toBe(false);
  } finally {
    service.close();
  }
});

test("API secrets accept short values, generate 32 characters and preserve legacy API keys", async ({
  page,
}, info) => {
  const password = "legacy-vault-password-123";
  const legacyKeyValue = "legacy-test-key-stays-preserved";
  const shortSecret = "abc";
  const envResponse = await page.request.post(
    "/__orvane/certificates/environment-save",
    { data: { name: "Acme Sandbox", accountId: "1234567_SB1" } },
  );
  expect(envResponse.ok()).toBe(true);
  const envs = (await envResponse.json()) as CertificateData;
  const environmentId = envs.environments[0]!.id;
  // Seed the original v1 payload without a kind field, as existing users have.
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveVaultKey(password, salt);
  const legacy: ApiKeyRecord = {
    id: randomUUID(),
    name: "Existing API key",
    purpose: "Legacy integration",
    environmentId,
    secret: legacyKeyValue,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const seed = await page.request.post("/__orvane/certificates/vault-write", {
    data: {
      expectedRevision: 0,
      envelope: await sealVault(key, salt, [legacy]),
    },
  });
  expect(seed.ok()).toBe(true);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.postData() || "");
  });
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Certificate manager", exact: true })
    .click();
  const app = page.locator(".certificate-manager");
  const types = app.getByRole("navigation", { name: "Credential types" });
  await types.getByRole("button", { name: "API secrets", exact: true }).click();
  const vault = app.locator(".api-key-vault");
  await vault.getByLabel("Vault password", { exact: true }).fill(password);
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await expect(
    vault.getByText("No API secrets yet. Add one and choose its environment."),
  ).toBeVisible();
  await types.getByRole("button", { name: "API keys", exact: true }).click();
  await expect(vault.locator(".vault-detail h2")).toHaveText(
    "Existing API key",
  );
  await expect(vault.getByLabel("Saved API key", { exact: true })).toHaveValue(
    legacyKeyValue,
  );
  await types.getByRole("button", { name: "API secrets", exact: true }).click();
  await vault
    .getByRole("button", { name: "Add API secret", exact: true })
    .click();
  const dialog = page.locator("dialog.vault-dialog[open]");
  await expect(dialog).toHaveAccessibleName("Add API secret");
  await dialog
    .getByLabel("Secret name", { exact: true })
    .fill("Integration secret");
  await dialog
    .getByLabel("API secret purpose", { exact: true })
    .fill("Client authentication");
  await dialog
    .getByRole("button", { name: "Generate 32-character secret", exact: true })
    .click();
  const generated = await dialog
    .getByLabel("API secret value", { exact: true })
    .inputValue();
  expect(generated).toMatch(/^[A-Za-z0-9_-]{32}$/);
  await expect(
    dialog.getByLabel("API secret value", { exact: true }),
  ).toHaveAttribute("type", "password");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("api-secret-settings.png"),
  });
  await dialog
    .getByRole("button", { name: "Save API secret", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    vault.getByLabel("Saved API secret", { exact: true }),
  ).toHaveValue(generated);
  await expect(vault.locator(".credential-group-title")).toContainText(
    "Acme Sandbox",
  );
  await vault
    .getByRole("button", { name: "Edit API secret", exact: true })
    .click();
  await dialog
    .getByLabel("API secret value", { exact: true })
    .fill(shortSecret);
  await dialog
    .getByRole("button", { name: "Save API secret", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    vault.getByLabel("Saved API secret", { exact: true }),
  ).toHaveValue(shortSecret);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("api-secrets.png"),
  });
  await types.getByRole("button", { name: "API keys", exact: true }).click();
  await expect(vault.getByLabel("Saved API key", { exact: true })).toHaveValue(
    legacyKeyValue,
  );
  await page.reload();
  await types.getByRole("button", { name: "API secrets", exact: true }).click();
  await expect(
    vault.getByRole("heading", { name: "Unlock API secrets", exact: true }),
  ).toBeVisible();
  await vault.getByLabel("Vault password", { exact: true }).fill(password);
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await expect(
    vault.getByLabel("Saved API secret", { exact: true }),
  ).toHaveValue(shortSecret);
  const response = await page.request.post(
    "/__orvane/certificates/vault-read",
    { data: {} },
  );
  const stored = (await response.json()) as VaultState;
  const decrypted = await openVault(password, stored.envelope!);
  expect(decrypted.records).toHaveLength(2);
  expect(decrypted.records.find((r) => r.id === legacy.id)).toEqual(legacy);
  expect(decrypted.records.find((r) => r.kind === "api-secret")?.secret).toBe(
    shortSecret,
  );
  expect(
    posts.every(
      (body) =>
        !body.includes(password) &&
        !body.includes(generated) &&
        !body.includes(legacyKeyValue) &&
        !body.includes(`\"secret\":\"${shortSecret}\"`),
    ),
  ).toBe(true);
  await vault
    .getByRole("button", { name: "Edit API secret", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("mobile-api-secret-settings.png"),
  });
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .locator(".dock")
    .getByRole("button", { name: "Certificate manager", exact: true })
    .click();
  await vault.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect(
    vault.getByLabel("Saved API secret", { exact: true }),
  ).toHaveCount(0);
});

test("API keys are grouped by environment, encrypted before requests, and locked on reload", async ({
  page,
}, info) => {
  test.setTimeout(90000);
  const password = "demo-vault-password-123";
  const secret = "test-api-secret-not-a-real-credential";
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.postData() || "");
  });
  await page.addInitScript(() =>
    localStorage.setItem("orvane.examples.v1", "installed"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace options" }).click();
  await page
    .getByRole("button", { name: "Create Certificate manager", exact: true })
    .click();
  const app = page.locator(".certificate-manager");
  await app
    .getByRole("button", { name: "Manage environments", exact: true })
    .click();
  const environmentDialog = page.locator("dialog.cert-dialog[open]");
  for (const [name, accountId] of [
    ["Acme Sandbox", "1234567_SB1"],
    ["Acme Production", "1234567"],
  ]) {
    await environmentDialog
      .getByLabel("Environment name", { exact: true })
      .fill(name!);
    await environmentDialog
      .getByLabel("Account ID", { exact: true })
      .fill(accountId!);
    await environmentDialog
      .getByRole("button", { name: "Save environment", exact: true })
      .click();
    await expect(
      environmentDialog.getByLabel("Environment name", { exact: true }),
    ).toHaveValue("");
  }
  await environmentDialog
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await app
    .getByRole("navigation", { name: "Credential types" })
    .getByRole("button", { name: "API keys", exact: true })
    .click();
  const vault = app.getByRole("region", { name: "API key vault", exact: true });
  await vault.getByLabel("Vault password", { exact: true }).fill(password);
  await vault
    .getByLabel("Confirm vault password", { exact: true })
    .fill(password);
  await vault
    .getByRole("button", { name: "Create encrypted vault", exact: true })
    .click();
  await expect(
    vault.getByRole("button", { name: "Add API key", exact: true }),
  ).toBeVisible();
  const dialog = page.locator("dialog.vault-dialog[open]");
  for (const [name, environment] of [
    ["Sandbox integration", "Acme Sandbox"],
    ["Production integration", "Acme Production"],
  ]) {
    await vault
      .getByRole("button", { name: "Add API key", exact: true })
      .click();
    await dialog.getByLabel("Key name", { exact: true }).fill(name!);
    await dialog
      .getByRole("combobox", { name: "API key environment", exact: true })
      .click();
    await page.getByRole("option", { name: new RegExp(environment!) }).click();
    await dialog
      .getByLabel("API key purpose", { exact: true })
      .fill("SuiteTalk access");
    await dialog.getByLabel("API key value", { exact: true }).fill(secret);
    await dialog
      .getByRole("button", { name: "Save API key", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
  }
  await expect(vault.locator(".credential-group-title")).toHaveCount(2);
  await expect(
    vault.getByLabel("Saved API key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await vault.getByRole("button", { name: "Reveal key", exact: true }).click();
  await expect(vault.getByLabel("Saved API key", { exact: true })).toHaveValue(
    secret,
  );
  await vault.getByRole("button", { name: "Hide key", exact: true }).click();
  await page.screenshot({ path: info.outputPath("api-keys.png") });
  await app
    .getByRole("navigation", {
      name: "Filter by NetSuite environment",
      exact: true,
    })
    .getByRole("button", { name: /Acme Sandbox/ })
    .click();
  await expect(vault.locator(".credential-group-title")).toHaveCount(1);
  await expect(vault.locator(".vault-detail h2")).toHaveText(
    "Sandbox integration",
  );
  await vault
    .getByLabel("Search API keys", { exact: true })
    .fill("no matching name");
  await expect(
    vault.getByText("No matching API keys. Try another environment or search."),
  ).toBeVisible();
  await vault.getByLabel("Search API keys", { exact: true }).fill("");
  await vault.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect(vault.getByLabel("Saved API key", { exact: true })).toHaveCount(
    0,
  );
  await vault
    .getByLabel("Vault password", { exact: true })
    .fill("wrong-password-value");
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await expect(vault.getByRole("alert")).toContainText("Could not unlock");
  await vault.getByLabel("Vault password", { exact: true }).fill(password);
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await expect(vault.locator(".vault-detail h2")).toHaveText(
    "Sandbox integration",
  );
  await vault
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  const nextPassword = "replacement-vault-password-456";
  await dialog
    .getByLabel("New vault password", { exact: true })
    .fill(nextPassword);
  await dialog
    .getByLabel("Confirm new password", { exact: true })
    .fill(nextPassword);
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("change-password.png"),
  });
  await dialog
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await app
    .getByRole("navigation", { name: "Credential types" })
    .getByRole("button", { name: "API keys", exact: true })
    .click();
  await expect(
    vault.getByRole("heading", { name: "Unlock API keys", exact: true }),
  ).toBeVisible();
  await vault.getByLabel("Vault password", { exact: true }).fill(password);
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await expect(vault.getByRole("alert")).toContainText("Could not unlock");
  await vault.getByLabel("Vault password", { exact: true }).fill(nextPassword);
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await expect(vault.locator(".credential-group-title")).toHaveCount(2);
  // Refresh and tab changes must drop plaintext, while persisted data is ciphertext only.
  await app
    .getByRole("navigation", { name: "Credential types" })
    .getByRole("button", { name: "Certificates", exact: true })
    .click();
  await app
    .getByRole("navigation", { name: "Credential types" })
    .getByRole("button", { name: "API keys", exact: true })
    .click();
  await expect(
    vault.getByRole("heading", { name: "Unlock API keys", exact: true }),
  ).toBeVisible();
  expect(
    posts.every(
      (body) =>
        !body.includes(secret) &&
        !body.includes(password) &&
        !body.includes(nextPassword),
    ),
  ).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    secret,
  );
  await page.screenshot({ path: info.outputPath("locked-vault.png") });
  await vault.getByLabel("Vault password", { exact: true }).fill(nextPassword);
  await vault
    .getByRole("button", { name: "Unlock vault", exact: true })
    .click();
  await vault
    .getByRole("button", { name: "Edit API key", exact: true })
    .click();
  await dialog
    .getByLabel("API key purpose", { exact: true })
    .fill("Updated purpose");
  await page.screenshot({
    animations: "disabled",
    path: info.outputPath("key-settings.png"),
  });
  await dialog
    .getByRole("button", { name: "Save API key", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(vault.locator(".cert-detail-purpose")).toHaveText(
    "Updated purpose",
  );
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
  await expect(vault.locator(".vault-workspace")).toHaveCSS(
    "flex-direction",
    "column",
  );
  await vault.screenshot({ path: info.outputPath("narrow-api-keys.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".dock")
    .getByRole("button", { name: "Certificate manager", exact: true })
    .click();
  await vault
    .getByRole("button", { name: "Edit API key", exact: true })
    .click();
  await dialog.evaluate((el) =>
    Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    ),
  );
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath("mobile-key-settings.png") });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.clock.install();
  await page.clock.fastForward(301000);
  await expect(
    vault.getByRole("heading", { name: "Unlock API keys", exact: true }),
  ).toBeVisible();
  await expect(vault.getByLabel("Saved API key", { exact: true })).toHaveCount(
    0,
  );
});
