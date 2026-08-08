//! Browser WASM port of [ecooxai/aurora-wm](https://github.com/ecooxai/aurora-wm).
//!
//! Includes the Aurora Files UI (folder chrome from upstream `redraw_folder`) and
//! auto-starts it when the WM boots — matching the real Linux WM launching its
//! file manager / built-in folder window.

use image::imageops::FilterType;
use rusttype::{point, Font, Scale};
use std::io::Cursor;

const TOPBAR_HEIGHT: i32 = 40;
const DOCK_ICON_SIZE: i32 = 44;
const DOCK_ICON_RADIUS: i32 = 12;
const DOCK_STRIDE: i32 = 50;
const DOCK_HEIGHT: i32 = DOCK_ICON_SIZE;
const DOCK_BOTTOM_MARGIN: i32 = 12;
const TITLEBAR_HEIGHT: i32 = 34;
const FRAME_CORNER_RADIUS: i32 = 8;
const WINDOW_COUNT: usize = 3;
const DOCK_BUTTONS: i32 = 5;
const FILES_INDEX: usize = 2;
const TERM_INDEX: usize = 0;
const NETSURF_INDEX: usize = 1;
const MAX_FILES: usize = 64;
const NAME_CAP: usize = 96;
const PATH_CAP: usize = 160;

const WALLPAPER_PNG: &[u8] =
    include_bytes!("../../vendor/aurora-wm/wallpaper/f7d4b278-3aef-4a94-b84e-f14acde427ac.png");
const FONT_REGULAR: &[u8] = include_bytes!("../../vendor/aurora-wm/fonts/NotoSans-Regular.ttf");
const FONT_BOLD: &[u8] = include_bytes!("../../vendor/aurora-wm/fonts/NotoSans-Bold.ttf");
const FONT_MONO: &[u8] = include_bytes!("../../vendor/aurora-wm/fonts/NotoSansMono-Regular.ttf");

static STATUS_RUNNING: &[u8] = b"running - terminal + netsurf + files";
static STATUS_IDLE: &[u8] = b"idle";
static SOURCE_URL: &[u8] = b"https://github.com/ecooxai/aurora-wm";

const WINDOW_TITLES: [&str; WINDOW_COUNT] = ["Aurora Terminal", "NetSurf", "Aurora Files"];
const DOCK_LABELS: [&str; 5] = ["Term", "Files", "Net", "Set", "More"];
const PLACES: [&str; 4] = ["Home", "Workspace", "Etc", "Tmp"];

#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Rect {
    const fn empty() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        }
    }

    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

#[derive(Clone, Copy)]
struct Client {
    frame: Rect,
    content: Rect,
    mapped: u32,
}

impl Client {
    const fn empty() -> Self {
        Self {
            frame: Rect::empty(),
            content: Rect::empty(),
            mapped: 0,
        }
    }
}

#[derive(Clone)]
struct FileEntry {
    name: String,
    kind: u32, // 0=dir 1=file 2=text 3=config
}

struct Fonts {
    regular: Font<'static>,
    bold: Font<'static>,
    mono: Font<'static>,
}

impl Fonts {
    fn load() -> Self {
        Self {
            regular: Font::try_from_bytes(FONT_REGULAR).expect("NotoSans-Regular"),
            bold: Font::try_from_bytes(FONT_BOLD).expect("NotoSans-Bold"),
            mono: Font::try_from_bytes(FONT_MONO).expect("NotoSansMono-Regular"),
        }
    }
}

struct State {
    width: u32,
    height: u32,
    wallpaper: Vec<u8>,
    frame: Vec<u8>,
    clients: [Client; WINDOW_COUNT],
    active: u32,
    tick: u32,
    layout_version: u32,
    running: u32,
    dock: Rect,
    fonts: Fonts,
    files_path: String,
    files: Vec<FileEntry>,
    files_selected: i32,
    files_visible: u32,
    term_lines: Vec<String>,
    term_visible: u32,
    netsurf_visible: u32,
    path_buf: [u8; PATH_CAP],
    name_buf: [u8; NAME_CAP],
}

impl State {
    fn new() -> Self {
        Self {
            width: 960,
            height: 540,
            wallpaper: Vec::new(),
            frame: Vec::new(),
            clients: [Client::empty(); WINDOW_COUNT],
            active: NETSURF_INDEX as u32,
            tick: 0,
            layout_version: 0,
            running: 0,
            dock: Rect::empty(),
            fonts: Fonts::load(),
            files_path: "/workspace".to_string(),
            files: Vec::new(),
            files_selected: 0,
            files_visible: 1,
            term_lines: Vec::new(),
            term_visible: 1,
            netsurf_visible: 1,
            path_buf: [0; PATH_CAP],
            name_buf: [0; NAME_CAP],
        }
    }
}

static mut STATE: Option<State> = None;

