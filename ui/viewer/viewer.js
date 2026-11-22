// Tool Book viewer: one static page. Reads current.json, releases/<n>/toolbook.json and assets/
// by relative path and re-checks every 60 s. Works from a web server, a folder, or the app's cache (machine PCs), where
// status.json beside it says whether the last check reached the publish folder.
// An offline copy (release.js offlineCopy) carries everything in window.TB_OFFLINE and fetches nothing.
(() => {
  const OFF = window.TB_OFFLINE;
  const $ = (id) => document.getElementById(id);
  // a stored UTC time as this computer's local "YYYY-MM-DD HH:MM"; the same as localTime in lib/util.js (the tests check)
  function localTime(iso) {
    const d = new Date(iso ?? "");
    if (!iso || isNaN(d)) return String(iso ?? "");
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const fetchJson = async (url) => {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(url + ": " + r.status);
    return r.json();
  };
  const el = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  let tb = null, release = null, selected = null;

  const opts = (sel, first, values) => {
    const keep = sel.value;
    sel.replaceChildren(new Option(first, ""), ...values.map((v) => new Option(v, v)));
    sel.value = values.includes(keep) ? keep : "";
  };

  const RETIRED = "\u0000retired"; // never a machine name
  let view = ""; // "" = All tools, RETIRED = retired tools, else a machine name = Tools in machine
  const length = (t) => "length" in t ? t.length : Object.values(t.machines || {}).map((e) => e?.length).find((v) => v != null && v !== ""); // old releases kept it per machine
  const badge = (text, m) => { const b = el("span", text, "badge"); if (m) b.dataset.m = m; return b; };
  const machineView = () => (view && view !== RETIRED ? view : "");
  // Phones show one pane at a time. Opening a tool adds a history entry, so the phone's own Back
  // (or the page's Back to list) returns to the list where it was scrolled.
  const narrow = matchMedia("(max-width: 700px)"); // same width as the viewer.css @media rule
  const inDetail = () => document.body.classList.contains("detail");
  let listTop = 0;
  const openDetail = () => {
    if (!narrow.matches || inDetail()) return;
    listTop = $("list").scrollTop;
    document.body.classList.add("detail");
    $("detail").scrollTop = 0;
    history.pushState({ tool: selected }, "");
  };
  addEventListener("popstate", () => {
    if (!inDetail()) return;
    document.body.classList.remove("detail");
    $("list").scrollTop = listTop;
    if (keyOpened) $("list").querySelector('[tabindex="0"]')?.focus({ preventScroll: true }); // back on the row it came from
  });
  // Keyboard (design review 11-08): Tab reaches the selected tool (or the first). Up/Down, Page Up/Down, Home, End move;
  // on a wide screen they also show the tool, on a phone Enter or Space opens it.
  let keyOpened = false;
  $("list").addEventListener("keydown", (e) => {
    const rows = [...$("list").children], i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === "Enter" || e.key === " ") return e.preventDefault(), (keyOpened = true), rows[i].click();
    let j = { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + 10, PageUp: i - 10, Home: 0, End: rows.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    j = Math.max(0, Math.min(rows.length - 1, j));
    if (!narrow.matches) return rows[j].click();
    rows[i].tabIndex = -1;
    rows[j].tabIndex = 0;
    rows[j].focus();
  });
  const filtered = () => tbFilter(tb.tools, { q: $("q").value, machine: machineView(), status: view === RETIRED ? "retired" : "", category: $("category").value, material: $("material").value, sort: tb.sort_in_machine });

  function drawViews() {
    $("views").replaceChildren(
      ...["", ...tb.machines, ...(tb.tools.some((t) => t.removed) ? [RETIRED] : [])].map((m) => {
        const b = el("button", m === RETIRED ? "Retired" : m ? "Tools in machine " + m : "All tools", m === view ? "sel" : "");
        b.setAttribute("aria-pressed", String(m === view)); // screen readers hear which view is on (design review 0.2.5)
        b.onclick = () => ((view = m), drawViews(), drawList());
        return b;
      })
    );
  }

  // Built not known: on this machine in a machine's list, else on every machine
  const unknownHere = (t) => (machineView() ? t.machines?.[machineView()]?.built == null : tbBuiltUnknown(t));
  function drawList() {
    const rows = filtered();
    const unknown = rows.filter((t) => !t.removed && unknownHere(t)).length;
    $("count").textContent = `${rows.length} of ${tb.tools.length} tools` + (unknown ? ` - Built not known on ${unknown}` : "");
    const hadFocus = $("list").contains(document.activeElement);
    $("list").replaceChildren(
      ...rows.map((t) => {
        const li = el("li", null, t.tool_id === selected ? "sel" : "");
        li.setAttribute("role", "option");
        li.setAttribute("aria-selected", String(t.tool_id === selected));
        li.tabIndex = t.tool_id === selected ? 0 : -1;
        // columns: the pot (in a machine's list), the number, then the description and badges
        if (machineView()) li.append(el("span", tbPocketLabel(t, view), "pocket" + (t.machines?.[view]?.pockets?.length ? "" : " none")));
        const desc = el("span", tbDescription(t, machineView()) + " ", "desc");
        desc.append(...t.materials.map((m) => badge(m, m)),
          ...(t.removed ? [badge("Retired", "retired")] : unknownHere(t) ? [badge("Built: not known", "unknown")] : tbIsBuilt(t) || machineView() ? [] : [badge("Planned", "planned")]), ...(t.flags || []).map((f) => badge(f, "flag")));
        li.append(el("b", "T" + t.tool_id), desc);
        li.onclick = () => ((selected = t.tool_id), drawList(), drawDetail(), openDetail());
        return li;
      })
    );
    const current = $("list").querySelector('[tabindex="0"]') || $("list").firstChild;
    if (current) current.tabIndex = 0;
    if (hadFocus && !inDetail()) current?.focus();
  }

  function drawDetail() {
    const t = tb.tools.find((x) => x.tool_id === selected);
    const d = $("detail");
    if (!t) { // tool gone in this release
      selected = null;
      if (inDetail()) history.back();
      return d.replaceChildren();
    }
    const bar = el("div", null, "backbar"), back = el("button", "‹ Back to list");
    back.onclick = () => history.back();
    bar.append(back);
    // the tool tag: the number large, the description, and its pot on each machine (the machine being viewed outlined)
    const tag = el("div", null, "tag"), h2 = el("h2");
    h2.append(el("span", "T" + t.tool_id, "tno"), " ", el("span", tbDescription(t, machineView()), "tdesc"));
    const pots = el("div", null, "pots");
    for (const m of tb.machines) {
      const ps = t.machines[m]?.pockets || [];
      const chip = el("span", null, "pot" + (ps.length ? "" : " none") + (m === machineView() ? " here" : ""));
      chip.append(el("small", m), ps.length ? tbPocketLabel(t, m) : "no pot");
      pots.append(chip);
    }
    tag.append(h2, pots);
    d.replaceChildren(bar, tag);
    if (t.removed || t.flags?.length) d.append(el("p", null, "flags"));
    if (t.removed) d.lastChild.append(badge("Retired - kept for history, not in any machine list", "retired"));
    for (const f of t.flags || []) d.lastChild.append(badge(f, "flag"));
    if (t.image) {
      const img = el("img");
      img.src = OFF?.assets[t.image] ?? "assets/" + t.image;
      img.alt = "Tool " + t.tool_id;
      d.append(img);
    }
    const rows = [["Category", t.category], ["Material", t.material], ["Coolant", t.coolant], ["Speeds / feeds", t.speeds], ["Inserts", t.inserts], ["Group (backup tools)", t.group], ["Bar dot position", t.bar_dot], ["Spindle direction", t.spindle_dir], ["Used on", (t.used_on || []).join(", ")], ["Tool length - reference only", length(t)]];
    for (const m of tb.machines) {
      const e = t.machines[m] || {};
      rows.push(["Machine " + m, tbBuiltText(t, m) + (e.pockets?.length ? " - pot " + e.pockets.join(", ") : "")]);
      if (e.description) rows.push([`Description on ${m}`, e.description]);
      if ("length" in t && e.length != null && e.length !== "") rows.push([`Length on ${m} - reference only`, e.length]); // old releases: length() above already shows it
    }
    if (!t.removed && tbBuiltUnknown(t)) rows.push(["Status", "Built not known (not filled in yet)"]);
    else if (!t.removed && !tbIsBuilt(t)) rows.push(["Status", "Planned (not built on any machine)"]);
    const table = el("table");
    for (const [k, v] of rows)
      if (v != null && v !== "") {
        const tr = el("tr");
        tr.append(el("th", k), el("td", String(v)));
        table.append(tr);
      }
    d.append(table);
    for (const [title, arr] of [["Details", t.detail_lines], ["Notes", t.extra_notes]])
      if (arr.length) {
        d.append(el("h3", title));
        const pre = el("pre", arr.join("\n"));
        d.append(pre);
      }
    if (t.history?.length) {
      d.append(el("h3", "Earlier tools with this number"));
      for (const h of t.history) d.append(el("pre", [h.description, ...(h.detail_lines || []).map((l) => "  " + l), ...(h.extra_notes || []).map((l) => "  " + l)].join("\n"), "was"));
    }
  }

  function drawState(online, errText, checked) {
    const s = $("state");
    s.className = online ? "ok" : "bad";
    s.textContent = online ? "Up to date" : "Offline copy";
    s.title = (errText || "") + (checked ? (errText ? "\n" : "") + "Last checked " + localTime(checked) : "");
  }

  function show(book, cur) {
    tb = book;
    release = cur.release;
    $("title").textContent = tb.name;
    document.title = `${tb.name} - ${(cur.release == null && cur.app) || "Crib"}`;
    // an offline copy from 0.2.13 on is made from the saved toolbook, not a release
    $("info").textContent = cur.release == null ? `${cur.app || "Crib"} offline copy - saved ${localTime(cur.saved_at)}` : `Release ${release} - published ${localTime(cur.published_at)}`;
    if (view && !tb.machines.includes(view) && !(view === RETIRED && tb.tools.some((t) => t.removed))) view = "";
    const notes = tb.notes || [];
    $("notes").hidden = !notes.length;
    $("notes-head").textContent = `Book notes (${notes.length})`;
    $("notes-body").textContent = notes.join("\n");
    drawViews();
    opts($("category"), "All categories", [...new Set(tb.tools.map((t) => t.category))].sort());
    opts($("material"), "All materials", tb.materials || [...new Set(tb.tools.flatMap((t) => t.materials))]);
    drawList();
    drawDetail();
  }

  // only the app's machine-PC cache has a status.json (sync.js); asking a published folder for it is a 404 on every load
  const inApp = location.protocol === "tb:" || location.hostname === "tb.localhost";
  async function refresh() {
    let status = null;
    if (inApp) try { status = await fetchJson("status.json"); } catch (e) { /* not checked yet */ }
    try {
      const cur = await fetchJson("current.json");
      if (cur.release !== release) show(await fetchJson(`releases/${cur.release}/toolbook.json`), cur);
      drawState(!status || status.online, status && status.error, status && status.checked_at);
    } catch (err) {
      drawState(false, String(err.message || err)); // keep showing what we have
    }
  }

  for (const id of ["q", "category", "material"]) $(id).addEventListener("input", () => tb && drawList());
  if (OFF) {
    show(OFF.toolbook, OFF);
    const s = $("state");
    s.className = "saved";
    s.textContent = `${OFF.app || "Crib"} offline copy ${localTime(OFF.saved_at)}`;
    s.title = `Saved ${localTime(OFF.saved_at)}${OFF.source ? " from " + OFF.source : ""}. Opens without the network and does not update itself: "Save offline copy..." in Crib makes a newer one.`;
  } else {
    refresh();
    setInterval(refresh, 60000);
  }
})();
