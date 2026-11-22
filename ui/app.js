import { tauriFs as fs } from "./lib/fs-tauri.js";
import { join, dirname, writeAtomic, samePath, showPath, localTime, enc, toJson } from "./lib/util.js";
import { validate, warnings, categoryRange, builtNotKnown, potConflicts } from "./lib/schema.js";
import * as book from "./lib/book.js";
import * as rel from "./lib/release.js";
import { syncOnce } from "./lib/sync.js";
import * as hub from "./lib/hub.js";
import { makeLock, checkLock } from "./lib/lock.js";
import "./viewer/filter.js"; // sets globalThis.tbFilter, shared with the viewer page
import { THEMES, BUILTIN_COUNT, DEFAULT_THEME, applyTheme } from "./theme.js";

const T = window.__TAURI__;
const app = document.getElementById("app");
const inv = (c, a) => T.core.invoke(c, a);
let settings = {};
let appName = "Crib";
let version = ""; // the installed build's (Installed apps shows the same), so builds can be told apart
let timers = [];
let canLeave = null; // set by an open toolbook: asks about unsaved edits, releases the lock

const el = (tag, props = {}, ...kids) => {
  const attrs = Object.entries(props).filter(([k]) => k.includes("-")); // "aria-label" and the like are attributes
  const e = Object.assign(document.createElement(tag), Object.fromEntries(Object.entries(props).filter(([k]) => !k.includes("-"))));
  for (const [k, v] of attrs) e.setAttribute(k, v);
  e.append(...kids.filter((k) => k != null && k !== false)); // `cond && el(...)` leaves out a child
  return e;
};
// Ties each <label> to the input/select/textarea right after it, so clicking the label goes to the box and screen
// readers name the box. Labels that wrap their control need nothing.
let labelSeq = 0;
const linkLabels = (root) => {
  for (const l of root.querySelectorAll("label")) {
    const c = l.nextElementSibling;
    if (l.htmlFor || l.querySelector("input,select,textarea") || !c?.matches("input,select,textarea")) continue;
    c.id ||= "f" + ++labelSeq;
    l.htmlFor = c.id;
  }
  return root;
};
// A name for a box whose only hint is its placeholder (the placeholder goes when typing starts).
const named = (e, name) => (e.setAttribute("aria-label", name), e);
const btn = (text, onclick, cls) => el("button", { textContent: text, onclick, className: cls || "" });
const saveSettings = () => inv("settings_write", { text: JSON.stringify(settings, null, 1) });
const pickFolder = async () => T.dialog.open({ directory: true });
// In-page notices: window.alert showed nothing in the Windows webview, so results and errors were invisible.
// Read out by screen readers (aria-live); a click or Escape closes it.
const note = document.body.appendChild(Object.assign(document.createElement("div"), { id: "notice", hidden: true, title: "Click or press Escape to dismiss", onclick: () => (note.hidden = true) }));
note.setAttribute("role", "status");
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !note.hidden && !document.querySelector(".modal")) note.hidden = true; });
let noteTimer = 0;
const notify = (text, isErr) => {
  clearTimeout(noteTimer);
  note.setAttribute("aria-live", isErr ? "assertive" : "polite");
  note.textContent = text;
  note.className = isErr ? "err" : "ok";
  note.hidden = false;
  if (!isErr) noteTimer = setTimeout(() => (note.hidden = true), 20000);
};
const fail = (err) => notify(String(err?.message || err), true);
// In-page question. window.confirm shows nothing in the Windows app and answers OK by itself, so here "Remove machine" and the rest acted without asking. Every question goes through this.
// -> the text of the button clicked; Escape = the last button. The default button (blue, has the focus, so Enter
// clicks it) is the first unless `def` names another: the safe one (Cancel) wherever the first would
// delete, overwrite or take something away (0.2.3, the work PC's view after the 0.2.2 review).
function ask(text, buttons, def = 0) {
  return new Promise((done) => {
    const back = document.activeElement; // focus returns there afterwards
    const close = (b) => { box.remove(); document.removeEventListener("keydown", onEsc, true); back?.isConnected && back.focus?.(); done(b); };
    // Escape = the last button; Tab and Shift+Tab go round the box's buttons only
    const onEsc = (e) => {
      if (e.key === "Escape") return e.preventDefault(), e.stopPropagation(), close(buttons.at(-1));
      if (e.key !== "Tab") return;
      e.preventDefault();
      const bs = [...box.querySelectorAll("button")], i = bs.indexOf(document.activeElement);
      bs[(i < 0 ? def : i + (e.shiftKey ? bs.length - 1 : 1)) % bs.length].focus();
    };
    const qid = "ask-" + Date.now();
    const box = el("div", { className: "modal" }, el("div", { className: "dialog", role: "dialog" },
      el("p", { id: qid, textContent: text }),
      el("div", { className: "row end" }, ...buttons.map((b, i) => btn(b, () => close(b), i === def ? "primary" : "")))));
    box.firstChild.setAttribute("aria-describedby", qid);
    box.firstChild.setAttribute("aria-modal", "true");
    document.body.append(box);
    document.addEventListener("keydown", onEsc, true);
    box.querySelectorAll("button")[def].focus();
  });
}
const clearTimers = () => (timers.forEach(clearInterval), (timers = []));
// The shell (UI redesign): a sidebar (the app and its version, where you are, the theme, Change mode or Unlock) and the
// screen in a raised panel beside it. Every screen still calls show(header(...its buttons), ...content), so the
// screens and their buttons are as before. Leaving an open toolbook from the sidebar asks first, as Change mode did.
let here = ""; // the open toolbook's name, shown under Toolbooks in the sidebar; openBook sets it before show()
const MODE_NAME = { editor: "Programmer PC", machine: "Machine PC", hub: "Hub PC" };
const go = async (fn) => { if (!canLeave || (await canLeave())) fn(); };
const icon = (glyph) => el("span", { className: "ico", "aria-hidden": "true", textContent: glyph });
const sidebar = () => {
  const home = { editor: editorHome, machine: () => machineHome(), hub: hubHome }[settings.mode];
  const opts = (list) => list.map(([id, label]) => new Option(label, id));
  const theme = el("select", { id: "theme-pick", disabled: locked(), title: locked() ? "Unlock to change the theme" : "", onchange: async () => { settings.theme = theme.value; applyTheme(theme.value); await saveSettings().catch(fail); } },
    el("optgroup", { label: "Built-in" }, ...opts(THEMES.slice(0, BUILTIN_COUNT))), el("optgroup", { label: "Omarchy" }, ...opts(THEMES.slice(BUILTIN_COUNT))));
  theme.value = settings.theme || DEFAULT_THEME;
  return el("nav", { className: "sidebar", "aria-label": appName },
    el("div", { className: "brand" }, el("img", { src: "crib.png", alt: "" }),
      el("div", {}, el("b", { textContent: appName }), el("small", { className: "muted", textContent: version ? "version " + version : "" }))),
    home && el("button", { className: "nav" + (here ? "" : " on"), title: settings.mode === "hub" ? "Hub" : "Toolbooks", onclick: () => go(home) }, icon(settings.mode === "hub" ? "\uf233" : "\uf02d"), el("span", { textContent: settings.mode === "hub" ? "Hub" : "Toolbooks" })),
    here && el("div", { className: "nav sub on", "aria-current": "page", title: here }, icon("\uf0f6"), el("span", { textContent: here })),
    el("div", { className: "grow" }),
    el("label", { className: "navlabel", htmlFor: "theme-pick", textContent: "Theme" }), theme,
    el("div", { className: "modeline muted", title: MODE_NAME[settings.mode] || "" }, icon(settings.mode === "machine" ? "\uf108" : settings.mode === "hub" ? "\uf0e8" : "\uf040"), MODE_NAME[settings.mode] || "Not set up yet"),
    locked() ? btn("Unlock...", unlockPage) : btn("Change mode", () => go(chooseMode)));
};
const frame = (...kids) => app.replaceChildren(sidebar(), el("main", { className: "main" }, ...kids));
const show = (...kids) => { clearTimers(); canLeave = null; frame(...kids); here = ""; };
const header = (...kids) => el("header", {}, el("h1", { textContent: settings.mode === "hub" ? "Hub" : settings.mode ? "Toolbooks" : appName }), ...kids);

