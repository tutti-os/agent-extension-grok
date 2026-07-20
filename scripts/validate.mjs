import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

const allowedExtensions = new Set([".json", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp"]);
const profileSchemas = Object.freeze({
  discovery: "tutti.agent.discovery.v1",
  tools: "tutti.agent.tools.v1",
  capabilities: "tutti.agent.capabilities.v1",
  composer: "tutti.agent.composer.v1",
  events: "tutti.agent.events.v1"
});

export async function validatePackage(packageDir, expectedAgentKey = "grok") {
  const manifest = JSON.parse(await readFile(path.join(packageDir, "tutti.agent.json"), "utf8"));
  validateManifest(manifest, expectedAgentKey);
  await validatePackageEntries(packageDir);
  await validateReferences(packageDir, manifest);
  await validateGrokProfiles(packageDir, manifest);
  return manifest;
}

export function validateManifest(manifest, expectedAgentKey = "grok") {
  if (manifest?.schemaVersion !== "tutti.agent.manifest.v2") {
    throw new Error("manifest must use tutti.agent.manifest.v2");
  }
  if (manifest.agentKey !== expectedAgentKey || manifest.agentKey !== "grok") {
    throw new Error("manifest agentKey must be grok");
  }
  if (!semver.valid(manifest.version)) throw new Error("manifest version must be SemVer");
  requireString(manifest.name, "manifest name");
  requireAsset(manifest.icon, "manifest icon");
  if (manifest.maskIcon !== undefined) requireAsset(manifest.maskIcon, "manifest maskIcon");
  if (manifest.heroImage !== undefined) requireAsset(manifest.heroImage, "manifest heroImage");

  if (manifest.runtime?.kind !== "standard-acp") {
    throw new Error("runtime kind must be standard-acp");
  }
  const install = manifest.runtime.install;
  if (install?.runner !== "binary" || (install.args?.length ?? 0) !== 0) {
    throw new Error("Grok runtime must use the binary runner without installer argv");
  }
  if (!Array.isArray(install.artifacts) || install.artifacts.length !== 1) {
    throw new Error("Grok must declare exactly one supported artifact");
  }
  const artifact = install.artifacts[0];
  const expectedArtifact = {
    kind: "executable",
    platform: "darwin-arm64",
    version: "0.2.103",
    url: "https://x.ai/cli/grok-0.2.103-macos-aarch64",
    sha256: "1be9de92f31566f2d38992125f902220b022f4f1e3fb7330532a0513d1d6f0f2",
    sizeBytes: 121600480,
    provenance: {
      kind: "official-release",
      url: "https://x.ai/cli/install.sh"
    }
  };
  if (JSON.stringify(artifact) !== JSON.stringify(expectedArtifact)) {
    throw new Error("Grok official artifact identity drifted from the approved pin");
  }
  requireHTTPSURL(artifact.url, "artifact URL");
  requireHTTPSURL(artifact.provenance.url, "artifact provenance URL");

  const launch = manifest.runtime.launch;
  if (launch?.executable !== "${installRoot}/grok") {
    throw new Error("Grok launch executable must be ${installRoot}/grok");
  }
  const expectedArgs = [
    "--no-auto-update",
    "--permission-mode",
    "${permissionMode}",
    "agent",
    "stdio"
  ];
  if (JSON.stringify(launch.args) !== JSON.stringify(expectedArgs)) {
    throw new Error("Grok launch argv must preserve the validated ACP contract");
  }
  if (launch.publishUserCommand !== false) {
    throw new Error("Grok managed runtime must not publish or replace a user command");
  }

  if (!manifest.profiles?.discovery || !manifest.profiles?.composer) {
    throw new Error("discovery and composer profiles are required");
  }
  for (const [kind, file] of Object.entries(manifest.profiles)) {
    if (!Object.hasOwn(profileSchemas, kind)) throw new Error(`unsupported profile ${kind}`);
    requireRelativePath(file, `profiles.${kind}`);
  }
  const localization = manifest.localizationInfo;
  requireString(localization?.defaultLocale, "default locale");
  requireRelativePath(localization?.defaultFile, "default locale file");
  for (const entry of localization?.additionalLocales ?? []) {
    requireString(entry.locale, "additional locale");
    requireRelativePath(entry.file, "additional locale file");
  }
  return manifest;
}

async function validateGrokProfiles(packageDir, manifest) {
  const discovery = await readJSON(packageDir, manifest.profiles.discovery);
  const candidate = discovery.candidates?.[0];
  if (discovery.schemaVersion !== profileSchemas.discovery || discovery.candidates?.length !== 1) {
    throw new Error("Grok discovery must declare one candidate");
  }
  if (JSON.stringify(candidate.binaryNames) !== JSON.stringify(["grok"]) ||
      JSON.stringify(candidate.version) !== JSON.stringify({ args: ["--version"], constraint: ">=0.2.89 <0.3.0" }) ||
      JSON.stringify(candidate.launchArgs) !== JSON.stringify(manifest.runtime.launch.args) ||
      candidate.probe?.kind !== "acp-initialize") {
    throw new Error("Grok discovery contract drifted from the runtime contract");
  }

  const composer = await readJSON(packageDir, manifest.profiles.composer);
  const mappings = Object.fromEntries(
    (composer.permissionModes ?? []).map((entry) => [entry.semantic, entry.runtimeId])
  );
  if (composer.schemaVersion !== profileSchemas.composer ||
      composer.launchSettings?.permission?.placeholder !== "${permissionMode}" ||
      composer.launchSettings?.permission?.defaultSemantic !== "ask-before-write" ||
      mappings["ask-before-write"] !== "default" ||
      mappings.auto !== "auto" ||
      mappings["full-access"] !== "bypassPermissions") {
    throw new Error("Grok spawn permission mappings are invalid");
  }
  if (composer.workflowModes?.plan?.enabledRuntimeId !== "plan" ||
      composer.workflowModes?.plan?.disabledRuntimeId !== "default" ||
      composer.workflowModes?.plan?.updateStrategy !== "restart-with-launch-permission") {
    throw new Error("Grok Plan workflow mapping is invalid");
  }
  if (composer.setModel?.reasoningEffortMeta !== true) {
    throw new Error("Grok model changes must forward runtime-advertised reasoning effort metadata");
  }
}

async function validateReferences(packageDir, manifest) {
  const references = [
    [manifest.icon.src, null],
    ...(manifest.maskIcon ? [[manifest.maskIcon.src, null]] : []),
    ...(manifest.heroImage ? [[manifest.heroImage.src, null]] : []),
    [manifest.localizationInfo.defaultFile, null],
    ...(manifest.localizationInfo.additionalLocales ?? []).map((entry) => [entry.file, null]),
    ...Object.entries(manifest.profiles).map(([kind, file]) => [file, profileSchemas[kind]])
  ];
  for (const [relativePath, schema] of references) {
    requireRelativePath(relativePath, "package reference");
    const info = await stat(path.join(packageDir, relativePath)).catch(() => null);
    if (!info?.isFile() || info.size === 0) throw new Error(`missing package reference: ${relativePath}`);
    if (schema) {
      const value = await readJSON(packageDir, relativePath);
      if (value.schemaVersion !== schema) throw new Error(`${relativePath} must use ${schema}`);
    }
  }
}

async function validatePackageEntries(root, relativeDir = "") {
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${relativePath}`);
    if (entry.isDirectory()) {
      await validatePackageEntries(root, relativePath);
      continue;
    }
    if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      throw new Error(`unsupported package entry: ${relativePath}`);
    }
    const info = await stat(absolutePath);
    if ((info.mode & 0o111) !== 0) throw new Error(`executable is forbidden: ${relativePath}`);
  }
}

function requireAsset(asset, label) {
  if (asset?.type !== "asset") throw new Error(`${label}.type must be asset`);
  requireRelativePath(asset.src, `${label}.src`);
}

function requireRelativePath(value, label) {
  const normalized = requireString(value, label);
  if (path.isAbsolute(normalized) || normalized.includes("\0") || normalized.split(/[\\/]+/u).includes("..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return normalized;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}

function requireHTTPSURL(value, label) {
  const parsed = new URL(requireString(value, label));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or fragment`);
  }
}

async function readJSON(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}
