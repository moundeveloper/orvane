import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function localHostCertificate(directory: string, address: string) {
  if (!isIPv4(address)) throw Error("Select a local IPv4 address.");
  const root = join(directory, "host-certificates");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const authority = join(root, "authority");
  const leaf = join(root, address);
  const caCert = join(authority, "orvane-host-ca.pem");
  const caKey = join(authority, "ca-key.pem");
  const gitOpenSSL = join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "openssl.exe");
  const executable = process.platform === "win32" && existsSync(gitOpenSSL) ? gitOpenSSL : "openssl";
  const openssl = (args: string[], cwd: string) => run(executable, args, { cwd, timeout: 15_000, windowsHide: true });

  async function stage(target: string, create: (folder: string) => Promise<void>) {
    const temporary = await mkdtemp(join(root, "create-"));
    try {
      await create(temporary);
      try { await rename(temporary, target); }
      catch (error) { if (!existsSync(target)) throw error; }
    } finally {
      const files = await readdir(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (files) {
        await Promise.all(files.map((file) => unlink(join(temporary, file))));
        await rmdir(temporary);
      }
    }
  }

  try {
    if (!existsSync(caCert)) await stage(authority, async (cwd) => {
      await openssl([
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1825",
        "-subj", "/CN=Orvane Host Local CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca-key.pem", "-out", "orvane-host-ca.pem",
      ], cwd);
    });
    if (!existsSync(join(leaf, "server.pem"))) await stage(leaf, async (cwd) => {
      await openssl([
        "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=Orvane Host",
        "-keyout", "server-key.pem", "-out", "server.csr",
      ], cwd);
      await writeFile(join(cwd, "extensions.cnf"), [
        `subjectAltName=IP:${address}`, "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment", "extendedKeyUsage=serverAuth",
      ].join("\n"));
      await openssl([
        "x509", "-req", "-in", "server.csr", "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
        "-CAserial", join(cwd, "serial"), "-days", "825", "-extfile", "extensions.cnf", "-out", "server.pem",
      ], cwd);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Error("OpenSSL is needed to make the Host certificate. Git for Windows includes it.");
    throw Error("Could not create the Host certificate.");
  }
  const [cert, key, trust] = await Promise.all([
    readFile(join(leaf, "server.pem")), readFile(join(leaf, "server-key.pem")), readFile(caCert, "utf8"),
  ]);
  if (!new X509Certificate(cert).checkIP(address)) throw Error("The Host certificate does not match this address.");
  return { tls: { cert, key }, trust };
}