// The toolbar's less-used buttons, behind "More": a click on one, Escape, or clicking elsewhere closes it.
const more = (...buttons) => {
  const d = el("details", { className: "more" }, el("summary", { textContent: "More" }), el("div", { className: "menu" }, ...buttons));
  d.addEventListener("click", (e) => { if (e.target.closest(".menu button")) d.open = false; });
  d.addEventListener("keydown", (e) => { if (e.key === "Escape" && d.open) { e.stopPropagation(); d.open = false; d.querySelector("summary").focus(); } });
  d.addEventListener("focusout", (e) => { if (!d.contains(e.relatedTarget)) d.open = false; });
  return d;
};

async function chooseMode() {
  show(
    header(),
    el("div", { className: "page" },
      el("h2", { textContent: "How is this PC used?" }),
      el("p", { className: "muted", textContent: "Programmers edit toolbooks. Machine PCs only show the published copy. A hub PC, on both the office and the machine network, passes the published copies on to the machine network." }),
      btn("Programmer - edit toolbooks", () => setMode("editor"), "primary"), " ",
      btn("Machine PC - show published toolbooks", () => setMode("machine"), "primary"), " ",
      btn("Hub PC - pass toolbooks on to the machines", () => setMode("hub"), "primary"))
  );
}
async function setMode(mode) {
  settings.mode = mode;
  await saveSettings();
  boot();
}

// ================= editor mode =================
// A toolbook can live in any folder, so the
// home page lists toolbook folders (settings.books), not one toolbooks folder. settings.root is only where "Create" makes new ones.
const bookName = (d) => d.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
const addBook = async (d) => {
  settings.books ??= [];
  if (!settings.books.some((b) => samePath(b, d))) { settings.books.push(d); await saveSettings(); }
  return d;
};

