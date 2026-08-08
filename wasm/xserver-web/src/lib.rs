//! A browser display-server adapter for AgentOS.
//!
//! This is deliberately a small X-server-shaped boundary rather than an
//! unmodified Xorg build. It owns window surfaces, hit testing, pointer/key
//! events, and a 32-bit RGBA framebuffer. JavaScript uploads that framebuffer
//! to a WebGPU texture, which gives the browser the same display/input seam an
//! X client would normally see through a socket and an X screen.

const MAX_WINDOWS: usize = 8;

#[derive(Clone, Copy)]
struct Surface {
    visible: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    active: u32,
}

impl Surface {
    const fn empty() -> Self {
        Self {
            visible: 0,
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            active: 0,
        }
    }
}

static mut WIDTH: u32 = 960;
static mut HEIGHT: u32 = 540;
static mut FRAME: Vec<u8> = Vec::new();
static mut SURFACES: [Surface; MAX_WINDOWS] = [Surface::empty(); MAX_WINDOWS];
static mut POINTER_X: i32 = 0;
static mut POINTER_Y: i32 = 0;
static mut POINTER_BUTTONS: u32 = 0;
static mut LAST_KEY: u32 = 0;

const PROTOCOL_NAME: &[u8] = b"AGENTOS XSERVER WEB 0.1";

fn put_pixel(frame: &mut [u8], width: u32, x: u32, y: u32, color: [u8; 4]) {
    let index = ((y as usize) * (width as usize) + (x as usize)) * 4;
    if index + 3 < frame.len() {
        frame[index..index + 4].copy_from_slice(&color);
    }
}

fn fill_rect(frame: &mut [u8], width: u32, height: u32, x: i32, y: i32, w: i32, h: i32, color: [u8; 4]) {
    if w <= 0 || h <= 0 {
        return;
    }
    let x0 = x.max(0) as u32;
    let y0 = y.max(0) as u32;
    let x1 = x.saturating_add(w).min(width as i32).max(0) as u32;
    let y1 = y.saturating_add(h).min(height as i32).max(0) as u32;
    for yy in y0..y1.min(height) {
        for xx in x0..x1.min(width) {
            put_pixel(frame, width, xx, yy, color);
        }
    }
}

fn draw_window(frame: &mut [u8], width: u32, height: u32, surface: Surface, index: usize) {
    let body = if surface.active == 1 {
        [31, 51, 57, 255]
    } else {
        [24, 36, 42, 255]
    };
    let title = if surface.active == 1 {
        [51, 91, 91, 255]
    } else {
        [38, 54, 61, 255]
    };
    let border = if surface.active == 1 {
        [115, 222, 210, 255]
    } else {
        [61, 87, 91, 255]
    };
    let x = surface.x;
    let y = surface.y;
    let w = surface.width;
    let h = surface.height;

    fill_rect(frame, width, height, x + 7, y + 9, w, h, [0, 0, 0, 80]);
    fill_rect(frame, width, height, x, y, w, h, border);
    fill_rect(frame, width, height, x + 1, y + 1, w - 2, h - 2, body);
    fill_rect(frame, width, height, x + 1, y + 1, w - 2, 30, title);

    // Traffic lights and a compact title glyph strip. Text labels are mirrored
    // by the accessible DOM overlay in WebDesktop.tsx.
    fill_rect(frame, width, height, x + 12, y + 12, 7, 7, [255, 127, 107, 255]);
    fill_rect(frame, width, height, x + 23, y + 12, 7, 7, [255, 195, 109, 255]);
    fill_rect(frame, width, height, x + 34, y + 12, 7, 7, [188, 244, 118, 255]);
    let mut title_seed = (index as i32) * 3 + 2;
    for glyph in 0..8 {
        let glyph_width = 7 + ((title_seed + glyph) % 3);
        fill_rect(
            frame,
            width,
            height,
            x + 58 + (glyph as i32) * 11,
            y + 13,
            glyph_width,
            4,
            [174, 207, 199, 210],
        );
        title_seed = title_seed.wrapping_add(1);
    }

    let content_top = y + 50;
    let row_gap = 25;
    for row in 0..6 {
        let line_width = (w - 48 - ((row * 17) % 76)).max(30);
        let color = if index == 0 && row % 2 == 0 {
            [116, 202, 184, 190]
        } else if index == 1 {
            [104, 148, 160, 170]
        } else {
            [117, 139, 144, 150]
        };
        fill_rect(
            frame,
            width,
            height,
            x + 22,
            content_top + row * row_gap,
            line_width,
            6,
            color,
        );
        if row < 5 {
            fill_rect(
                frame,
                width,
                height,
                x + 22,
                content_top + row * row_gap + 12,
                (line_width / 2).max(24),
                3,
                [77, 103, 108, 155],
            );
        }
    }
}