fn state() -> &'static mut State {
    unsafe {
        if STATE.is_none() {
            STATE = Some(State::new());
        }
        STATE.as_mut().unwrap_unchecked()
    }
}

fn decode_wallpaper(width: u32, height: u32) -> Vec<u8> {
    let image = image::load(Cursor::new(WALLPAPER_PNG), image::ImageFormat::Png).unwrap_or_else(|_| {
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([18, 42, 58, 255]),
        ))
    });
    image
        .resize_exact(width, height, FilterType::Triangle)
        .into_rgba8()
        .into_raw()
}

fn dock_geometry(screen_width: i32, screen_height: i32) -> Rect {
    let width = (DOCK_BUTTONS * DOCK_STRIDE - (DOCK_STRIDE - DOCK_ICON_SIZE)).max(DOCK_ICON_SIZE);
    let width = width.min(screen_width);
    let x = (screen_width.saturating_sub(width)) / 2;
    let y = screen_height.saturating_sub(DOCK_HEIGHT + DOCK_BOTTOM_MARGIN);
    Rect {
        x,
        y,
        width,
        height: DOCK_HEIGHT,
    }
}

/// Layout: NetSurf (browser) left/primary, Files top-right, Aurora Terminal bottom-right.
/// All three auto-start with the WM session.
fn place_client(index: usize, screen_w: i32, _screen_h: i32, dock: Rect) -> Client {
    let content_top = TOPBAR_HEIGHT + 26;
    let content_bottom = dock.y - 16;
    let content_h = (content_bottom - content_top).max(240);
    let browser_w = ((screen_w * 58) / 100).clamp(440, 580);
    let side_x = 24 + browser_w + 14;
    let side_w = (screen_w - side_x - 24).max(240);

    let (frame_x, frame_y, frame_w, frame_h) = match index {
        NETSURF_INDEX => (24, content_top, browser_w, content_h),
        FILES_INDEX => {
            let h = ((content_h * 55) / 100).max(180);
            (side_x, content_top, side_w, h)
        }
        TERM_INDEX => {
            let h = ((content_h * 40) / 100).max(150);
            let y = content_top + content_h - h;
            (side_x, y, side_w, h)
        }
        _ => (side_x, content_top, side_w, content_h / 2),
    };

    let frame = Rect {
        x: frame_x,
        y: frame_y,
        width: frame_w.max(180),
        height: frame_h.max(140),
    };
    let content = Rect {
        x: frame.x,
        y: frame.y + TITLEBAR_HEIGHT,
        width: frame.width,
        height: (frame.height - TITLEBAR_HEIGHT).max(1),
    };
    Client {
        frame,
        content,
        mapped: 1,
    }
}

fn layout_clients(state: &mut State) {
    let w = state.width as i32;
    let h = state.height as i32;
    state.dock = dock_geometry(w, h);
    for index in 0..WINDOW_COUNT {
        state.clients[index] = place_client(index, w, h, state.dock);
    }
    state.layout_version = state.layout_version.wrapping_add(1);
}

fn put_pixel(frame: &mut [u8], width: u32, x: i32, y: i32, color: [u8; 4]) {
    if x < 0 || y < 0 {
        return;
    }
    let x = x as u32;
    let y = y as u32;
    let height = (frame.len() / 4) as u32 / width.max(1);
    if x >= width || y >= height {
        return;
    }
    let index = ((y * width + x) * 4) as usize;
    if index + 3 >= frame.len() {
        return;
    }
    let src_a = color[3] as u32;
    if src_a >= 250 {
        frame[index..index + 4].copy_from_slice(&color);
        return;
    }
    if src_a == 0 {
        return;
    }
    let inv = 255 - src_a;
    frame[index] = ((color[0] as u32 * src_a + frame[index] as u32 * inv) / 255) as u8;
    frame[index + 1] = ((color[1] as u32 * src_a + frame[index + 1] as u32 * inv) / 255) as u8;
    frame[index + 2] = ((color[2] as u32 * src_a + frame[index + 2] as u32 * inv) / 255) as u8;
    frame[index + 3] = 255;
}

fn fill_rect(frame: &mut [u8], width: u32, rect: Rect, color: [u8; 4]) {
    if rect.width <= 0 || rect.height <= 0 {
        return;
    }
    for y in rect.y..rect.y + rect.height {
        for x in rect.x..rect.x + rect.width {
            put_pixel(frame, width, x, y, color);
        }
    }
}

