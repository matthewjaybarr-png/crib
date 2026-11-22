export const join = (a, ...b) => [a.replace(/[\\/]+$/, ""), ...b].join("/");
export const dirname = (p) => p.replace(/[\\/][^\\/]*$/, "");
// Windows paths: \ and / are the same, case does not count, a trailing slash does not count
const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
export const samePath = (a, b) => normPath(a) === normPath(b);
// A path as people should read it: a Windows path (a drive letter, \\server\share, or any \ in it) with every / turned
// into \, since join() adds / and the folder pickers give \ ("D:\Shop\Cell A\TOOL BOOK/Cell A.html"). Other paths (Linux) are left as they are.
export const showPath = (p) => { const s = String(p ?? ""); return /^[A-Za-z]:|\\/.test(s) ? s.replace(/\//g, "\\") : s; };
export const enc = (s) => new TextEncoder().encode(s);
export const dec = (b) => new TextDecoder().decode(b);

export async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const toJson = (o) => JSON.stringify(o, null, 1) + "\n";

// write to <path>.tmp then rename over the target: readers see the old or the new file, never half
export async function writeAtomic(fs, path, bytes) {
  const tmp = path + ".tmp";
  try {
    await fs.writeBytes(tmp, typeof bytes === "string" ? enc(bytes) : bytes);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.remove(tmp).catch(() => {}); // no half-written file left behind (0.2.13: a full or read-only folder)
    throw err;
  }
}

// Stored times are UTC (toISOString). Show them as this computer's local "YYYY-MM-DD HH:MM", never the UTC digits.
// Anything that is not a time comes back as it was ("" for nothing), so an old or damaged record still shows.
export function localTime(iso) {
  const d = new Date(iso ?? "");
  if (!iso || isNaN(d)) return String(iso ?? "");
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
