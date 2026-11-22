// Machine side: mirror a publish folder into the local cache, only ever switching the cache to a
// release whose files all arrived and hashed correctly. On any failure the cache keeps the last good copy.
import { join, dec, sha256, toJson, writeAtomic } from "./util.js";
import { VIEWER, SAFE_PATH, safeRelease, matches, readCurrent, prune } from "./release.js";

async function copyFile(fs, src, dst, want) {
  const bytes = await fs.readBytes(src);
  if (want && (await sha256(bytes)) !== want) throw new Error(`${src}: hash does not match the manifest`);
  await fs.mkdirs(dst.replace(/[\\/][^\\/]*$/, ""));
  await writeAtomic(fs, dst, bytes);
}

/** -> {online, release, error?}. Also writes <cache>/status.json for the viewer page. */
export async function syncOnce(fs, src, cache) {
  let status;
  try {
    const cur = await readCurrent(fs, src);
    if (!cur) throw new Error("no current.json in the publish folder");
    const mpath = `releases/${safeRelease(cur.release)}/manifest.json`;
    const mbytes = await fs.readBytes(join(src, mpath));
    if ((await sha256(mbytes)) !== cur.manifest_sha256) throw new Error("manifest does not match current.json");
    for (const f of JSON.parse(dec(mbytes)).files) {
      if (!SAFE_PATH.test(f.path)) throw new Error("unsafe path in manifest: " + f.path);
      const dst = join(cache, f.path);
      if (!(await matches(fs, dst, f))) await copyFile(fs, join(src, f.path), dst, f.sha256); // also repairs a corrupt cache file
    }
    await copyFile(fs, join(src, mpath), join(cache, mpath), cur.manifest_sha256);
    for (const v of VIEWER) if (await fs.stat(join(src, v))) await copyFile(fs, join(src, v), join(cache, v));
    if ((await readCurrent(fs, cache))?.manifest_sha256 !== cur.manifest_sha256) {
      await writeAtomic(fs, join(cache, "current.json"), toJson(cur)); // the switch
      await prune(fs, cache);
    }
    status = { online: true, release: cur.release };
  } catch (err) {
    const have = await readCurrent(fs, cache).catch(() => null);
    status = { online: false, release: have?.release ?? null, error: String(err.message || err) };
  }
  status.checked_at = new Date().toISOString();
  await fs.mkdirs(cache);
  await writeAtomic(fs, join(cache, "status.json"), toJson(status));
  return status;
}
