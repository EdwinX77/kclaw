#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [storePath, ...tarballs] = process.argv.slice(2);

if (!storePath || tarballs.length === 0) {
  console.error("usage: alias-pnpm-tarball-store.mjs <pnpm-store-path> <tarball...>");
  process.exit(2);
}

const indexDbPath = join(storePath, "index.db");
if (!existsSync(indexDbPath)) {
  console.error(`pnpm store index not found: ${indexDbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(indexDbPath);
const getSource = db.prepare(
  "SELECT data FROM package_index WHERE key LIKE ? ORDER BY key LIMIT 1",
);
const upsertAlias = db.prepare("INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)");

for (const tarball of tarballs) {
  if (!existsSync(tarball)) {
    continue;
  }

  const tarballBuffer = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(tarballBuffer).digest("base64")}`;
  const manifest = readTarballManifest(tarball);
  const packageId = `${manifest.name}@${manifest.version}`;
  const source = getSource.get(`${integrity}\tfile:%`);

  if (!source) {
    throw new Error(`pnpm store entry for local tarball was not found: ${tarball}`);
  }

  upsertAlias.run(`${integrity}\t${packageId}`, source.data);
  console.log(`pnpm tarball cache alias: ${packageId}`);
}

db.close();

function readTarballManifest(tarball) {
  const result = spawnSync("tar", ["-xOf", tarball, "package/package.json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `failed to read package/package.json from ${tarball}: ${
        result.stderr.trim() || result.status
      }`,
    );
  }

  const manifest = JSON.parse(result.stdout);
  if (
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    throw new Error(`invalid npm tarball manifest in ${tarball}`);
  }
  return manifest;
}
