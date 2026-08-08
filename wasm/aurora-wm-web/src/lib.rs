//! Aurora WM's browser target.
//!
//! The upstream 'ecooxai/aurora-wm' binary is an X11 WM: it opens DISPLAY,
//! claims WM_S*, and consumes X11 events. This target preserves the part that
//! is useful in a browser—window ownership, focus, layout and keyboard
//! navigation—while exposing a tiny C ABI to the in-tab Xserver adapter.
//! It is a real Rust/WASM build, not a JavaScript drawing mock.

const WINDOW_COUNT: usize = 3;

#[derive(Clone, Copy)]
struct Window {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl Window {
    const fn empty() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        }
    }
}

static mut DISPLAY_WIDTH: u32 = 960;
static mut DISPLAY_HEIGHT: u32 = 540;
static mut WINDOWS: [Window; WINDOW_COUNT] = [Window::empty(); WINDOW_COUNT];
static mut ACTIVE_WINDOW: u32 = 0;
static mut TICK: u32 = 0;
static mut LAYOUT_VERSION: u32 = 0;

static TERMINAL_TITLE: &[u8] = b"terminal";
static LOG_TITLE: &[u8] = b"agent log";
static FILES_TITLE: &[u8] = b"files";

fn layout() {
    unsafe {
        let width = DISPLAY_WIDTH as i32;
        let height = DISPLAY_HEIGHT as i32;
        let margin = (width / 20).max(24);
        let gap = 16;
        let side_width = (width / 3).max(250);
        let side_x = width - margin - side_width;
        let left_width = (side_x - margin - gap).max(280);
        let content_top = 74;
        let content_bottom = (height - 48).max(content_top + 220);
        let content_height = (content_bottom - content_top).max(220);
        let terminal_height = ((content_height * 62) / 100).max(180);

        WINDOWS[0] = Window {
            x: margin,
            y: content_top,
            width: left_width,
            height: terminal_height,
        };
        WINDOWS[1] = Window {
            x: side_x,
            y: content_top,
            width: side_width,
            height: ((content_height - gap) / 2).max(120),
        };
        WINDOWS[2] = Window {
            x: side_x,
            y: content_top + ((content_height + gap) / 2),
            width: side_width,
            height: ((content_height - gap) / 2).max(120),
        };
        LAYOUT_VERSION = LAYOUT_VERSION.wrapping_add(1);
    }
}

#[no_mangle]
pub extern "C" fn aurora_init(width: u32, height: u32) -> u32 {
    unsafe {
        DISPLAY_WIDTH = width.clamp(320, 1600);
        DISPLAY_HEIGHT = height.clamp(180, 1000);
        ACTIVE_WINDOW = 0;
        TICK = 0;
    }
    layout();
    1
}

#[no_mangle]
pub extern "C" fn aurora_tick(now_ms: u32) {
    unsafe {
        TICK = now_ms;
    }
}

#[no_mangle]
pub extern "C" fn aurora_window_count() -> u32 {
    WINDOW_COUNT as u32
}

#[no_mangle]
pub extern "C" fn aurora_window_x(index: u32) -> i32 {
    unsafe { WINDOWS.get(index as usize).copied().unwrap_or(Window::empty()).x }
}

#[no_mangle]
pub extern "C" fn aurora_window_y(index: u32) -> i32 {
    unsafe { WINDOWS.get(index as usize).copied().unwrap_or(Window::empty()).y }
}

#[no_mangle]
pub extern "C" fn aurora_window_width(index: u32) -> i32 {
    unsafe { WINDOWS.get(index as usize).copied().unwrap_or(Window::empty()).width }
}

#[no_mangle]
pub extern "C" fn aurora_window_height(index: u32) -> i32 {
    unsafe { WINDOWS.get(index as usize).copied().unwrap_or(Window::empty()).height }
}

#[no_mangle]
pub extern "C" fn aurora_window_active(index: u32) -> u32 {
    unsafe { (index == ACTIVE_WINDOW) as u32 }
}

#[no_mangle]
pub extern "C" fn aurora_active_window() -> u32 {
    unsafe { ACTIVE_WINDOW }
}

#[no_mangle]
pub extern "C" fn aurora_layout_version() -> u32 {
    unsafe { LAYOUT_VERSION }
}

#[no_mangle]
pub extern "C" fn aurora_tick_value() -> u32 {
    unsafe { TICK }
}

#[no_mangle]
pub extern "C" fn aurora_pointer_down(x: i32, y: i32) -> u32 {
    unsafe {
        for (index, window) in WINDOWS.iter().enumerate().rev() {
            if x >= window.x
                && y >= window.y
                && x < window.x + window.width
                && y < window.y + window.height
            {
                ACTIVE_WINDOW = index as u32;
                return ACTIVE_WINDOW + 1;
            }
        }
    }
    0
}

#[no_mangle]
pub extern "C" fn aurora_handle_key(key: u32) -> u32 {
    unsafe {
        match key {
            9 => ACTIVE_WINDOW = (ACTIVE_WINDOW + 1) % WINDOW_COUNT as u32,
            49..=51 => ACTIVE_WINDOW = key - 49,
            _ => {}
        }
        ACTIVE_WINDOW
    }
}

fn title(index: u32) -> &'static [u8] {
    match index {
        0 => TERMINAL_TITLE,
        1 => LOG_TITLE,
        _ => FILES_TITLE,
    }
}

#[no_mangle]
pub extern "C" fn aurora_window_title_ptr(index: u32) -> u32 {
    title(index).as_ptr() as u32
}

#[no_mangle]
pub extern "C" fn aurora_window_title_len(index: u32) -> u32 {
    title(index).len() as u32
}
