#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod player;

use player::LibrespotPlayer;
use std::{fs, sync::Arc};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

pub struct PlayerState(pub Arc<Mutex<Option<LibrespotPlayer>>>);

pub struct WebApiAuth {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: Instant,
}

pub struct WebApiState(pub Arc<Mutex<Option<WebApiAuth>>>);

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

async fn refresh_webapi_token(
    state: Arc<Mutex<Option<WebApiAuth>>>,
) -> Result<(), String> {
    eprintln!("[bardo] starting webapi refresh...");

    let refresh_token = {
        let guard = state.lock().unwrap();
        let token = guard.as_ref().ok_or("No auth")?.refresh_token.clone();
        eprintln!("[bardo] got refresh_token (len={})", token.len());
        token
    };

    let client = reqwest::Client::new();

    eprintln!("[bardo] sending request to Spotify...");

    let res = client
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", player::SPOTIFY_CLIENT_ID),
        ])
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = res.status();
    eprintln!("[bardo] response status: {}", status);

    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("spotify error {}: {}", status, text));
    }

    #[derive(serde::Deserialize)]
    struct Resp {
        access_token: String,
        expires_in: u64,
        refresh_token: Option<String>,
    }

    let body: Resp = res
        .json()
        .await
        .map_err(|e| format!("json parse failed: {e}"))?;

    eprintln!(
        "[bardo] new webapi token received, expires_in={}s",
        body.expires_in
    );

    let mut guard = state.lock().unwrap();
    let auth = guard.as_mut().ok_or("No auth")?;

    auth.access_token = body.access_token.clone();

    if let Some(r) = body.refresh_token {
        eprintln!("[bardo] refresh token rotated (len={})", r.len());
        auth.refresh_token = r;
    }

    auth.expires_at = Instant::now() + Duration::from_secs(body.expires_in);

    eprintln!("[bardo] webapi refresh OK");

    Ok(())
}

fn spawn_webapi_refresh(state: Arc<Mutex<Option<WebApiAuth>>>) {
    tokio::spawn(async move {
        eprintln!("[bardo] started webapi refresh loop");

        loop {
            let sleep_duration = {
                let guard = state.lock().unwrap();

                if let Some(auth) = guard.as_ref() {
                    let now = Instant::now();

                    if auth.expires_at <= now {
                        eprintln!("[bardo] token already expired");
                        Duration::from_secs(0)
                    } else {
                        let remaining = auth.expires_at - now;

                        eprintln!(
                            "[bardo] webapi token valid for {}s",
                            remaining.as_secs()
                        );

                        let sleep = remaining
                            .checked_sub(Duration::from_secs(60))
                            .unwrap_or(Duration::from_secs(0));

                        eprintln!(
                            "[bardo] sleeping for {}s before refresh",
                            sleep.as_secs()
                        );

                        sleep
                    }
                } else {
                    eprintln!("[bardo] no auth yet, retrying in 5s");
                    Duration::from_secs(5)
                }
            };

            tokio::time::sleep(sleep_duration).await;

            eprintln!("[bardo] waking up, triggering webapi refresh...");

            match refresh_webapi_token(state.clone()).await {
                Ok(_) => eprintln!("[bardo] refresh cycle completed"),
                Err(e) => eprintln!("[bardo] refresh failed: {e}"),
            }
        }
    });
}

#[tauri::command]
async fn run_spotify_login(
    web_state: State<'_, WebApiState>,
    player_state: State<'_, PlayerState>,
    app: AppHandle,
) -> Result<(), String> {
    eprintln!("[bardo] run_spotify_login called");

    let token = tokio::task::spawn_blocking(|| {
        librespot_oauth::OAuthClientBuilder::new(
            player::SPOTIFY_CLIENT_ID,
            "http://127.0.0.1:8888/login",
            player::SCOPES.to_vec(),
        )
        .open_in_browser()
        .build()
        .map_err(|e| format!("OAuth build failed: {e}"))?
        .get_access_token()
        .map_err(|e| format!("OAuth failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))??;

    eprintln!("[bardo] OAuth succeeded. Expires at {:?}", token.expires_at);

    let auth = WebApiAuth {
        access_token: token.access_token.clone(),
        refresh_token: token.refresh_token.clone(),
        expires_at: token.expires_at,
    };

    *web_state.0.lock().unwrap() = Some(auth);

    eprintln!("[bardo] Initializing session + Spirc...");

    let credentials =
        librespot_core::authentication::Credentials::with_access_token(&token.access_token);

    let (session, player, mixer, spirc, spirc_task) =
        LibrespotPlayer::init_spirc(credentials).await?;

    eprintln!("[bardo] session initialized, spawning spirc task...");

    tokio::spawn(async move {
        spirc_task.await;
        eprintln!("[bardo] spirc task ended");
    });

    let p = LibrespotPlayer::from_parts(
        session,
        player,
        mixer,
        spirc,
        token.access_token.clone(),
        token.refresh_token.clone(),
        token.expires_at,
        app,
    );

    *player_state.0.lock().unwrap() = Some(p);

    spawn_webapi_refresh(web_state.0.clone());

    eprintln!("[bardo] login complete");

    Ok(())
}

#[tauri::command]
fn get_access_token(web_state: State<'_, WebApiState>) -> Result<String, String> {
    web_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.access_token.clone())
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
    let v = (volume * u16::MAX as f64).clamp(0.0, u16::MAX as f64) as u16;
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
        .manage(PlayerState(Arc::new(Mutex::new(None))))
        .manage(WebApiState(Arc::new(Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            run_spotify_login,
            get_access_token,
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