import {
  constants,
  generateKeyPair,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { promisify } from "node:util";

// Minimal DER writer for the fixed X.509 profile below. Cryptographic operations
// use Node/OpenSSL; no external command or caller-supplied ASN.1 is executed.
const der = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const bytes: number[] = [];
  for (let n = body.length; n; n = Math.floor(n / 256)) bytes.unshift(n & 255);
  const length =
    body.length < 128 ? [body.length] : [0x80 | bytes.length, ...bytes];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const oid = (hex: string) => der(6, Buffer.from(hex, "hex"));
const integer = (value: Buffer) =>
  der(2, ...(value[0]! & 0x80 ? [Buffer.from([0]), value] : [value]));
const nil = der(5);
const pem = (label: string, value: Buffer) =>
  `-----BEGIN ${label}-----\n${value
    .toString("base64")
    .match(/.{1,64}/g)!
    .join("\n")}\n-----END ${label}-----\n`;
const time = (value: string) => {
  const date = new Date(value)
    .toISOString()
    .replace(/[-:T]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const year = Number(date.slice(0, 4));
  return der(
    year >= 1950 && year < 2050 ? 0x17 : 0x18,
    Buffer.from(year >= 1950 && year < 2050 ? date.slice(2) : date),
  );
};
export async function generateCertificate(settings: {
  commonName: string;
  bits: number;
  hash: "sha256" | "sha384" | "sha512";
  notBefore: string;
  notAfter: string;
}) {
  const { publicKey, privateKey } = await promisify(generateKeyPair)("rsa", {
    modulusLength: settings.bits,
    publicExponent: 0x10001,
  });
  const hashNumber = { sha256: "01", sha384: "02", sha512: "03" }[
    settings.hash
  ];
  const saltLength = { sha256: 32, sha384: 48, sha512: 64 }[settings.hash];
  const hashAlgorithm = sequence(oid(`6086480165030402${hashNumber}`), nil);
  const signatureAlgorithm = sequence(
    oid("2a864886f70d01010a"), // id-RSASSA-PSS
    sequence(
      der(0xa0, hashAlgorithm),
      der(0xa1, sequence(oid("2a864886f70d010108"), hashAlgorithm)),
      der(0xa2, integer(Buffer.from([saltLength]))),
    ),
  );
  const name = sequence(
    der(
      0x31,
      sequence(
        oid("550403"),
        der(12, Buffer.from(settings.commonName, "utf8")),
      ),
    ),
  );
  const serial = randomBytes(16);
  serial[0] = serial[0]! | 1;
  const extensions = der(
    0xa3,
    sequence(
      sequence(oid("551d13"), der(1, Buffer.from([255])), der(4, sequence())), // critical, CA=false
      sequence(
        oid("551d0f"),
        der(1, Buffer.from([255])),
        der(4, der(3, Buffer.from([7, 128]))),
      ), // critical digitalSignature
    ),
  );
  const tbs = sequence(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    signatureAlgorithm,
    name,
    sequence(time(settings.notBefore), time(settings.notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign(settings.hash, tbs, {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength,
  });
  const certDer = sequence(
    tbs,
    signatureAlgorithm,
    der(3, Buffer.from([0]), signature),
  );
  const cert = new X509Certificate(certDer);
  if (!cert.verify(publicKey) || !cert.checkPrivateKey(privateKey) || cert.ca)
    throw Error("The generated certificate did not pass verification.");
  return {
    certPem: pem("CERTIFICATE", certDer),
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    fingerprint: cert.fingerprint256,
    serial: cert.serialNumber,
  };
}
