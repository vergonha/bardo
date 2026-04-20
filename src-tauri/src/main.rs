#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod player;
use player::LibrespotPlayer;
use std::{fs, sync::Arc};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, State};
#[derive(Default)]
pub struct PlayerState(pub Arc<Mutex<Option<LibrespotPlayer>>>);
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

async fn refresh_flow(
    state: Arc<Mutex<Option<LibrespotPlayer>>>,
) -> Result<(), String> {
    eprintln!("[bardo] starting refresh flow...");

    let refresh_token = {
        let guard = state.lock().unwrap();
        let token = guard
            .as_ref()
            .ok_or("No player")?
            .refresh_token
            .clone();

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
        refresh_token: Option<String>
    }

    let body: Resp = res
        .json()
        .await
        .map_err(|e| format!("json parse failed: {e}"))?;

    eprintln!(
        "[bardo] new token received, expires_in={}s",
        body.expires_in
    );

    let new_expiry =
        std::time::Instant::now() + std::time::Duration::from_secs(body.expires_in);

    eprintln!("[bardo] rebuilding session...");

    let credentials =
        librespot_core::authentication::Credentials::with_access_token(&body.access_token);

    let (session, player, mixer, spirc, spirc_task) =
        LibrespotPlayer::init_spirc(credentials).await?;

    eprintln!("[bardo] session rebuilt, spawning spirc task...");

    tokio::spawn(async move {
        spirc_task.await;
        eprintln!("[bardo] spirc task ended after refresh");
    });

    {
        let mut guard = state.lock().unwrap();
        let p: &mut LibrespotPlayer = guard.as_mut().ok_or("No player")?;

        if let Some(new_refresh) = body.refresh_token {
            p.refresh_token = new_refresh;
        }        

        p.access_token = body.access_token;
        p.expires_at = new_expiry;
        p.player = player;
        p.mixer = mixer;
        p.spirc = std::sync::Arc::new(spirc);
    }

    eprintln!("[bardo] silent refresh OK");

    Ok(())
}

fn spawn_auto_refresh(state: Arc<Mutex<Option<LibrespotPlayer>>>) {
    tokio::spawn(async move {
        eprintln!("[bardo] started background loop");

        loop {
            let sleep_duration = {
                let guard = state.lock().unwrap();

                if let Some(player) = guard.as_ref() {
                    let now = std::time::Instant::now();

                    if player.expires_at <= now {
                        eprintln!("[bardo] token already expired");
                        std::time::Duration::from_secs(0)
                    } else {
                        let remaining = player.expires_at - now;

                        eprintln!(
                            "[bardo] token valid for {}s",
                            remaining.as_secs()
                        );

                        let sleep = remaining
                            .checked_sub(std::time::Duration::from_secs(60))
                            .unwrap_or(std::time::Duration::from_secs(0));

                        eprintln!(
                            "[bardo] sleeping for {}s before refresh",
                            sleep.as_secs()
                        );

                        sleep
                    }
                } else {
                    eprintln!("[bardo] no player yet, retrying in 5s");
                    std::time::Duration::from_secs(5)
                }
            };

            tokio::time::sleep(sleep_duration).await;

            eprintln!("[bardo] waking up, triggering refresh...");

            match refresh_flow(state.clone()).await {
                Ok(_) => {
                    eprintln!("[bardo] refresh cycle completed");
                }
                Err(e) => {
                    eprintln!("[bardo] refresh failed: {e}");
                }
            }
        }
    });
}

#[tauri::command]
async fn run_spotify_login(
    player_state: State<'_, PlayerState>,
    app: AppHandle,
) -> Result<String, String> {
    eprintln!("[bardo] run_spotify_login called");
    let p = LibrespotPlayer::new(app).await?;
    let token = p.access_token.clone();
    *player_state.0.lock().unwrap() = Some(p);
    spawn_auto_refresh(player_state.0.clone());
    eprintln!("[bardo] Login complete, token stored.");
    Ok(token)
}

#[tauri::command]
fn get_access_token(player_state: State<'_, PlayerState>) -> Result<String, String> {
    player_state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.access_token.clone())
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
        .manage(PlayerState(Arc::new(Mutex::new(None))))
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