fn fill_round_rect(frame: &mut [u8], width: u32, rect: Rect, radius: i32, color: [u8; 4]) {
    let r = radius.max(0).min(rect.width.min(rect.height) / 2);
    for y in 0..rect.height {
        for x in 0..rect.width {
            let px = x;
            let py = y;
            let in_corner = |cx: i32, cy: i32| {
                let dx = px - cx;
                let dy = py - cy;
                dx * dx + dy * dy <= r * r
            };
            let ok = if px < r && py < r {
                in_corner(r, r)
            } else if px >= rect.width - r && py < r {
                in_corner(rect.width - r - 1, r)
            } else if px < r && py >= rect.height - r {
                in_corner(r, rect.height - r - 1)
            } else if px >= rect.width - r && py >= rect.height - r {
                in_corner(rect.width - r - 1, rect.height - r - 1)
            } else {
                true
            };
            if ok {
                put_pixel(frame, width, rect.x + px, rect.y + py, color);
            }
        }
    }
}

fn fill_circle(frame: &mut [u8], width: u32, cx: i32, cy: i32, radius: i32, color: [u8; 4]) {
    for y in -radius..=radius {
        for x in -radius..=radius {
            if x * x + y * y <= radius * radius {
                put_pixel(frame, width, cx + x, cy + y, color);
            }
        }
    }
}

fn draw_text(
    frame: &mut [u8],
    width: u32,
    font: &Font<'static>,
    text: &str,
    x: i32,
    y: i32,
    size: f32,
    color: [u8; 4],
) {
    let scale = Scale::uniform(size);
    let metrics = font.v_metrics(scale);
    let glyphs: Vec<_> = font
        .layout(text, scale, point(x as f32, y as f32 + metrics.ascent))
        .collect();
    for glyph in glyphs {
        if let Some(bb) = glyph.pixel_bounding_box() {
            glyph.draw(|gx, gy, v| {
                let alpha = (v * f32::from(color[3])).round().clamp(0.0, 255.0) as u8;
                if alpha == 0 {
                    return;
                }
                put_pixel(
                    frame,
                    width,
                    bb.min.x + gx as i32,
                    bb.min.y + gy as i32,
                    [color[0], color[1], color[2], alpha],
                );
            });
        }
    }
}

fn measure_text(font: &Font<'static>, text: &str, size: f32) -> i32 {
    let scale = Scale::uniform(size);
    let mut width = 0.0f32;
    for glyph in font.layout(text, scale, point(0.0, 0.0)) {
        let advance = glyph.position().x + glyph.unpositioned().h_metrics().advance_width;
        width = width.max(advance);
    }
    width.ceil() as i32
}

fn draw_text_right(
    frame: &mut [u8],
    width: u32,
    font: &Font<'static>,
    text: &str,
    right: i32,
    y: i32,
    size: f32,
    color: [u8; 4],
) {
    let w = measure_text(font, text, size);
    draw_text(frame, width, font, text, right - w, y, size, color);
}

fn kind_label(kind: u32) -> &'static str {
    match kind {
        0 => "Folder",
        2 => "Text",
        3 => "Config",
        _ => "File",
    }
}

fn draw_file_icon(frame: &mut [u8], width: u32, kind: u32, cx: i32, cy: i32) {
    match kind {
        0 => {
            fill_round_rect(
                frame,
                width,
                Rect {
                    x: cx - 10,
                    y: cy - 7,
                    width: 20,
                    height: 14,
                },
                3,
                [246, 190, 82, 240],
            );
            fill_rect(
                frame,
                width,
                Rect {
                    x: cx - 10,
                    y: cy - 10,
                    width: 9,
                    height: 5,
                },
                [246, 190, 82, 240],
            );
        }
        _ => {
            fill_round_rect(
                frame,
                width,
                Rect {
                    x: cx - 8,
                    y: cy - 10,
                    width: 16,
                    height: 20,
                },
                3,
                [255, 255, 255, 220],
            );
            fill_rect(
                frame,
                width,
                Rect {
                    x: cx - 5,
                    y: cy - 5,
                    width: 10,
                    height: 2,
                },
                [90, 130, 150, 200],
            );
            fill_rect(
                frame,
                width,
                Rect {
                    x: cx - 5,
                    y: cy,
                    width: 10,
                    height: 2,
                },
                [90, 130, 150, 200],
            );
            fill_rect(
                frame,
                width,
                Rect {
                    x: cx - 5,
                    y: cy + 5,
                    width: 7,
                    height: 2,
                },
                [90, 130, 150, 180],
            );
        }
    }
}

