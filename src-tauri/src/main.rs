// Rally Stage Challenge — desktop shell.
//
// The game is entirely front-end code; this is a native window around it. No
// commands are exposed to the web layer, so the attack surface is a window and
// nothing else.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start Rally Stage Challenge");
}
