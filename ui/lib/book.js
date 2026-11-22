// A toolbook folder: toolbook.json, assets/<sha256>.<ext>, .lock. Edit lock + safe save.
import { join, enc, dec, sha256, toJson } from "./util.js";
import { migrate } from "./schema.js";

export const STALE_MS = 3 * 60 * 1000; // no heartbeat for this long = stale; heartbeat is every 30 s
const file = (dir) => join(dir, "toolbook.json");
const lockFile = (dir) => join(dir, ".lock");

export async function listBooks(fs, root) {
  const out = [];
  for (const e of await fs.list(root)) if (e.isDir && (await fs.stat(file(join(root, e.name))))) out.push(e.name);
  return out.sort();
}

export async function createBook(fs, root, name, machines) {
  const dir = join(root, name);
  if (await fs.stat(dir)) throw new Error(`"${name}" already exists`);
  await fs.mkdirs(join(dir, "assets"));
  await fs.writeBytes(file(dir), enc(toJson({ schema_version: 2, name, publish_dir: "", materials: [], machines, tools: [] })));
}

/** -> {tb, hash, migrated}. An old-shape file is converted in memory only (hash stays the disk hash); it is written only by Save. */
export async function openBook(fs, dir) {
  const bytes = await fs.readBytes(file(dir));
  const tb = JSON.parse(dec(bytes));
  const { changed } = migrate(tb);
  return { tb, hash: await sha256(bytes), migrated: changed };
}

// ---- lock. me = {user, host, id}; id is random per open toolbook, so two windows of one user differ.
const stamp = (me) => JSON.stringify({ user: me.user, host: me.host, id: me.id, time: new Date().toISOString() });

async function readLock(fs, dir) {
  try {
    const l = JSON.parse(dec(await fs.readBytes(lockFile(dir))));
    return { ...l, stale: !(Date.now() - Date.parse(l.time) < STALE_MS) };
  } catch (err) {
    if (!(await fs.stat(lockFile(dir)))) return null;
    return { user: "unknown", host: "unknown", id: null, time: null, stale: true }; // unreadable lock
  }
}

/** -> {ok:true} or {ok:false, holder:{user,host,time,stale}}. */
export async function acquire(fs, dir, me) {
  try {
    await fs.writeBytes(lockFile(dir), enc(stamp(me)), { createNew: true });
    return { ok: true };
  } catch {
    const holder = await readLock(fs, dir);
    if (!holder) return acquire(fs, dir, me); // released between our two calls
    return holder.id === me.id ? { ok: true } : { ok: false, holder };
  }
}

// Short exclusive guard around every lock change and every save commit, so a takeover, heartbeat,
// release and save never interleave. It is never broken by age: a paused-but-live writer would then
// be overwritten. ponytail: a guard left by a crash blocks saving until someone deletes .lock.guard
// (the error says so); a real lock service would remove that chore.
async function guarded(fs, dir, fn) {
  const g = join(dir, ".lock.guard");
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeBytes(g, enc(token), { createNew: true });
  } catch (err) {
    if (!(await fs.stat(g))) throw err;
    throw Object.assign(new Error("The toolbook is being saved or taken over - try again in a moment. If this keeps happening, make sure nobody is saving, then delete .lock.guard in the toolbook folder."), { busy: true });
  }
  try {
    return await fn();
  } finally {
    if ((await fs.readText(g).catch(() => null)) === token) await fs.remove(g);
  }
}

/** Only after the user confirmed a stale lock. observed = the holder they saw ({id, time}); refused if it changed. */
export async function takeOver(fs, dir, me, observed) {
  return guarded(fs, dir, async () => {
    const now = await readLock(fs, dir);
    if (now && (now.id !== observed.id || now.time !== observed.time)) throw new Error("The lock changed since you looked - someone is working on it.");
    await fs.writeBytes(lockFile(dir), enc(stamp(me)));
    return true;
  });
}

/** true while the lock is still ours; refreshes its time. A busy guard just skips this beat. */
export async function heartbeat(fs, dir, me) {
  try {
    return await guarded(fs, dir, async () => {
      if ((await readLock(fs, dir))?.id !== me.id) return false;
      await fs.writeBytes(lockFile(dir), enc(stamp(me)));
      return true;
    });
  } catch (err) {
    if (err.busy) return true;
    throw err;
  }
}

export async function release(fs, dir, me) {
  for (let i = 0; i < 5; i++) {
    try {
      return await guarded(fs, dir, async () => {
        if ((await readLock(fs, dir))?.id === me.id) await fs.remove(lockFile(dir));
      });
    } catch (err) {
      if (!err.busy) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Counts edits so a save only clears "unsaved" for the edits it actually wrote. */
export const tracker = () => ({ rev: 0, saved: 0, get dirty() { return this.rev !== this.saved; } });

/** Refuses unless we still hold the lock and nobody changed toolbook.json since we loaded it. -> new hash */
export async function save(fs, dir, tb, loadedHash, me, track) {
  const bytes = enc(toJson(tb));
  const rev = track?.rev; // edits made while the write is pending stay unsaved
  await guarded(fs, dir, async () => {
    if ((await readLock(fs, dir))?.id !== me.id) throw new Error("The edit lock was lost - reload the toolbook.");
    const cur = await fs.readBytes(file(dir));
    if ((await sha256(cur)) !== loadedHash) throw new Error("toolbook.json changed on disk since you opened it - reload.");
    await fs.writeBytes(file(dir) + ".tmp", bytes);
    await fs.rename(file(dir) + ".tmp", file(dir));
  });
  if (track) track.saved = rev;
  return sha256(bytes);
}

/** Copy a picked file into assets/ under its content hash. -> "<sha>.<ext>" */
export async function addAsset(fs, dir, bytes, ext) {
  const name = `${await sha256(bytes)}.${ext}`;
  const p = join(dir, "assets", name);
  if (!(await fs.stat(p))) {
    await fs.mkdirs(join(dir, "assets"));
    await fs.writeBytes(p + ".tmp", bytes);
    await fs.rename(p + ".tmp", p);
  }
  return name;
}