/// Port of upstream `redraw_folder` chrome for the Aurora Files client window.
fn draw_files_app(
    frame: &mut [u8],
    width: u32,
    fonts: &Fonts,
    content: Rect,
    path: &str,
    entries: &[FileEntry],
    selected: i32,
) {
    fill_round_rect(frame, width, content, 14, [247, 252, 255, 230]);
    fill_round_rect(frame, width, content, 14, [214, 229, 237, 40]);

    // Header toolbar buttons (home / terminal / sort / more) like upstream.
    for (i, x) in [content.x + 18, content.x + 56, content.x + 94].into_iter().enumerate() {
        fill_round_rect(
            frame,
            width,
            Rect {
                x,
                y: content.y + 14,
                width: 30,
                height: 30,
            },
            10,
            [255, 255, 255, 170],
        );
        let label = match i {
            0 => "H",
            1 => "T",
            _ => "S",
        };
        draw_text(
            frame,
            width,
            &fonts.bold,
            label,
            x + 9,
            content.y + 20,
            12.0,
            [40, 110, 100, 255],
        );
    }
    fill_round_rect(
        frame,
        width,
        Rect {
            x: content.x + content.width - 50,
            y: content.y + 14,
            width: 30,
            height: 30,
        },
        10,
        [255, 255, 255, 170],
    );
    draw_text(
        frame,
        width,
        &fonts.bold,
        "...",
        content.x + content.width - 42,
        content.y + 18,
        14.0,
        [40, 110, 100, 255],
    );

    draw_text(
        frame,
        width,
        &fonts.bold,
        path,
        content.x + 18,
        content.y + 50,
        14.0,
        [40, 110, 100, 255],
    );
    fill_rect(
        frame,
        width,
        Rect {
            x: content.x + 18,
            y: content.y + 72,
            width: content.width - 36,
            height: 1,
        },
        [178, 202, 214, 140],
    );

    // Places sidebar
    let sidebar = Rect {
        x: content.x + 12,
        y: content.y + 84,
        width: 110,
        height: content.height - 96,
    };
    fill_round_rect(frame, width, sidebar, 10, [255, 255, 255, 140]);
    draw_text(
        frame,
        width,
        &fonts.bold,
        "Places",
        sidebar.x + 12,
        sidebar.y + 10,
        12.0,
        [60, 90, 110, 255],
    );
    for (i, place) in PLACES.iter().enumerate() {
        let y = sidebar.y + 34 + i as i32 * 28;
        let active = *place == "Workspace";
        if active {
            fill_round_rect(
                frame,
                width,
                Rect {
                    x: sidebar.x + 8,
                    y: y - 4,
                    width: sidebar.width - 16,
                    height: 24,
                },
                8,
                [116, 213, 198, 130],
            );
        }
        draw_text(
            frame,
            width,
            &fonts.regular,
            place,
            sidebar.x + 16,
            y,
            12.0,
            [40, 70, 90, 255],
        );
    }

    let list_x = content.x + 132;
    let list_w = content.width - 148;
    if entries.is_empty() {
        draw_text(
            frame,
            width,
            &fonts.regular,
            "No files in this folder.",
            list_x,
            content.y + 110,
            13.0,
            [120, 140, 155, 255],
        );
        return;
    }

    let row_h = 42;
    let max_rows = ((content.height - 96) / row_h).max(1) as usize;
    for (idx, entry) in entries.iter().take(max_rows).enumerate() {
        let row_y = content.y + 90 + idx as i32 * row_h;
        let is_selected = selected == idx as i32;
        fill_round_rect(
            frame,
            width,
            Rect {
                x: list_x,
                y: row_y - 4,
                width: list_w,
                height: 34,
            },
            9,
            if is_selected {
                [116, 213, 198, 140]
            } else {
                [255, 255, 255, 140]
            },
        );
        draw_file_icon(frame, width, entry.kind, list_x + 18, row_y + 13);
        draw_text(
            frame,
            width,
            &fonts.bold,
            &entry.name,
            list_x + 40,
            row_y,
            13.0,
            [30, 50, 65, 255],
        );
        draw_text(
            frame,
            width,
            &fonts.regular,
            kind_label(entry.kind),
            list_x + 40,
            row_y + 16,
            10.0,
            [90, 120, 135, 230],
        );
    }

    let status = format!("{} items · Aurora Files", entries.len());
    draw_text(
        frame,
        width,
        &fonts.regular,
        &status,
        list_x,
        content.y + content.height - 22,
        11.0,
        [80, 110, 125, 230],
    );
}

fn draw_titlebar(
    frame: &mut [u8],
    width: u32,
    fonts: &Fonts,
    index: usize,
    client: Client,
    active: bool,
) {
    let title = Rect {
        x: client.frame.x,
        y: client.frame.y,
        width: client.frame.width,
        height: TITLEBAR_HEIGHT,
    };
    let color = if active {
        [221, 238, 252, 232]
    } else {
        [250, 254, 255, 225]
    };
    fill_round_rect(
        frame,
        width,
        Rect {
            x: title.x,
            y: title.y,
            width: title.width,
            height: title.height + FRAME_CORNER_RADIUS,
        },
        FRAME_CORNER_RADIUS,
        color,
    );
    fill_rect(
        frame,
        width,
        Rect {
            x: title.x,
            y: title.y + TITLEBAR_HEIGHT - FRAME_CORNER_RADIUS,
            width: title.width,
            height: FRAME_CORNER_RADIUS,
        },
        color,
    );
    fill_circle(frame, width, title.x + 19, title.y + 17, 8, [241, 96, 105, 235]);
    fill_circle(frame, width, title.x + 42, title.y + 17, 8, [246, 190, 82, 235]);
    fill_circle(frame, width, title.x + 65, title.y + 17, 8, [76, 197, 178, 235]);
    draw_text(
        frame,
        width,
        &fonts.bold,
        WINDOW_TITLES[index],
        title.x + 86,
        title.y + 8,
        15.0,
        if active {
            [40, 70, 95, 255]
        } else {
            [70, 95, 115, 230]
        },
    );
}

