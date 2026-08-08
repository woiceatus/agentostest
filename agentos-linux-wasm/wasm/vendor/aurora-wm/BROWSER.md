# Vendored ecooxai/aurora-wm

Source: https://github.com/ecooxai/aurora-wm

This tree is vendored for the AgentOS browser port in `wasm/aurora-wm-web`.
The browser crate consumes:

- wallpaper asset `wallpaper/f7d4b278-3aef-4a94-b84e-f14acde427ac.png`
- fonts `NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `NotoSansMono-Regular.ttf`
- WM constants / manage_window / chrome / rusttype text path mirrored from `src/`

Native `cargo build` of this checkout may still fail (trimmed extras). Clone
upstream for a full native Linux build on `:11`.
