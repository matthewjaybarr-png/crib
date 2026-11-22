// Validator for toolbook.json. validate() returns errors (publishing
// is refused while there are any); warnings() returns advisories that never block, such as a tool id outside
// the range written in its category ("MILLS 100-299" with a probe kept as tool 1).
export const DEFAULT_MATERIALS = []; // each toolbook names its own in Settings
const ASSET = /^[0-9a-f]{64}\.(png|step|glb)$/;

export function categoryRange(cat) {
  const m = /(\d+)\s*-\s*(\d+)\s*$/.exec(cat || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export const SORTS = ["tool_id", "pocket"]; // tb.sort_in_machine: how "Tools in machine N" is ordered
const shortText = (v, max = 100) => v == null || (typeof v === "string" && v.length <= max);
const numOrText = (v) => v == null || v === "" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 100);

function lines(v, max) {
  return Array.isArray(v) && v.length <= 30 && v.every((s) => typeof s === "string" && s.length <= max);
}

/**
 * Bring an older toolbook.json to the current shape, in place: tb.materials added, and a tool with no
 * tool.length (the first shape kept length per machine only) gets one. Machine lengths that all agree
 * fold into tool.length; lengths that differ stay on their machines and tool.length is null (never
 * picked automatically). Both are reference values. -> {changed}
 */
export function migrate(tb) {
  let changed = false;
  if (!tb.materials) (tb.materials = [...DEFAULT_MATERIALS]), (changed = true);
  for (const t of tb.tools || []) {
    if ("length" in t) continue;
    const es = Object.values(t.machines || {}).filter((e) => e && typeof e === "object"); // null entries: the validator reports them
    const vals = es.map((e) => e.length).filter((v) => v != null && v !== "");
    if (new Set(vals.map(String)).size > 1) t.length = null;
    else {
      t.length = vals[0] ?? null;
      for (const e of es) delete e.length;
    }
    changed = true;
  }
  return { changed };
}

export function validate(tb) {
  const errs = [];
  if (!tb || tb.schema_version !== 2 || !Array.isArray(tb.tools)) return ["not a toolbook.json (schema_version 2)"];
  if (tb.tools.length > 2000) errs.push("more than 2000 tools");
  const mats0 = tb.materials ?? DEFAULT_MATERIALS;
  if (!Array.isArray(mats0) || mats0.length > 12 || new Set(mats0).size !== mats0.length || mats0.some((x) => typeof x !== "string" || !x.trim() || x.length > 20 || x.includes("/ ") || x.includes(" /"))) errs.push("materials must be a unique list of up to 12 short names");
  const MATERIALS = Array.isArray(mats0) ? mats0 : [];
  const machines = Array.isArray(tb.machines) ? tb.machines : [];
  if (!machines.length) errs.push("no machines listed");
  if (tb.notes != null && !(Array.isArray(tb.notes) && tb.notes.length <= 200 && tb.notes.every((n) => typeof n === "string" && n.length <= 1000))) errs.push("book notes: at most 200 lines of text");
  if (tb.sort_in_machine != null && !SORTS.includes(tb.sort_in_machine)) errs.push(`sort in machine must be one of: ${SORTS.join(", ")}`);
  const seen = new Set();
  for (const t of tb.tools) {
    const id = t.tool_id;
    const at = `Tool ${id}: `;
    if (!Number.isInteger(id) || id < 1 || id > 99999999) { // up to 8 digits: some controls number tools that way
      errs.push(`Invalid tool id ${JSON.stringify(id)}`);
      continue;
    }
    if (seen.has(id)) errs.push(`Duplicate tool id ${id}`);
    seen.add(id);
    if (typeof t.description !== "string" || !t.description.trim() || t.description.length > 600) errs.push(at + "description must be 1-600 characters");
    if (typeof t.category !== "string" || t.category.length > 150) errs.push(at + "category must be text up to 150 characters");
    const mats = t.materials;
    if (!Array.isArray(mats) || mats.length > MATERIALS.length || new Set(mats).size !== mats.length || mats.some((x) => !MATERIALS.includes(x))) errs.push(at + "materials must be a unique list from: " + MATERIALS.join(", "));
    else if (t.material !== mats.join(" / ")) errs.push(at + "material text does not match materials");
    if (!numOrText(t.inserts)) errs.push(at + "inserts must be a number or short text");
    if (typeof t.coolant !== "string" || t.coolant.length > 100) errs.push(at + "coolant must be text up to 100 characters");
    for (const [k, label] of [["group", "group"], ["speeds", "speeds / feeds"], ["bar_dot", "bar dot"], ["spindle_dir", "spindle direction"]]) if (!shortText(t[k])) errs.push(at + `${label} must be text up to 100 characters`);
    if (t.removed != null && t.removed !== true) errs.push(at + "removed must be true or left out");
    if (t.flags != null && !(Array.isArray(t.flags) && t.flags.length <= 10 && new Set(t.flags).size === t.flags.length && t.flags.every((f) => typeof f === "string" && f.trim() && f.length <= 40)))
      errs.push(at + "flags: at most 10 different short labels");
    if (!lines(t.detail_lines, 5000)) errs.push(at + "detail lines: at most 30 lines of text");
    if (!lines(t.extra_notes, 5000)) errs.push(at + "notes: at most 30 lines of text");
    // jobs or parts that use the tool
    if (t.used_on != null && !(Array.isArray(t.used_on) && t.used_on.length <= 50 && new Set(t.used_on).size === t.used_on.length && t.used_on.every((u) => typeof u === "string" && u.trim() && u.length <= 100)))
      errs.push(at + "used on: at most 50 different short entries");
    // earlier tools that had this number, newest last
    if (t.history != null && !(Array.isArray(t.history) && t.history.length <= 20 && t.history.every((h) => h && typeof h.description === "string" && h.description.trim() && h.description.length <= 600 && (h.detail_lines == null || lines(h.detail_lines, 5000)) && (h.extra_notes == null || lines(h.extra_notes, 5000)))))
      errs.push(at + "history: at most 20 earlier tools, each with a description");
    const m = t.machines || {};
    if (!numOrText(t.length)) errs.push(at + "length must be a number or short text");
    for (const k of Object.keys(m)) if (!machines.includes(k)) errs.push(at + `unknown machine ${k}`);
    for (const k of machines) {
      const e = m[k];
      if (!e || !(typeof e.built === "boolean" || e.built === null)) errs.push(at + `machine ${k} needs built: yes, no or not known`);
      else {
        if (!numOrText(e.length)) errs.push(at + `machine ${k} length must be a number or short text`);
        // the tool as it is on this machine, when it differs
        if (e.description != null && !(typeof e.description === "string" && e.description.trim() && e.description.length <= 600)) errs.push(at + `machine ${k} description must be 1-600 characters`);
        if (e.pockets != null && !(Array.isArray(e.pockets) && e.pockets.length <= 20 && e.pockets.every((p) => p !== "" && p != null && numOrText(p) && String(p).length <= 20)))
          errs.push(at + `machine ${k} pots: at most 20, each a number or short text`);
      }
    }
    if (t.image != null && !(ASSET.test(t.image) && t.image.endsWith(".png"))) errs.push(at + "bad image reference");
    if (t.model != null && !(ASSET.test(t.model.step) && (t.model.glb == null || ASSET.test(t.model.glb)))) errs.push(at + "bad model reference");
  }
  return errs;
}

/** Tools (not retired) whose Built is not known on some machine - not yet filled in. Publish asks first. -> [{id, machines}] */
export const builtNotKnown = (tb) => (tb?.tools ?? []).filter((t) => !t.removed)
  .map((t) => ({ id: t.tool_id, machines: (tb.machines ?? []).filter((m) => t.machines?.[m] && t.machines[m].built === null) })).filter((x) => x.machines.length);

/** Pots held by more than one tool (not retired) on the same machine. -> [{machine, pot, tools: [ids]}], sorted. Published in the manifest so every app shows the same list. */
export function potConflicts(tb) {
  const out = [];
  for (const m of tb?.machines ?? []) {
    const by = new Map();
    for (const t of tb.tools ?? []) if (!t.removed) for (const p of t.machines?.[m]?.pockets ?? []) {
      const k = String(p).trim().toUpperCase();
      if (!by.has(k)) by.set(k, { machine: m, pot: p, tools: [] });
      if (!by.get(k).tools.includes(t.tool_id)) by.get(k).tools.push(t.tool_id);
    }
    out.push(...[...by.values()].filter((c) => c.tools.length > 1));
  }
  return out;
}

/** Advisories that never block publishing. Same "Tool N: " prefix as validate(), so lists can mark the tool. */
export function warnings(tb) {
  const out = [];
  for (const t of tb?.tools ?? []) {
    const r = categoryRange(t.category);
    if (r && Number.isInteger(t.tool_id) && (t.tool_id < r[0] || t.tool_id > r[1])) out.push(`Tool ${t.tool_id}: id is outside its category range ${r[0]}-${r[1]}`);
  }
  // one line per tool and pot, the machines joined ("pot 12 on Mill 1 and Mill 2 is also on T605")
  const seen = new Map();
  for (const c of potConflicts(tb)) for (const id of c.tools) {
    const k = `${id}|${String(c.pot).toUpperCase()}|${c.tools.filter((o) => o !== id).join(",")}`;
    if (seen.has(k)) seen.get(k).ms.push(c.machine);
    else seen.set(k, { id, pot: c.pot, others: c.tools.filter((o) => o !== id), ms: [c.machine] });
  }
  for (const w of seen.values()) out.push(`Tool ${w.id}: pot ${w.pot} on ${w.ms.join(" and ")} is also on ${w.others.map((o) => "T" + o).join(", ")} - check which is right`);
  return out;
}
