#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use tiny_http::{Header, Response, Server};
use url::Url;

#[derive(Default)]
pub struct SpotifyState {
    pub access_token: Mutex<Option<String>>,
    pub refresh_token: Mutex<Option<String>>,
}

#[derive(Deserialize, Serialize, Debug)]
struct SpotifyTokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
    scope: String,
}

#[derive(Deserialize)]
struct AppConfig {
    spotify: SpotifyConfig,
}

#[derive(Deserialize)]
struct SpotifyConfig {
    client_id: String,
    client_secret: String,
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .expect("Couldn't find config folder.")
        .join("bardo")
        .join("bardo.config.toml")
}

fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    let content = fs::read_to_string(&path).map_err(|_| {
        format!(
            "bardo.config.toml not found. Path {}. Create bardo.config.toml.",
            path.display()
        )
    })?;
    toml::from_str(&content).map_err(|e| format!("Erro ao ler config.toml: {e}"))
}

#[tauri::command]
async fn run_spotify_login(state: State<'_, SpotifyState>) -> Result<String, String> {
    let code = tokio::task::spawn_blocking(|| -> Result<String, String> {
        eprintln!("[bardo] awaiting callback...");
        let server = Server::http("127.0.0.1:8080").map_err(|e| e.to_string())?;
        let request = server.recv().map_err(|e| e.to_string())?;
        eprintln!("[bardo] request: {}", request.url());

        let raw_url = format!("http://127.0.0.1:8080{}", request.url());
        let url = Url::parse(&raw_url).map_err(|e| e.to_string())?;

        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.into_owned())
            .ok_or("Code not found.".to_string())?;

        let html = "<html><body><h1>Pode fechar esta aba!</h1></body></html>";
        let response = Response::from_string(html)
            .with_header(Header::from_bytes(&b"Content-Type"[..], &b"text/html"[..]).unwrap());
        request.respond(response).map_err(|e| e.to_string())?;

        Ok(code)
    })
    .await
    .map_err(|e| e.to_string())??;

    eprintln!("[bardo] crafting token...");
    let tokens = craft_token(&code).await?;
    eprintln!("[bardo] token crafted!");

    *state.access_token.lock().unwrap() = Some(tokens.access_token.clone());
    if let Some(ref rt) = tokens.refresh_token {
        *state.refresh_token.lock().unwrap() = Some(rt.clone());
        save_on_keychain(rt)?;
    }

    Ok(tokens.access_token)
}

#[tauri::command]
fn get_access_token(state: State<'_, SpotifyState>) -> Result<String, String> {
    let token = state.access_token.lock().unwrap();
    token.clone().ok_or("Need to Login.".into())
}

#[tauri::command]
async fn refresh_token(state: State<'_, SpotifyState>) -> Result<String, String> {
    let config = load_config()?;

    let refresh_token = {
        let rt = state.refresh_token.lock().unwrap();
        rt.clone()
    };
    let refresh_token = match refresh_token {
        Some(rt) => rt,
        None => read_from_keychain()?,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(
            &config.spotify.client_id,
            Some(&config.spotify.client_secret),
        )
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let tokens: SpotifyTokenResponse = response.json().await.map_err(|e| e.to_string())?;
    *state.access_token.lock().unwrap() = Some(tokens.access_token.clone());
    Ok(tokens.access_token)
}

fn save_on_keychain(refresh_token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new("bardo", "refresh_token").map_err(|e| e.to_string())?;
    entry
        .set_password(refresh_token)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_from_keychain() -> Result<String, String> {
    let entry = keyring::Entry::new("bardo", "refresh_token").map_err(|e| e.to_string())?;
    entry
        .get_password()
        .map_err(|_| "Refresh token not found.".into())
}

async fn craft_token(code: &str) -> Result<SpotifyTokenResponse, String> {
    let config = load_config()?;
    let redirect_uri = "http://127.0.0.1:8080";

    let client = reqwest::Client::new();
    let response = client
        .post("https://accounts.spotify.com/api/token")
        .basic_auth(
            &config.spotify.client_id,
            Some(&config.spotify.client_secret),
        )
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    response.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn check_config() -> Result<(), String> {
    load_config().map(|_| ())
}

#[tauri::command]
fn get_client_id() -> Result<String, String> {
    load_config().map(|c| c.spotify.client_id)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SpotifyState::default())
        .invoke_handler(tauri::generate_handler![
            run_spotify_login,
            get_access_token,
            refresh_token,
            check_config,
            get_client_id
        ])
        .run(tauri::generate_context!())
        .expect("...");
}
