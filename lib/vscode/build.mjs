// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 The Kodela Authors
import * as esbuild from "esbuild";
import fs from "fs";
import path from "path";
import os from "os";

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  sourcemap: true,
});

console.log("Build complete: dist/extension.cjs");

// Auto-deploy to the installed VS Code extension directory.
// Always resolves the latest installed version from ~/.vscode/extensions/extensions.json
// so we never accidentally deploy to a stale version directory.
const extDir = path.join(os.homedir(), ".vscode", "extensions");
const registryPath = path.join(extDir, "extensions.json");

let deployTarget = null;
try {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const entry = registry.find((e) =>
    e?.identifier?.id?.toLowerCase() === "kodela.kodela"
  );
  if (entry?.relativeLocation) {
    deployTarget = path.join(extDir, entry.relativeLocation);
  }
} catch {
  // fallback: scan for highest semver kodela dir
  const dirs = fs.readdirSync(extDir).filter((d) => d.startsWith("kodela.kodela-"));
  if (dirs.length > 0) {
    dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    deployTarget = path.join(extDir, dirs[0]);
  }
}

if (deployTarget) {
  const distDest = path.join(deployTarget, "dist", "extension.cjs");
  const pkgDest = path.join(deployTarget, "package.json");
  fs.copyFileSync("dist/extension.cjs", distDest);
  fs.copyFileSync("package.json", pkgDest);
  console.log(`Deployed to: ${deployTarget}`);
} else {
  console.warn("Could not find installed Kodela extension directory — skipping deploy.");
}
