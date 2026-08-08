//! C ABI entry points for running real Aurora WM against the in-tab JS XServer.

use std::cell::RefCell;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::*;
use x11rb::rust_connection::RustConnection;
use x11rb::CURRENT_TIME;

use crate::web_stream::JsStream;
use crate::{become_wm, Aurora, AnyResult, WmConn};

thread_local! {
    static APP: RefCell<Option<Aurora>> = const { RefCell::new(None) };
}

fn start_inner() -> AnyResult<()> {
    let stream = JsStream::new();
    let conn: WmConn = RustConnection::connect_to_stream(stream, 0)?;
    let screen_num = 0usize;
    let screen = conn.setup().roots[screen_num].clone();
    let display = ":web".to_string();

    let selection_name = format!("WM_S{}", screen_num);
    let wm_s_atom = conn
        .intern_atom(false, selection_name.as_bytes())?
        .reply()?
        .atom;
    let wm_window = conn.generate_id()?;
    conn.create_window(
        x11rb::COPY_FROM_PARENT as u8,
        wm_window,
        screen.root,
        -10,
        -10,
        1,
        1,
        0,
        WindowClass::INPUT_OUTPUT,
        screen.root_visual,
        &CreateWindowAux::new(),
    )?;

    become_wm(&conn, &screen)?;
    conn.set_selection_owner(wm_window, wm_s_atom, CURRENT_TIME)?;

    // Prefer non-composited path: JS XServer has no COMPOSITE extension.
    let mut app = Aurora::new(conn, display, &screen, screen_num, Some(false))?;
    // Desktop build maps Settings at create time; keep the web session clean
    // until the user opens it (Display / Power / dock gear).
    app.settings_visible = false;
    app.settings_front = false;
    let _ = app.conn.unmap_window(app.ui.settings);
    app.scan_existing_windows()?;
    app.redraw_everything()?;
    app.conn.flush()?;

    APP.with(|slot| {
        *slot.borrow_mut() = Some(app);
    });
    Ok(())
}

#[no_mangle]
pub extern "C" fn aurora_wm_start() -> i32 {
    match start_inner() {
        Ok(()) => 1,
        Err(err) => {
            eprintln!("aurora-wm web start failed: {err}");
            0
        }
    }
}

#[no_mangle]
pub extern "C" fn aurora_wm_pump() -> i32 {
    let mut ok = 1i32;
    APP.with(|slot| {
        if let Some(app) = slot.borrow_mut().as_mut() {
            if let Err(err) = app.pump_once() {
                eprintln!("aurora-wm pump error: {err}");
                ok = 0;
            }
        } else {
            ok = 0;
        }
    });
    ok
}

#[no_mangle]
pub extern "C" fn aurora_wm_is_running() -> i32 {
    APP.with(|slot| i32::from(slot.borrow().is_some()))
}

#[no_mangle]
pub extern "C" fn aurora_wm_stop() {
    APP.with(|slot| {
        *slot.borrow_mut() = None;
    });
}
