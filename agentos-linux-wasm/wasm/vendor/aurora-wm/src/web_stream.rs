//! Minimal x11rb Stream adapter over the in-tab JS XServer byte transport.
//! Same import surface as wasm/x11-apps/x11_transport.js.

use std::io::{self, ErrorKind, IoSlice, Result};
use std::os::fd::RawFd;

use x11rb::rust_connection::{PollMode, Stream};
use x11rb::utils::RawFdContainer;

extern "C" {
    fn x11_js_write(ptr: *const u8, len: usize) -> i32;
    fn x11_js_read(ptr: *mut u8, maxlen: usize) -> i32;
    fn x11_js_poll() -> i32;
}

/// Byte-stream bridge: Aurora (WASM) ↔ JS XServer via Emscripten js-library.
#[derive(Debug)]
pub struct JsStream;

impl JsStream {
    pub fn new() -> Self {
        Self
    }
}

impl Stream for JsStream {
    fn poll(&self, mode: PollMode) -> Result<()> {
        if mode.readable() {
            // Level-triggered: return immediately; callers use WouldBlock on read/write.
            // If no data yet, still return Ok — x11rb will read and get WouldBlock.
            let _ = unsafe { x11_js_poll() };
        }
        Ok(())
    }

    fn read(&self, buf: &mut [u8], _fd_storage: &mut Vec<RawFdContainer>) -> Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let n = unsafe { x11_js_read(buf.as_mut_ptr(), buf.len()) };
        if n < 0 {
            return Err(io::Error::new(ErrorKind::Other, "x11_js_read failed"));
        }
        if n == 0 {
            // Distinguish EOF vs WouldBlock using poll.
            let avail = unsafe { x11_js_poll() };
            if avail < 0 {
                return Err(io::Error::new(ErrorKind::Other, "x11_js_poll failed"));
            }
            if avail == 0 {
                return Err(io::Error::new(ErrorKind::WouldBlock, "no x11 data"));
            }
            // Data reported but read returned 0 — treat as WouldBlock/retry.
            return Err(io::Error::new(ErrorKind::WouldBlock, "x11 read retry"));
        }
        Ok(n as usize)
    }

    fn write(&self, buf: &[u8], fds: &mut Vec<RawFdContainer>) -> Result<usize> {
        if !fds.is_empty() {
            // JS XServer has no FD passing; drop any FDs.
            fds.clear();
        }
        if buf.is_empty() {
            return Ok(0);
        }
        let n = unsafe { x11_js_write(buf.as_ptr(), buf.len()) };
        if n < 0 {
            return Err(io::Error::new(ErrorKind::Other, "x11_js_write failed"));
        }
        Ok(n as usize)
    }

    fn write_vectored(&self, bufs: &[IoSlice<'_>], fds: &mut Vec<RawFdContainer>) -> Result<usize> {
        let mut total = 0usize;
        for buf in bufs {
            if buf.is_empty() {
                continue;
            }
            let n = self.write(buf, fds)?;
            total += n;
            if n < buf.len() {
                break;
            }
        }
        Ok(total)
    }
}

// Silence unused RawFd on some toolchains inspecting Stream FD APIs.
#[allow(dead_code)]
fn _raw_fd_ty(_: RawFd) {}