fn draw_terminal_body(
    frame: &mut [u8],
    width: u32,
    fonts: &Fonts,
    content: Rect,
    active: bool,
    lines: &[String],
) {
    // Aurora Files-style terminal chrome (tab + light body), fed by host shell lines.
    fill_rect(frame, width, content, [247, 252, 255, 245]);
    fill_rect(
        frame,
        width,
        Rect {
            x: content.x,
            y: content.y,
            width: content.width,
            height: 28,
        },
        [230, 238, 245, 255],
    );
    fill_round_rect(
        frame,
        width,
        Rect {
            x: content.x + 8,
            y: content.y + 4,
            width: 92,
            height: 22,
        },
        8,
        if active {
            [255, 255, 255, 255]
        } else {
            [245, 248, 252, 255]
        },
    );
    draw_text(
        frame,
        width,
        &fonts.bold,
        "shell",
        content.x + 20,
        content.y + 8,
        12.0,
        [40, 80, 95, 255],
    );
    let body_top = content.y + 30;
    fill_rect(
        frame,
        width,
        Rect {
            x: content.x,
            y: body_top,
            width: content.width,
            height: content.height - 30,
        },
        [24, 36, 42, 255],
    );
    let fallback = [
        "Aurora Terminal".to_string(),
        "compiled from ecooxai/aurora-wm".to_string(),
        "PTY bridge: agentOS browser shell".to_string(),
        "$ ls /workspace".to_string(),
        "README.md  hello.txt  config.json".to_string(),
        "$".to_string(),
    ];
    let rows: &[String] = if lines.is_empty() { &fallback } else { lines };
    let mut y = body_top + 10;
    for line in rows {
        if y + 16 > content.y + content.height - 4 {
            break;
        }
        draw_text(
            frame,
            width,
            &fonts.mono,
            line,
            content.x + 12,
            y,
            12.0,
            [115, 222, 210, 255],
        );
        y += 16;
    }
}

fn draw_netsurf_placeholder(frame: &mut [u8], width: u32, fonts: &Fonts, content: Rect) {
    // Content is overwritten by netsurf-web.wasm framebuffer in the browser host.
    fill_rect(frame, width, content, [248, 250, 252, 255]);
    draw_text(
        frame,
        width,
        &fonts.bold,
        "NetSurf",
        content.x + 18,
        content.y + 18,
        18.0,
        [20, 80, 140, 255],
    );
    draw_text(
        frame,
        width,
        &fonts.regular,
        "Loading netsurf-web.wasm framebuffer…",
        content.x + 18,
        content.y + 46,
        13.0,
        [60, 90, 120, 255],
    );
    draw_text(
        frame,
        width,
        &fonts.regular,
        "github.com/netsurf-browser/netsurf",
        content.x + 18,
        content.y + 68,
        12.0,
        [90, 120, 150, 255],
    );
}

fn draw_topbar(frame: &mut [u8], width: u32, fonts: &Fonts, tick: u32) {
    fill_rect(
        frame,
        width,
        Rect {
            x: 0,
            y: 0,
            width: width as i32,
            height: TOPBAR_HEIGHT,
        },
        [250, 254, 255, 210],
    );
    fill_rect(
        frame,
        width,
        Rect {
            x: 0,
            y: TOPBAR_HEIGHT - 1,
            width: width as i32,
            height: 1,
        },
        [180, 200, 215, 180],
    );
    fill_circle(frame, width, 22, 20, 7, [76, 197, 178, 255]);
    draw_text(
        frame,
        width,
        &fonts.bold,
        "Aurora",
        38,
        10,
        16.0,
        [45, 75, 95, 255],
    );
    let pulse = ((tick / 400) % 2) as i32;
    fill_circle(
        frame,
        width,
        width as i32 - 18,
        20,
        5,
        if pulse == 0 {
            [76, 197, 178, 255]
        } else {
            [182, 243, 107, 255]
        },
    );
    draw_text_right(
        frame,
        width,
        &fonts.regular,
        "DISPLAY :0  ·  TERM+NETSURF+FILES",
        width as i32 - 32,
        11,
        13.0,
        [60, 90, 110, 240],
    );
}

