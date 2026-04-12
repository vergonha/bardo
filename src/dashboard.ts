/// <reference types="@types/spotify-web-playback-sdk" />
import { invoke } from "@tauri-apps/api/core";

let deviceId: string | null = null;


function millisToMinutesAndSeconds(millis: number): string {
  const minutes = Math.floor(millis / 60000);
  const seconds = ((millis % 60000) / 1000).toFixed(0);
  return minutes + ":" + (Number(seconds) < 10 ? "0" : "") + seconds;
}

function ctx() {
  new AudioContext().resume();
}

function setUpDevice(player: Spotify.Player) {
  player.activateElement();
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

function resetDurationValues() {
  const seek = document.querySelector<HTMLInputElement>("#seek")!;
  const currentTime =
    document.querySelector(".track-controller")!.firstElementChild!;
  currentTime.innerHTML = "0:00";
  seek.value = "0";
}

function changeMusicDuration(uri: string) {
  const trackTime = document.querySelector<HTMLElement>(".track-time")!;
  fetchApi("tracks/" + uri.split(":")[2]).then((res) => {
    trackTime.innerHTML = millisToMinutesAndSeconds(res.duration_ms);
  });
}

async function playTrack(uri: string | string[]) {
  ctx();
  resetDurationValues();

  document.getElementsByClassName(
    "fa-solid fa-pause"
  )[0]!.removeAttribute("style");
  (
    document.getElementsByClassName("fa-solid fa-play")[0] as HTMLElement
  ).style.display = "none";

  const token = await getToken();
  fetch(
    "https://api.spotify.com/v1/me/player/play?device_id=" + deviceId,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: Array.isArray(uri) ? uri : [uri],
      }),
    }
  );
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
  ctx();

  const playlistImage =
    document.querySelector<HTMLImageElement>(".playlist-image-object")!;
  const playlistTitle = document.querySelector(".playlist-main-title")!;
  const playlistDescription = document.querySelector(".playlist-description")!;
  const playlistUL =
    document.querySelector<HTMLUListElement>(".playlist-tracks")!;
  const playButton = document.querySelector<HTMLElement>(".play-button")!;

  playButton.style.display = "inline-block";
  playlistUL.innerHTML = "";

  getPlaylist(id).then((playlist) => {
    playlistImage.src = playlist.icon;
    playlistTitle.innerHTML = playlist.name;
    playlistDescription.innerHTML = playlist.description;

    const uris: string[] = [];

    playlist.tracks.forEach((track: any) => {
      uris.push(track.uri);

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
      li.onclick = () => playTrack(track.uri);

      trackDiv.append(li, add);
      playlistUL.appendChild(trackDiv);
    });

    playButton.onclick = () => playTrack(uris);
  });
}

function changeMusic(track: Spotify.Track) {
  document.querySelector(".track-title")!.innerHTML = track.name;
  document.querySelector(".artists-title")!.innerHTML = track.artists
    .map((a) => a.name)
    .join(", ");
  document.querySelector(".album-title")!.innerHTML = track.album.name;
  document.querySelector<HTMLImageElement>(".track-image-object")!.src =
    track.album.images[0].url;
}

function debounce<T extends (...args: any[]) => void>(
  callback: T,
  wait: number
) {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => callback(...args), wait);
  };
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
  const playlistsDiv =
    document.querySelector<HTMLElement>(".playlists-results")!;
  playlistsDiv.innerHTML = "";

  playlists.items.forEach((item: any) => {

    if (!item) { return };

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

async function carregarPlaylists() {
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
      console.log(res);
      handleSearchPlaylists(res.playlists);
      handleSearchTracks(res.tracks);

    });
  }, 1000)
);

window.onSpotifyWebPlaybackSDKReady = async () => {
  new AudioContext().resume();
  const token = await getToken();

  const player = new Spotify.Player({
    name: "Bardo",
    getOAuthToken: (callback) => callback(token),
    volume: 1.0,
  });

  player.connect().then((success) => {
    if (success) {
      setUpDevice(player);
      console.log("Web Playback SDK conectado!");
    }
  });

  player.addListener("ready", ({ device_id }) => {
    deviceId = device_id;
  });

  let progressInterval: ReturnType<typeof setInterval> | null = null;

  player.addListener("player_state_changed", (state) => {
    if (!state) return;

    const { track_window: { current_track } } = state;
    changeMusic(current_track);
    changeMusicDuration(current_track.uri);

    if (progressInterval) clearInterval(progressInterval);

    progressInterval = setInterval(async () => {
      const currentState = await player.getCurrentState();
      if (!currentState || currentState.paused) return;

      const seek = document.querySelector<HTMLInputElement>("#seek")!;
      const timeEl =
        document.querySelector(".track-controller")!.firstElementChild!;

      seek.value = String(
        (currentState.position * 100) /
        currentState.track_window.current_track.duration_ms
      );
      timeEl.innerHTML = millisToMinutesAndSeconds(currentState.position);
    }, 2000);
  });

  const pauseIcon = document.getElementsByClassName(
    "fa-solid fa-pause"
  )[0] as HTMLElement;
  const playIcon = document.getElementsByClassName(
    "fa-solid fa-play"
  )[0] as HTMLElement;

  document.getElementById("toggle")!.onclick = async () => {
    const state = await player.getCurrentState();
    if (!state) return;

    await player.togglePlay();

    if (state.paused) {
      pauseIcon.style.display = "initial";
      playIcon.style.display = "none";
    } else {
      pauseIcon.style.display = "none";
      playIcon.style.display = "initial";
    }
  };

  document.getElementById("nextTrack")!.onclick = () => {
    resetDurationValues();
    player.nextTrack();
  };

  document.getElementById("previousTrack")!.onclick = () => {
    resetDurationValues();
    player.previousTrack();
  };

  const volume = document.querySelector<HTMLInputElement>("#volume-control")!;
  volume.addEventListener("change", (e) => {
    const el = e.currentTarget as HTMLInputElement;
    el.style.backgroundSize = `${el.value}% 100%`;
    player.setVolume(Number(el.value) / 100);
  });

  const seekEl = document.querySelector<HTMLInputElement>("#seek")!;
  const timeEl =
    document.querySelector(".track-controller")!.firstElementChild!;

  seekEl.addEventListener("change", async () => {
    const state = await player.getCurrentState();
    if (!state) return;

    const duration =
      (seekEl.valueAsNumber / 100) *
      state.track_window.current_track.duration_ms;

    timeEl.innerHTML = millisToMinutesAndSeconds(duration);
    player.seek(duration);
  });

  carregarPlaylists();
};