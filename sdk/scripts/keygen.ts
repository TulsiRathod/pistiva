/**
 * Creates an encrypted agent key file and prints the public key to register in the console.
 *   npm run keygen -- <path/to/agent.key.json>
 * The passphrase comes from KEY_PASSPHRASE.
 */
import { existsSync } from "node:fs";
import { generateKeyPair, kidFor, saveKeyFile } from "@pistiva/agent-sdk";

const path = process.argv[2];
const passphrase = process.env.KEY_PASSPHRASE;
if (!path || !passphrase) {
  console.error("Usage: KEY_PASSPHRASE=... npm run keygen -- <path/to/agent.key.json>");
  process.exit(1);
}
if (existsSync(path)) {
  console.error(`${path} already exists; refusing to overwrite a key`);
  process.exit(1);
}
const keys = generateKeyPair();
await saveKeyFile(path, keys, passphrase);
console.log(`Key file:   ${path}`);
console.log(`Key ID:     ${kidFor(keys.publicKey)}`);
console.log(`Public key: ${keys.publicKey}`);
console.log("Register the public key on the agent in the console. The private key stays in the key file.");
