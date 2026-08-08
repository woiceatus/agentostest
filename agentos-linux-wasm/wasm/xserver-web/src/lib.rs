//! In-browser display server compositor for AgentOS.
//!
//! The JS `x11` package owns the X11 wire protocol (connections, MapRequest,
//! drawing requests). This WASM module owns the screen framebuffer: wallpaper,
//! window surfaces, hit testing, and presentation — the display-server half of
//! an X session that a browser canvas can show.

const MAX_WINDOWS: usize = 8;
const PROTOCOL_NAME: &[u8] = b"AGENTOS XSERVER WEB 0.2";

#[derive(Clone, Copy)]
struct Surface {
    visible: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    active: u32,
    titlebar: u32,
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
            titlebar: 1,
        }
    }
}

struct State {
    width: u32,
    height: u32,
    frame: Vec<u8>,
    wallpaper: Vec<u8>,
    surfaces: [Surface; MAX_WINDOWS],
    pointer_x: i32,
    pointer_y: i32,
    pointer_buttons: u32,
    last_key: u32,
    running: u32,
}

impl State {
    fn new() -> Self {
        Self {
            width: 960,
            height: 540,
            frame: Vec::new(),
            wallpaper: Vec::new(),
            surfaces: [Surface::empty(); MAX_WINDOWS],
            pointer_x: 480,
            pointer_y: 270,
            pointer_buttons: 0,
            last_key: 0,
            running: 0,
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
    let inv = 255 - src_a;
    frame[index] = ((color[0] as u32 * src_a + frame[index] as u32 * inv) / 255) as u8;
    frame[index + 1] = ((color[1] as u32 * src_a + frame[index + 1] as u32 * inv) / 255) as u8;
    frame[index + 2] = ((color[2] as u32 * src_a + frame[index + 2] as u32 * inv) / 255) as u8;
    frame[index + 3] = 255;
}

fn fill_rect(frame: &mut [u8], width: u32, x: i32, y: i32, w: i32, h: i32, color: [u8; 4]) {
    if w <= 0 || h <= 0 {
        return;
    }
    for yy in y..y + h {
        for xx in x..x + w {
            put_pixel(frame, width, xx, yy, color);
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

fn ensure_buffers(state: &mut State) {
    let bytes = (state.width as usize) * (state.height as usize) * 4;
    if state.frame.len() != bytes {
        state.frame.resize(bytes, 0);
    }
    if state.wallpaper.len() != bytes {
        state.wallpaper.resize(bytes, 0);
        // Fallback gradient if no wallpaper was uploaded yet.
        for y in 0..state.height {
            for x in 0..state.width {
                let i = ((y * state.width + x) * 4) as usize;
                state.wallpaper[i] = (18 + x * 20 / state.width.max(1)) as u8;
                state.wallpaper[i + 1] = (42 + y * 30 / state.height.max(1)) as u8;
                state.wallpaper[i + 2] = (58 + x * 12 / state.width.max(1)) as u8;
                state.wallpaper[i + 3] = 255;
            }
        }
    }
}

fn draw_window(frame: &mut [u8], width: u32, surface: Surface, index: usize) {
    let title_h = if surface.titlebar == 1 { 34 } else { 0 };
    fill_rect(
        frame,
        width,
        surface.x + 6,
        surface.y + 8,
        surface.width,
        surface.height,
        [0, 0, 0, 50],
    );
    if title_h > 0 {
        let title = if surface.active == 1 {
            [221, 238, 252, 235]
        } else {
            [250, 254, 255, 220]
        };
        fill_rect(
            frame,
            width,
            surface.x,
            surface.y,
            surface.width,
            title_h,
            title,
        );
        fill_circle(frame, width, surface.x + 19, surface.y + 17, 8, [241, 96, 105, 235]);
        fill_circle(frame, width, surface.x + 42, surface.y + 17, 8, [246, 190, 82, 235]);
        fill_circle(frame, width, surface.x + 65, surface.y + 17, 8, [76, 197, 178, 235]);
    }
    let body = if surface.active == 1 {
        [31, 51, 57, 245]
    } else {
        [24, 36, 42, 235]
    };
    fill_rect(
        frame,
        width,
        surface.x,
        surface.y + title_h,
        surface.width,
        (surface.height - title_h).max(1),
        body,
    );
    let accent = match index % 3 {
        0 => [115, 222, 210, 210],
        1 => [142, 186, 196, 200],
        _ => [182, 243, 107, 200],
    };
    let mut y = surface.y + title_h + 16;
    for row in 0..4 {
        let line_w = (surface.width - 36 - row * 16).max(28);
        fill_rect(frame, width, surface.x + 16, y, line_w, 5, accent);
        y += 20;
    }
}

fn render_frame(state: &mut State, tick: u32) {
    ensure_buffers(state);
    state.frame.copy_from_slice(&state.wallpaper);
    // Topbar strip so the display server itself shows chrome even before WM paint.
    fill_rect(
        &mut state.frame,
        state.width,
        0,
        0,
        state.width as i32,
        40,
        [250, 254, 255, 180],
    );
    let pulse = ((tick / 350) % 2) as i32;
    fill_circle(
        &mut state.frame,
        state.width,
        state.width as i32 - 24,
        20,
        5,
        if pulse == 0 {
            [76, 197, 178, 255]
        } else {
            [182, 243, 107, 255]
        },
    );

    for (index, surface) in state.surfaces.iter().copied().enumerate() {
        if surface.visible == 1 {
            draw_window(&mut state.frame, state.width, surface, index);
        }
    }

    let marker = if state.pointer_buttons > 0 {
        [182, 243, 107, 255]
    } else {
        [121, 222, 210, 230]
    };
    fill_rect(
        &mut state.frame,
        state.width,
        state.pointer_x - 1,
        state.pointer_y - 9,
        3,
        19,
        marker,
    );
    fill_rect(
        &mut state.frame,
        state.width,
        state.pointer_x - 9,
        state.pointer_y - 1,
        19,
        3,
        marker,
    );
    state.running = 1;
}

#[no_mangle]
pub extern "C" fn xserver_init(width: u32, height: u32) -> u32 {
    let state = state();
    state.width = width.clamp(320, 1600);
    state.height = height.clamp(180, 1000);
    state.surfaces = [Surface::empty(); MAX_WINDOWS];
    state.pointer_x = (state.width / 2) as i32;
    state.pointer_y = (state.height / 2) as i32;
    state.pointer_buttons = 0;
    state.last_key = 0;
    state.running = 1;
    state.frame.clear();
    state.wallpaper.clear();
    ensure_buffers(state);
    1
}

#[no_mangle]
pub extern "C" fn xserver_wallpaper_ptr() -> u32 {
    let state = state();
    ensure_buffers(state);
    state.wallpaper.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn xserver_wallpaper_len() -> u32 {
    let state = state();
    ensure_buffers(state);
    state.wallpaper.len() as u32
}

#[no_mangle]
pub extern "C" fn xserver_set_window(
    id: u32,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    active: u32,
) {
    let state = state();
    if let Some(surface) = state.surfaces.get_mut(id as usize) {
        *surface = Surface {
            visible: 1,
            x,
            y,
            width: width.max(1),
            height: height.max(1),
            active: active.min(1),
            titlebar: 1,
        };
    }
}

#[no_mangle]
pub extern "C" fn xserver_clear_windows() {
    state().surfaces = [Surface::empty(); MAX_WINDOWS];
}

#[no_mangle]
pub extern "C" fn xserver_input_pointer(x: i32, y: i32, buttons: u32) -> u32 {
    let state = state();
    state.pointer_x = x;
    state.pointer_y = y;
    state.pointer_buttons = buttons;
    for (index, surface) in state.surfaces.iter().enumerate().rev() {
        if surface.visible == 1
            && x >= surface.x
            && y >= surface.y
            && x < surface.x + surface.width
            && y < surface.y + surface.height
        {
            return (index as u32) + 1;
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn xserver_input_key(key: u32) {
    state().last_key = key;
}

#[no_mangle]
pub extern "C" fn xserver_last_key() -> u32 {
    state().last_key
}

#[no_mangle]
pub extern "C" fn xserver_render(tick: u32) -> u32 {
    let state = state();
    render_frame(state, tick);
    state.frame.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn xserver_frame_ptr() -> u32 {
    state().frame.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn xserver_frame_len() -> u32 {
    state().frame.len() as u32
}

#[no_mangle]
pub extern "C" fn xserver_width() -> u32 {
    state().width
}

#[no_mangle]
pub extern "C" fn xserver_height() -> u32 {
    state().height
}

#[no_mangle]
pub extern "C" fn xserver_is_running() -> u32 {
    state().running
}

#[no_mangle]
pub extern "C" fn xserver_protocol_name_ptr() -> u32 {
    PROTOCOL_NAME.as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn xserver_protocol_name_len() -> u32 {
    PROTOCOL_NAME.len() as u32
}
