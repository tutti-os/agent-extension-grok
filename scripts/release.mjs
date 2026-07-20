import { createHash, sign, verify, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import semver from "semver";
import { validateManifest, validatePackage } from "./validate.mjs";

export async function buildRelease(options) {
  const packageDir = path.resolve(options.packageDir);
  const outputDir = path.resolve(options.outputDir);
  const version = requireSemver(options.version, "release version");
  const baseUrl = requireHTTPSBaseURL(options.baseUrl);
  const manifest = structuredClone(await validatePackage(packageDir, "grok"));
  manifest.version = version;
  validateManifest(manifest, "grok");

  const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "tutti-grok-release-"));
  const stagedPackage = path.join(stagingRoot, "package");
  const releaseDir = path.join(outputDir, "agents", "grok", version);
  const artifactName = `grok-${version}.zip`;
  const artifactPath = path.join(releaseDir, artifactName);
  await mkdir(releaseDir, { recursive: true });
  try {
    await cp(packageDir, stagedPackage, { recursive: true, errorOnExist: true, dereference: false });
    await writeFile(path.join(stagedPackage, "tutti.agent.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await validatePackage(stagedPackage, "grok");
    await createReproducibleZip(stagedPackage, artifactPath);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  const artifact = await readFile(artifactPath);
  const unsigned = {
    schemaVersion: "tutti.agent.release.v1",
    agentKey: "grok",
    version,
    manifest,
    artifactUrl: `${baseUrl}/agents/grok/${version}/${artifactName}`,
    artifactSha256: createHash("sha256").update(artifact).digest("hex"),
    artifactSizeBytes: artifact.length,
    publishedAt: options.publishedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
    gitSha: String(options.gitSha ?? "").trim()
  };
  const privateKey = String(options.privateKey ?? process.env.TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY ?? "").replace(/\\n/gu, "\n");
  if (!privateKey) throw new Error("TUTTI_AGENT_EXTENSION_SIGNING_PRIVATE_KEY is required");
  const release = {
    ...unsigned,
    signature: {
      algorithm: "ed25519",
      keyId: String(options.signingKeyId),
      value: sign(null, signingPayload(unsigned), privateKey).toString("base64")
    }
  };
  const releasePath = path.join(releaseDir, "release.json");
  await writeJSON(releasePath, release);
  return { release, releasePath, artifactPath };
}

export async function buildVersions(options) {
  const release = JSON.parse(await readFile(path.resolve(options.releaseFile), "utf8"));
  const current = options.existingVersions
    ? JSON.parse(await readFile(path.resolve(options.existingVersions), "utf8"))
    : { schemaVersion: "tutti.agent.versions.v1", agentKey: "grok", versions: [] };
  if (current.schemaVersion !== "tutti.agent.versions.v1" || current.agentKey !== "grok") {
    throw new Error("existing versions index identity is invalid");
  }
  const record = {
    version: release.version,
    minTuttiVersion: requireSemver(options.minTuttiVersion ?? "0.0.0", "minimum Tutti version"),
    requiredHostCapabilities: [],
    status: "active",
    release
  };
  const byVersion = new Map(current.versions.map((entry) => [entry.version, entry]));
  const existing = byVersion.get(record.version);
  if (existing && stableJSONStringify(existing) !== stableJSONStringify(record)) {
    throw new Error(`version ${record.version} already exists with different content`);
  }
  byVersion.set(record.version, record);
  for (const version of normalizeWithdrawVersions(options.withdrawVersions)) {
    if (version === record.version) {
      throw new Error(`cannot withdraw the version being published: ${version}`);
    }
    const entry = byVersion.get(version);
    if (!entry) {
      throw new Error(`cannot withdraw unknown version: ${version}`);
    }
    byVersion.set(version, { ...entry, status: "withdrawn" });
  }
  const versions = [...byVersion.values()].sort((left, right) => semver.rcompare(left.version, right.version));
  const result = { schemaVersion: "tutti.agent.versions.v1", agentKey: "grok", versions };
  await writeJSON(path.resolve(options.output), result);
  return result;
}

function normalizeWithdrawVersions(value) {
  const versions = String(value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(versions)].map((version) => requireSemver(version, "withdrawn version"));
}

export async function verifyBuiltRelease({ release, artifactPath, publicKey, signingKeyId }) {
  if (release.signature?.keyId !== signingKeyId || release.signature?.algorithm !== "ed25519") {
    throw new Error("release signing identity is invalid");
  }
  const { signature, ...unsigned } = release;
  if (!verify(null, signingPayload(unsigned), publicKey, Buffer.from(signature.value, "base64"))) {
    throw new Error("release signature is invalid");
  }
  const artifact = await readFile(artifactPath);
  if (artifact.length !== release.artifactSizeBytes || createHash("sha256").update(artifact).digest("hex") !== release.artifactSha256) {
    throw new Error("release artifact identity is invalid");
  }
}

async function createReproducibleZip(packageDir, artifactPath) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "tutti-grok-zip-"));
  const root = path.join(staging, "package");
  try {
    await cp(packageDir, root, { recursive: true, dereference: false });
    const entries = await normalizeEntries(root);
    await rm(artifactPath, { force: true });
    const result = spawnSync("zip", ["-X", "-q", artifactPath, "-@"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      input: `${entries.join("\n")}\n`
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `zip exited with ${result.status}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function normalizeEntries(root, relativeDir = "") {
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const result = [];
  for (const entry of entries) {
    if (/[\n\r]/u.test(entry.name)) throw new Error("package path contains a newline");
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    await utimes(absolutePath, new Date("1980-01-01T00:00:00Z"), new Date("1980-01-01T00:00:00Z"));
    if (entry.isDirectory()) {
      result.push(`${relativePath}/`, ...(await normalizeEntries(root, relativePath)));
    } else if (entry.isFile()) {
      if ((await stat(absolutePath)).mode & 0o111) throw new Error(`executable package entry: ${relativePath}`);
      result.push(relativePath);
    } else {
      throw new Error(`unsupported package entry: ${relativePath}`);
    }
  }
  return result;
}

function signingPayload(value) {
  return Buffer.from(stableJSONStringify(value), "utf8");
}

function stableJSONStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableJSONStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJSONStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requireSemver(value, label) {
  const normalized = String(value ?? "").trim();
  if (!semver.valid(normalized)) throw new Error(`${label} must be SemVer`);
  return normalized;
}

function requireHTTPSBaseURL(value) {
  const normalized = String(value ?? "").trim().replace(/\/+$/u, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:") throw new Error("release base URL must use HTTPS");
  return normalized;
}

async function writeJSON(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument ${key ?? ""}`);
    result[key.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())] = value;
  }
  return result;
}

if (process.argv[1] === import.meta.filename) {
  const command = process.argv[2];
  const options = parseArgs(process.argv.slice(3));
  if (command === "build") {
    await buildRelease(options);
  } else if (command === "versions") {
    await buildVersions(options);
  } else if (command === "test-keypair") {
    const { publicKey } = generateKeyPairSync("ed25519");
    process.stdout.write(publicKey.export({ type: "spki", format: "pem" }));
  } else {
    throw new Error("usage: release.mjs build|versions [options]");
  }
}
