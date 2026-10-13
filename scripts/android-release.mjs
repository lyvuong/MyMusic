// Builds, signs and publishes the Android app for in-app updates.
//
//   node scripts/android-release.mjs            build + upload to R2 (bucket mymusic-releases)
//   node scripts/android-release.mjs --dry-run  build only
//
// Version: build number = number of commits on HEAD, name = 0.1.<build number>, so every commit
// gets a higher version. Signing uses flutter/android/key.properties (CI writes it from secrets).
// Uploads the APKs first and android/latest.json last, so the app never sees a half-published release.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dryRun = process.argv.includes("--dry-run");
const root = fileURLToPath(new URL("..", import.meta.url));
const flutterDir = join(root, "flutter");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();

if (!existsSync(join(flutterDir, "android", "key.properties"))) {
  throw new Error("flutter/android/key.properties is missing: releases must be signed with the release key (see README).");
}
if (!existsSync(join(flutterDir, "android", "app", "google-services.json"))) {
  throw new Error("flutter/android/app/google-services.json is missing (see README).");
}

const versionCode = Number(out("git", ["rev-list", "--count", "HEAD"]));
const versionName = `0.1.${versionCode}`;
const commit = out("git", ["rev-parse", "--short", "HEAD"]);
const notes = out("git", ["log", "-1", "--format=%s"]);
console.log(`MyMusic ${versionName} (${versionCode}, ${commit})`);

run("flutter", [
  "build", "apk", "--release", "--split-per-abi",
  `--build-name=${versionName}`, `--build-number=${versionCode}`,
  "--dart-define-from-file=config/production.json",
  // Same version code for every ABI (Flutter otherwise adds 1000 x ABI), so the app can compare
  // its own code with latest.json.
  "-Pforce-version-code-ignoring-abi=true",
], { cwd: flutterDir });

const built = join(flutterDir, "build", "app", "outputs", "flutter-apk");
const dist = join(root, "dist-android");
mkdirSync(dist, { recursive: true });
const apks = {};
for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"]) {
  const file = `mymusic-${versionCode}-${abi}.apk`;
  copyFileSync(join(built, `app-${abi}-release.apk`), join(dist, file));
  const data = readFileSync(join(dist, file));
  apks[abi] = { file, size: statSync(join(dist, file)).size, sha256: createHash("sha256").update(data).digest("hex") };
}
const latest = { versionCode, versionName, commit, notes, publishedAt: new Date().toISOString(), apks };
writeFileSync(join(dist, "latest.json"), JSON.stringify(latest, null, 2));
console.log(`Built ${Object.keys(apks).length} APKs in dist-android`);

if (dryRun) process.exit(0);
// Cloudflare's API occasionally answers 502/5xx; retry a few times before failing the release.
const put = (key, file, type) => {
  const args = ["wrangler", "r2", "object", "put", `mymusic-releases/android/${key}`, "--file", file, "--content-type", type, "--remote"];
  for (let attempt = 1; ; attempt++) {
    try {
      return run("npx", args, { cwd: root });
    } catch (err) {
      if (attempt >= 4) throw err;
      const wait = 5 * 2 ** (attempt - 1);
      console.warn(`Upload of ${key} failed (attempt ${attempt}/4), retrying in ${wait}s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait * 1000);
    }
  }
};
for (const { file } of Object.values(apks)) put(file, join(dist, file), "application/vnd.android.package-archive");
put("latest.json", join(dist, "latest.json"), "application/json");
console.log(`Published ${versionName}`);