async function editorHome() {
  const root = settings.root;
  let rootErr = null;
  // upgrade: the toolbooks in the old toolbooks folder start the list (tried again next time if the folder is not there)
  if (!settings.books && root) {
    try { settings.books = (await book.listBooks(fs, root)).map((n) => join(root, n)); await saveSettings(); } catch (err) { rootErr = err; }
  }
  const books = settings.books ?? [];
  const found = await Promise.all(books.map((d) => fs.stat(join(d, "toolbook.json")).catch(() => null)));
  const rows = books.map((d, i) => [d, found[i]]).sort(([a], [b]) => bookName(a).localeCompare(bookName(b)) || a.localeCompare(b));
  const list = el("div", {}, ...rows.map(([d, ok]) => el("div", { className: "card" + (ok ? "" : " gone") },
    el("span", { className: "name" }, bookName(d), el("small", { className: ok ? "muted" : "err", textContent: (ok ? "" : "folder not found: ") + showPath(d) })),
    ok && btn("Open", () => openBook(d), "primary"),
    btn("Remove from list", async () => {
      if ((await ask(`Take ${bookName(d)} (${showPath(d)}) off this list?\n\nNo files are deleted. "Open toolbook..." puts it back.`, ["Remove from list", "Cancel"], 1)) !== "Remove from list") return;
      settings.books = settings.books.filter((b) => b !== d);
      await saveSettings(); editorHome();
    }))));
  if (rootErr) list.append(el("p", { className: "err", textContent: `Cannot read ${showPath(root)}: ${rootErr}` }));
  else if (!books.length) list.append(el("p", { className: "muted", textContent: 'No toolbooks yet. "Open toolbook..." adds one from any folder.' }));
  const newName = el("input", { placeholder: "New toolbook name", "aria-label": "New toolbook name" });
  const newMachines = el("input", { placeholder: "Machines, e.g. Mill 1, Lathe 2", "aria-label": "Machines" });
  show(
    header(),
    el("div", { className: "page" },
      el("h2", { textContent: "Toolbooks" }), list,
      el("div", { className: "row" }, btn("Open toolbook...", async () => {
        const f = await T.dialog.open({ title: "Open a toolbook: pick the toolbook.json in its folder", filters: [{ name: "Toolbook", extensions: ["json"] }] });
        if (!f) return;
        if (!/(^|[\\/])toolbook\.json$/i.test(f)) return fail("Pick the file named toolbook.json inside a toolbook's folder.");
        await addBook(dirname(f)); editorHome();
      }), el("span", { className: "muted", textContent: "add a toolbook from any folder (local disk, network share, USB drive)" })),
      el("h2", { textContent: "Folder for new toolbooks" }),
      el("div", { className: "row" }, el("input", { value: root || "", readOnly: true, placeholder: "not set", "aria-label": "Folder for new toolbooks" }),
        btn("Choose...", async () => {
          const p = await pickFolder();
          if (!p) return;
          settings.root = p;
          await saveSettings();
          for (const n of await book.listBooks(fs, p).catch(() => [])) await addBook(join(p, n)); // its toolbooks join the list
          editorHome();
        })),
      root && el("div", { className: "row" }, newName, newMachines,
        btn("Create", async () => {
          try {
            const n = newName.value.trim();
            if (!n) return fail("Give the new toolbook a name.");
            await book.createBook(fs, root, n, newMachines.value.split(",").map((s) => s.trim()).filter(Boolean));
            await addBook(join(root, n));
            editorHome();
          } catch (err) { fail(err); }
        })),
  );
}

const sid = () => crypto.getRandomValues(new Uint32Array(2)).join("-");

async function openBook(dir) {
  const name = bookName(dir);
  const who = await inv("whoami");
  const me = { ...who, id: sid() };
  let lock = await book.acquire(fs, dir, me);
  let readonly = !lock.ok;
  let holder = lock.holder;
  let { tb, hash, migrated } = await book.openBook(fs, dir);
  const tr = book.tracker();
  // Old file shape converted in memory is "unsaved" only for the lock holder; a read-only viewer has no edits.
  // onlyMig: the only dirt is the conversion, so reload() may still replace it with a fresh read.
  let onlyMig = false;
  const markMig = () => { if (migrated && !readonly) (tr.rev++, (onlyMig = true)); };
  markMig();
  let selected = null, imgUrl = null;
  const flt = { q: "", machine: "", category: "", material: "", status: "" };
  const notesIn = el("input", { placeholder: "Release notes (optional)", "aria-label": "Release notes", size: 22 });
  const viewerFiles = async () => Object.fromEntries(await Promise.all(rel.VIEWER.map(async (n) => [n, new Uint8Array(await (await fetch("viewer/" + n)).arrayBuffer())])));
  const publishDir = () => tb.publish_dir || join(dir, "published");
  // The offline copy is its own button with a Save As box, made from the saved toolbook; Publish
  // no longer writes one. The folder is remembered per toolbook (the old offlineDir setting is only the first start).
  const saveOfflineCopy = async () => {
    let file = null;
    try {
      if (tr.dirty) {
        if ((await ask("Save the toolbook first? The offline copy is made from the saved toolbook.", ["Save", "Cancel"])) !== "Save") return;
        await save();
        if (tr.dirty) return;
      }
      settings.offlineDirs ??= {};
      const start = Object.entries(settings.offlineDirs).find(([k]) => samePath(k, dir))?.[1] ?? settings.offlineDir ?? dir;
      file = await T.dialog.save({ title: "Save offline copy", defaultPath: showPath(join(start, tb.name + ".html")), filters: [{ name: "Web page", extensions: ["html"] }] });
      if (!file) return;
      const { html } = await rel.offlineCopy(fs, dir, await viewerFiles(), { source: dir, app: appName });
      await writeAtomic(fs, file, html);
      settings.offlineDirs[dir] = dirname(file);
      await saveSettings();
      if ((await ask(`Offline copy saved: ${showPath(file)} (${localTime(new Date().toISOString())})\n\nDouble-click it to open ${tb.name} without the network. It does not update itself: save a new one after changes.`, ["Open folder", "Close"], 1)) === "Open folder")
        await inv("show_in_folder", { path: file }).catch(fail);
    } catch (err) {
      await ask(`Offline copy NOT saved${file ? " to " + showPath(file) : ""}.\n\n${err?.message ?? err}`, ["Close"]);
    }
  };
  // Save as: the toolbook (with any unsaved edits) and its pictures go into another folder, which joins the list and
  // is opened; the old folder keeps the toolbook as last saved.
  const saveAs = async () => {
    const p = await T.dialog.open({ directory: true, title: `Folder to save ${tb.name} in (toolbook.json goes straight into it)` });
    if (!p || samePath(p, dir)) return;
    try {
      if (await fs.stat(join(p, "toolbook.json"))) throw new Error(`${showPath(p)} already has a toolbook in it. Pick or make an empty folder.`);
      await fs.mkdirs(join(p, "assets"));
      for (const e of await fs.list(join(dir, "assets")).catch(() => [])) if (!e.isDir) await fs.copy(join(dir, "assets", e.name), join(p, "assets", e.name));
      await writeAtomic(fs, join(p, "toolbook.json"), enc(toJson(tb)));
    } catch (err) { return fail(`Not saved as ${showPath(p)}: ${err?.message ?? err}`); }
    await addBook(p);
    if (!readonly) await book.release(fs, dir, me).catch(() => {});
    await openBook(p);
    notify(`Saved as ${showPath(p)}. The copy in ${showPath(dir)} is still there as it was last saved.${tb.publish_dir ? ` This copy still publishes to ${showPath(tb.publish_dir)}.` : ""}`);
  };

  // After regaining the lock, unsaved edits are kept (Save still refuses if the file changed meanwhile); otherwise reload.
  const reload = async () => {
    if (tr.dirty && !onlyMig) return;
    tr.saved = tr.rev; onlyMig = false;
    ({ tb, hash, migrated } = await book.openBook(fs, dir));
    markMig();
  };
  const lost = () => { readonly = true; holder = { user: "someone else", host: "", stale: false }; draw(); };
  const startBeat = () => timers.push(setInterval(async () => { if (!readonly && !(await book.heartbeat(fs, dir, me).catch(() => false))) lost(); }, 30000));

  const leave = async () => {
    if (tr.dirty && readonly) {
      if ((await ask("You have unsaved edits and the edit lock is gone, so they cannot be saved now.\n\nDiscard them and leave?", ["Discard and leave", "Cancel"], 1)) !== "Discard and leave") return false;
    } else if (tr.dirty) {
      const a = await ask(`Save your changes to ${tb.name} before leaving?`, ["Save", "Don't save", "Cancel"]);
      if (a === "Cancel") return false;
      if (a === "Save") {
        await save();
        if (tr.dirty) return false;
      }
    }
    if (!readonly) await book.release(fs, dir, me).catch(() => {});
    return true;
  };
  const close = async () => { if (await leave()) editorHome(); };
  const save = async () => {
    try { hash = await book.save(fs, dir, tb, hash, me, tr); draw(); } catch (err) { fail(err); }
  };
  const touch = () => { tr.rev++; onlyMig = false; drawHead(); };
  const head = el("div");
  const side = el("div", { id: "side" });
  const form = el("div", { id: "form" });
  const drawHead = () => {
    const errs = validate(tb), warns = warnings(tb);
    const dis = readonly;
    head.replaceChildren(
      header(
        el("span", { className: "crumb", textContent: tb.name + (tr.dirty ? " *" : ""), title: showPath(dir) + (tr.dirty ? " - not saved yet" : "") }),
        el("span", { className: errs.length ? "err" : "muted", title: errs.slice(0, 20).join("\n"), textContent: errs.length ? errs.length + " problems" : "valid" }),
        warns.length ? el("span", { className: "warn", title: warns.slice(0, 20).join("\n") + "\nWarnings never block publishing.", textContent: warns.length + (warns.length === 1 ? " warning" : " warnings") }) : null,
        btn("Save", save, "primary"),
        notesIn,
        btn("Publish", async () => {
          try {
            if (tr.dirty) await save();
            if (tr.dirty) return;
            const unknown = builtNotKnown(tb);
            if (unknown.length) {
              const list = unknown.slice(0, 12).map((u) => `T${u.id}${u.machines.length < tb.machines.length ? ` (${u.machines.join(", ")})` : ""}`).join(", ") + (unknown.length > 12 ? `, ... (${unknown.length} tools)` : "");
              if ((await ask(`Built is not known on ${unknown.length === 1 ? "1 tool" : `${unknown.length} tools`}: ${list}.\n\nThe machines show them as "Built: not known". Set Built on each tool to fix it.`, ["Publish anyway", "Cancel"], 1)) !== "Publish anyway") return; // focus starts on Cancel
            }
            const n = await rel.publish(fs, dir, publishDir(), tb, await viewerFiles(), { author: me.user, notes: notesIn.value.trim() });
            notesIn.value = "";
            notify(`Published release ${n} to ${showPath(publishDir())}`);
          } catch (err) { fail(err); }
        }),
        btn("Save offline copy...", saveOfflineCopy),
        more(btn("Save as...", saveAs),
        btn("Roll back", async () => {
          if ((await ask("Point the published copy back at the previous release?", ["Roll back", "Cancel"], 1)) !== "Roll back") return;
          try { notify("Published copy is now release " + (await rel.rollback(fs, publishDir()))); } catch (err) { fail(err); }
        }),
        btn("Settings", () => settingsDialog()),
        btn("Close toolbook", close))
      )
    );
    head.querySelectorAll("button").forEach((b) => { if (dis && ["Save", "Publish", "Roll back"].includes(b.textContent)) b.disabled = true; });
    if (readonly) {
      head.append(el("div", { className: "banner" },
        `Read-only: edited by ${holder.user}${holder.host ? " on " + holder.host : ""}${holder.time ? " since " + localTime(holder.time) : ""}.`,
        btn("Try again", async () => { const l = await book.acquire(fs, dir, me); if (l.ok) { readonly = false; await reload(); startBeat(); } else holder = l.holder; draw(); }),
        holder.stale && btn("Take over (they stopped working)", async () => {
          if ((await ask(`${holder.user}'s lock has not been refreshed for a while. Take over editing?`, ["Take over", "Cancel"], 1)) !== "Take over") return;
          try {
            if (await book.takeOver(fs, dir, me, { id: holder.id, time: holder.time })) { readonly = false; await reload(); startBeat(); }
          } catch (err) { fail(err); }
          draw();
        })));
    }
  };

  const settingsDialog = () => {
    const mach = el("input", { value: tb.machines.join(", "), disabled: readonly });
    const pub = el("input", { value: tb.publish_dir, placeholder: "default: published/ inside the toolbook", disabled: readonly });
    const matIn = el("input", { value: tb.materials.join(", "), disabled: readonly });
    const notesBox = el("textarea", { value: (tb.notes || []).join("\n"), disabled: readonly, placeholder: "e.g. Check pull stud torque weekly" });
    const sortSel = el("select", { disabled: readonly }, new Option("Tool number", "tool_id"), new Option("Pot", "pocket"));
    sortSel.value = tb.sort_in_machine || "tool_id";
    form.replaceChildren(
      el("h2", { textContent: "Toolbook settings" }),
      el("label", { textContent: "Machines (comma separated)" }), mach,
      el("label", { textContent: "Materials (comma separated)" }), matIn,
      el("label", { textContent: "Publish folder" }), pub,
      btn("Choose publish folder...", async () => { const p = await pickFolder(); if (p) pub.value = p; }),
      el("label", { textContent: "Book notes - shown at the top of the viewer (one per line)" }), notesBox,
      el("label", { textContent: "Order of \"Tools in machine\" lists" }), sortSel,
      el("p", {}, btn("Apply", async () => {
        const next = [...new Set(mach.value.split(",").map((s) => s.trim()).filter(Boolean))];
        if (!next.length) return fail("A toolbook needs at least one machine.");
        const nm = [...new Set(matIn.value.split(",").map((s) => s.trim()).filter(Boolean))];
        const badName = nm.find((m) => m.length > 20 || m.includes("/ ") || m.includes(" /"));
        if (badName) return fail(`Material "${badName}" is not allowed: at most 20 characters, no space next to a "/".`);
        const used = tb.materials.filter((m) => !nm.includes(m) && tb.tools.some((t) => t.materials.includes(m)));
        if (used.length) return fail(`Material ${used.join(", ")} is still used by tools - remove it from them first.`);
        const gone = tb.machines.filter((m) => !next.includes(m));
        if (gone.length && (await ask(`Remove machine ${gone.join(", ")}? Its built entries on every tool are deleted.`, ["Remove", "Cancel"], 1)) !== "Remove") return;
        for (const t of tb.tools) {
          for (const m of gone) delete t.machines[m];
          for (const m of next) t.machines[m] ??= { built: false };
        }
        tb.machines = next;
        tb.materials = nm;
        tb.publish_dir = pub.value.trim();
        const notes = notesBox.value.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
        if (notes.length) tb.notes = notes; else delete tb.notes;
        if (sortSel.value === "pocket") tb.sort_in_machine = "pocket"; else delete tb.sort_in_machine;
        touch(); draw();
      }), " ", btn("Back", draw))
    );
    linkLabels(form);
  };

  // Filter box, id box and Add stay in the DOM for good (typing keeps focus); only count and list are redrawn.
  const search = el("input", { placeholder: "Filter", "aria-label": "Filter tools", oninput: (e) => { flt.q = e.target.value; drawSide(); } });
  const sel = (key, first) => el("select", { onchange: (e) => { flt[key] = e.target.value; drawSide(); } }, new Option(first, ""));
  const fMachine = named(sel("machine", "All machines"), "Machine"), fCat = named(sel("category", "All categories"), "Category"), fMat = named(sel("material", "All materials"), "Material"), fStat = named(sel("status", "Built or planned"), "Status");
  fStat.append(new Option("Built (somewhere)", "built"), new Option("Planned (built nowhere)", "planned"), new Option("Built not known", "unknown"), new Option("Retired", "retired"));
  const fill = (s, key, values) => {
    values = values.filter(Boolean); // an empty category must not duplicate "All categories"
    if ([...s.options].slice(1).map((o) => o.value).join("\n") !== values.join("\n")) s.replaceChildren(s.options[0], ...values.map((v) => new Option(v, v))); // rebuilt only when changed, so an open list stays open
    s.value = values.includes(flt[key]) ? flt[key] : (flt[key] = "");
  };
  const idIn = el("input", { placeholder: "new id", "aria-label": "New tool id", size: 6 });
  const addBtn = btn("Add", () => {
    const id = Number(idIn.value);
    if (!Number.isInteger(id) || tb.tools.some((t) => t.tool_id === id)) return fail("Enter an unused whole number.");
    const cat = [...new Set(tb.tools.map((t) => t.category))].find((c) => { const r = categoryRange(c); return r && id >= r[0] && id <= r[1]; }) || "";
    tb.tools.push({ tool_id: id, description: "NEW TOOL", category: cat, material: "", materials: [], inserts: null, coolant: "", detail_lines: [], extra_notes: [], length: null, machines: Object.fromEntries(tb.machines.map((m) => [m, { built: false }])), image: null, model: null });
    idIn.value = "";
    Object.assign(flt, { q: "", machine: "", category: "", material: "", status: "" }); search.value = ""; // so the new tool is visible
    selected = id; touch(); draw();
  });
  const count = el("div", { className: "muted", style: "padding:0 10px" });
  const list = named(el("ul", { id: "list", role: "listbox" }), "Tools");
  // Keyboard: Tab reaches the selected tool (or the first); Up/Down, Page Up/Down, Home, End
  // move and select; Enter or Space selects too. Clicking a row redraws the list and keeps the focus on it.
  list.onkeydown = (e) => {
    const rows = [...list.children], i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const j = e.key === "Enter" || e.key === " " ? i : { ArrowDown: i + 1, ArrowUp: i - 1, PageDown: i + 10, PageUp: i - 10, Home: 0, End: rows.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, j))].click();
  };
  side.replaceChildren(el("div", { className: "tools" }, search, idIn, addBtn), el("div", { className: "tools" }, fMachine, fCat, fMat, fStat), count, list);

  const drawSide = () => {
    fill(fMachine, "machine", tb.machines); fill(fCat, "category", [...new Set(tb.tools.map((t) => t.category))].sort()); fill(fMat, "material", tb.materials); fStat.value = flt.status;
    const rows = tbFilter(tb.tools, { ...flt, sort: tb.sort_in_machine });
    const toolOf = (e) => /Tool (\d+):/.exec(e)?.[1];
    const bad = new Set(validate(tb).map(toolOf)), warn = new Set(warnings(tb).map(toolOf));
    // columns: the pot when a machine is picked, the mark, the number, then the description
    const pocket = (t) => (flt.machine ? el("span", { className: "pocket" + (t.machines?.[flt.machine]?.pockets?.length ? "" : " none"), textContent: tbPocketLabel(t, flt.machine) }) : null);
    idIn.disabled = addBtn.disabled = readonly;
    count.textContent = `${rows.length} of ${tb.tools.length}`;
    const hadFocus = list.contains(document.activeElement);
    // a tool with an error or a warning also gets a mark, not only a colour
    const mark = (t) => bad.has(String(t.tool_id)) ? el("span", { className: "mark", textContent: "\u2715 ", title: "Has an error" }) : warn.has(String(t.tool_id)) ? el("span", { className: "mark", textContent: "\u26A0 ", title: "Has a warning" }) : null;
    list.replaceChildren(...rows.map((t) => el("li", { className: (t.tool_id === selected ? "sel " : "") + (bad.has(String(t.tool_id)) ? "bad" : warn.has(String(t.tool_id)) ? "warn" : ""), role: "option", "aria-selected": String(t.tool_id === selected), tabIndex: t.tool_id === selected ? 0 : -1, onclick: () => { selected = t.tool_id; drawSide(); drawForm(); } },
      pocket(t), mark(t), el("b", { textContent: "T" + t.tool_id }), el("span", { className: "desc", textContent: tbDescription(t, flt.machine) + (t.removed ? "  [retired]" : tbBuiltUnknown(t) ? "  [built not known]" : tbIsBuilt(t) ? "" : "  [planned]") + (t.flags?.length ? `  [${t.flags.join(", ")}]` : "") }))));
    const current = list.querySelector('[tabindex="0"]') || list.firstChild;
    if (current) current.tabIndex = 0;
    if (hadFocus) current?.focus();
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" }); // the stepper can pick a tool that is scrolled out of sight
    const st = form.querySelector(".stepper"), t = tb.tools.find((x) => x.tool_id === selected);
    if (st && t) st.replaceWith(makeStepper(t));
  };

  const numText = (s) => { s = s.trim(); return s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : s; };
  const field = (label, value, set, extra = {}) => [el("label", { textContent: label }), el("input", { type: "text", value: value ?? "", disabled: readonly, oninput: (e) => { set(e.target.value); touch(); drawSideSoon(); }, ...extra })];
  let soon = 0;
  const drawSideSoon = () => { clearTimeout(soon); soon = setTimeout(drawSide, 400); };

  const category = (t) => {
    const f = field("Category", t.category, (v) => (t.category = v));
    f[1].setAttribute("list", "cats");
    return f;
  };

  // where the tool is in the list as filtered, with buttons for the one above and below it (UI redesign);
  // drawSide rebuilds it too, so the count follows the filters
  const makeStepper = (t) => {
    const rows = tbFilter(tb.tools, { ...flt, sort: tb.sort_in_machine }), at = rows.indexOf(t);
    const step = (d) => { const n = rows[at + d]; if (n) { selected = n.tool_id; drawSide(); drawForm(); } };
    const stepBtn = (glyph, d, name) => Object.assign(btn(glyph, () => step(d), "icon"), { title: name, disabled: !rows[at + d] || at < 0 });
    return el("div", { className: "stepper" }, el("span", { className: "muted", textContent: at < 0 ? "hidden by the filters" : `${at + 1} / ${rows.length}` }),
      named(stepBtn("\uf077", -1, "Previous tool in the list"), "Previous tool"), named(stepBtn("\uf078", 1, "Next tool in the list"), "Next tool"));
  };

  const drawForm = async () => {
    const t = tb.tools.find((x) => x.tool_id === selected);
    if (!t) return form.replaceChildren(el("div", { className: "empty" }, el("span", { className: "ico big", "aria-hidden": "true", textContent: "\uf0ad" }),
      el("h2", { textContent: tb.tools.length ? "Pick a tool or add one." : "No tools yet" }),
      el("p", { className: "muted", textContent: tb.tools.length ? "Click a tool in the list (or use the arrow keys there). To add one, type its number in the box next to Add." : "Type a tool number in the box next to Add." })));
    const stepper = makeStepper(t);
    const cats = el("datalist", { id: "cats" }, ...[...new Set(tb.tools.map((x) => x.category))].sort().map((c) => el("option", { value: c })));
    const mats = el("div", { className: "inline" }, ...tb.materials.map((m) => el("label", {}, el("input", { type: "checkbox", checked: t.materials.includes(m), disabled: readonly, onchange: (e) => {
      t.materials = tb.materials.filter((x) => (x === m ? e.target.checked : t.materials.includes(x)));
      t.material = t.materials.join(" / "); touch(); drawTag();
    } }), " " + m)));
    const machines = tb.machines.map((m) => {
      const e = (t.machines[m] ??= { built: false });
      return el("div", { className: "inline" }, el("b", { textContent: m }),
        el("label", { title: e.built === null ? "Not known yet. Tick or untick to set it." : "" },
          el("input", { type: "checkbox", checked: e.built === true, indeterminate: e.built === null, disabled: readonly, onchange: (ev) => { e.built = ev.target.checked; touch(); draw(); } }), e.built === null ? " built: not known" : " built"),
        el("label", {}, " pots ", el("input", { type: "text", size: 10, className: "num", placeholder: "e.g. 181, 320", value: (e.pockets || []).join(", "), disabled: readonly, oninput: (ev) => {
          const p = ev.target.value.split(",").map(numText).filter((v) => v != null);
          if (p.length) e.pockets = p; else delete e.pockets;
          touch(); drawTag(); drawSideSoon();
        } })),
        el("label", {}, ` length on ${m} - reference only `, el("input", { type: "text", size: 8, className: "num", value: e.length ?? "", disabled: readonly, oninput: (ev) => {
          const v = numText(ev.target.value);
          if (v == null) delete e.length; else e.length = v;
          touch();
        } })),
        el("label", {}, ` description on ${m} `, el("input", { type: "text", size: 30, placeholder: "same as Description", value: e.description ?? "", disabled: readonly, oninput: (ev) => {
          if (ev.target.value.trim()) e.description = ev.target.value; else delete e.description;
          touch(); drawSideSoon();
        } })));
    });
    // optional text fields are left out of the file when blank
    const optional = (label, key) => field(label, t[key], (v) => { if (v.trim()) t[key] = v; else delete t[key]; });
    const lines = (label, key) => [el("label", { textContent: label + " (one per line)" }), el("textarea", { value: t[key].join("\n"), disabled: readonly, oninput: (e) => { t[key] = e.target.value.split("\n"); while (t[key].length && !t[key].at(-1).trim()) t[key].pop(); touch(); } })];
    // the tool tag: the number, the description and the pot on each machine, kept up to date as they are typed
    const tag = el("div", { className: "tag" });
    const drawTag = () => tag.replaceChildren(
      el("h2", {}, el("span", { className: "tno", textContent: "T" + t.tool_id }), " ", el("span", { className: "tdesc", textContent: t.description || "No description" })),
      el("div", { className: "pots" }, ...(() => { const cs = potConflicts(tb); return tb.machines.map((m) => {
        const has = t.machines[m]?.pockets?.length;
        const also = cs.filter((c) => c.machine === m && c.tools.includes(t.tool_id)).map((c) => `pot ${c.pot} is also on ${c.tools.filter((o) => o !== t.tool_id).map((o) => "T" + o).join(", ")}`);
        return el("span", { className: "pot" + (has ? "" : " none") + (also.length ? " clash" : ""), title: also.length ? also.join("\n") + " - check which is right" : "" }, el("small", { textContent: m }), has ? tbPocketLabel(t, m) : "no pot", also.length ? el("small", { textContent: "\u26A0 " + also.join("; ") }) : null);
      }); })()),
      el("div", { className: "mats" }, ...t.materials.map((m) => el("span", { className: "badge", textContent: m }))));
    const img = el("img", { alt: "" });
    img.style.display = "none";
    if (t.image) {
      imgUrl && URL.revokeObjectURL(imgUrl);
      fs.readBytes(join(dir, "assets", t.image)).then((b) => { imgUrl = URL.createObjectURL(new Blob([b], { type: "image/png" })); img.src = imgUrl; img.style.display = ""; }).catch(() => {});
    }
    form.replaceChildren(
      stepper, (drawTag(), tag),
      el("h3", { textContent: "General" }),
      el("div", { className: "fields" },
      ...field("Tool ID", t.tool_id, (v) => { t.tool_id = Number(v); selected = t.tool_id; drawTag(); }, { className: "num" }),
      ...field("Description", t.description, (v) => { t.description = v; drawTag(); }),
      ...category(t), cats,
      el("label", { textContent: "Materials" }), named(Object.assign(mats, { role: "group" }), "Materials"),
      ...field("Inserts", t.inserts, (v) => (t.inserts = numText(v))),
      ...field("Coolant", t.coolant, (v) => (t.coolant = v)),
      ...optional("Speeds / feeds", "speeds"),
      ...optional("Group (backup tools)", "group"),
      ...optional("Bar dot position", "bar_dot"),
      ...optional("Spindle direction", "spindle_dir"),
      ...field("Flags (comma separated, e.g. replace)", (t.flags || []).join(", "), (v) => {
        const f = [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))];
        if (f.length) t.flags = f; else delete t.flags;
      }),
      ...field("Used on - jobs or parts (comma separated, e.g. 1001-A, BRACKET)", (t.used_on || []).join(", "), (v) => {
        const u = [...new Set(v.split(",").map((x) => x.trim()).filter(Boolean))];
        if (u.length) t.used_on = u; else delete t.used_on;
      }),
      ...field("Tool length - reference only", t.length, (v) => (t.length = numText(v)), { className: "num" })),
      el("h3", { textContent: "Machines" }), el("p", { className: "muted", textContent: "Planned = not built on any machine. Built not known = not filled in yet. A machine's own length and description are fill-in only where they differ from the tool's; lengths are reference only, never a live offset." }), ...machines,
      el("h3", { textContent: "Details" }), ...lines("Details", "detail_lines"),
      el("h3", { textContent: "Notes" }), ...lines("Notes", "extra_notes"),
      ...(t.history?.length ? [el("h3", { textContent: "Earlier tools with this number" }), ...t.history.map((h, i) => el("div", { className: "was" },
        el("pre", { textContent: [h.description, ...(h.detail_lines || []).map((l) => "  " + l), ...(h.extra_notes || []).map((l) => "  " + l)].join("\n") }),
        btn("Remove from history", () => { t.history.splice(i, 1); if (!t.history.length) delete t.history; touch(); drawForm(); })))] : []),
      el("h3", { textContent: "Picture" }), img,
      el("div", { className: "row" },
        btn("Set picture (PNG)...", async () => {
          const p = await T.dialog.open({ filters: [{ name: "PNG", extensions: ["png"] }] });
          if (!p) return;
          try { t.image = await book.addAsset(fs, dir, await fs.readBytes(p), "png"); touch(); drawForm(); } catch (err) { fail(err); }
        }),
        t.image && btn("Remove picture", () => { t.image = null; touch(); drawForm(); })),
      el("h3", { textContent: "Retired" }),
      el("label", {}, el("input", { type: "checkbox", checked: !!t.removed, disabled: readonly, onchange: (e) => { if (e.target.checked) t.removed = true; else delete t.removed; touch(); drawSide(); } }),
        " Retired - kept for history, left out of every list except \"Retired\""),
      el("p", { className: "danger" }, btn("Delete this tool", async () => { if ((await ask(`Delete tool ${t.tool_id}?`, ["Delete", "Cancel"], 1)) === "Delete") { tb.tools = tb.tools.filter((x) => x !== t); selected = null; touch(); draw(); } }))
    );
    linkLabels(form);
    if (readonly) form.querySelectorAll("button:not(.stepper button)").forEach((b) => (b.disabled = true)); // stepping still works
  };

  const draw = () => { drawHead(); drawSide(); drawForm(); };
  const cols = el("div", { id: "cols" }, side, form);
  here = name;
  show(head, cols);
  canLeave = leave;
  draw();
  if (!readonly) startBeat();
}

