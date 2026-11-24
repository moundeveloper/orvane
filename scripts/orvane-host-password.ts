import { writeFile } from "node:fs/promises";
import { makeHostPasswordVerifier } from "../server/orvane-host.ts";

const destination = process.argv[2];
if (!destination || process.stdin.isTTY)
  throw Error("Pass an unused verifier file path and pipe a password from masked input.");
let password = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  password += chunk;
  if (password.length > 260) throw Error("The password is too long.");
}
await writeFile(destination, await makeHostPasswordVerifier(password.replace(/\r?\n$/, "")) + "\n", {
  flag: "wx",
  mode: 0o600,
});
