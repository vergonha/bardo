use souvlaki::{MediaControls, MediaMetadata, MediaPlayback};
use crate::osmc::init_media_controls;
use tauri::Manager;
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
use crate::blog;

pub const SCOPES: &[&str] = &[
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
    inner: Arc<Mutex<PlayerInner>>,
}

impl LibrespotPlayer {
    pub fn from_parts(
        session: Session,
        player: Arc<Player>,
        mixer: Arc<SoftMixer>,
        spirc: Spirc,
        app_handle: AppHandle,
    ) -> Self {
        blog!("[bardo] building LibrespotPlayer");
        let spirc = Arc::new(spirc);

        #[cfg(target_os = "windows")]
        let hwnd = app_handle
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as *mut std::ffi::c_void);

        // todo
        #[cfg(not(target_os = "windows"))]
        let hwnd = None;

        let media_controls = init_media_controls(hwnd, app_handle.clone());

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
            media_controls.clone(),
        );

        Self::spawn_position_ticker(app_handle, inner.clone());

        blog!("[bardo] LibrespotPlayer ready");

        Self {
            player,
            mixer,
            spirc,
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
            blog!("[bardo] Attempt {attempt}/5: creating fresh session...");

            let session = Session::new(SessionConfig::default(), None);
            let mixer = Arc::new(SoftMixer::open(MixerConfig::default()).unwrap());

            blog!("[bardo] Attempt {attempt}/5: creating player...");

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

            blog!("[bardo] Attempt {attempt}/5: starting Spirc...");

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
                    blog!(
                        "[bardo] Spirc started on attempt {attempt}. Username: {:?}",
                        session.username()
                    );
                    return Ok((session, player, mixer, spirc, task));
                }
                Err(e) => {
                    last_err = e.to_string();
                    blog!("[bardo] Spirc failed (attempt {attempt}): {e}");
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
        media_controls: Arc<Mutex<MediaControls>>,
    ) {
        tokio::spawn(async move {
            blog!("[bardo] Event loop started.");

            while let Some(event) = event_channel.recv().await {
                match event {
                    PlayerEvent::TrackChanged { audio_item } => {
                        blog!("[bardo] TrackChanged: {}", audio_item.uri);

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

                            let title = track.name.clone();
                            let album = track.album.name.clone();

                            let info = TrackInfo {
                                name: title.clone(),
                                artists: artists.clone(),
                                album: album.clone(),
                                image_url: image_url.clone(),
                                duration_ms: track.duration as u32,
                                uri: audio_item.uri.clone(),
                            };

                            blog!(
                                "[bardo] Emitting track_changed: {} - {}",
                                info.name, artists
                            );

                            let mc = media_controls.clone();
                            tokio::task::spawn_blocking(move || {
                                if let Ok(mut mc) = mc.lock() {
                                    let _ = mc.set_metadata(MediaMetadata {
                                        title: Some(&title),
                                        artist: Some(&artists),
                                        album: Some(&album),
                                        cover_url: Some(&image_url),
                                        ..Default::default()
                                    });
                                    let _ = mc.set_playback(MediaPlayback::Playing {
                                        progress: None,
                                    });
                                }
                            });

                            let _ = app.emit("track_changed", info);
                        }
                    }
                    PlayerEvent::Playing { position_ms, .. } => {
                        blog!("[bardo] Playing at {position_ms}ms");

                        let mut s = inner.lock().unwrap();
                        s.position_ms = position_ms;
                        s.started_at = Some(Instant::now());
                        s.is_playing = true;

                        let mc = media_controls.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Ok(mut mc) = mc.lock() {
                                let _ = mc.set_playback(MediaPlayback::Playing { progress: None });
                            }
                        });
                    }
                    PlayerEvent::Paused { position_ms, .. } => {
                        blog!("[bardo] Paused at {position_ms}ms");

                        let mut s = inner.lock().unwrap();
                        s.position_ms = position_ms;
                        s.started_at = None;
                        s.is_playing = false;

                        let _ = app.emit("player_paused", ());

                        let mc = media_controls.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Ok(mut mc) = mc.lock() {
                                let _ = mc.set_playback(MediaPlayback::Paused { progress: None });
                            }
                        });
                    }
                    PlayerEvent::Stopped { .. } => {
                        blog!("[bardo] Stopped.");

                        let mut s = inner.lock().unwrap();
                        s.position_ms = 0;
                        s.started_at = None;
                        s.is_playing = false;

                        let _ = app.emit("player_stopped", ());
                        let mc = media_controls.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Ok(mut mc) = mc.lock() {
                                let _ = mc.set_playback(MediaPlayback::Stopped);
                            }
                        });
                    }
                    PlayerEvent::EndOfTrack { .. } => {
                        blog!("[bardo] EndOfTrack.");

                        let mut s = inner.lock().unwrap();
                        s.position_ms = 0;
                        s.started_at = None;
                        s.is_playing = false;

                        let _ = app.emit("track_ended", ());

                        let mc = media_controls.clone();
                        tokio::task::spawn_blocking(move || {
                            if let Ok(mut mc) = mc.lock() {
                                let _ = mc.set_playback(MediaPlayback::Stopped);
                            }
                        });
                    }
                    _ => {}
                }
            }

            blog!("[bardo] WARNING: event_channel closed — event loop exited");
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
        blog!("[bardo] play_track: {uri}");
        load_uri(&self.player, &uri);
    }

    pub fn pause(&self) {
        blog!("[bardo] pause()");
        self.player.pause();
    }

    pub fn resume(&self) {
        blog!("[bardo] resume()");
        self.player.play();
    }

    pub fn seek(&self, position_ms: u32) {
        blog!("[bardo] seek({position_ms}ms)");
        self.player.seek(position_ms);

        let mut s = self.inner.lock().unwrap();
        s.position_ms = position_ms;
        s.started_at = Some(Instant::now());
    }

    pub fn set_volume(&self, volume: f64) {
        let v = (volume * u16::MAX as f64).clamp(0.0, u16::MAX as f64) as u16;
        blog!("[bardo] set_volume({volume} -> raw {v})");
        self.mixer.set_volume(v);
    }

    pub fn stop(&self) {
        blog!("[bardo] stop()");
        self.player.stop();
    }
}

fn load_uri(player: &Arc<Player>, uri: &str) {
    let id_str = uri.split(':').nth(2).unwrap_or("");

    match SpotifyId::from_base62(id_str) {
        Ok(id) => {
            blog!("[bardo] load_uri: {uri}");
            player.load(SpotifyUri::Track { id }, true, 0);
        }
        Err(_) => blog!("[bardo] load_uri: invalid URI: {uri}"),
    }
}