fn draw_dock(frame: &mut [u8], width: u32, fonts: &Fonts, dock: Rect, active: u32) {
    fill_round_rect(frame, width, dock, 16, [250, 254, 255, 200]);
    let cy = dock.y + dock.height / 2;
    for i in 0..DOCK_BUTTONS {
        let ix = dock.x + i * DOCK_STRIDE;
        let iy = cy - DOCK_ICON_SIZE / 2;
        let focused = (i == 0 && active == TERM_INDEX as u32)
            || (i == 1 && active == FILES_INDEX as u32)
            || (i == 2 && active == NETSURF_INDEX as u32);
        let color = match i {
            0 => [76, 197, 178, 235],
            1 => [115, 170, 220, 235],
            2 => [246, 190, 82, 235],
            3 => [182, 243, 107, 235],
            _ => [180, 160, 210, 235],
        };
        fill_round_rect(
            frame,
            width,
            Rect {
                x: ix,
                y: iy,
                width: DOCK_ICON_SIZE,
                height: DOCK_ICON_SIZE,
            },
            DOCK_ICON_RADIUS,
            color,
        );
        if focused {
            fill_rect(
                frame,
                width,
                Rect {
                    x: ix + 12,
                    y: iy + DOCK_ICON_SIZE + 2,
                    width: 20,
                    height: 3,
                },
                [40, 70, 90, 220],
            );
        }
        let label = DOCK_LABELS[i as usize];
        let tw = measure_text(&fonts.bold, label, 10.0);
        draw_text(
            frame,
            width,
            &fonts.bold,
            label,
            ix + (DOCK_ICON_SIZE - tw) / 2,
            iy + 14,
            10.0,
            [20, 35, 45, 255],
        );
    }
}

fn render(state: &mut State) {
    let width = state.width;
    let bytes = (width as usize) * (state.height as usize) * 4;
    if state.frame.len() != bytes {
        state.frame.resize(bytes, 0);
    }
    if state.wallpaper.len() == bytes {
        state.frame.copy_from_slice(&state.wallpaper);
    } else {
        state.frame.fill(0);
    }

    let fonts = Fonts {
        regular: state.fonts.regular.clone(),
        bold: state.fonts.bold.clone(),
        mono: state.fonts.mono.clone(),
    };
    let clients = state.clients;
    let active = state.active;
    let dock = state.dock;
    let tick = state.tick;
    let path = state.files_path.clone();
    let entries = state.files.clone();
    let selected = state.files_selected;
    let files_visible = state.files_visible;
    let term_visible = state.term_visible;
    let netsurf_visible = state.netsurf_visible;
    let term_lines = state.term_lines.clone();
    let frame = &mut state.frame;

    draw_topbar(frame, width, &fonts, tick);
    for (index, client) in clients.iter().copied().enumerate() {
        if client.mapped == 0 {
            continue;
        }
        if index == FILES_INDEX && files_visible == 0 {
            continue;
        }
        if index == TERM_INDEX && term_visible == 0 {
            continue;
        }
        if index == NETSURF_INDEX && netsurf_visible == 0 {
            continue;
        }
        let is_active = index as u32 == active;
        fill_rect(
            frame,
            width,
            Rect {
                x: client.frame.x + 6,
                y: client.frame.y + 8,
                width: client.frame.width,
                height: client.frame.height,
            },
            [0, 0, 0, 55],
        );
        draw_titlebar(frame, width, &fonts, index, client, is_active);
        match index {
            FILES_INDEX => draw_files_app(
                frame,
                width,
                &fonts,
                client.content,
                &path,
                &entries,
                selected,
            ),
            TERM_INDEX => draw_terminal_body(
                frame,
                width,
                &fonts,
                client.content,
                is_active,
                &term_lines,
            ),
            NETSURF_INDEX => draw_netsurf_placeholder(frame, width, &fonts, client.content),
            _ => {}
        }
    }
    draw_dock(frame, width, &fonts, dock, active);
}

fn default_files() -> Vec<FileEntry> {
    vec![
        FileEntry {
            name: "README.md".into(),
            kind: 2,
        },
        FileEntry {
            name: "hello.txt".into(),
            kind: 2,
        },
        FileEntry {
            name: "data.txt".into(),
            kind: 2,
        },
        FileEntry {
            name: "config.json".into(),
            kind: 3,
        },
    ]
}

#[no_mangle]
pub extern "C" fn aurora_init(width: u32, height: u32) -> u32 {
    let state = state();
    state.width = width.clamp(320, 1600);
    state.height = height.clamp(180, 1000);
    state.active = NETSURF_INDEX as u32;
    state.tick = 0;
    state.running = 1;
    state.files_visible = 1;
    state.term_visible = 1;
    state.netsurf_visible = 1;
    state.files_selected = 0;
    if state.files.is_empty() {
        state.files = default_files();
    }
    state.wallpaper = decode_wallpaper(state.width, state.height);
    state.frame = state.wallpaper.clone();
    layout_clients(state);
    render(state);
    1
}

#[no_mangle]
pub extern "C" fn aurora_tick(now_ms: u32) {
    state().tick = now_ms;
}

