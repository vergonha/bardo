#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod player;
mod osmc;
mod credentials;
use player::LibrespotPlayer;
use std::{sync::Arc};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::task::JoinHandle;

/// set once in `main()`'s `.setup()`, so any log call anywhere in the app
/// (even outside a tauri command) can also push the line to the front-end.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// prints to stderr and, once the app has started, emits a "bardo-log"
/// event so the front-end can show the same line during login.
pub fn bardo_log(msg: String) {
    eprintln!("{msg}");
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("bardo-log", msg);
    }
}

/// like `eprintln!`/`println!`, but also forwards the line to the front-end.
#[macro_export]
macro_rules! blog {
    ($($arg:tt)*) => {
        $crate::bardo_log(format!($($arg)*))
    };
}

pub struct PlayerState(pub Arc<Mutex<Option<LibrespotPlayer>>>);

pub struct WebApiAuth {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: Instant,
}

pub struct WebApiState {
    pub auth: Arc<Mutex<Option<WebApiAuth>>>,
    pub refresh_task: Arc<Mutex<Option<JoinHandle<()>>>>,
}

pub fn spotify_client_id() -> &'static str {
    env!("SPOTIFY_CLIENT_ID")
}

struct TokenPair {
    access_token: String,
    refresh_token: String,
    expires_at: Instant,
}

async fn exchange_refresh_token(refresh_token: &str) -> Result<TokenPair, String> {
    let client = reqwest::Client::new();

    blog!("[bardo] exchanging refresh token for access token...");
    blog!("[bardo] client_id: {}", spotify_client_id());
    let res = client
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", spotify_client_id()),
        ])
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = res.status();

    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(format!("spotify error: {text}"));
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

    Ok(TokenPair {
        access_token: body.access_token,
        refresh_token: body.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at: Instant::now() + Duration::from_secs(body.expires_in),
    })
}

async fn refresh_webapi_token(
    state: Arc<Mutex<Option<WebApiAuth>>>,
) -> Result<(), String> {
    blog!("[bardo] starting webapi refresh...");

    let refresh_token = {
        let guard = state.lock().unwrap();
        guard.as_ref().ok_or("No auth")?.refresh_token.clone()
    };

    let pair = exchange_refresh_token(&refresh_token).await?;

    {
        let mut guard = state.lock().unwrap();
        let auth = guard.as_mut().ok_or("No auth")?;
        auth.access_token = pair.access_token.clone();
        auth.refresh_token = pair.refresh_token.clone();
        auth.expires_at = pair.expires_at;
    }

    credentials::save(&pair.access_token, &pair.refresh_token, pair.expires_at);

    blog!("[bardo] webapi refresh OK");

    Ok(())
}

fn save_playback_credentials_async(username: String, auth_data: Vec<u8>) {
    tokio::task::spawn_blocking(move || {
        let creds = librespot_core::authentication::Credentials {
            username: Some(username),
            auth_type: librespot_protocol::authentication::AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS,
            auth_data,
        };
        credentials::save_playback(&creds);
    });
}

