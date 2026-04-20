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
use librespot_playback::mixer::Mixer;
use librespot_playback::{
    audio_backend,
    config::{AudioFormat, PlayerConfig},
    mixer::{softmixer::SoftMixer, MixerConfig},
    player::{Player, PlayerEvent},
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const SPOTIFY_CLIENT_ID: &str = "6eb9dc7f1df14d7aa1d9ad394c763799";
pub const SCOPES: &[&str] = &[
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
                return self.position_ms + started.elapsed().as_millis() as u32;
            }
        }
        self.position_ms
    }
}

pub struct LibrespotPlayer {
    pub player: Arc<Player>,
    pub mixer: Arc<SoftMixer>,
    pub spirc: Arc<Spirc>,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: Instant,
    inner: Arc<Mutex<PlayerInner>>,
}

impl LibrespotPlayer {
    pub fn from_parts(
        session: Session,
        player: Arc<Player>,
        mixer: Arc<SoftMixer>,
        spirc: Spirc,
        access_token: String,
        refresh_token: String,
        expires_at: Instant,
        app_handle: AppHandle,
    ) -> Self {
        eprintln!("[bardo] building LibrespotPlayer");

        let inner = Arc::new(Mutex::new(PlayerInner {
            position_ms: 0,
            started_at: None,
            is_playing: false,
        }));

        Self::spawn_event_loop(
            player.get_player_event_channel(),
            session,
            app_handle.clone(),
            inner.clone(),
        );

        Self::spawn_position_ticker(app_handle, inner.clone());

        eprintln!("[bardo] LibrespotPlayer ready");

        Self {
            player,
            mixer,
            spirc: Arc::new(spirc),
            access_token,
            refresh_token,
            expires_at,
            inner,
        }
    }

    pub async fn init_spirc(
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

            let session = Session::new(SessionConfig::default(), None);
            let mixer = Arc::new(SoftMixer::open(MixerConfig::default()).unwrap());

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
                        "[bardo] Spirc started on attempt {attempt}. Username: {:?}",
                        session.username()
                    );
                    return Ok((session, player, mixer, spirc, task));
                }
                Err(e) => {
                    last_err = e.to_string();
                    eprintln!("[bardo] Spirc failed (attempt {attempt}): {e}");
                    tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
                }
            }
        }

        Err(format!("Failed after 5 attempts: {last_err}"))
    }

    fn spawn_event_loop(
        mut event_channel: librespot_playback::player::PlayerEventChannel,
        session: Session,
        app: AppHandle,
        inner: Arc<Mutex<PlayerInner>>,
    ) {
        tokio::spawn(async move {
            eprintln!("[bardo] Event loop started.");

            while let Some(event) = event_channel.recv().await {
                match event {
                    PlayerEvent::TrackChanged { audio_item } => {
                        eprintln!("[bardo] TrackChanged: {}", audio_item.uri);

                        if let Ok(track) =
                            Track::get(&session, &audio_item.track_id).await
                        {
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
                                        img.id.to_string().to_lowercase()
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
                    }
                    PlayerEvent::Playing { position_ms, .. } => {
                        eprintln!("[bardo] Playing at {position_ms}ms");

                        let mut s = inner.lock().unwrap();
                        s.position_ms = position_ms;
                        s.started_at = Some(Instant::now());
                        s.is_playing = true;
                    }
                    PlayerEvent::Paused { position_ms, .. } => {
                        eprintln!("[bardo] Paused at {position_ms}ms");

                        let mut s = inner.lock().unwrap();
                        s.position_ms = position_ms;
                        s.started_at = None;
                        s.is_playing = false;

                        let _ = app.emit("player_paused", ());
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

                        let _ = app.emit("track_ended", ());
                    }
                    _ => {}
                }
            }

            eprintln!("[bardo] WARNING: event_channel closed — event loop exited");
        });
    }

    fn spawn_position_ticker(app: AppHandle, inner: Arc<Mutex<PlayerInner>>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));

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

    pub fn play_track(&self, uri: String) {
        eprintln!("[bardo] play_track: {uri}");
        load_uri(&self.player, &uri);
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
        let v = (volume * u16::MAX as f64).clamp(0.0, u16::MAX as f64) as u16;
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