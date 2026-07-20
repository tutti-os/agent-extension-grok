import { execFileSync } from "node:child_process";
import path from "node:path";
import { validatePackage } from "./validate.mjs";

const root = path.resolve(import.meta.dirname, "..");
execFileSync(process.execPath, [path.join(root, "scripts", "package.mjs")], { stdio: "inherit" });
await validatePackage(path.join(root, "build", "tutti-agent", "package"), "grok");
process.stdout.write("Grok Agent Extension checks passed\n");
