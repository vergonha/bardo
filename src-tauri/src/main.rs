#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod player;

use player::LibrespotPlayer;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[derive(Default)]
pub struct SpotifyState {
    pub access_token: Mutex<Option<String>>,
}

pub struct PlayerState(pub Mutex<Option<LibrespotPlayer>>);

#[derive(serde::Deserialize)]
struct AppConfig {
    spotify: SpotifyConfig,
}

#[derive(serde::Deserialize)]
struct SpotifyConfig {
    client_id: String,
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .expect("Couldn't find config folder.")
        .join("bardo")
        .join("bardo.config.toml")
}

fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    let content = fs::read_to_string(&path)
        .map_err(|_| format!("bardo.config.toml not found at {}", path.display()))?;
    toml::from_str(&content).map_err(|e| format!("Config parse error: {e}"))
}

#[tauri::command]
async fn run_spotify_login(
    state: State<'_, SpotifyState>,
    player_state: State<'_, PlayerState>,
    app: AppHandle,
) -> Result<String, String> {
    eprintln!("[bardo] run_spotify_login called");
    let p = LibrespotPlayer::new(app).await?;
    let token = p.access_token.clone();
    *state.access_token.lock().unwrap() = Some(token.clone());
    *player_state.0.lock().unwrap() = Some(p);
    eprintln!("[bardo] Login complete, token stored.");
    Ok(token)
}

#[tauri::command]
async fn refresh_token(
    state: State<'_, SpotifyState>,
    player_state: State<'_, PlayerState>,
    app: AppHandle,
) -> Result<String, String> {
    eprintln!("[bardo] refresh_token called");
    {
        let token_guard = state.access_token.lock().unwrap();
        let player_guard = player_state.0.lock().unwrap();
        if token_guard.is_some() && player_guard.is_some() {
            eprintln!("[bardo] Player already running, reusing token.");
            return Ok(token_guard.clone().unwrap());
        }
    }
    eprintln!("[bardo] No live session, starting fresh OAuth...");
    let p = LibrespotPlayer::new(app).await?;
    let token = p.access_token.clone();
    *state.access_token.lock().unwrap() = Some(token.clone());
    *player_state.0.lock().unwrap() = Some(p);
    eprintln!("[bardo] refresh_token: new session ready.");
    Ok(token)
}

#[tauri::command]
fn get_access_token(state: State<'_, SpotifyState>) -> Result<String, String> {
    state
        .access_token
        .lock()
        .unwrap()
        .clone()
        .ok_or("Not logged in.".into())
}

#[tauri::command]
fn check_config() -> Result<(), String> {
    load_config().map(|_| ())
}

#[tauri::command]
fn get_client_id() -> Result<String, String> {
    load_config().map(|c| c.spotify.client_id)
}

#[tauri::command]
fn player_play_track(
    uri: String,
    player_state: State<'_, PlayerState>,
) -> Result<(), String> {
    player_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Player not started")?
        .play_track(uri);
    Ok(())
}

#[tauri::command]
fn player_pause(player_state: State<'_, PlayerState>) -> Result<(), String> {
    player_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Player not started")?
        .pause();
    Ok(())
}

#[tauri::command]
fn player_resume(player_state: State<'_, PlayerState>) -> Result<(), String> {
    player_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Player not started")?
        .resume();
    Ok(())
}

#[tauri::command]
fn player_seek(
    position_ms: u32,
    player_state: State<'_, PlayerState>,
) -> Result<(), String> {
    player_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Player not started")?
        .seek(position_ms);
    Ok(())
}

#[tauri::command]
fn player_set_volume(
    volume: f64,
    player_state: State<'_, PlayerState>,
) -> Result<(), String> {
    player_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .ok_or("Player not started")?
        .set_volume(volume);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SpotifyState::default())
        .manage(PlayerState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            run_spotify_login,
            get_access_token,
            refresh_token,
            check_config,
            get_client_id,
            player_play_track,
            player_pause,
            player_resume,
            player_seek,
            player_set_volume,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run app");
}