#[no_mangle]
pub extern "C" fn aurora_render(now_ms: u32) -> u32 {
    let state = state();
    state.tick = now_ms;
    render(state);
    1
}

#[no_mangle]
pub extern "C" fn aurora_frame_ptr() -> u32 {
    state().frame.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_frame_len() -> u32 {
    state().frame.len() as u32
}

#[no_mangle]
pub extern "C" fn aurora_wallpaper_ptr() -> u32 {
    state().wallpaper.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_wallpaper_len() -> u32 {
    state().wallpaper.len() as u32
}

#[no_mangle]
pub extern "C" fn aurora_window_count() -> u32 {
    WINDOW_COUNT as u32
}

#[no_mangle]
pub extern "C" fn aurora_window_x(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.frame.x)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_window_y(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.frame.y)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_window_width(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.frame.width)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_window_height(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.frame.height)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_content_x(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.content.x)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_content_y(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.content.y)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_content_width(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.content.width)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_content_height(index: u32) -> i32 {
    state()
        .clients
        .get(index as usize)
        .map(|c| c.content.height)
        .unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn aurora_window_active(index: u32) -> u32 {
    (index == state().active) as u32
}

#[no_mangle]
pub extern "C" fn aurora_active_window() -> u32 {
    state().active
}

#[no_mangle]
pub extern "C" fn aurora_layout_version() -> u32 {
    state().layout_version
}

#[no_mangle]
pub extern "C" fn aurora_tick_value() -> u32 {
    state().tick
}

#[no_mangle]
pub extern "C" fn aurora_topbar_height() -> i32 {
    TOPBAR_HEIGHT
}

#[no_mangle]
pub extern "C" fn aurora_titlebar_height() -> i32 {
    TITLEBAR_HEIGHT
}

#[no_mangle]
pub extern "C" fn aurora_dock_x() -> i32 {
    state().dock.x
}

#[no_mangle]
pub extern "C" fn aurora_dock_y() -> i32 {
    state().dock.y
}

#[no_mangle]
pub extern "C" fn aurora_dock_width() -> i32 {
    state().dock.width
}

#[no_mangle]
pub extern "C" fn aurora_dock_height() -> i32 {
    state().dock.height
}

#[no_mangle]
pub extern "C" fn aurora_is_running() -> u32 {
    state().running
}

#[no_mangle]
pub extern "C" fn aurora_files_visible() -> u32 {
    state().files_visible
}

#[no_mangle]
pub extern "C" fn aurora_files_show(show: u32) -> u32 {
    let state = state();
    state.files_visible = if show == 0 { 0 } else { 1 };
    if state.files_visible == 1 {
        state.active = FILES_INDEX as u32;
        state.clients[FILES_INDEX].mapped = 1;
    }
    state.layout_version = state.layout_version.wrapping_add(1);
    1
}

#[no_mangle]
pub extern "C" fn aurora_files_clear() {
    let state = state();
    state.files.clear();
    state.files_selected = -1;
}

#[no_mangle]
pub extern "C" fn aurora_files_path_buf() -> u32 {
    state().path_buf.as_mut_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_files_path_cap() -> u32 {
    PATH_CAP as u32
}

#[no_mangle]
pub extern "C" fn aurora_files_set_path(len: u32) -> u32 {
    let state = state();
    let n = (len as usize).min(PATH_CAP);
    state.files_path = String::from_utf8_lossy(&state.path_buf[..n]).to_string();
    1
}

#[no_mangle]
pub extern "C" fn aurora_files_name_buf() -> u32 {
    state().name_buf.as_mut_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_files_name_cap() -> u32 {
    NAME_CAP as u32
}

#[no_mangle]
pub extern "C" fn aurora_files_add(len: u32, kind: u32) -> u32 {
    let state = state();
    if state.files.len() >= MAX_FILES {
        return 0;
    }
    let n = (len as usize).min(NAME_CAP);
    let name = String::from_utf8_lossy(&state.name_buf[..n]).to_string();
    if name.is_empty() {
        return 0;
    }
    state.files.push(FileEntry {
        name,
        kind: kind.min(3),
    });
    if state.files_selected < 0 {
        state.files_selected = 0;
    }
    1
}

#[no_mangle]
pub extern "C" fn aurora_files_count() -> u32 {
    state().files.len() as u32
}

#[no_mangle]
pub extern "C" fn aurora_term_show(show: u32) -> u32 {
    let state = state();
    state.term_visible = if show == 0 { 0 } else { 1 };
    if state.term_visible == 1 {
        state.active = TERM_INDEX as u32;
        state.clients[TERM_INDEX].mapped = 1;
    }
    1
}

#[no_mangle]
pub extern "C" fn aurora_term_visible() -> u32 {
    state().term_visible
}

#[no_mangle]
pub extern "C" fn aurora_term_clear() {
    state().term_lines.clear();
}

#[no_mangle]
pub extern "C" fn aurora_term_line_buf() -> u32 {
    state().name_buf.as_mut_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_term_line_cap() -> u32 {
    NAME_CAP as u32
}

#[no_mangle]
pub extern "C" fn aurora_term_add_line(len: u32) -> u32 {
    let state = state();
    if state.term_lines.len() >= 40 {
        state.term_lines.remove(0);
    }
    let n = (len as usize).min(NAME_CAP);
    let line = String::from_utf8_lossy(&state.name_buf[..n]).to_string();
    state.term_lines.push(line);
    state.term_visible = 1;
    1
}

#[no_mangle]
pub extern "C" fn aurora_netsurf_show(show: u32) -> u32 {
    let state = state();
    state.netsurf_visible = if show == 0 { 0 } else { 1 };
    if state.netsurf_visible == 1 {
        state.active = NETSURF_INDEX as u32;
        state.clients[NETSURF_INDEX].mapped = 1;
    }
    1
}

#[no_mangle]
pub extern "C" fn aurora_netsurf_visible() -> u32 {
    state().netsurf_visible
}

#[no_mangle]
pub extern "C" fn aurora_netsurf_index() -> u32 {
    NETSURF_INDEX as u32
}

#[no_mangle]
pub extern "C" fn aurora_term_index() -> u32 {
    TERM_INDEX as u32
}

#[no_mangle]
pub extern "C" fn aurora_map_request(index: u32, _req_w: i32, _req_h: i32) -> u32 {
    let state = state();
    if index as usize >= WINDOW_COUNT {
        return 0;
    }
    let client = place_client(index as usize, state.width as i32, state.height as i32, state.dock);
    state.clients[index as usize] = client;
    state.active = index;
    if index as usize == FILES_INDEX {
        state.files_visible = 1;
    }
    state.layout_version = state.layout_version.wrapping_add(1);
    state.running = 1;
    1
}

#[no_mangle]
pub extern "C" fn aurora_pointer_down(x: i32, y: i32) -> u32 {
    let state = state();
    // Dock launchers: Term -> terminal, Files -> Aurora Files (like real WM).
    let dock = state.dock;
    if dock.contains(x, y) {
        let local = x - dock.x;
        let button = local / DOCK_STRIDE;
        match button {
            0 => {
                state.term_visible = 1;
                state.active = TERM_INDEX as u32;
                state.clients[TERM_INDEX].mapped = 1;
            }
            1 => {
                state.files_visible = 1;
                state.active = FILES_INDEX as u32;
                state.clients[FILES_INDEX].mapped = 1;
            }
            2 => {
                state.netsurf_visible = 1;
                state.active = NETSURF_INDEX as u32;
                state.clients[NETSURF_INDEX].mapped = 1;
            }
            _ => {}
        }
        state.layout_version = state.layout_version.wrapping_add(1);
        return state.active + 1;
    }

    for (index, client) in state.clients.iter().enumerate().rev() {
        if client.mapped == 1 && client.frame.contains(x, y) {
            if index == FILES_INDEX && state.files_visible == 0 {
                continue;
            }
            state.active = index as u32;
            if index == FILES_INDEX {
                // Select file row if click is in the list area.
                let content = client.content;
                let list_x = content.x + 132;
                let list_top = content.y + 90;
                if x >= list_x && y >= list_top {
                    let row = (y - list_top) / 42;
                    if row >= 0 && (row as usize) < state.files.len() {
                        state.files_selected = row;
                    }
                }
            }
            return state.active + 1;
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn aurora_handle_key(key: u32) -> u32 {
    let state = state();
    match key {
        9 => state.active = (state.active + 1) % WINDOW_COUNT as u32,
        49..=51 => state.active = key - 49,
        _ => {}
    }
    state.active
}

#[no_mangle]
pub extern "C" fn aurora_window_title_ptr(index: u32) -> u32 {
    WINDOW_TITLES
        .get(index as usize)
        .unwrap_or(&WINDOW_TITLES[0])
        .as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_window_title_len(index: u32) -> u32 {
    WINDOW_TITLES
        .get(index as usize)
        .unwrap_or(&WINDOW_TITLES[0])
        .len() as u32
}

#[no_mangle]
pub extern "C" fn aurora_status_ptr() -> u32 {
    if state().running == 1 {
        STATUS_RUNNING.as_ptr() as u32
    } else {
        STATUS_IDLE.as_ptr() as u32
    }
}

#[no_mangle]
pub extern "C" fn aurora_status_len() -> u32 {
    if state().running == 1 {
        STATUS_RUNNING.len() as u32
    } else {
        STATUS_IDLE.len() as u32
    }
}

#[no_mangle]
pub extern "C" fn aurora_source_ptr() -> u32 {
    SOURCE_URL.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_source_len() -> u32 {
    SOURCE_URL.len() as u32
}
