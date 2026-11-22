// Publish folder layout (also what the website serves and what machine PCs cache):
//   index.html viewer.js viewer.css   the viewer page (code: replaced in place, not in manifests)
//   current.json                      {release, previous, manifest_sha256, published_at}
//   releases/<n>/manifest.json        {release, pot_conflicts:[{machine, pot, tools}] (0.2.10), files:[{path, sha256, size}]} for everything but itself
//   releases/<n>/toolbook.json
//   assets/<sha256>.<ext>             content-addressed, shared by releases
// current.json is the only thing replaced to switch releases, via write-temp-then-rename.
import { join, enc, dec, sha256, toJson, writeAtomic } from "./util.js";
import { validate, potConflicts } from "./schema.js";

// Viewer sources. Publish writes ONE self-contained index.html built from them, so a cache never pairs
// new HTML with old scripts after an interrupted copy. Older publish folders still hold the separate files;
// sync copies those too, index.html last.
export const VIEWER = ["filter.js", "viewer.js", "viewer.css", "index.html"];

/** index.html with viewer.css and the two scripts inlined. */
export function bundleViewer(v) {
  const t = (b) => dec(b).replace(/<\/(script|style)/gi, "<\\/$1");
  const html = dec(v["index.html"])
    .replace('<link rel="stylesheet" href="viewer.css">', () => `<style>${t(v["viewer.css"])}</style>`)
    .replace('<script src="filter.js"></script>', () => `<script>${t(v["filter.js"])}</script>`)
    .replace('<script src="viewer.js"></script>', () => `<script>${t(v["viewer.js"])}</script>`);
  if (/(?:src|href)="(?:viewer|filter)\./.test(html)) throw new Error("viewer index.html still refers to a separate file");
  return enc(html);
}

// The only paths a manifest may name; anything else (e.g. "../x") is refused before any file is touched.
export const SAFE_PATH = /^(assets\/[0-9a-f]{64}\.(png|step|glb)|releases\/[0-9]+\/toolbook\.json)$/;
export const safeRelease = (n) => {
  if (!Number.isInteger(n) || n < 1) throw new Error("bad release number in current.json");
  return n;
};

/** true if the file exists with exactly this content */
export async function matches(fs, path, f) {
  return (await fs.stat(path))?.size === f.size && (await sha256(await fs.readBytes(path))) === f.sha256;
}

export async function readJson(fs, p) {
  return JSON.parse(dec(await fs.readBytes(p)));
}

export async function readCurrent(fs, root) {
  return (await fs.stat(join(root, "current.json"))) ? readJson(fs, join(root, "current.json")) : null;
}

/** Problems with the current release (missing/tampered files); [] means good. */
export async function verify(fs, root) {
  const cur = await readCurrent(fs, root);
  if (!cur) return ["no current.json"];
  const mp = join(root, "releases", String(safeRelease(cur.release)), "manifest.json");
  if (!(await fs.stat(mp))) return [`manifest of release ${cur.release} is missing`];
  const mbytes = await fs.readBytes(mp);
  if ((await sha256(mbytes)) !== cur.manifest_sha256) return ["manifest does not match current.json"];
  const bad = [];
  for (const f of JSON.parse(dec(mbytes)).files) {
    if (!SAFE_PATH.test(f.path)) return [`unsafe path in manifest: ${f.path}`];
    const p = join(root, f.path);
    if (!(await fs.stat(p))) bad.push(`${f.path}: missing`);
    else if ((await sha256(await fs.readBytes(p))) !== f.sha256) bad.push(`${f.path}: hash differs`);
  }
  return bad;
}

async function nextRelease(fs, root) {
  let max = 0;
  if (await fs.stat(join(root, "releases"))) for (const e of await fs.list(join(root, "releases"))) max = Math.max(max, Number(e.name) || 0);
  return max + 1; // never reuse a number, so a half-written folder from a killed publish is just garbage
}

/** Drop releases other than current/previous and assets they do not use. */
export async function prune(fs, root) {
  const cur = await readCurrent(fs, root);
  if (!cur) return;
  const keep = new Set([cur.release, cur.previous].filter((n) => n != null).map(String));
  const used = new Set();
  for (const e of await fs.list(join(root, "releases"))) {
    if (!keep.has(e.name)) await fs.remove(join(root, "releases", e.name));
    else if (await fs.stat(join(root, "releases", e.name, "manifest.json"))) {
      for (const f of (await readJson(fs, join(root, "releases", e.name, "manifest.json"))).files) used.add(f.path);
    }
  }
  if (await fs.stat(join(root, "assets")))
    for (const e of await fs.list(join(root, "assets"))) if (!used.has("assets/" + e.name)) await fs.remove(join(root, "assets", e.name));
}

/**
 * Publish tb (as saved on disk) from bookDir to root. viewer = {name: bytes} for VIEWER.
 * meta = {author, notes} goes into the manifest next to name, schema_version and published_at.
 * Order matters: assets, viewer, release folder, and only then current.json.
 */
export async function publish(fs, bookDir, root, tb, viewer, meta = {}) {
  const errs = validate(tb);
  if (errs.length) throw new Error("Not published - fix these first:\n" + errs.slice(0, 10).join("\n"));
  const cur = await readCurrent(fs, root);
  const n = await nextRelease(fs, root);
  const at = new Date().toISOString();
  const files = [];
  const add = async (path, bytes) => files.push({ path, sha256: await sha256(bytes), size: bytes.length });

  let made = false; // the assets folder is made at the first copy, so a failed check leaves no empty folder
  const refs = new Set(tb.tools.flatMap((t) => [t.image, t.model?.step, t.model?.glb]).filter(Boolean));
  for (const name of refs) {
    let bytes;
    try { bytes = await fs.readBytes(join(bookDir, "assets", name)); } catch (err) {
      const t = tb.tools.find((t) => [t.image, t.model?.step, t.model?.glb].includes(name));
      throw new Error(`Not published - T${t?.tool_id ?? "?"} uses assets/${name}, which is missing or unreadable in the toolbook folder (${err.message ?? err})`);
    }
    if ((await sha256(bytes)) !== name.split(".")[0]) throw new Error(`assets/${name} does not match its hash`);
    const dst = join(root, "assets", name);
    await add("assets/" + name, bytes);
    if (!made) { await fs.mkdirs(join(root, "assets")); made = true; }
    if (!(await matches(fs, dst, files.at(-1)))) await writeAtomic(fs, dst, bytes); // also repairs a corrupt copy
  }
  await writeAtomic(fs, join(root, "index.html"), bundleViewer(viewer));
  const rel = join(root, "releases", String(n));
  await fs.mkdirs(rel);
  const tbBytes = enc(toJson(tb));
  await writeAtomic(fs, join(rel, "toolbook.json"), tbBytes);
  await add(`releases/${n}/toolbook.json`, tbBytes);
  const manifest = enc(toJson({ release: n, name: tb.name, schema_version: tb.schema_version, author: meta.author ?? null, published_at: at, notes: meta.notes || null, pot_conflicts: potConflicts(tb), files }));
  await writeAtomic(fs, join(rel, "manifest.json"), manifest);
  await writeAtomic(fs, join(root, "current.json"), toJson({ release: n, previous: cur?.release ?? null, manifest_sha256: await sha256(manifest), published_at: at }));
  await prune(fs, root);
  return n;
}

const base64 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/**
 * The toolbook in bookDir, as saved, as ONE html file that needs nothing else: the viewer, the toolbook and its
 * pictures (as data: URLs) inside it, so it opens from a PC's own disk with the network down. It does not update
 * itself. Separate from Publish: no publish needed, the published folder is not touched.
 * Every picture is checked against its hash first. viewer = {name: bytes} for VIEWER; source = the toolbook folder,
 * app = the app name (shown on the banner). -> {html (bytes), name}
 */
export async function offlineCopy(fs, bookDir, viewer, { source, app } = {}) {
  const tb = await readJson(fs, join(bookDir, "toolbook.json"));
  const assets = {};
  for (const name of new Set(tb.tools.map((t) => t.image).filter(Boolean))) {
    const bytes = await fs.readBytes(join(bookDir, "assets", name));
    if ((await sha256(bytes)) !== name.split(".")[0]) throw new Error(`assets/${name} does not match its hash, so no offline copy was made`);
    assets[name] = "data:image/png;base64," + base64(bytes);
  }
  // "<" escaped so no text in the toolbook can end the script early; source goes first so a reader finds it cheaply
  const data = JSON.stringify({ ...(source ? { source } : {}), ...(app ? { app } : {}), saved_at: new Date().toISOString(), toolbook: tb, assets }).replace(/</g, "\\u003c");
  const html = dec(bundleViewer(viewer)).replace("<script>", () => `<script>window.TB_OFFLINE = ${data};</script>\n<script>`);
  return { html: enc(html), name: tb.name };
}

/** Point current.json back at the previous release (call again to go forward again). */
export async function rollback(fs, root) {
  const cur = await readCurrent(fs, root);
  if (cur?.previous == null) throw new Error("There is no previous release.");
  const mp = join(root, "releases", String(cur.previous), "manifest.json");
  if (!(await fs.stat(mp))) throw new Error(`Release ${cur.previous} is no longer on disk.`);
  await writeAtomic(fs, join(root, "current.json"), toJson({ release: cur.previous, previous: cur.release, manifest_sha256: await sha256(await fs.readBytes(mp)), published_at: new Date().toISOString() }));
  return cur.previous;
}
