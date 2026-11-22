// Tool list filter shared by the editor (imported for its side effect) and the viewer page (a plain
// script, so this file is not a module). tbFilter(tools, {q, machine, category, material, status, sort}):
// q also finds a machine's own description, Used on and earlier tools (history).
// machine = built on that machine, or Built not known there (shown marked);
// status "built" = built on some machine, "planned" = known to be built nowhere, "unknown" = built nowhere known but
// not known on some machine, "retired" = only retired (removed) tools, which every other status leaves out.
// Sorted by tool id, or with sort "pocket" and a machine, by that machine's first pocket (no pocket last).
(() => {
  const isBuilt = (t) => Object.values(t.machines || {}).some((e) => e && e.built === true);
  // not built anywhere known, but Built not known on some machine
  const isUnknown = (t) => !isBuilt(t) && Object.values(t.machines || {}).some((e) => e && e.built == null);
  const pocketKey = (t, m) => {
    const p = t.machines?.[m]?.pockets?.[0];
    return p == null ? [2, 0, ""] : typeof p === "number" ? [0, p, ""] : [1, 0, String(p)]; // numbers, then text, then none
  };
  const byPocket = (m) => (a, b) => {
    const x = pocketKey(a, m), y = pocketKey(b, m);
    return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]) || a.tool_id - b.tool_id;
  };
  globalThis.tbFilter = (tools, f) => {
    const q = (f.q || "").trim().toLowerCase();
    const idq = /^(?:t\s*|#\s*)?(\d+)$/.exec(q);
    return tools
      .filter((t) => {
        if ((f.status === "retired") !== !!t.removed) return false;
        if (f.machine && !(t.machines?.[f.machine] && t.machines[f.machine].built !== false)) return false;
        if (f.category && t.category !== f.category) return false;
        if (f.material && !t.materials.includes(f.material)) return false;
        if (f.status === "built" && !isBuilt(t)) return false;
        if (f.status === "planned" && (isBuilt(t) || isUnknown(t))) return false;
        if (f.status === "unknown" && !isUnknown(t)) return false;
        if (!q) return true;
        if (idq) return t.tool_id === Number(idq[1]);
        const own = Object.values(t.machines || {}).map((e) => e?.description ?? ""), was = (t.history || []).map((h) => h.description);
        return [t.tool_id, "t" + t.tool_id, t.description, ...own, ...Object.values(t.machines || {}).flatMap((e) => (e?.pockets ?? []).map((p) => "p" + p)), t.group ?? "", t.category, ...(t.flags || []), ...(t.used_on || []), ...t.detail_lines, ...t.extra_notes, ...was].join(" ").toLowerCase().includes(q);
      })
      .sort(f.sort === "pocket" && f.machine ? byPocket(f.machine) : (a, b) => a.tool_id - b.tool_id);
  };
  globalThis.tbIsBuilt = isBuilt;
  globalThis.tbBuiltUnknown = isUnknown;
  // "built", "not built" or "built: not known" for tool t on machine m
  globalThis.tbBuiltText = (t, m) => { const b = t.machines?.[m]?.built; return b === true ? "built" : b === false ? "not built" : "built: not known"; };
  // the description to show for t: its own one on machine m when it has one (Q10, Q12), else the tool's
  globalThis.tbDescription = (t, m) => (m && t.machines?.[m]?.description) || t.description;
  // list label for a tool's pockets on machine m: "P12", "P36, P113", "P TOP" (text gets a space), "P -" (none)
  globalThis.tbPocketLabel = (t, m) => {
    const ps = t.machines?.[m]?.pockets || [];
    return ps.length ? ps.map((p) => (typeof p === "number" ? "P" + p : "P " + p)).join(", ") : "P -";
  };
})();