// ================= machine mode =================
const newId = () => "b" + Date.now().toString(36) + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const viewerBase = () => (navigator.userAgent.includes("Windows") ? "http://tb.localhost/" : "tb://localhost/");

// A copy still running when the next 60 s round comes (a big first copy) is not started twice.
const running = new Set();
const single = async (key, fn) => {
  if (running.has(key)) return null;
  running.add(key);
  try { return await fn(); } finally { running.delete(key); }
};

async function machineHome(start = false) {
  const cacheRoot = await inv("cache_root");
  const books = (settings.machineBooks ??= []);
  if (books.some((b) => !b.id)) { books.forEach((b) => (b.id ??= newId())); await saveSettings(); } // cache folder = id, never a name
  const lock = locked();
  const cards = new Map();
  const status = async (b) => {
    const s = await single(b.id, () => syncOnce(fs, b.dir, join(cacheRoot, b.id)));
    const c = cards.get(b.name);
    if (c && s) c.textContent = s.release == null ? "no copy yet" : `release ${s.release}` + (s.online ? "" : " - Offline copy");
    return s;
  };
  const syncAll = () => books.forEach((b) => status(b).catch(() => {}));
  const name = el("input", { placeholder: "Toolbook name", "aria-label": "Toolbook name" });
  const dir = el("input", { placeholder: "Publish folder", "aria-label": "Publish folder", readOnly: true });
  show(
    header(),
    el("div", { className: "page" },
      el("h2", { textContent: "Toolbooks on this PC" }),
      ...books.map((b) => {
        const st = el("span", { className: "muted", textContent: "checking..." });
        cards.set(b.name, st);
        return el("div", { className: "card" }, el("span", { className: "name", textContent: b.name }), st,
          btn("Open", () => openViewer(b), "primary"),
          !lock && btn("Remove", async () => { if ((await ask("Remove " + b.name + " from this PC?", ["Remove", "Cancel"], 1)) === "Remove") { settings.machineBooks = books.filter((x) => x !== b); await saveSettings(); machineHome(); } }));
      }),
      !lock && el("h2", { textContent: "Add a toolbook" }),
      !lock && el("div", { className: "row" }, name, dir, btn("Choose folder...", async () => { const p = await pickFolder(); if (p) dir.value = p; }),
        btn("Add", async () => {
          if (!name.value.trim() || !dir.value) return fail("Enter a name and choose the publish folder.");
          const nm = name.value.trim();
          if (books.some((b) => b.name.toLowerCase() === nm.toLowerCase())) return fail("A toolbook with that name is already on this PC.");
          books.push({ id: newId(), name: nm, dir: dir.value });
          await saveSettings(); machineHome();
        })),
      !lock && lockSection())
  );
  const openViewer = (b) => {
    here = b.name;
    show(header(btn("Back", () => machineHome())), el("iframe", { src: `${viewerBase()}${b.id}/` }));
    timers.push(setInterval(() => status(b).catch(() => {}), 60000));
    status(b).catch(() => {});
  };
  syncAll();
  timers.push(setInterval(syncAll, 60000));
  if (start && lock && books.length === 1) openViewer(books[0]); // a locked PC starts in its toolbook
}