/// streaming/spirc login needs an access token minted for spotify's own
/// desktop client identity (what `sessionconfig::default()` already uses):
/// a token from a third-party developer app is accepted at the oauth
/// consent screen but then rejected by login5 with invalid_credentials.
/// this is a separate grant from the web api one (different client, only
/// the `streaming` scope, its own loopback callback port), matching how
/// librespot's own `play_connect` example and spotifast both do it.
async fn obtain_playback_access_token() -> Result<String, String> {
    let client_id = librespot_core::config::SessionConfig::default().client_id;

    tokio::task::spawn_blocking(move || {
        librespot_oauth::OAuthClientBuilder::new(
            &client_id,
            "http://127.0.0.1:8898/login",
            vec!["streaming"],
        )
        .open_in_browser()
        .build()
        .map_err(|e| format!("Playback OAuth build failed: {e}"))?
        .get_access_token()
        .map(|t| t.access_token)
        .map_err(|e| format!("Playback OAuth failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task failed: {e}"))?
}

async fn playback_credentials(
    allow_prompt: bool,
) -> Result<Option<librespot_core::authentication::Credentials>, String> {
    if let Some(creds) = credentials::load_playback() {
        return Ok(Some(creds));
    }
    if !allow_prompt {
        return Ok(None);
    }
    let token = obtain_playback_access_token().await?;
    Ok(Some(librespot_core::authentication::Credentials::with_access_token(token)))
}

/// starts the spirc/connect session, preferring a previously stored reusable
/// login (see `credentials::save_playback`) over asking the browser again.
/// with `allow_prompt`, opens the playback sign-in when nothing is stored yet,
/// or retries with a fresh one if the stored credentials were revoked.
async fn start_playback_session(
    allow_prompt: bool,
) -> Result<
    Option<(
        librespot_core::session::Session,
        Arc<librespot_playback::player::Player>,
        Arc<librespot_playback::mixer::softmixer::SoftMixer>,
        librespot_connect::Spirc,
        impl std::future::Future<Output = ()>,
    )>,
    String,
> {
    let had_stored = credentials::load_playback().is_some();

    let Some(creds) = playback_credentials(allow_prompt).await? else {
        return Ok(None);
    };

    let parts = match LibrespotPlayer::init_spirc(creds).await {
        Ok(parts) => parts,
        Err(e) if had_stored && allow_prompt => {
            blog!(
                "[bardo] stored playback credentials failed ({e}); requesting a fresh playback sign-in"
            );
            let token = obtain_playback_access_token().await?;
            let fallback = librespot_core::authentication::Credentials::with_access_token(token);
            LibrespotPlayer::init_spirc(fallback).await?
        }
        Err(e) => return Err(e),
    };

    let (session, ..) = &parts;
    save_playback_credentials_async(session.username(), session.auth_data());

    Ok(Some(parts))
}

fn spawn_webapi_refresh(state: State<'_, WebApiState>) {
    let mut task_guard = state.refresh_task.lock().unwrap();

    if task_guard.is_some() {
        blog!("[bardo] refresh loop already running, skipping spawn");
        return;
    }

    let auth_state = state.auth.clone();

    let handle = tokio::spawn(async move {
        blog!("[bardo] started webapi refresh loop");

        loop {
            let sleep_duration = {
                let guard = auth_state.lock().unwrap();

                if let Some(auth) = guard.as_ref() {
                    let now = Instant::now();

                    if auth.expires_at <= now {
                        Duration::from_secs(1)
                    } else {
                        let remaining = auth.expires_at - now;

                        let sleep = remaining
                            .checked_sub(Duration::from_secs(60))
                            .unwrap_or(Duration::from_secs(1));

                        sleep
                    }
                } else {
                    Duration::from_secs(5)
                }
            };

            tokio::time::sleep(sleep_duration).await;

            blog!("[bardo] triggering webapi refresh...");

            match refresh_webapi_token(auth_state.clone()).await {
                Ok(_) => {
                    blog!("[bardo] refresh cycle completed");
                }
                Err(e) => {
                    blog!("[bardo] refresh failed: {e}");
                }
            }
        }
    });

    *task_guard = Some(handle);
}

async fn try_restore_session(app: AppHandle) {
    let Some(saved) = credentials::load() else {
        blog!("[bardo] no saved session found");
        return;
    };

    blog!("[bardo] restoring saved session...");

    let pair = if saved.expires_at <= Instant::now() {
        match exchange_refresh_token(&saved.refresh_token).await {
            Ok(pair) => pair,
            Err(e) => {
                blog!("[bardo] failed to refresh saved session: {e}");
                return;
            }
        }
    } else {
        TokenPair {
            access_token: saved.access_token,
            refresh_token: saved.refresh_token,
            expires_at: saved.expires_at,
        }
    };

    credentials::save(&pair.access_token, &pair.refresh_token, pair.expires_at);

    let web_state = app.state::<WebApiState>();
    *web_state.auth.lock().unwrap() = Some(WebApiAuth {
        access_token: pair.access_token.clone(),
        refresh_token: pair.refresh_token,
        expires_at: pair.expires_at,
    });

    // never pop a browser window on startup; playback stays off until the
    // user signs in again if no playback credentials were saved yet.
    match start_playback_session(false).await {
        Ok(Some((session, player, mixer, spirc, spirc_task))) => {
            tokio::spawn(async move {
                spirc_task.await;
                blog!("[bardo] spirc task ended");
            });

            let p = LibrespotPlayer::from_parts(session, player, mixer, spirc, app.clone());
            let player_state = app.state::<PlayerState>();
            *player_state.0.lock().unwrap() = Some(p);

            spawn_webapi_refresh(web_state);

            blog!("[bardo] session restored");
        }
        Ok(None) => {
            blog!("[bardo] no playback credentials saved yet; sign in again to enable playback");
            spawn_webapi_refresh(web_state);
        }
        Err(e) => {
            blog!("[bardo] failed to restore playback session: {e}");
        }
    }
}

#[tauri::command]
async fn run_spotify_login(
    web_state: State<'_, WebApiState>,
    player_state: State<'_, PlayerState>,
    app: AppHandle,
) -> Result<(), String> {
    blog!("[bardo] run_spotify_login called");
    blog!("[bardo] client_id: {}", spotify_client_id());

    let token = tokio::task::spawn_blocking(|| {
        librespot_oauth::OAuthClientBuilder::new(
            spotify_client_id(),
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

    blog!("[bardo] OAuth succeeded");

    let auth = WebApiAuth {
        access_token: token.access_token.clone(),
        refresh_token: token.refresh_token.clone(),
        expires_at: token.expires_at,
    };

    *web_state.auth.lock().unwrap() = Some(auth);

    credentials::save(&token.access_token, &token.refresh_token, token.expires_at);

    blog!("[bardo] initializing librespot session...");

    let Some((session, player, mixer, spirc, spirc_task)) = start_playback_session(true).await?
    else {
        return Err("playback sign-in did not complete".into());
    };

    tokio::spawn(async move {
        spirc_task.await;
        blog!("[bardo] spirc task ended");
    });

    let p = LibrespotPlayer::from_parts(
        session,
        player,
        mixer,
        spirc,
        app,
    );

    *player_state.0.lock().unwrap() = Some(p);

    spawn_webapi_refresh(web_state.clone());

    blog!("[bardo] login complete");

    Ok(())
}

/// fast, local check (no network) so the login screen knows whether it's
/// worth waiting on `try_restore_session` instead of showing the login
/// button right away for a first-time user.
#[tauri::command]
fn has_saved_credentials() -> bool {
    credentials::load().is_some()
}

#[tauri::command]
fn get_access_token(web_state: State<'_, WebApiState>) -> Result<String, String> {
    web_state
        .auth
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.access_token.clone())
        .ok_or("Not logged in.".into())
}

#[tauri::command]
fn get_client_id() -> String {
    spotify_client_id().to_string()
    
}

#[tauri::command]
fn player_play_track(
    uri: String,
    player_state: State<'_, PlayerState>,
) -> Result<(), String> {
    blog!("[bardo] play_track: {uri}");

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
    blog!("[bardo] pause()");

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
    blog!("[bardo] resume()");

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
    blog!("[bardo] seek({position_ms}ms)");

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
    blog!("[bardo] set_volume({volume} -> raw {v})");

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
        .manage(WebApiState {
            auth: Arc::new(Mutex::new(None)),
            refresh_task: Arc::new(Mutex::new(None)),
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let _ = APP_HANDLE.set(app_handle.clone());
            tauri::async_runtime::spawn(try_restore_session(app_handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_spotify_login,
            has_saved_credentials,
            get_access_token,
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
