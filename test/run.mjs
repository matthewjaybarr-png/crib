// Synthetic tests: every toolbook here is made up in this file (no shop data). Run: npm test
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { nodeFs as fs } from "./nodefs.mjs";
import { validate, migrate, potConflicts, builtNotKnown, warnings, categoryRange } from "../ui/lib/schema.js";
import { createBook, listBooks, openBook, acquire, release as unlock } from "../ui/lib/book.js";
import { publish, rollback, readCurrent, offlineCopy, VIEWER } from "../ui/lib/release.js";
import { syncOnce } from "../ui/lib/sync.js";
import { hubFolder } from "../ui/lib/hub.js";
import { makeLock, checkLock } from "../ui/lib/lock.js";
import "../ui/viewer/filter.js";

let n = 0;
const test = async (name, f) => { await f(); n++; console.log("ok", name); };
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "crib-test-"));
const tool = (id, extra = {}) => ({ tool_id: id, description: `DRILL ${id}`, category: "DRILLS 100-199", materials: [], material: "", inserts: null, coolant: "", detail_lines: [], extra_notes: [], length: null,
  machines: { "Mill 1": { built: true, pockets: [id] }, "Mill 2": { built: false } }, ...extra });
const book = (tools) => ({ schema_version: 2, name: "Cell A", publish_dir: "", materials: [], machines: ["Mill 1", "Mill 2"], tools });
const viewer = Object.fromEntries(await Promise.all(VIEWER.map(async (v) => [v, await fs.readBytes(path.join("ui/viewer", v))])));

await test("a new book starts empty and opens", async () => {
  await createBook(fs, tmp, "Cell A", ["Mill 1", "Mill 2"]);
  assert.deepEqual(await listBooks(fs, tmp), ["Cell A"]);
  const { tb } = await openBook(fs, path.join(tmp, "Cell A"));
  assert.deepEqual(tb.tools, []);
  assert.deepEqual(tb.materials, []);
  assert.deepEqual(validate(tb), []);
  await assert.rejects(createBook(fs, tmp, "Cell A", ["Mill 1"]), /already exists/);
});

await test("validate catches bad tools", async () => {
  assert.deepEqual(validate(book([tool(101)])), []);
  assert.ok(validate(book([tool(101), tool(101)])).some((e) => e.includes("Duplicate")));
  assert.ok(validate(book([tool(101, { materials: ["STEEL"], material: "STEEL" })])).some((e) => e.includes("materials")));
  assert.ok(validate({ ...book([]), machines: [] }).includes("no machines listed"));
  assert.ok(validate(book([tool(101, { machines: { "Mill 1": { built: true } } })])).some((e) => e.includes("Mill 2")));
});

await test("migrate, warnings, pot conflicts, built not known", async () => {
  const old = { schema_version: 2, machines: ["Mill 1"], tools: [{ tool_id: 1, machines: { "Mill 1": { built: null, length: 4.5 } } }] };
  assert.equal(migrate(old).changed, true);
  assert.equal(old.tools[0].length, 4.5);
  assert.deepEqual(categoryRange("DRILLS 100-199"), [100, 199]);
  assert.ok(warnings(book([tool(5)])).length > 0);
  assert.equal(potConflicts(book([tool(101), tool(102, { machines: { "Mill 1": { built: true, pockets: [101] }, "Mill 2": { built: false } } })])).length, 1);
  assert.equal(builtNotKnown(book([tool(101, { machines: { "Mill 1": { built: null }, "Mill 2": { built: false } } })])).length, 1);
});

await test("edit lock: a second window is refused", async () => {
  const dir = path.join(tmp, "Cell A");
  const a = { user: "a", host: "pc1", id: "1" }, b = { user: "b", host: "pc2", id: "2" };
  assert.equal((await acquire(fs, dir, a)).ok, true);
  const r = await acquire(fs, dir, b);
  assert.equal(r.ok, false);
  assert.equal(r.holder.user, "a");
  await unlock(fs, dir, a);
  assert.equal((await acquire(fs, dir, b)).ok, true);
});

await test("publish, sync to a machine cache, rollback, offline copy", async () => {
  const dir = path.join(tmp, "Cell A"), pub = path.join(tmp, "pub"), cache = path.join(tmp, "cache");
  await fs.mkdirs(pub);
  const tb = book([tool(101)]);
  await fs.writeBytes(path.join(dir, "toolbook.json"), new TextEncoder().encode(JSON.stringify(tb)));
  assert.equal(await publish(fs, dir, pub, tb, viewer), 1);
  assert.equal(await publish(fs, dir, pub, book([tool(101), tool(102)]), viewer), 2);
  await assert.rejects(publish(fs, dir, pub, book([tool(101), tool(101)]), viewer), /Not published/);
  const s = await syncOnce(fs, pub, cache);
  assert.equal(s.release, 2);
  const rel = JSON.parse(await fs.readText(path.join(cache, "releases/2/toolbook.json")));
  assert.equal(rel.tools.length, 2);
  await rollback(fs, pub);
  assert.equal((await readCurrent(fs, pub)).release, 1);
  const off = await offlineCopy(fs, dir, viewer, { app: "Crib" });
  assert.match(new TextDecoder().decode(off.html), /TB_OFFLINE/);
});

await test("hub folder rules", async () => {
  assert.equal(hubFolder("D:/hub", "Cell A"), "D:/hub/Cell A");
  assert.throws(() => hubFolder("//server/share", "Cell A"), /own disk/);
  assert.throws(() => hubFolder("D:/hub", "bad/name"), /folder name/);
  assert.throws(() => hubFolder("D:/pub", "Cell A", "D:/pub/x"), /overlap/);
});

await test("mode password", async () => {
  const l = await makeLock("abcd", "abcd");
  assert.equal(await checkLock(l, "abcd"), true);
  assert.equal(await checkLock(l, "abce"), false);
  await assert.rejects(makeLock("ab", "ab"), /4 characters/);
});

await test("filter", async () => {
  const tools = [tool(102), tool(101, { removed: true }), tool(103, { description: "FACE MILL" })];
  assert.deepEqual(globalThis.tbFilter(tools, {}).map((t) => t.tool_id), [102, 103]);
  assert.deepEqual(globalThis.tbFilter(tools, { q: "face" }).map((t) => t.tool_id), [103]);
  assert.deepEqual(globalThis.tbFilter(tools, { q: "t102" }).map((t) => t.tool_id), [102]);
  assert.deepEqual(globalThis.tbFilter(tools, { status: "retired" }).map((t) => t.tool_id), [101]);
});

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`${n} tests passed`);