// ================= hub mode =================
async function hubHome() {
  const root = settings.hubRoot;
  const books = (settings.hubBooks ??= []);
  const lock = locked();
  const who = await inv("whoami");
  const cards = new Map();
  const round = async (b) => {
    const s = await single("hub:" + b.name, () => hub.passOn(fs, root, b).catch((err) => ({ online: false, release: null, error: String(err.message || err) })));
    const c = cards.get(b);
    if (!c || !s) return;
    c.textContent = s.release == null ? `no copy yet: ${s.error}` : s.online ? `release ${s.release} - up to date` : `office side not reachable - the machines keep release ${s.release}`;
    c.title = `Last checked ${new Date().toLocaleTimeString()}` + (s.error ? "\n" + s.error : "");
    c.className = s.online ? "muted" : "warn";
  };
  const all = () => books.forEach((b) => round(b));
  // the hub folder as a web page (lib.rs hub_web): any browser that can reach this PC, nothing to install
  const web = el("p", { className: "muted", textContent: settings.hubWeb ? "starting..." : "Off. When on, anything on the same network as this PC can read the toolbooks in a browser; nothing can be changed from there." });
  if (settings.hubWeb && root) inv("hub_web", { root }).then(
    (port) => { web.textContent = `On. In a browser: http://${who.host}:${port}/  (a phone or tablet may need this PC's address on the machine network instead of its name, e.g. http://192.168.1.20:${port}/). The first time, Windows asks to allow ${appName} through the firewall: an admin has to say yes.`; },
    (err) => { web.className = "warn"; web.textContent = `The web page could not start: ${err.message ?? err}`; });
  const name = el("input", { placeholder: "Toolbook name, e.g. Cell A", "aria-label": "Toolbook name" });
  const src = el("input", { placeholder: "Office publish folder", "aria-label": "Office publish folder", readOnly: true });
  show(
    header(),
    el("div", { className: "page" },
      // plain at the top while it is on: the setting survives updates, and only the firewall keeps it in
      settings.hubWeb ? el("p", { className: "warn", textContent: "Web page: ON - anything on the same network as this PC can read these toolbooks in a browser (nobody outside can reach it while the firewall blocks it). To turn it off, untick it under \"Web page\" below." }) : null,
      el("h2", { textContent: "Hub folder" }),
      el("p", { className: "muted", textContent: "A folder on this PC's own disk, shared read-only to the machine network. This PC only reads the office side and only writes in this folder." }),
      el("div", { className: "row" }, el("input", { value: root || "", readOnly: true, placeholder: "not set", "aria-label": "Hub folder" }),
        !lock && btn("Choose...", async () => {
          const p = await pickFolder();
          if (!p) return;
          try { books.forEach((b) => hub.hubFolder(p, b.name, b.src)); } catch (err) { return fail(err); }
          settings.hubRoot = p; await saveSettings(); hubHome();
        })),
      el("h2", { textContent: "Toolbooks passed on" }),
      ...books.map((b) => {
        const st = el("span", { className: "muted", textContent: "checking..." });
        cards.set(b, st);
        return el("div", { className: "card" }, el("span", { className: "name", textContent: b.name }), st,
          !lock && btn("Remove", async () => {
            if ((await ask(`Stop passing ${b.name} on? Its folder in the hub folder is left as it is, so delete it yourself if the machines should not see it any more.`, ["Stop passing on", "Cancel"], 1)) !== "Stop passing on") return;
            settings.hubBooks = books.filter((x) => x !== b); await saveSettings(); hubHome();
          }));
      }),
      el("p", { className: "muted", textContent: books.length
        ? `Machine PCs: "Add a toolbook", folder \\\\${who.host}\\<the share's name>\\<toolbook>. A new release reaches this PC within a minute, and the machine PCs a minute after that.`
        : "None yet." }),
      el("h2", { textContent: `Web page for phones, tablets and PCs without ${appName}` }),
      el("label", {}, el("input", { type: "checkbox", checked: !!settings.hubWeb, disabled: lock || !root, onchange: async (e) => {
        settings.hubWeb = e.target.checked; await saveSettings();
        if (!settings.hubWeb) await inv("hub_web", { root: "" }).catch(() => {});
        hubHome();
      } }), " Show these toolbooks as a read-only web page"),
      web,
      !lock && el("h2", { textContent: "Add a toolbook" }),
      !lock && el("div", { className: "row" }, name, src, btn("Choose folder...", async () => { const p = await pickFolder(); if (p) src.value = p; }),
        btn("Add", async () => {
          const nm = name.value.trim();
          if (!nm || !src.value) return fail("Enter a name and choose the toolbook's publish folder on the office side.");
          if (books.some((b) => b.name.toLowerCase() === nm.toLowerCase())) return fail("A toolbook with that name is already passed on.");
          try { hub.hubFolder(root, nm, src.value); } catch (err) { return fail(err); }
          books.push({ name: nm, src: src.value });
          await saveSettings(); hubHome();
        })),
      !lock && lockSection())
  );
  if (root) { all(); timers.push(setInterval(all, 60000)); }
}

