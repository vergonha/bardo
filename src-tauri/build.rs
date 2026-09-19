fn main() {
    // loads .env locally; in ci the secret is already a real env var, so
    // this simply finds no file and does nothing.
    let _ = dotenvy::dotenv();

    if let Ok(client_id) = std::env::var("SPOTIFY_CLIENT_ID") {
        println!("cargo:rustc-env=SPOTIFY_CLIENT_ID={client_id}");
    }
    println!("cargo:rerun-if-changed=.env");

    tauri_build::build()
}
