use keyring::Entry;
use librespot_core::authentication::Credentials;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const SERVICE: &str = "bardo";
const USER: &str = "spotify";
const PLAYBACK_USER: &str = "spotify-playback";

#[derive(Serialize, Deserialize)]
struct StoredToken {
    access_token: String,
    refresh_token: String,
    expires_at_unix: u64,
}

pub struct SavedAuth {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: Instant,
}

pub fn save(access_token: &str, refresh_token: &str, expires_at: Instant) {
    let remaining = expires_at.saturating_duration_since(Instant::now());
    let stored = StoredToken {
        access_token: access_token.to_string(),
        refresh_token: refresh_token.to_string(),
        expires_at_unix: now_unix() + remaining.as_secs(),
    };

    let Ok(json) = serde_json::to_string(&stored) else {
        eprintln!("[bardo] failed to serialize credentials");
        return;
    };

    match Entry::new(SERVICE, USER).and_then(|entry| entry.set_password(&json)) {
        Ok(()) => eprintln!("[bardo] saved credentials to the system credential store"),
        Err(e) => eprintln!("[bardo] failed to save credentials: {e}"),
    }
}

pub fn load() -> Option<SavedAuth> {
    let entry = Entry::new(SERVICE, USER).ok()?;
    let json = entry.get_password().ok()?;
    let stored: StoredToken = serde_json::from_str(&json).ok()?;

    let now = now_unix();
    let expires_at = if stored.expires_at_unix > now {
        Instant::now() + Duration::from_secs(stored.expires_at_unix - now)
    } else {
        Instant::now()
    };

    Some(SavedAuth {
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
        expires_at,
    })
}

/// reusable spotify connect login (`authentication_stored_spotify_credentials`),
/// exchanged once from an oauth access token by librespot's own login flow.
/// spotify's login5 endpoint has grown far less tolerant of a bare oauth
/// access token being resubmitted on every restart, so this is kept and
/// reused instead of calling `credentials::with_access_token` again.
pub fn save_playback(credentials: &Credentials) {
    let Ok(json) = serde_json::to_string(credentials) else {
        eprintln!("[bardo] failed to serialize playback credentials");
        return;
    };

    match Entry::new(SERVICE, PLAYBACK_USER).and_then(|entry| entry.set_password(&json)) {
        Ok(()) => eprintln!("[bardo] saved playback credentials to the system credential store"),
        Err(e) => eprintln!("[bardo] failed to save playback credentials: {e}"),
    }
}

pub fn load_playback() -> Option<Credentials> {
    let entry = Entry::new(SERVICE, PLAYBACK_USER).ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
