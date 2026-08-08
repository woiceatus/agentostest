# Vendored ecooxai/aurora-wm

Source: https://github.com/ecooxai/aurora-wm

This tree is vendored for the AgentOS browser port in `wasm/aurora-wm-web`.
The browser crate consumes:

- wallpaper asset `wallpaper/f7d4b278-3aef-4a94-b84e-f14acde427ac.png`
- WM constants / manage_window / chrome behavior mirrored from `src/`

It is **not** meant to be `cargo build`'d as the native Linux binary inside this
checkout (fonts and extra wallpapers are trimmed). Clone upstream for a full
native build on `:11`.
