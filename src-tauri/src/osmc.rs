use souvlaki::{
    MediaControls, MediaControlEvent, PlatformConfig,
};
use tauri::Emitter;
use std::sync::{Arc, Mutex};

pub fn init_media_controls(
    hwnd: Option<*mut std::ffi::c_void>,
    app: tauri::AppHandle,
) -> Arc<Mutex<MediaControls>> {
    let config = PlatformConfig {
        dbus_name: "bardo",
        display_name: "bardo",
        hwnd,
    };

    let mut controls = MediaControls::new(config)
        .expect("Failed to init media controls");

    controls
        .attach(move |event: MediaControlEvent| {
            match event {
                MediaControlEvent::Play => {
                    let _ = app.emit("smtc_play", ());
                }
                MediaControlEvent::Pause => {
                    let _ = app.emit("smtc_pause", ());
                }
                MediaControlEvent::Next => {
                    let _ = app.emit("smtc_next", ());
                }
                MediaControlEvent::Previous => {
                    let _ = app.emit("smtc_prev", ());
                }
                _ => {}
            }
        })
        .expect("Failed to attach media control handler");

    Arc::new(Mutex::new(controls))
}
