//! Browser WASM port of [ecooxai/aurora-wm](https://github.com/ecooxai/aurora-wm).
//!
//! Upstream Aurora is a native Linux X11 WM (`x11rb` + Unix sockets). This crate
//! keeps the real WM shape that matters in a browser tab:
//! - SubstructureRedirect / MapRequest client management geometry
//! - framed clients with Aurora titlebars
//! - topbar + dock layout from upstream constants
//! - wallpaper from the vendored Aurora assets
//!
//! The in-tab JS X11 protocol server still owns the wire protocol; this module
//! is the actual window manager decision + chrome engine compiled to WASM.

use image::imageops::FilterType;
use std::io::Cursor;

/// Constants mirrored from upstream `ecooxai/aurora-wm` `src/main.rs`.
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

const WALLPAPER_PNG: &[u8] =
    include_bytes!("../../vendor/aurora-wm/wallpaper/f7d4b278-3aef-4a94-b84e-f14acde427ac.png");

static TERMINAL_TITLE: &[u8] = b"terminal";
static LOG_TITLE: &[u8] = b"agent log";
static FILES_TITLE: &[u8] = b"files";
static STATUS_RUNNING: &[u8] = b"running - aurora-wm wasm - SubstructureRedirect";
static STATUS_IDLE: &[u8] = b"idle";
static SOURCE_URL: &[u8] = b"https://github.com/ecooxai/aurora-wm";

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
}

