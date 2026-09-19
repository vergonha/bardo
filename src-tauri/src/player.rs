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
    config::PlayerConfig,
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
    "user-read-recently-played",
    "user-top-read",
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
    session: Session,
    inner: Arc<Mutex<PlayerInner>>,
    ticker_handle: tokio::task::JoinHandle<()>,
}

impl Drop for LibrespotPlayer {
    fn drop(&mut self) {
        self.ticker_handle.abort();
    }
}

impl LibrespotPlayer {
    pub fn from_parts(
        session: Session,
        player: Arc<Player>,
        mixer: Arc<SoftMixer>,
        spirc: Spirc,
        app_handle: AppHandle,
    ) -> Self {
        blog!("[bardo player] building LibrespotPlayer");
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
            session.clone(),
            app_handle.clone(),
            inner.clone(),
            media_controls.clone(),
        );

        let ticker_handle = Self::spawn_position_ticker(app_handle, inner.clone());

        blog!("[bardo player] LibrespotPlayer ready");

        Self {
            player,
            mixer,
            spirc,
            session,
            inner,
            ticker_handle,
        }
    }

    pub fn session(&self) -> Session {
        self.session.clone()
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
        let mut last_err = String::new();

        for attempt in 1u8..=5 {
            blog!("[bardo player] Attempt {attempt}/5: creating fresh session...");

            let session = Session::new(SessionConfig::default(), None);
            let mixer = Arc::new(SoftMixer::open(MixerConfig::default()).unwrap());

            blog!("[bardo player] Attempt {attempt}/5: creating player...");

            let player = Player::new(
                PlayerConfig::default(),
                session.clone(),
                mixer.get_soft_volume(),
                || Box::new(crate::sink::FollowingSink::new()),
            );

            let connect_config = ConnectConfig {
                name: "Bardo player".to_string(),
                ..Default::default()
            };

            blog!("[bardo player] Attempt {attempt}/5: starting Spirc...");

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
                        "[bardo player] Spirc started on attempt {attempt}. Username: {:?}",
                        session.username()
                    );
                    return Ok((session, player, mixer, spirc, task));
                }
                Err(e) => {
                    last_err = e.to_string();
                    blog!("[bardo player] Spirc failed (attempt {attempt}): {e}");
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
            blog!("[bardo player] Event loop started.");

            while let Some(event) = event_channel.recv().await {
                match event {
                    PlayerEvent::TrackChanged { audio_item } => {
                        blog!("[bardo player] TrackChanged: {}", audio_item.uri);

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
                                "[bardo player] Emitting track_changed: {} - {}",
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
                        blog!("[bardo player] Playing at {position_ms}ms");

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
                        blog!("[bardo player] Paused at {position_ms}ms");

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
                        blog!("[bardo player] Stopped.");

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
                        blog!("[bardo player] EndOfTrack.");

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

            blog!("[bardo player] WARNING: event_channel closed — event loop exited");
        });
    }

    fn spawn_position_ticker(
        app: AppHandle,
        inner: Arc<Mutex<PlayerInner>>,
    ) -> tokio::task::JoinHandle<()> {
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
        })
    }

    pub fn play_track(&self, uri: String) {
        blog!("[bardo player] play_track: {uri}");
        load_uri(&self.player, &uri);
    }

    pub fn pause(&self) {
        blog!("[bardo player] pause()");
        self.player.pause();
    }

    pub fn resume(&self) {
        blog!("[bardo player] resume()");
        self.player.play();
    }

    pub fn seek(&self, position_ms: u32) {
        blog!("[bardo player] seek({position_ms}ms)");
        self.player.seek(position_ms);

        let mut s = self.inner.lock().unwrap();
        s.position_ms = position_ms;
        s.started_at = Some(Instant::now());
    }

    pub fn set_volume(&self, volume: f64) {
        let v = (volume * u16::MAX as f64).clamp(0.0, u16::MAX as f64) as u16;
        blog!("[bardo player] set_volume({volume} -> raw {v})");
        self.mixer.set_volume(v);
    }

    pub fn stop(&self) {
        blog!("[bardo player] stop()");
        self.player.stop();
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct RootlistPlaylist {
    pub uri: String,
    pub name: String,
    pub image_url: Option<String>,
    pub owner: String,
}

pub(crate) async fn fetch_rootlist_playlists(
    session: &Session,
) -> Result<Vec<RootlistPlaylist>, String> {
    use protobuf::Message;

    let mut playlists = Vec::new();
    let mut from = 0usize;

    loop {
        let bytes = session
            .spclient()
            .get_rootlist(from, Some(500))
            .await
            .map_err(|e| format!("rootlist request failed: {e}"))?;

        let content =
            librespot_protocol::playlist4_external::SelectedListContent::parse_from_bytes(&bytes)
                .map_err(|e| format!("rootlist parse failed: {e}"))?;

        let Some(contents) = content.contents.into_option() else {
            break;
        };

        let count = contents.items.len();
        let truncated = contents.truncated();

        for (item, meta) in contents.items.iter().zip(contents.meta_items.iter()) {
            let uri = item.uri();
            if !uri.starts_with("spotify:playlist:") {
                continue;
            }

            playlists.push(RootlistPlaylist {
                uri: uri.to_string(),
                name: meta.attributes.name().to_string(),
                image_url: cover(
                    meta.attributes.picture(),
                    meta.attributes
                        .picture_size
                        .iter()
                        .map(|p| (p.target_name(), p.url())),
                ),
                owner: meta.owner_username().to_string(),
            });
        }

        if !truncated || count == 0 {
            break;
        }
        from += count;
    }

    Ok(playlists)
}

#[derive(Serialize, Clone, Debug)]
pub struct TrackArtist {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlaylistTrack {
    pub uri: String,
    pub id: String,
    pub name: String,
    pub artists: String,
    pub artist_list: Vec<TrackArtist>,
    pub album: String,
    pub album_id: String,
    pub image: String,
    pub duration_ms: i32,
}

#[derive(Serialize, Clone, Debug)]
pub struct PlaylistDetail {
    pub name: String,
    pub description: String,
    pub owner: String,
    pub icon: Option<String>,
    pub tracks: Vec<PlaylistTrack>,
}

const IMAGE_HOST: &str = "https://i.scdn.co/image/";

fn cover<'a>(picture: &[u8], sizes: impl Iterator<Item = (&'a str, &'a str)>) -> Option<String> {
    let mut best: Option<(u8, &str)> = None;
    for (target_name, url) in sizes {
        let rank = match target_name {
            "large" => 3,
            "default" => 2,
            _ => 1,
        };
        if best.is_none() || best.is_some_and(|(seen, _)| rank > seen) {
            best = Some((rank, url));
        }
    }
    best.and_then(|(_, url)| match url.strip_prefix("spotify:image:") {
        Some(hex) => Some(format!("{IMAGE_HOST}{hex}")),
        None if url.starts_with("http") => Some(url.to_string()),
        None => None,
    })
        .or_else(|| {
            (!picture.is_empty())
                .then(|| format!("{IMAGE_HOST}{}", librespot_core::FileId::from_raw(picture)))
        })
}

pub(crate) async fn fetch_playlist(
    session: &Session,
    id: &str,
) -> Result<PlaylistDetail, String> {
    use librespot_metadata::Playlist;

    let uri = SpotifyUri::Playlist {
        user: None,
        id: SpotifyId::from_base62(id).map_err(|e| format!("bad playlist id: {e}"))?,
    };
    let list = Playlist::get(session, &uri)
        .await
        .map_err(|e| format!("playlist read failed: {e}"))?;

    let attributes = &list.attributes;
    let icon = cover(
        &attributes.picture,
        attributes
            .picture_sizes
            .iter()
            .map(|p| (p.target_name.as_str(), p.url.as_str())),
    );

    let owner = match &list.id {
        SpotifyUri::Playlist { user: Some(u), .. } => u.clone(),
        _ => String::new(),
    };

    let details = track_metadata(session, &list.contents.items).await?;
    let tracks = list
        .contents
        .items
        .iter()
        .filter_map(|row| details.get(&row.id.to_uri()).cloned())
        .collect();

    Ok(PlaylistDetail {
        name: attributes.name.clone(),
        description: attributes.description.clone(),
        owner,
        icon,
        tracks,
    })
}

async fn track_metadata(
    session: &Session,
    rows: &[librespot_metadata::playlist::item::PlaylistItem],
) -> Result<std::collections::HashMap<String, PlaylistTrack>, String> {
    use librespot_protocol::extended_metadata::{
        BatchedEntityRequest, EntityRequest, ExtensionQuery,
    };
    use librespot_protocol::extension_kind::ExtensionKind;
    use protobuf::{EnumOrUnknown, Message};

    let mut asked = std::collections::HashSet::new();
    let mut request = BatchedEntityRequest::new();
    for row in rows {
        if !matches!(row.id, SpotifyUri::Track { .. }) {
            continue;
        }
        let uri = row.id.to_uri();
        if !asked.insert(uri.clone()) {
            continue;
        }
        request.entity_request.push(EntityRequest {
            entity_uri: uri,
            query: vec![ExtensionQuery {
                extension_kind: EnumOrUnknown::new(ExtensionKind::TRACK_V4),
                ..Default::default()
            }],
            ..Default::default()
        });
    }

    let mut out = std::collections::HashMap::new();
    if request.entity_request.is_empty() {
        return Ok(out);
    }

    let response = session
        .spclient()
        .get_extended_metadata(request)
        .await
        .map_err(|e| format!("track metadata failed: {e}"))?;

    for array in response.extended_metadata {
        if array.extension_kind.enum_value() != Ok(ExtensionKind::TRACK_V4) {
            continue;
        }
        for data in array.extension_data {
            if !matches!(data.header.status_code, 0 | 200) {
                continue;
            }
            let Some(any) = data.extension_data.as_ref() else {
                continue;
            };
            let Ok(message) = librespot_protocol::metadata::Track::parse_from_bytes(&any.value)
            else {
                continue;
            };
            let Ok(track) = Track::try_from(&message) else {
                continue;
            };
            out.insert(
                data.entity_uri,
                PlaylistTrack {
                    uri: track.id.to_uri(),
                    id: track.id.to_id(),
                    name: track.name,
                    artists: track
                        .artists
                        .iter()
                        .map(|a| a.name.clone())
                        .collect::<Vec<_>>()
                        .join(", "),
                    artist_list: track
                        .artists
                        .iter()
                        .map(|a| TrackArtist {
                            id: a.id.to_id(),
                            name: a.name.clone(),
                        })
                        .collect(),
                    album_id: track.album.id.to_id(),
                    image: track
                        .album
                        .covers
                        .first()
                        .map(|c| format!("{IMAGE_HOST}{}", c.id))
                        .unwrap_or_default(),
                    album: track.album.name,
                    duration_ms: track.duration,
                },
            );
        }
    }
    Ok(out)
}

fn load_uri(player: &Arc<Player>, uri: &str) {
    let id_str = uri.split(':').nth(2).unwrap_or("");

    match SpotifyId::from_base62(id_str) {
        Ok(id) => {
            blog!("[bardo player] load_uri: {uri}");
            player.load(SpotifyUri::Track { id }, true, 0);
        }
        Err(_) => blog!("[bardo player] load_uri: invalid URI: {uri}"),
    }
}
