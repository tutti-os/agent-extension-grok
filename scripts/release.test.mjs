import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildRelease, buildVersions, verifyBuiltRelease } from "./release.mjs";

const root = path.resolve(import.meta.dirname, "..");

describe("Grok extension release", () => {
  it("builds a reproducible signed v2 package and versions index", async () => {
    execFileSync(process.execPath, [path.join(root, "scripts", "package.mjs")]);
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "grok-extension-release-test-"));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const options = {
      packageDir: path.join(root, "build", "tutti-agent", "package"),
      outputDir,
      version: "0.1.0",
      baseUrl: "https://example.test/tutti-agent-releases",
      signingKeyId: "tutti-grok-release-v1",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
      publishedAt: "2026-07-20T00:00:00Z",
      gitSha: "test"
    };
    const first = await buildRelease(options);
    const firstBytes = await readFile(first.artifactPath);
    const second = await buildRelease(options);
    const secondBytes = await readFile(second.artifactPath);
    assert.deepEqual(secondBytes, firstBytes);
    await verifyBuiltRelease({
      release: second.release,
      artifactPath: second.artifactPath,
      publicKey,
      signingKeyId: options.signingKeyId
    });
    const versions = await buildVersions({
      releaseFile: second.releasePath,
      output: path.join(outputDir, "agents", "grok", "versions.json"),
      minTuttiVersion: "0.0.0"
    });
    assert.equal(versions.versions[0].release.manifest.schemaVersion, "tutti.agent.manifest.v2");
    assert.equal(versions.versions[0].release.manifest.runtime.install.artifacts[0].version, "0.2.103");
  });

  it("withdraws an existing release while publishing a replacement", async () => {
    execFileSync(process.execPath, [path.join(root, "scripts", "package.mjs")]);
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "grok-extension-release-test-"));
    const { privateKey } = generateKeyPairSync("ed25519");
    const baseOptions = {
      packageDir: path.join(root, "build", "tutti-agent", "package"),
      outputDir,
      baseUrl: "https://example.test/tutti-agent-releases",
      signingKeyId: "tutti-grok-release-v2",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
      publishedAt: "2026-07-20T00:00:00Z",
      gitSha: "test"
    };
    const original = await buildRelease({ ...baseOptions, version: "0.1.0" });
    const versionsPath = path.join(outputDir, "agents", "grok", "versions.json");
    await buildVersions({
      releaseFile: original.releasePath,
      output: versionsPath,
      minTuttiVersion: "0.0.0"
    });
    const replacement = await buildRelease({ ...baseOptions, version: "0.1.1" });
    const versions = await buildVersions({
      releaseFile: replacement.releasePath,
      existingVersions: versionsPath,
      output: versionsPath,
      minTuttiVersion: "0.0.0",
      withdrawVersions: "0.1.0"
    });

    assert.deepEqual(
      versions.versions.map(({ version, status }) => ({ version, status })),
      [
        { version: "0.1.1", status: "active" },
        { version: "0.1.0", status: "withdrawn" }
      ]
    );
  });
});