impl State {
    fn new() -> Self {
        Self {
            width: 960,
            height: 540,
            wallpaper: Vec::new(),
            frame: Vec::new(),
            clients: [Client::empty(); WINDOW_COUNT],
            active: 0,
            tick: 0,
            layout_version: 0,
            running: 0,
            dock: Rect::empty(),
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
    let rgba = image
        .resize_exact(width, height, FilterType::Triangle)
        .into_rgba8();
    rgba.into_raw()
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

/// Port of upstream manage_window geometry placement for the browser demo clients.
fn place_client(index: usize, screen_w: i32, screen_h: i32, dock: Rect) -> Client {
    let max_w = (screen_w - 80).max(280);
    let max_h = (screen_h - TOPBAR_HEIGHT - DOCK_HEIGHT - TITLEBAR_HEIGHT - 62).max(180);
    let margin = 24;
    let gap = 14;
    let side_w = ((screen_w * 34) / 100).clamp(240, 340).min(max_w);
    let left_w = (screen_w - margin * 2 - gap - side_w).clamp(280, max_w);
    let content_top = TOPBAR_HEIGHT + 18;
    let content_bottom = dock.y - 16;
    let content_h = (content_bottom - content_top).max(200).min(max_h + TITLEBAR_HEIGHT);

    let (frame_x, frame_y, frame_w, frame_h) = match index {
        0 => {
            let h = ((content_h * 70) / 100).max(200);
            (margin, content_top, left_w, h.min(content_h))
        }
        1 => (margin + left_w + gap, content_top, side_w, (content_h - gap) / 2),
        _ => (
            margin + left_w + gap,
            content_top + (content_h + gap) / 2,
            side_w,
            (content_h - gap) / 2,
        ),
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
    if x >= width {
        return;
    }
    let height = (frame.len() / 4) as u32 / width.max(1);
    if y >= height {
        return;
    }
    let index = ((y * width + x) * 4) as usize;
    if index + 3 < frame.len() {
        // Alpha blend over existing wallpaper/chrome.
        let src_a = color[3] as u32;
        if src_a >= 250 {
            frame[index..index + 4].copy_from_slice(&color);
            return;
        }
        let dst_r = frame[index] as u32;
        let dst_g = frame[index + 1] as u32;
        let dst_b = frame[index + 2] as u32;
        let inv = 255 - src_a;
        frame[index] = ((color[0] as u32 * src_a + dst_r * inv) / 255) as u8;
        frame[index + 1] = ((color[1] as u32 * src_a + dst_g * inv) / 255) as u8;
        frame[index + 2] = ((color[2] as u32 * src_a + dst_b * inv) / 255) as u8;
        frame[index + 3] = 255;
    }
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

fn draw_titlebar(frame: &mut [u8], width: u32, client: Client, active: bool) {
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
    fill_circle(
        frame,
        width,
        title.x + 19,
        title.y + 17,
        8,
        [241, 96, 105, 235],
    );
    fill_circle(
        frame,
        width,
        title.x + 42,
        title.y + 17,
        8,
        [246, 190, 82, 235],
    );
    fill_circle(
        frame,
        width,
        title.x + 65,
        title.y + 17,
        8,
        [76, 197, 178, 235],
    );
    // Title glyph strip (text is also mirrored by the DOM / X11 ImageText path).
    let bar = if active {
        [90, 120, 150, 200]
    } else {
        [140, 160, 175, 180]
    };
    fill_rect(
        frame,
        width,
        Rect {
            x: title.x + 86,
            y: title.y + 15,
            width: (title.width - 110).clamp(40, 180),
            height: 4,
        },
        bar,
    );
}

fn draw_client_body(frame: &mut [u8], width: u32, index: usize, client: Client, active: bool) {
    let body = if active {
        [31, 51, 57, 245]
    } else {
        [24, 36, 42, 235]
    };
    fill_rect(frame, width, client.content, body);
    let accent = match index {
        0 => [115, 222, 210, 220],
        1 => [142, 186, 196, 210],
        _ => [182, 243, 107, 210],
    };
    let mut y = client.content.y + 18;
    for row in 0..5 {
        let line_w = (client.content.width - 40 - row * 18).max(36);
        fill_rect(
            frame,
            width,
            Rect {
                x: client.content.x + 18,
                y,
                width: line_w,
                height: 5,
            },
            accent,
        );
        y += 22;
    }
}

fn draw_topbar(frame: &mut [u8], width: u32, height: i32, tick: u32) {
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
    fill_rect(
        frame,
        width,
        Rect {
            x: 38,
            y: 14,
            width: 96,
            height: 4,
        },
        [70, 100, 120, 210],
    );
    fill_rect(
        frame,
        width,
        Rect {
            x: 38,
            y: 22,
            width: 64,
            height: 3,
        },
        [120, 150, 170, 180],
    );
    let pulse = ((tick / 400) % 2) as i32;
    fill_circle(
        frame,
        width,
        width as i32 - 28,
        20,
        5,
        if pulse == 0 {
            [76, 197, 178, 255]
        } else {
            [182, 243, 107, 255]
        },
    );
    let _ = height;
}

fn draw_dock(frame: &mut [u8], width: u32, dock: Rect) {
    fill_round_rect(frame, width, dock, 16, [250, 254, 255, 200]);
    let cy = dock.y + dock.height / 2;
    for i in 0..DOCK_BUTTONS {
        let ix = dock.x + i * DOCK_STRIDE;
        let iy = cy - DOCK_ICON_SIZE / 2;
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
    draw_topbar(&mut state.frame, width, state.height as i32, state.tick);
    for (index, client) in state.clients.iter().copied().enumerate() {
        if client.mapped == 0 {
            continue;
        }
        let active = index as u32 == state.active;
        // Soft shadow
        fill_rect(
            &mut state.frame,
            width,
            Rect {
                x: client.frame.x + 6,
                y: client.frame.y + 8,
                width: client.frame.width,
                height: client.frame.height,
            },
            [0, 0, 0, 55],
        );
        draw_titlebar(&mut state.frame, width, client, active);
        draw_client_body(&mut state.frame, width, index, client, active);
    }
    draw_dock(&mut state.frame, width, state.dock);
}

fn title_bytes(index: u32) -> &'static [u8] {
    match index {
        0 => TERMINAL_TITLE,
        1 => LOG_TITLE,
        _ => FILES_TITLE,
    }
}

#[no_mangle]
pub extern "C" fn aurora_init(width: u32, height: u32) -> u32 {
    let state = state();
    state.width = width.clamp(320, 1600);
    state.height = height.clamp(180, 1000);
    state.active = 0;
    state.tick = 0;
    state.running = 1;
    state.wallpaper = decode_wallpaper(state.width, state.height);
    state.frame = state.wallpaper.clone();
    layout_clients(state);
    render(state);
    1
}

#[no_mangle]
pub extern "C" fn aurora_tick(now_ms: u32) {
    let state = state();
    state.tick = now_ms;
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

/// MapRequest helper: recompute placement for a client and mark it managed/mapped.
#[no_mangle]
pub extern "C" fn aurora_map_request(index: u32, _req_w: i32, _req_h: i32) -> u32 {
    let state = state();
    if index as usize >= WINDOW_COUNT {
        return 0;
    }
    let client = place_client(index as usize, state.width as i32, state.height as i32, state.dock);
    state.clients[index as usize] = client;
    state.active = index;
    state.layout_version = state.layout_version.wrapping_add(1);
    state.running = 1;
    1
}

#[no_mangle]
pub extern "C" fn aurora_pointer_down(x: i32, y: i32) -> u32 {
    let state = state();
    for (index, client) in state.clients.iter().enumerate().rev() {
        if client.mapped == 1 && client.frame.contains(x, y) {
            state.active = index as u32;
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
    title_bytes(index).as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_window_title_len(index: u32) -> u32 {
    title_bytes(index).len() as u32
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
