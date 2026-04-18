use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use librespot_connect::{ConnectConfig, Spirc};
use librespot_core::{
    authentication::Credentials,
    config::SessionConfig,
    session::Session,
    spotify_id::SpotifyId,
    spotify_uri::SpotifyUri,
};
use librespot_metadata::{Metadata, Track};
use librespot_oauth::OAuthClientBuilder;
use librespot_playback::{
    audio_backend,
    config::{AudioFormat, PlayerConfig},
    mixer::{softmixer::SoftMixer, Mixer, MixerConfig},
    player::{Player, PlayerEvent},
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SPOTIFY_CLIENT_ID: &str = "6eb9dc7f1df14d7aa1d9ad394c763799";
const REDIRECT_URI: &str = "http://127.0.0.1:8888/login";

const SCOPES: &[&str] = &[
    "streaming",
    "user-read-email",
    "user-read-private",
    "app-remote-control",
    "user-read-playback-state",
    "user-modify-playback-state",
    "playlist-read-private",
    "playlist-read-collaborative",
];

#[derive(Serialize, Clone, Debug)]
pub struct TrackInfo {
    pub name: String,
    pub artists: String,
    pub album: String,
    pub image_url: String,
    pub duration_ms: u32,
    pub uri: String,
}

struct PlayerInner {
    position_ms: u32,
    started_at: Option<Instant>,
    is_playing: bool,
}

impl PlayerInner {
    fn current_position(&self) -> u32 {
        if self.is_playing {
            if let Some(started) = self.started_at {
                return self.position_ms
                    + started.elapsed().as_millis() as u32;
            }
        }
        self.position_ms
    }
}

pub struct LibrespotPlayer {
    pub player: Arc<Player>,
    pub mixer: Arc<SoftMixer>,
    pub spirc: Arc<Spirc>,
    pub queue: Arc<Mutex<Vec<String>>>,
    pub access_token: String,
    inner: Arc<Mutex<PlayerInner>>,
}

impl LibrespotPlayer {
    pub async fn new(app_handle: AppHandle) -> Result<Self, String> {
        eprintln!("[bardo] Starting OAuth flow...");

        let token = tokio::task::spawn_blocking(|| {
            OAuthClientBuilder::new(
                SPOTIFY_CLIENT_ID,
                REDIRECT_URI,
                SCOPES.to_vec(),
            )
            .open_in_browser()
            .build()
            .map_err(|e| format!("OAuth build failed: {e}"))?
            .get_access_token()
            .map_err(|e| format!("OAuth failed: {e}"))
        })
        .await
        .map_err(|e| format!("Task failed: {e}"))??;

        eprintln!(
            "[bardo] OAuth succeeded. Expires in {:#?}s",
            token.expires_at
        );

        let access_token = token.access_token.clone();
        let credentials = Credentials::with_access_token(&access_token);

        // Retry loop — each attempt gets a completely fresh session
        eprintln!("[bardo] Initializing session + Spirc...");
        let (session, player, mixer, spirc, spirc_task) =
            Self::init_spirc(credentials.clone()).await?;

        // Watch spirc task — if it exits, device disappears
        tokio::spawn(async move {
            spirc_task.await;
            eprintln!(
                "[bardo] WARNING: spirc_task ended — \
                 device disappeared from Spotify Connect"
            );
        });

        let queue: Arc<Mutex<Vec<String>>> =
            Arc::new(Mutex::new(vec![]));
        let inner = Arc::new(Mutex::new(PlayerInner {
            position_ms: 0,
            started_at: None,
            is_playing: false,
        }));

        Self::spawn_event_loop(
            player.get_player_event_channel(),
            session,
            app_handle.clone(),
            queue.clone(),
            player.clone(),
            inner.clone(),
        );

        Self::spawn_position_ticker(app_handle, inner.clone());

        eprintln!(
            "[bardo] LibrespotPlayer ready. \
             Device 'Bardo' should be visible."
        );

        Ok(Self {
            player,
            mixer,
            spirc: Arc::new(spirc),
            queue,
            access_token,
            inner,
        })
    }

    pub async fn transfer_playback(
        access_token: &str,
        device_id: &str,
    ) -> Result<(), String> {
        eprintln!("[bardo] Transferring playback to device {device_id}...");
        let client = reqwest::Client::new();
        let res = client
            .put("https://api.spotify.com/v1/me/player")
            .bearer_auth(access_token)
            .json(&serde_json::json!({
                "device_ids": [device_id],
                "play": false
            }))
            .send()
            .await
            .map_err(|e| format!("Transfer playback request failed: {e}"))?;

        let status = res.status();
        if status.is_success() || status.as_u16() == 204 {
            eprintln!("[bardo] Playback transferred successfully.");
            Ok(())
        } else {
            let body = res.text().await.unwrap_or_default();
            Err(format!("Transfer playback failed ({status}): {body}"))
        }
    }    

    async fn init_spirc(
        credentials: Credentials,
    ) -> Result<
        (
            Session,
            Arc<Player>,
            Arc<SoftMixer>,
            Spirc,
            impl std::future::Future<Output = ()>,
        ),
        String,
    > {
        let audio_format = AudioFormat::default();
        let backend = audio_backend::find(None).unwrap();
        let mut last_err = String::new();

        for attempt in 1u8..=5 {
            eprintln!("[bardo] Attempt {attempt}/5: creating fresh session...");

            // Do NOT call session.connect() — Spirc::new() does it internally
            // after registering its own message listeners first
            let session = Session::new(SessionConfig::default(), None);

            let mixer =
                Arc::new(SoftMixer::open(MixerConfig::default()).unwrap());

            eprintln!("[bardo] Attempt {attempt}/5: creating player...");
            let player = Player::new(
                PlayerConfig::default(),
                session.clone(),
                mixer.get_soft_volume(),
                move || backend(None, audio_format),
            );

            let connect_config = ConnectConfig {
                name: "Bardo".to_string(),
                ..Default::default()
            };

            eprintln!("[bardo] Attempt {attempt}/5: starting Spirc...");
            match Spirc::new(
                connect_config,
                session.clone(),
                credentials.clone(),
                player.clone(),
                mixer.clone(),
            )
            .await
            {
                Ok((spirc, task)) => {
                    eprintln!(
                        "[bardo] Spirc started on attempt {attempt}. \
                        Username: {:?}",
                        session.username()
                    );
                    return Ok((session, player, mixer, spirc, task));
                }
                Err(e) => {
                    last_err = e.to_string();
                    eprintln!("[bardo] Spirc failed (attempt {attempt}): {e}");
                    tokio::time::sleep(Duration::from_millis(
                        500 * attempt as u64,
                    ))
                    .await;
                }
            }
        }

        Err(format!("Failed after 5 attempts: {last_err}"))
    }

    fn spawn_event_loop(
        mut event_channel: librespot_playback::player::PlayerEventChannel,
        session: Session,
        app: AppHandle,
        queue: Arc<Mutex<Vec<String>>>,
        player: Arc<Player>,
        inner: Arc<Mutex<PlayerInner>>,
    ) {
        tokio::spawn(async move {
            eprintln!("[bardo] Event loop started.");
            while let Some(event) = event_channel.recv().await {
                match event {
                    PlayerEvent::TrackChanged { audio_item } => {
                        eprintln!(
                            "[bardo] TrackChanged: {}",
                            audio_item.uri
                        );
                        match Track::get(&session, &audio_item.track_id)
                            .await
                        {
                            Ok(track) => {
                                let artists = track
                                    .artists
                                    .0
                                    .iter()
                                    .map(|a| a.name.clone())
                                    .collect::<Vec<_>>()
                                    .join(", ");

                                let image_url = track
                                    .album
                                    .cover_group
                                    .0
                                    .first()
                                    .map(|img| {
                                        format!(
                                            "https://i.scdn.co/image/{}",
                                            img.id
                                                .to_string()
                                                .to_lowercase()
                                        )
                                    })
                                    .unwrap_or_default();

                                let info = TrackInfo {
                                    name: track.name.clone(),
                                    artists: artists.clone(),
                                    album: track.album.name.clone(),
                                    image_url,
                                    duration_ms: track.duration as u32,
                                    uri: audio_item.uri.clone(),
                                };
                                eprintln!(
                                    "[bardo] Emitting track_changed: {} - {}",
                                    info.name, artists
                                );
                                let _ = app.emit("track_changed", info);
                            }
                            Err(e) => eprintln!(
                                "[bardo] Track fetch error: {e}"
                            ),
                        }
                    }

                    PlayerEvent::Playing { position_ms, .. } => {
                        eprintln!("[bardo] Playing at {position_ms}ms");
                        let mut s = inner.lock().unwrap();
                        s.position_ms = position_ms;
                        s.started_at = Some(Instant::now());
                        s.is_playing = true;
                        let _ = app.emit("player_playing", ());
                    }

                    PlayerEvent::Paused { position_ms, .. } => {
                        eprintln!("[bardo] Paused at {position_ms}ms");
                        let mut s = inner.lock().unwrap();
                        s.position_ms = position_ms;
                        s.started_at = None;
                        s.is_playing = false;
                        let _ = app.emit("player_paused", position_ms);
                    }

                    PlayerEvent::Stopped { .. } => {
                        eprintln!("[bardo] Stopped.");
                        let mut s = inner.lock().unwrap();
                        s.position_ms = 0;
                        s.started_at = None;
                        s.is_playing = false;
                        let _ = app.emit("player_stopped", ());
                    }

                    PlayerEvent::EndOfTrack { .. } => {
                        eprintln!("[bardo] EndOfTrack.");
                        {
                            let mut s = inner.lock().unwrap();
                            s.position_ms = 0;
                            s.started_at = None;
                            s.is_playing = false;
                        }
                        let next =
                            queue.lock().unwrap().drain(..1).next();
                        match next {
                            Some(uri) => {
                                eprintln!(
                                    "[bardo] Advancing to: {uri}"
                                );
                                load_uri(&player, &uri);
                            }
                            None => {
                                eprintln!("[bardo] Queue empty.");
                                let _ = app.emit("track_ended", ());
                            }
                        }
                    }

                    _ => {}
                }
            }
            eprintln!(
                "[bardo] WARNING: event_channel closed — event loop exited"
            );
        });
    }

    fn spawn_position_ticker(
        app: AppHandle,
        inner: Arc<Mutex<PlayerInner>>,
    ) {
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let (is_playing, pos) = {
                    let s = inner.lock().unwrap();
                    (s.is_playing, s.current_position())
                };
                if is_playing {
                    let _ = app.emit("position_changed", pos);
                }
            }
        });
    }

    pub fn play_tracks(&self, uris: Vec<String>) {
        let mut iter = uris.into_iter();
        if let Some(first) = iter.next() {
            let mut q = self.queue.lock().unwrap();
            q.clear();
            q.extend(iter);
            drop(q);
            eprintln!("[bardo] play_tracks: loading {first}");
            load_uri(&self.player, &first);
            
        }
    }

    pub fn next_track(&self) {
        let next = self.queue.lock().unwrap().drain(..1).next();
        match next {
            Some(uri) => {
                eprintln!("[bardo] next_track: {uri}");
                load_uri(&self.player, &uri);
            }
            None => {
                eprintln!("[bardo] next_track: queue empty, stopping.");
                self.player.stop();
            }
        }
    }

    pub fn pause(&self) {
        eprintln!("[bardo] pause()");
        self.player.pause();
    }

    pub fn resume(&self) {
        eprintln!("[bardo] resume()");
        self.player.play();
    }

    pub fn seek(&self, position_ms: u32) {
        eprintln!("[bardo] seek({position_ms}ms)");
        self.player.seek(position_ms);
        let mut s = self.inner.lock().unwrap();
        s.position_ms = position_ms;
        s.started_at = Some(Instant::now());
    }

    pub fn set_volume(&self, volume: f64) {
        let v = (volume * u16::MAX as f64).clamp(0.0, u16::MAX as f64)
            as u16;
        eprintln!("[bardo] set_volume({volume} -> raw {v})");
        self.mixer.set_volume(v);
    }

    pub fn stop(&self) {
        eprintln!("[bardo] stop()");
        self.player.stop();
    }
}

fn load_uri(player: &Arc<Player>, uri: &str) {
    let id_str = uri.split(':').nth(2).unwrap_or("");
    match SpotifyId::from_base62(id_str) {
        Ok(id) => {
            eprintln!("[bardo] load_uri: {uri}");
            player.load(SpotifyUri::Track { id }, true, 0);
        }
        Err(_) => eprintln!("[bardo] load_uri: invalid URI: {uri}"),
    }
}