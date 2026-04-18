import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface TrackInfo {
  name: string;
  artists: string;
  album: string;
  image_url: string;
  duration_ms: number;
  uri: string;
}

let currentDurationMs = 0;
let isPlaying = false;

function millisToMinutesAndSeconds(millis: number): string {
  const minutes = Math.floor(millis / 60000);
  const seconds = ((millis % 60000) / 1000).toFixed(0);
  return minutes + ":" + (Number(seconds) < 10 ? "0" : "") + seconds;
}

function debounce<T extends (...args: any[]) => void>(callback: T, wait: number) {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), wait);
  };
}

function resetDurationValues() {
  const seek = document.querySelector<HTMLInputElement>("#seek")!;
  const currentTime = document.querySelector(".track-controller")!.firstElementChild!;
  currentTime.innerHTML = "0:00";
  seek.value = "0";
}

function setPlayingUI(playing: boolean) {
  isPlaying = playing;
  const pauseIcon = document.querySelector<HTMLElement>(".fa-solid.fa-pause")!;
  const playIcon = document.querySelector<HTMLElement>(".fa-solid.fa-play")!;
  pauseIcon.style.display = playing ? "" : "none";
  playIcon.style.display = playing ? "none" : "";
}

async function getToken(): Promise<string> {
  try {
    return await invoke<string>("get_access_token");
  } catch {
    try {
      return await invoke<string>("refresh_token");
    } catch {
      window.location.href = "/index.html";
      throw new Error("Sem sessão");
    }
  }
}

async function fetchApi(endpoint: string) {
  const token = await getToken();
  const response = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json();
}