// ================= password (machine and hub PCs) =================
let unlocked = false; // until the program restarts or "Lock now"
function locked() { return !!settings.lock && settings.mode !== "editor" && !unlocked; }
const modeHome = () => (settings.mode === "hub" ? hubHome() : machineHome());

function unlockPage() {
  const pw = el("input", { type: "password", placeholder: "Password", "aria-label": "Password" });
  const go = async () => {
    if (await checkLock(settings.lock, pw.value)) { unlocked = true; note.hidden = true; return modeHome(); }
    pw.value = "";
    await new Promise((r) => setTimeout(r, 1500)); // slows guessing
    fail("Wrong password.");
  };
  // a block body: a handler that returns false cancels the key, and 0.2.0's `e.key === "Enter" && go()` let nothing be typed
  pw.onkeydown = (e) => { if (e.key === "Enter") go(); };
  show(
    el("header", {}, el("h1", { textContent: appName }), btn("Cancel", () => modeHome())),
    el("div", { className: "page" },
      el("h2", { textContent: "Unlock this PC" }),
      el("p", { className: "muted", textContent: "The password lets you change this PC's mode and its toolbooks." }),
      el("div", { className: "row" }, pw, btn("Unlock", go, "primary")))
  );
  pw.focus();
}

function lockSection() {
  if (settings.lock)
    return el("div", {},
      el("h2", { textContent: "Password" }),
      el("p", { className: "muted", textContent: "Unlocked until the program restarts or Lock now." }),
      el("div", { className: "row" },
        btn("Lock now", () => { unlocked = false; modeHome(); }, "primary"),
        btn("Remove the password", async () => {
          if ((await ask("Remove the password? Anyone at this PC can then change its mode and toolbooks.", ["Remove the password", "Cancel"], 1)) !== "Remove the password") return;
          delete settings.lock; await saveSettings(); modeHome();
        })));
  const a = el("input", { type: "password", placeholder: "Password", "aria-label": "Password" });
  const b = el("input", { type: "password", placeholder: "Same password again", "aria-label": "Same password again" });
  return el("div", {},
    el("h2", { textContent: "Lock this PC" }),
    el("p", { className: "muted", textContent: settings.mode === "hub"
      ? "With a password set, nobody can change this PC's mode or the toolbooks it passes on without it."
      : "With a password set, this PC starts in its toolbook (when it has one) and nobody can change the mode or the toolbooks without it." }),
    el("div", { className: "row" }, a, b,
      btn("Set password and lock", async () => {
        try { settings.lock = await makeLock(a.value, b.value); } catch (err) { return fail(err); }
        unlocked = false;
        await saveSettings();
        notify("Locked. Unlock... at the bottom left asks for the password.");
        modeHome();
      })));
}

// closing the window asks about unsaved edits and lets go of the edit lock
T.window?.getCurrentWindow?.().onCloseRequested(async (e) => {
  if (document.querySelector(".modal")) return e.preventDefault(); // a question is already open: answer that first
  if (canLeave && !(await canLeave())) e.preventDefault();
});

async function boot() {
  settings = JSON.parse(await inv("settings_read"));
  version = (await T.app?.getVersion?.().catch(() => "")) ?? "";
  document.title = appName;
  if (settings.theme) applyTheme(settings.theme);
  if (settings.mode === "editor") {
    await editorHome();
    // started with a toolbook folder as its argument (e.g. from a launcher): open it
    const asked = await inv("start_arg").catch(() => null);
    if (asked) openBook(await addBook(asked.replace(/[\\/]+$/, ""))).catch(fail);
  } else if (settings.mode === "machine") machineHome(true);
  else if (settings.mode === "hub") hubHome();
  else chooseMode();
}
boot().catch((err) => (app.textContent = "Startup failed: " + err));
