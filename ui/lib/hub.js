// Hub PC (the PC on both the office and the machine network): passes each published toolbook from its office
// publish folder on to a folder on the hub's own disk, which is shared read-only to the machine network. It runs
// the same checked copy as a machine PC (sync.js), so the hub folder is itself a complete publish folder and machine
// PCs add it like any other. The hub only reads the office side and only writes inside its own folder.
import { join } from "./util.js";
import { syncOnce } from "./sync.js";

const norm = (p) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
const overlap = (a, b) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");

/** The folder machine PCs read for this toolbook; throws when the name or the folders can't be used. */
export function hubFolder(root, name, src = "") {
  if (!root) throw new Error("Choose the hub folder first.");
  if (/^[\\/]{2}/.test(root)) throw new Error("The hub folder must be on this PC's own disk, not on a network share.");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name) || /[ .]$/.test(name))
    throw new Error(`"${name}" can't be a folder name: use letters, numbers, spaces, dots, - and _.`);
  if (src && overlap(norm(root), norm(src))) throw new Error("The office publish folder and the hub folder overlap. Choose a hub folder of its own on this PC.");
  return join(root, name);
}

/** One round for one toolbook {name, src}: office publish folder -> hub folder. -> syncOnce's status */
export const passOn = (fs, root, b) => syncOnce(fs, b.src, hubFolder(root, b.name, b.src));
