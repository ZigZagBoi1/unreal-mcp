#!/usr/bin/env node
// Build the plugin and install it into the running editor's ENGINE, then bring the editor back.
//
// Installing into the engine rather than the game project keeps the plugin out of the project's
// version control and its .uproject, which matters to a team that has not opted into it. Doing it by
// hand took four steps and one of them - closing the editor - stalled for half an hour on a Save
// Content prompt. So the editor is closed through restart_editor, which never raises that prompt,
// and relaunched with -AutoDeclinePackageRecovery so a crash leftover cannot block the start either.
//
// Usage: node scripts/install-engine.mjs [--unsaved report|save|discard] [--skip-build]

import { spawnSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { UnrealBridgeClient } from "../dist/bridgeClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, "..", "..", "UnrealMCPBridge");
const args = process.argv.slice(2);
const unsaved = args.includes("--unsaved") ? args[args.indexOf("--unsaved") + 1] : "report";
const skipBuild = args.includes("--skip-build");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portUp = () =>
  new Promise((res) => {
    const s = net.connect(8765, "127.0.0.1");
    s.on("connect", () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
  });

const bridge = new UnrealBridgeClient();
const ping = await bridge.send("ping", {});
const engineDir = String(ping.engineDir).replace(/[\\/]Engine[\\/]?$/, "");
const project = String(ping.projectFile);
console.log(`editor: ${ping.engineVersion} at ${engineDir}, project ${project}`);

const packageDir = join(tmpdir(), `mcp-plugin-install-${process.pid}`);
if (!skipBuild) {
  console.log("building...");
  const uat = join(engineDir, "Engine", "Build", "BatchFiles", "RunUAT.bat");
  const build = spawnSync(
    "cmd.exe",
    ["/c", uat, "BuildPlugin", `-Plugin=${join(pluginDir, "UnrealMCPBridge.uplugin")}`, `-Package=${packageDir}`, "-TargetPlatforms=Win64", "-Rocket"],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
  if (build.status !== 0) {
    const tail = `${build.stdout}\n${build.stderr}`.split(/\r?\n/).filter((l) => /error|Result:/i.test(l)).slice(-10).join("\n");
    console.error(`build failed (exit ${build.status}). Nothing was installed and the editor was not touched.\n${tail}`);
    process.exit(1);
  }
}

console.log(`closing the editor (unsaved: ${unsaved})...`);
try {
  await bridge.send("restart_editor", { mode: "quit", unsaved });
} catch (err) {
  // Most often unsaved work with --unsaved report: say what and how to choose, not a stack trace.
  console.error(`the editor was not closed: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  console.error("re-run with --unsaved save or --unsaved discard. The new build is ready; add --skip-build only if it was already installed.");
  process.exit(1);
}
for (let i = 0; i < 60 && (await portUp()); i++) await sleep(2000);
// The port closes before the process lets go of the DLL; give it a moment.
await sleep(5000);

const target = join(engineDir, "Engine", "Plugins", "Marketplace", "UnrealMCPBridge");
mkdirSync(target, { recursive: true });
if (!skipBuild) {
  // Binaries only. With Source beside them, the open editor's Live Coding treats the plugin as code to
  // rebuild and pops its build window on the user's screen; a precompiled plugin needs none of it.
  rmSync(join(target, "Source"), { recursive: true, force: true });
  for (const part of ["Binaries"]) {
    rmSync(join(target, part), { recursive: true, force: true });
    cpSync(join(packageDir, part), join(target, part), { recursive: true });
  }
  // BuildPlugin's packaged descriptor drops EnabledByDefault; without it every project would need a
  // .uproject entry, which is exactly what installing into the engine is meant to avoid.
  const descriptor = JSON.parse(readFileSync(join(packageDir, "UnrealMCPBridge.uplugin"), "utf8"));
  descriptor.EnabledByDefault = true;
  writeFileSync(join(target, "UnrealMCPBridge.uplugin"), JSON.stringify(descriptor, null, "\t"));
  if (existsSync(join(pluginDir, "Config"))) cpSync(join(pluginDir, "Config"), join(target, "Config"), { recursive: true });
  rmSync(packageDir, { recursive: true, force: true });
}

console.log("relaunching...");
spawn(join(engineDir, "Engine", "Binaries", "Win64", "UnrealEditor.exe"), [project, "-AutoDeclinePackageRecovery"], {
  detached: true,
  stdio: "ignore",
}).unref();
for (let i = 0; i < 120; i++) {
  await sleep(3000);
  if (await portUp()) {
    try {
      const after = await new UnrealBridgeClient().send("ping", {});
      console.log(`installed: plugin built ${after.pluginBuiltAt}, editor back on ${after.projectFile}`);
      process.exit(0);
    } catch {
      /* still loading */
    }
  }
}
console.error("the editor did not come back within 6 minutes; check it by hand");
process.exit(1);
