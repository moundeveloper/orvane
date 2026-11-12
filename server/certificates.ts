import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { LocalDatabase } from "./database.ts";
import { generateCertificate } from "./certificate-crypto.ts";
import { vaultEnvelopeSchema } from "../src/apiKeyVault.ts";
import type {
  CertificateData,
  CertificateEnvironment,
  CertificateRecord,
} from "../src/certificates.ts";

const execute = promisify(execFile);
const text = z.string().trim().min(1).max(160);
const id = z.string().uuid();
const filename = z
  .string()
  .trim()
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.pem$/,
    "Use a simple .pem filename (letters, numbers, hyphens and underscores).",
  );
const generation = z
  .object({
    name: text,
    purpose: z.string().trim().min(1).max(2000),
    environmentId: id,
    commonName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(
        (v) => !/[\x00-\x1f\x7f]/.test(v),
        "Common name cannot contain control characters.",
      ),
    bits: z.union([
      z.literal(2048),
      z.literal(3072),
      z.literal(4096),
      z.literal(8192),
    ]),
    hash: z.enum(["sha256", "sha384", "sha512"]),
    notBefore: z.iso.datetime(),
    notAfter: z.iso.datetime(),
    certFilename: filename,
    keyFilename: filename,
  })
  .refine(
    (v) => Date.parse(v.notBefore) >= Date.UTC(1950, 0, 1),
    "The start date must be in 1950 or later.",
  )
  .refine(
    (v) => v.certFilename.toLowerCase() !== v.keyFilename.toLowerCase(),
    "Certificate and key filenames must differ.",
  )
  .refine(
    (v) => Date.parse(v.notAfter) > Date.parse(v.notBefore),
    "Expiry must be after the start date.",
  )
  .refine(
    (v) =>
      Date.parse(v.notAfter) - Date.parse(v.notBefore) <= 10 * 366 * 86400000,
    "Validity cannot exceed ten years.",
  );

