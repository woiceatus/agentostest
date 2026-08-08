fn main() {
    #[cfg(feature = "web")]
    {
        // Browser host drives the WM via aurora_wm_start / aurora_wm_pump.
        // Keep a no-op main so emcc emits JS glue for the cdylib-linked binary.
        return;
    }
    #[cfg(not(feature = "web"))]
    {
        if let Err(err) = aurora_wm::run() {
            eprintln!("aurora-wm: {err}");
            std::process::exit(1);
        }
    }
}
