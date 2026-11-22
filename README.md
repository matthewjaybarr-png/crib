# Crib

A tool book for CNC shops: one editor on the office PC, and a read-only viewer on each machine PC that keeps
working when the network drops.

Crib starts empty. You name your machines and materials, add your tools, and publish.

## What it does

- **Tool book editor.** Tools with description, category, materials, coolant, length, inserts, flags, notes,
  pictures and "used on" jobs. Each machine has its own Built (yes / no / not known), pots and description.
- **Safe sharing.** The book lives in a folder (local disk, network share or USB drive). An edit lock stops two
  people saving over each other, and every save is atomic.
- **Publish.** Publishing writes a numbered release with a hashed manifest. Rollback points the published folder
  back at the previous release.
- **Machine PCs.** Each machine PC copies the published folder into a local cache. It only switches to a release
  once every file has arrived and its hash checks out, so a half-copied release is never shown.
- **Hub PC.** A PC that sits on both the office and the machine networks can pass published books on to the
  machine side.
- **Offline copy.** One HTML file holding the whole book and its pictures. It opens from any disk with no network.
- **Checks.** Duplicate tool numbers, pots used twice on one machine, tool numbers outside their category's
  range, and tools whose Built is still "not known".
- **Themes.** Built-in themes, plus the Omarchy themes.

## Build

You need Node 20+, Rust and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```
npm install
npm test             # synthetic tests for the book, publish, sync, hub, lock and filter code
cd src-tauri && cargo test
npm run build        # installers end up in src-tauri/target/release/bundle/
```

`npm run dev` runs the app with live reload.

## Apphub

Each time Crib starts, it writes `<config>/io.github.apphub/apps/Crib.json`. That file records where Crib is
installed and which version is running, so [Apphub](https://github.com/matthewjaybarr-png/apphub) can list it
with no setup. If writing the file fails, Crib prints a message and keeps running.

## Related apps

- [Swarf](https://github.com/matthewjaybarr-png/swarf): G-code editor
- [Apphub](https://github.com/matthewjaybarr-png/apphub): finds, installs and launches these apps
- [Jig](https://github.com/matthewjaybarr-png/jig): set-up sheets
- [Gauge](https://github.com/matthewjaybarr-png/gauge): shop calculator

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). The bundled fonts keep their own licenses (see `ui/fonts/README.md`).