async function addToQueue(uri: string) {
  const token = await getToken();
  const body = new URLSearchParams({ uri });
  return fetch("https://api.spotify.com/v1/me/player/queue?" + body, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function playTrack(uri: string | string[]) {
  resetDurationValues();
  setPlayingUI(true);
  if (Array.isArray(uri)) {
    await invoke("player_play_tracks", { uris: uri });
  } else {
    await invoke("player_play_track", { uri });
  }
}

async function togglePlay() {
  if (isPlaying) {
    await invoke("player_pause");
    setPlayingUI(false);
  } else {
    await invoke("player_resume");
    setPlayingUI(true);
  }
}

function extractTracksFromPlaylist(tracks: any[]) {
  const infos: any[] = [];
  tracks.forEach((track) => {
    try {
      infos.push({
        name: track.track.name,
        id: track.track.id,
        album: track.track.album.name,
        image: track.track.album.images[0].url,
        uri: track.track.uri,
        artists: track.track.artists.map((a: any) => a.name).join(", "),
        duration: millisToMinutesAndSeconds(track.track.duration_ms),
      });
    } catch (error) {
      console.log(error);
    }
  });
  return infos;
}

async function getPlaylist(id: string) {
  const playlist = await fetchApi(`playlists/${id}`);
  return {
    description: playlist.description,
    name: playlist.name,
    owner: playlist.owner.display_name,
    icon: playlist.images[0].url,
    tracks: extractTracksFromPlaylist(playlist.tracks.items),
  };
}

export function showPlaylist(id: string) {
  const playlistImage = document.querySelector<HTMLImageElement>(".playlist-image-object")!;
  const playlistTitle = document.querySelector(".playlist-main-title")!;
  const playlistDescription = document.querySelector(".playlist-description")!;
  const playlistUL = document.querySelector<HTMLUListElement>(".playlist-tracks")!;
  const playButton = document.querySelector<HTMLElement>(".play-button")!;

  playButton.style.display = "inline-block";
  playlistUL.innerHTML = "";

  getPlaylist(id).then((playlist) => {
    playlistImage.src = playlist.icon;
    playlistTitle.innerHTML = playlist.name;
    playlistDescription.innerHTML = playlist.description;

    const uris = playlist.tracks.map((t: any) => t.uri);

    playlist.tracks.forEach((track: any, index: number) => {
      const trackDiv = document.createElement("div");
      trackDiv.classList.add("track");

      const li = document.createElement("li");
      const image = document.createElement("img");
      image.src = track.image;

      const name = document.createElement("p");
      name.textContent = track.name;

      const artists = document.createElement("p");
      artists.textContent = track.artists;

      const duration = document.createElement("p");
      duration.textContent = track.duration;

      const add = document.createElement("i");
      add.classList.add("fa-solid", "fa-plus");
      add.onclick = () => addToQueue(track.uri);

      li.append(image, name, artists, duration);
      li.onclick = () => playTrack(uris.slice(index));
      trackDiv.append(li, add);
      playlistUL.appendChild(trackDiv);
    });

    playButton.onclick = () => playTrack(uris);
  });
}

async function loadPlaylists() {
  const data = await fetchApi("me/playlists?limit=50");
  const ul = document.querySelector<HTMLUListElement>("#playlist-list")!;
  ul.innerHTML = "";
  data.items.forEach((playlist: any) => {
    const li = document.createElement("li");
    li.textContent = playlist.name;
    li.onclick = () => showPlaylist(playlist.id);
    ul.appendChild(li);
  });
}

function handleSearchTracks(tracks: any) {
  const tracksDiv = document.querySelector<HTMLElement>(".tracks-results")!;
  tracksDiv.innerHTML = "";
  tracks.items.forEach((track: any) => {
    const div = document.createElement("div");
    div.classList.add("track-result");

    const icon = document.createElement("img");
    icon.src = track.album.images[0].url;

    const name = document.createElement("p");
    name.textContent = track.name;

    const artists = document.createElement("p");
    artists.textContent = track.artists.map((a: any) => a.name).join(", ");

    div.append(icon, name, artists);
    div.onclick = () => playTrack(track.uri);
    tracksDiv.appendChild(div);
  });
}

function handleSearchPlaylists(playlists: any) {
  const playlistsDiv = document.querySelector<HTMLElement>(".playlists-results")!;
  playlistsDiv.innerHTML = "";
  playlists.items.forEach((item: any) => {
    if (!item) return;

    const div = document.createElement("div");
    div.classList.add("playlist-result");

    const icon = document.createElement("img");
    icon.src = item.images[0].url;

    const name = document.createElement("h3");
    name.textContent = item.name;

    const owner = document.createElement("p");
    owner.textContent = `from ${item.owner.display_name}`;

    div.append(icon, name, owner);
    div.onclick = () => showPlaylist(item.id);
    playlistsDiv.appendChild(div);
  });
}

listen<TrackInfo>("track_changed", ({ payload }) => {
  document.querySelector(".track-title")!.innerHTML = payload.name;
  document.querySelector(".artists-title")!.innerHTML = payload.artists;
  document.querySelector(".album-title")!.innerHTML = payload.album;
  document.querySelector<HTMLImageElement>(".track-image-object")!.src = payload.image_url;
  document.querySelector<HTMLElement>(".track-time")!.innerHTML =
    millisToMinutesAndSeconds(payload.duration_ms);
  currentDurationMs = payload.duration_ms;
  resetDurationValues();
  setPlayingUI(true);
});

listen<number>("position_changed", ({ payload }) => {
  const seek = document.querySelector<HTMLInputElement>("#seek")!;
  const timeEl = document.querySelector(".track-controller")!.firstElementChild!;
  if (currentDurationMs > 0) {
    seek.value = String((payload / currentDurationMs) * 100);
  }
  timeEl.innerHTML = millisToMinutesAndSeconds(payload);
});

listen("player_paused", () => setPlayingUI(false));
listen("player_stopped", () => { setPlayingUI(false); resetDurationValues(); });
listen("track_ended", () => { setPlayingUI(false); resetDurationValues(); });

const search = document.querySelector<HTMLInputElement>("#search")!;
search.addEventListener(
  "keyup",
  debounce(() => {
    if (!search.value) return;
    const body = new URLSearchParams({
      q: search.value,
      type: "track,playlist",
      limit: "4",
    });
    fetchApi("search?" + body).then((res) => {
      handleSearchPlaylists(res.playlists);
      handleSearchTracks(res.tracks);
    });
  }, 1000)
);

document.getElementById("toggle")!.onclick = togglePlay;

document.getElementById("nextTrack")!.onclick = () => {
  invoke("player_next_track");
  resetDurationValues();
};

document.getElementById("previousTrack")!.onclick = async () => {
  await invoke("player_seek", { positionMs: 0 });
  resetDurationValues();
};

const volume = document.querySelector<HTMLInputElement>("#volume-control")!;
volume.addEventListener("change", (e) => {
  const el = e.currentTarget as HTMLInputElement;
  el.style.backgroundSize = `${el.value}% 100%`;
  invoke("player_set_volume", { volume: Number(el.value) / 100 });
});

const seekEl = document.querySelector<HTMLInputElement>("#seek")!;
const seekTimeEl = document.querySelector(".track-controller")!.firstElementChild!;
seekEl.addEventListener("change", () => {
  const position = (seekEl.valueAsNumber / 100) * currentDurationMs;
  seekTimeEl.innerHTML = millisToMinutesAndSeconds(position);
  invoke("player_seek", { positionMs: Math.floor(position) });
});

loadPlaylists();

const initialVolume = 50;
volume.style.backgroundSize = `${initialVolume}% 100%`;
invoke("player_set_volume", { volume: initialVolume / 100 });