import { z } from "zod";

const base64 = (size: number) =>
  z
    .string()
    .length(size)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/);
export const vaultEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    kdf: z.literal("PBKDF2-SHA256"),
    iterations: z.literal(600000),
    salt: base64(24),
    iv: base64(16),
    ciphertext: z
      .string()
      .min(24)
      .max(2800000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export type VaultEnvelope = z.infer<typeof vaultEnvelopeSchema>;
export interface VaultState {
  revision: number;
  envelope: VaultEnvelope | null;
}
export const apiKeyRecordSchema = z
  .object({
    id: z.string().uuid(),
    // Existing v1 vault entries without a kind remain API keys.
    kind: z.enum(["api-key", "api-secret"]).optional(),
    name: z.string().trim().min(1).max(160),
    purpose: z.string().trim().max(2000),
    environmentId: z.string().uuid(),
    secret: z.string().min(1).max(16384),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ApiKeyRecord = z.infer<typeof apiKeyRecordSchema>;
export function generateApiSecret() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => alphabet[byte & 63]!,
  ).join("");
}
const payloadSchema = z
  .object({
    type: z.literal("orvane-api-key-vault"),
    version: z.literal(1),
    records: z.array(apiKeyRecordSchema).max(1000),
  })
  .strict();
const encoder = new TextEncoder();
const context = encoder.encode("orvane-api-key-vault:v1:PBKDF2-SHA256:600000");
export const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
};
const fromBase64 = (text: string) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export async function deriveVaultKey(password: string, salt: string) {
  const bytes = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      bytes,
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: fromBase64(salt),
        iterations: 600000,
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  } finally {
    bytes.fill(0);
  }
}
export async function sealVault(
  key: Awaited<ReturnType<typeof deriveVaultKey>>,
  salt: string,
  records: ApiKeyRecord[],
): Promise<VaultEnvelope> {
  const payload = payloadSchema.parse({
    type: "orvane-api-key-vault",
    version: 1,
    records,
  });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = encoder.encode(JSON.stringify(payload));
  try {
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context, tagLength: 128 },
      key,
      bytes,
    );
    return vaultEnvelopeSchema.parse({
      version: 1,
      algorithm: "AES-256-GCM",
      kdf: "PBKDF2-SHA256",
      iterations: 600000,
      salt,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(encrypted)),
    });
  } finally {
    bytes.fill(0);
  }
}
export async function openVault(password: string, input: VaultEnvelope) {
  const envelope = vaultEnvelopeSchema.parse(input);
  const key = await deriveVaultKey(password, envelope.salt);
  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: fromBase64(envelope.iv),
          additionalData: context,
          tagLength: 128,
        },
        key,
        fromBase64(envelope.ciphertext),
      ),
    );
    const payload = payloadSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return { key, records: payload.records, salt: envelope.salt };
  } catch {
    throw new Error(
      "Could not unlock the vault. Check your password; a damaged vault also cannot be unlocked.",
    );
  } finally {
    bytes?.fill(0);
  }
}
