export interface CertificateEnvironment {
  id: string;
  name: string;
  accountId: string;
}
export interface CertificateRecord {
  id: string;
  name: string;
  purpose: string;
  environmentId: string;
  commonName: string;
  bits: number;
  hash: "sha256" | "sha384" | "sha512";
  notBefore: string;
  notAfter: string;
  certFilename: string;
  keyFilename: string;
  fingerprint: string;
  serial: string;
  createdAt: string;
  archived: boolean;
  certPath: string;
  keyPath: string;
}
export interface CertificateData {
  environments: CertificateEnvironment[];
  certificates: CertificateRecord[];
}
export async function certificateRequest<T>(
  operation: string,
  args: unknown = {},
): Promise<T> {
  const response = await fetch(`/__orvane/certificates/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const message =
      result && typeof result === "object" && "error" in result
        ? result.error
        : undefined;
    throw new Error(
      typeof message === "string"
        ? message
        : "The certificate operation failed.",
    );
  }
  return result as T;
}