export class CertificateService {
  private db: LocalDatabase;
  private root: string;
  private busy = false;
  constructor(directory: string, filename = "workspace.sqlite") {
    this.db = new LocalDatabase(path.join(directory, filename));
    this.root = path.resolve(
      directory,
      filename === "workspace.sqlite"
        ? "certificates"
        : `tests/certificates-${path.basename(filename, ".sqlite")}`,
    );
  }
  close() {
    this.db.close();
  }
  private environments() {
    return this.db.notesData(
      "certificate-environments",
      "list",
    ) as CertificateEnvironment[];
  }
  private records() {
    return this.db.notesData("certificate-pairs", "list") as Omit<
      CertificateRecord,
      "certPath" | "keyPath"
    >[];
  }
  private pairFolder(id: string) {
    // IDs are created by this service; validate even when reading saved metadata.
    return path.join(this.root, z.string().uuid().parse(id));
  }
  private list(): CertificateData {
    return {
      environments: this.environments(),
      certificates: this.records().map((record) => ({
        ...record,
        certPath: path.join(
          this.pairFolder(record.id),
          filename.parse(record.certFilename),
        ),
        keyPath: path.join(
          this.pairFolder(record.id),
          filename.parse(record.keyFilename),
        ),
      })),
    };
  }
  private async protect(folder: string) {
    if ((await lstat(folder)).isSymbolicLink())
      throw Error("The certificate storage folder cannot be a symbolic link.");
    if (process.platform === "win32") {
      const { stdout } = await execute(
        "whoami.exe",
        ["/user", "/fo", "csv", "/nh"],
        { windowsHide: true, timeout: 10000 },
      );
      const sid = stdout.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid)
        throw Error(
          "Could not determine your Windows identity to protect the private key folder.",
        );
      await execute(
        "icacls.exe",
        [
          folder,
          "/inheritance:r",
          "/grant:r",
          `*${sid}:(OI)(CI)F`,
          "*S-1-5-18:(OI)(CI)F",
        ],
        { windowsHide: true, timeout: 10000 },
      );
    } else await chmod(folder, 0o700);
  }
  async invoke(operation: string, args: unknown): Promise<unknown> {
    if (operation === "list") return this.list();
    if (operation === "vault-read")
      return (
        this.db.appData("api-key-vault") || { revision: 0, envelope: null }
      );
    if (operation === "vault-write") {
      const input = z
        .object({
          expectedRevision: z
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER - 1),
          envelope: vaultEnvelopeSchema,
        })
        .strict()
        .parse(args);
      return this.db.saveApiKeyVault(input.expectedRevision, input.envelope);
    }
    if (operation === "environment-save") {
      const env = z
        .object({
          id: id.optional(),
          name: text,
          accountId: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .regex(
              /^[a-zA-Z0-9_-]+$/,
              "Account ID can contain letters, numbers, hyphens and underscores.",
            ),
        })
        .parse(args);
      if (env.id && !this.environments().some((e) => e.id === env.id))
        throw Error("Environment no longer exists. Refresh and try again.");
      if (
        this.environments().some(
          (e) =>
            e.id !== env.id &&
            e.accountId.toLowerCase() === env.accountId.toLowerCase(),
        )
      )
        throw Error("An environment with this account ID already exists.");
      this.db.notesData("certificate-environments", "put", undefined, [
        { ...env, id: env.id || randomUUID() },
      ]);
      return this.list();
    }
    if (operation === "archive") {
      const input = z.object({ id, archived: z.boolean() }).parse(args);
      const record = this.records().find((v) => v.id === input.id);
      if (!record) throw Error("Certificate not found. Refresh and try again.");
      this.db.notesData("certificate-pairs", "put", undefined, [
        { ...record, archived: input.archived },
      ]);
      return this.list();
    }
    if (operation === "reveal") {
      const input = z
        .object({ id, file: z.enum(["certificate", "key", "folder"]) })
        .parse(args);
      const record = this.list().certificates.find((v) => v.id === input.id);
      if (!record) throw Error("Certificate not found. Refresh and try again.");
      const folder = this.pairFolder(record.id);
      const target =
        input.file === "folder"
          ? folder
          : input.file === "key"
            ? record.keyPath
            : record.certPath;
      const info = await lstat(target).catch(() => {
        throw Error(
          "The saved file is missing. Check its storage folder in Explorer.",
        );
      });
      if (
        info.isSymbolicLink() ||
        (await lstat(folder)).isSymbolicLink() ||
        (await lstat(this.root)).isSymbolicLink()
      )
        throw Error(
          "The saved file location has changed. Symbolic links are not allowed.",
        );
      if (process.platform !== "win32")
        throw Error("Reveal in Explorer is available on Windows.");
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "explorer.exe",
          input.file === "folder" ? [folder] : [`/select,${target}`],
          // Explorer is the requested UI, so it must get a visible window.
          // windowsHide:true opens invisible Explorer windows from the desktop
          // server even though process creation reports success.
          { windowsHide: false, detached: true, stdio: "ignore" },
        );
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
      return { revealed: true };
    }
    if (operation !== "generate") throw Error("Unknown certificate operation.");
    const settings = generation.parse(args);
    if (!this.environments().some((e) => e.id === settings.environmentId))
      throw Error("Choose an existing environment.");
    if (this.busy)
      throw Error("Another certificate is generating. Wait for it to finish.");
    this.busy = true;
    const recordId = randomUUID(),
      folder = this.pairFolder(recordId);
    let created = false;
    try {
      const result = await generateCertificate(settings);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.protect(this.root);
      await mkdir(folder, { mode: 0o700 });
      created = true;
      await writeFile(path.join(folder, settings.keyFilename), result.keyPem, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(
        path.join(folder, settings.certFilename),
        result.certPem,
        { flag: "wx", mode: 0o600 },
      );
      this.db.notesData("certificate-pairs", "add", undefined, [
        {
          ...settings,
          id: recordId,
          fingerprint: result.fingerprint,
          serial: result.serial,
          createdAt: new Date().toISOString(),
          archived: false,
        },
      ]);
      return this.list();
    } catch (error) {
      // Only remove the fresh UUID folder owned by this generation attempt.
      if (created) await rm(folder, { recursive: true, force: true });
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