fn render_frame(frame: &mut [u8], width: u32, height: u32, tick: u32, surfaces: [Surface; MAX_WINDOWS], pointer: (i32, i32, u32)) {
    for y in 0..height {
        let shade = ((y * 12) / height.max(1)) as u8;
        for x in 0..width {
            let glow = ((x * 8) / width.max(1)) as u8;
            put_pixel(frame, width, x, y, [8 + glow / 2, 17 + shade, 24 + glow, 255]);
        }
    }

    fill_rect(frame, width, height, 0, 0, width as i32, 42, [19, 30, 35, 255]);
    fill_rect(frame, width, height, 0, 41, width as i32, 1, [63, 94, 92, 255]);
    fill_rect(frame, width, height, 24, 13, 8, 8, [188, 244, 118, 255]);
    fill_rect(frame, width, height, 45, 15, 84, 4, [168, 198, 190, 220]);
    fill_rect(frame, width, height, 45, 23, 54, 3, [91, 123, 120, 200]);

    let pulse = ((tick / 350) % 2) as i32;
    fill_rect(
        frame,
        width,
        height,
        width as i32 - 162,
        15,
        7,
        7,
        if pulse == 0 { [115, 222, 210, 255] } else { [188, 244, 118, 255] },
    );
    fill_rect(frame, width, height, width as i32 - 145, 15, 105, 4, [143, 173, 169, 220]);

    for (index, surface) in surfaces.iter().copied().enumerate() {
        if surface.visible == 1 {
            draw_window(frame, width, height, surface, index);
        }
    }

    // A small browser-side pointer marker makes the X input route visible in
    // the demo even when the canvas is being driven from a touch device.
    let (px, py, buttons) = pointer;
    let marker = if buttons > 0 { [188, 244, 118, 255] } else { [121, 222, 210, 235] };
    fill_rect(frame, width, height, px - 1, py - 9, 3, 19, marker);
    fill_rect(frame, width, height, px - 9, py - 1, 19, 3, marker);
}

#[no_mangle]
pub extern "C" fn xserver_init(width: u32, height: u32) -> u32 {
    unsafe {
        WIDTH = width.clamp(320, 1600);
        HEIGHT = height.clamp(180, 1000);
        FRAME.clear();
        FRAME.resize((WIDTH as usize) * (HEIGHT as usize) * 4, 0);
        SURFACES = [Surface::empty(); MAX_WINDOWS];
        POINTER_X = (WIDTH / 2) as i32;
        POINTER_Y = (HEIGHT / 2) as i32;
    }
    1
}

#[no_mangle]
pub extern "C" fn xserver_set_window(id: u32, x: i32, y: i32, width: i32, height: i32, active: u32) {
    unsafe {
        if let Some(surface) = SURFACES.get_mut(id as usize) {
            *surface = Surface {
                visible: 1,
                x,
                y,
                width: width.max(1),
                height: height.max(1),
                active: active.min(1),
            };
        }
    }
}

#[no_mangle]
pub extern "C" fn xserver_clear_windows() {
    unsafe {
        SURFACES = [Surface::empty(); MAX_WINDOWS];
    }
}

#[no_mangle]
pub extern "C" fn xserver_input_pointer(x: i32, y: i32, buttons: u32) -> u32 {
    unsafe {
        POINTER_X = x;
        POINTER_Y = y;
        POINTER_BUTTONS = buttons;
        for (index, surface) in SURFACES.iter().enumerate().rev() {
            if surface.visible == 1
                && x >= surface.x
                && y >= surface.y
                && x < surface.x + surface.width
                && y < surface.y + surface.height
            {
                return (index as u32) + 1;
            }
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn xserver_input_key(key: u32) {
    unsafe {
        LAST_KEY = key;
    }
}

#[no_mangle]
pub extern "C" fn xserver_last_key() -> u32 {
    unsafe { LAST_KEY }
}

#[no_mangle]
pub extern "C" fn xserver_render(tick: u32) -> u32 {
    unsafe {
        let width = WIDTH;
        let height = HEIGHT;
        let surfaces = SURFACES;
        let pointer = (POINTER_X, POINTER_Y, POINTER_BUTTONS);
        render_frame(&mut FRAME, width, height, tick, surfaces, pointer);
        FRAME.as_ptr() as u32
    }
}

#[no_mangle]
pub extern "C" fn xserver_frame_ptr() -> u32 {
    unsafe { FRAME.as_ptr() as u32 }
}

#[no_mangle]
pub extern "C" fn xserver_frame_len() -> u32 {
    unsafe { FRAME.len() as u32 }
}

#[no_mangle]
pub extern "C" fn xserver_width() -> u32 {
    unsafe { WIDTH }
}

#[no_mangle]
pub extern "C" fn xserver_height() -> u32 {
    unsafe { HEIGHT }
}

#[no_mangle]
pub extern "C" fn xserver_protocol_name_ptr() -> u32 {
    PROTOCOL_NAME.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn xserver_protocol_name_len() -> u32 {
    PROTOCOL_NAME.len() as u32
}
