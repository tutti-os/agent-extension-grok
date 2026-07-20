import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(root, "extension");
const packageDir = path.join(root, "build", "tutti-agent", "package");
const version = String(process.env.TUTTI_AGENT_EXTENSION_VERSION || "0.1.0").trim();

if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`invalid TUTTI_AGENT_EXTENSION_VERSION: ${version}`);
}

await rm(packageDir, { recursive: true, force: true });
await mkdir(path.dirname(packageDir), { recursive: true });
await cp(sourceDir, packageDir, { recursive: true, dereference: false });
const manifestPath = path.join(packageDir, "tutti.agent.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.version = version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${packageDir}\n`);
