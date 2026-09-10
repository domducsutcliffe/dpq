#!/usr/bin/env node
// ── encrypt-data.mjs ─────────────────────────────────────────────────────────
// Encrypts the dashboard JSON data files using AES-256-GCM with a key derived
// from a password via PBKDF2.  The encrypted output is written alongside the
// originals as .enc files (base64-encoded JSON envelope containing salt, iv,
// and ciphertext).  The browser app decrypts them at runtime using the Web
// Crypto API with the same password.
//
// The password itself is never written down here — it lives in the PQ_PASSWORD Actions
// secret and in whatever you share with readers. A literal in this file would hand the
// dataset to anyone who can read the repo.
//
// Usage:
//   PQ_PASSWORD=<the shared password> node scripts/encrypt-data.mjs
//   node scripts/encrypt-data.mjs --password=<the shared password>
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, pbkdf2Sync, createCipheriv } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getVertical, DEFAULT_VERTICAL_ID } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const dataDir = path.join(repoRoot, "data");

const VERTICAL = getVertical(DEFAULT_VERTICAL_ID);
const verticalDir = path.join(dataDir, VERTICAL.id);

// Resolve password from CLI arg or env var
const pwArg = process.argv.find((a) => a.startsWith("--password="));
const PASSWORD = pwArg ? pwArg.split("=")[1] : process.env.PQ_PASSWORD;

if (!PASSWORD) {
  console.error("Error: supply a password via --password=<pw> or PQ_PASSWORD env var.");
  process.exit(1);
}

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length

function encrypt(plaintext, password) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  // Return a JSON envelope with base64-encoded fields
  return JSON.stringify({
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: authTag.toString("base64"),
    data: encrypted.toString("base64"),
    iterations: PBKDF2_ITERATIONS,
  });
}

async function encryptFile(filePath) {
  const plaintext = await readFile(filePath, "utf8");
  const encPath = filePath + ".enc";
  const envelope = encrypt(plaintext, PASSWORD);
  await writeFile(encPath, envelope, "utf8");
  const sizeKb = (Buffer.byteLength(envelope) / 1024).toFixed(1);
  console.log(`  ✓ ${path.relative(repoRoot, filePath)} → ${path.relative(repoRoot, encPath)} (${sizeKb} KB)`);
}

async function main() {
  console.log(`Encrypting data files for vertical "${VERTICAL.id}"...`);
  await encryptFile(path.join(verticalDir, "questions.json"));
  await encryptFile(path.join(verticalDir, "summary.json"));
  console.log("Encryption complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
