// Themes: 6 built-in ones and the 21 Omarchy ones, turned into Crib's
// own colour variables (app.css :root). Neon Ridge is app.css itself, so it sets nothing. Each theme only gives a
// background, surface, text, muted, accent and border; the rest is worked out here so text always stays readable
// (contrast checked against every background it sits on). Amber pot chips stay amber in every theme.
// [id, label, background, surface, text, muted, accent, border, dark]
export const THEMES = [
  ["neon-ridge", "Neon Ridge", "#0a1028", "#1a2550", "#d7dcf5", "#8089bd", "#38bdfa", "#2a3a78", true],
  ["tokyo-night", "Tokyo Night", "#1a1b26", "#24283b", "#c0caf5", "#9aa5ce", "#7aa2f7", "#414868", true],
  ["jade", "Jade", "#181b22", "#232a32", "#cedfea", "#889bad", "#a6da95", "#34433e", true],
  ["nord", "Nord", "#2e3440", "#3b4252", "#eceff4", "#b5c0d0", "#88c0d0", "#4c566a", true],
  ["paper", "Paper", "#f5f2ea", "#e8e4da", "#252a32", "#58606b", "#276749", "#c8c4b8", false],
  ["alpenglow-night", "Alpenglow Night", "#181529", "#29233d", "#e7dcff", "#ab9fc4", "#c995f4", "#635078", true],
  ["catppuccin-latte", "Catppuccin Latte", "#eff1f5", "#dce0e8", "#4c4f69", "#64677e", "#1e66f5", "#ccd0da", false],
  ["catppuccin", "Catppuccin", "#1e1e2e", "#313244", "#cdd6f4", "#8489a1", "#89b4fa", "#45475a", true],
  ["ethereal", "Ethereal", "#060b1e", "#131a3a", "#ffcead", "#6d7db6", "#7d82d9", "#252e56", true],
  ["everforest", "Everforest", "#2d353b", "#343f44", "#d3c6aa", "#a8a291", "#7fbbb3", "#3d484d", true],
  ["flexoki-light", "Flexoki Light", "#fffcf0", "#e6e4d9", "#100f0f", "#696763", "#205ea6", "#cecdc3", false],
  ["gruvbox", "Gruvbox", "#282828", "#3c3836", "#d4be98", "#a2917a", "#7daea3", "#504945", true],
  ["hackerman", "Hackerman", "#0b0c16", "#151828", "#ddf7ff", "#8690af", "#82fb9c", "#1f253a", true],
  ["jade-horse", "Jade Horse", "#142620", "#203b31", "#dfede5", "#91ad9f", "#8bcbb1", "#2b5147", true],
  ["kanagawa", "Kanagawa", "#1f1f28", "#223249", "#dcd7ba", "#8c8a7d", "#dcd7ba", "#363646", true],
  ["last-horizon", "Last Horizon", "#0c0b0c", "#0c0b0c", "#fafcfb", "#80797b", "#b59790", "#584e51", true],
  ["lumon", "Lumon", "#16242d", "#1b2d40", "#d6e2ee", "#6f9dbf", "#8bc9eb", "#243d56", true],
  ["lupine", "Lupine", "#fafafa", "#f5f5f5", "#212121", "#606060", "#3264eb", "#d0d0d0", false],
  ["matte-black", "Matte Black", "#121212", "#1e1e1e", "#bebebe", "#828282", "#e68e0d", "#2a2a2a", true],
  ["miasma", "Miasma", "#222222", "#2c2c2c", "#c2c2b0", "#939389", "#78824b", "#383838", true],
  ["retro-82", "Retro 82", "#05182e", "#0a2540", "#f6dcac", "#3f8f8a", "#faa968", "#134e5a", true],
  ["ristretto", "Ristretto", "#2c2525", "#3d2f2a", "#e6d9db", "#a49a9b", "#f38d70", "#403e41", true],
  ["rose-pine", "Rose Pine", "#faf4ed", "#f2e9e1", "#575279", "#6b6686", "#56949f", "#dfdad9", false],
  ["solitude", "Solitude", "#101315", "#101315", "#cacccc", "#828488", "#798186", "#343d41", true],
  ["starship", "Starship", "#1c1c1e", "#2c2c2e", "#f5f5f7", "#98989d", "#ff9f0a", "#3a3a3c", true],
  ["vantablack", "Vantablack", "#000000", "#1a1a1a", "#ffffff", "#7b7b7b", "#8d8d8d", "#1a1a1a", true],
  ["white", "White", "#ffffff", "#c0c0c0", "#000000", "#6c6c6c", "#6e6e6e", "#c0c0c0", false],
];
export const BUILTIN_COUNT = 6; // the first 6 are built in, the rest Omarchy's (the picker groups them)
export const DEFAULT_THEME = "neon-ridge";

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => { const B = rgb(b); return hex(rgb(a).map((v, i) => v + (B[i] - v) * t)); };
const lum = (h) => { const [r, g, b] = rgb(h).map((v) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// `c`, moved toward white (dark themes) or black (light ones) just far enough to reach `min` on every ground
const legible = (c, grounds, min, towardWhite) => {
  for (let t = 0; t <= 1.0001; t += 0.04) { const m = mix(c, towardWhite ? "#ffffff" : "#000000", t); if (grounds.every((g) => contrast(m, g) >= min)) return m; }
  return towardWhite ? "#ffffff" : "#000000";
};

export function themeVars(id) {
  const t = THEMES.find((x) => x[0] === id);
  if (!t || id === DEFAULT_THEME) return null;
  const [, , bg, surface, text, muted, accent, border, dark] = t;
  const panel = mix(bg, surface, 0.45), raise = surface, hover = mix(surface, accent, 0.16), sel = mix(surface, accent, 0.26);
  const grounds = [bg, panel, raise, sel];
  const primary = legible(accent, ["#ffffff"], 4.5, false); // white text on the main buttons
  const err = legible(dark ? "#ff8fae" : "#c0264f", grounds, 4.5, dark);
  const warn = legible(dark ? "#f0946e" : "#b4501f", grounds, 4.5, dark);
  return {
    bg, panel, raise, hover, sel, line: border,
    edge: legible(mix(border, text, 0.3), [panel, raise], 1.9, dark),
    ink: legible(text, grounds, 7, dark), muted: legible(muted, grounds, 4.5, dark),
    ring: legible(accent, [bg, panel, raise], 3, dark),
    primary, "primary-hover": mix(primary, "#ffffff", 0.1),
    err, errsel: mix(err, dark ? "#ffffff" : "#000000", 0.35), warn,
    guard: dark ? "#f0946e" : "#e07a45", "on-guard": "#070b1e",
    "pot-ink": legible(dark ? "#f5c98a" : "#8a5a00", grounds, 4.5, dark),
  };
}
const KEYS = Object.keys(themeVars("paper"));

export function applyTheme(id) {
  const s = document.documentElement.style;
  for (const k of KEYS) s.removeProperty("--" + k);
  for (const [k, v] of Object.entries(themeVars(id) || {})) s.setProperty("--" + k, v);
  s.colorScheme = THEMES.find((x) => x[0] === id)?.[8] === false ? "light" : "dark";
}
