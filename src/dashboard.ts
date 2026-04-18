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

interface QueueItem {
  uri: string;
  name: string;
  artists: string;
  image: string;
}

const MAX_HISTORY = 5;

let currentDurationMs = 0;
let isPlaying = false;
let currentTrack: QueueItem | null = null;
let queue: QueueItem[] = [];
let history: QueueItem[] = [];
let queueVisible = false;
let dragSrcIndex: number | null = null;

function millisToMinutesAndSeconds(millis: number): string {
  const minutes = Math.floor(millis / 60000);
  const seconds = ((millis % 60000) / 1000).toFixed(0);
  return minutes + ":" + (Number(seconds) < 10 ? "0" : "") + seconds;
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

function resetDurationValues() {
  const seek = document.querySelector<HTMLInputElement>("#seek")!;
  const currentTime =
    document.querySelector(".track-controller")!.firstElementChild!;
  currentTime.innerHTML = "0:00";
  seek.value = "0";
}

function setPlayingUI(playing: boolean) {
  isPlaying = playing;
  const pauseIcon = document.querySelector<HTMLElement>(
    ".fa-solid.fa-pause"
  )!;
  const playIcon = document.querySelector<HTMLElement>(
    ".fa-solid.fa-play"
  )!;
  pauseIcon.style.display = playing ? "" : "none";
  playIcon.style.display = playing ? "none" : "";
}

// ─── Auth / API ──────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  try {
    return await invoke<string>("get_access_token");
  } catch {
    try {
      return await invoke<string>("refresh_token");
    } catch {
      window.location.href = "/index.html";
      throw new Error("No session");
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

// ─── Queue Management ────────────────────────────────────────────────────────

function pushHistory(item: QueueItem) {
  history.push(item);
  if (history.length > MAX_HISTORY) history.shift();
}

/** Internal: update state and invoke Rust to play one track. */
function startTrack(item: QueueItem) {
  if (currentTrack) pushHistory(currentTrack);
  currentTrack = item;
  resetDurationValues();
  setPlayingUI(true);
  invoke("player_play_track", { uri: item.uri });
  renderQueue();
}

/**
 * Play a playlist starting at startIndex.
 * Queues all remaining tracks after startIndex.
 */
export function playPlaylist(tracks: QueueItem[], startIndex = 0) {
  queue = tracks.slice(startIndex + 1);
  startTrack(tracks[startIndex]);
}

/**
 * Play a single search result track.
 * Clears the queue entirely.
 */
export function playSearchTrack(uri: string) {
  if (currentTrack) pushHistory(currentTrack);
  // Metadata will arrive via track_changed; set null until then.
  currentTrack = null;
  queue = [];
  resetDurationValues();
  setPlayingUI(true);
  invoke("player_play_track", { uri });
  renderQueue();
}

/** Advance to the next item in the queue. */
function advanceQueue() {
  if (queue.length === 0) {
    setPlayingUI(false);
    resetDurationValues();
    return;
  }
  startTrack(queue.shift()!);
}



function addToQueue(item: QueueItem) {
  queue.push(item);
  renderQueue();
}

function removeFromQueue(index: number) {
  queue.splice(index, 1);
  renderQueue();
}

function reorderQueue(from: number, to: number) {
  console.log(`[queue] reorder from=${from} to=${to} before=`, [...queue.map(q => q.name)]);
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);
  console.log(`[queue] reorder after=`, [...queue.map(q => q.name)]);
  renderQueue();
}

// Call once at startup, outside renderQueue
function initQueueDragListeners() {
  const list = document.getElementById("queue-list")!;

  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";

    const target = (e.target as HTMLElement).closest<HTMLElement>(
      "li.queue-item:not(.queue-item--current)"
    );
    document
      .querySelectorAll(".queue-item")
      .forEach((el) => el.classList.remove("drag-over"));
    if (target) {
      target.classList.add("drag-over");
    }
  });

  list.addEventListener("dragleave", (e) => {
    // Only clear highlights when leaving the list entirely
    if (!list.contains(e.relatedTarget as Node)) {
      document
        .querySelectorAll(".queue-item")
        .forEach((el) => el.classList.remove("drag-over"));
    }
  });

  list.addEventListener("drop", (e) => {
    e.preventDefault();
    document
      .querySelectorAll(".queue-item")
      .forEach((el) => el.classList.remove("drag-over"));

    const target = (e.target as HTMLElement).closest<HTMLElement>(
      "li.queue-item:not(.queue-item--current)"
    );
    if (!target) {
      console.log("[queue] drop: no valid target found");
      return;
    }

    const toIndex = parseInt(target.dataset.index!);
    console.log(`[queue] drop src=${dragSrcIndex} dst=${toIndex}`);

    if (dragSrcIndex !== null && dragSrcIndex !== toIndex) {
      reorderQueue(dragSrcIndex, toIndex);
    }
  });
}

// ─── Queue UI ────────────────────────────────────────────────────────────────

function renderQueue() {
  const list = document.getElementById("queue-list")!;
  const empty = document.getElementById("queue-empty")!;
  const count = document.getElementById("queue-count")!;

  list.innerHTML = "";

  const total = (currentTrack ? 1 : 0) + queue.length;
  count.textContent = `${total} track${total !== 1 ? "s" : ""}`;
  empty.style.display = total === 0 ? "" : "none";

  if (currentTrack) {
    const li = document.createElement("li");
    li.classList.add("queue-item", "queue-item--current");
    li.innerHTML = `
      <img src="${currentTrack.image}" alt="" />
      <div class="queue-item-info">
        <div class="queue-item-name">${currentTrack.name}</div>
        <div class="queue-item-artists">${currentTrack.artists}</div>
      </div>
    `;
    list.appendChild(li);
  }

  queue.forEach((item, index) => {
    const li = document.createElement("li");
    li.classList.add("queue-item");
    li.draggable = true;
    li.dataset.index = String(index); // used by container drop listener

    li.innerHTML = `
      <i class="fa-solid fa-grip-vertical queue-drag-handle"></i>
      <img src="${item.image}" alt="" />
      <div class="queue-item-info">
        <div class="queue-item-name">${item.name}</div>
        <div class="queue-item-artists">${item.artists}</div>
      </div>
      <div class="queue-item-actions">
        <i class="fa-solid fa-xmark" title="Remove"></i>
      </div>
    `;

    li.querySelector(".fa-xmark")!.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromQueue(index);
    });

    li.addEventListener("dragstart", (e) => {
      dragSrcIndex = index;
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", String(index));
      console.log(`[queue] dragstart index=${index} name="${item.name}"`);
      // Defer adding class so the drag ghost renders normally
      requestAnimationFrame(() => li.classList.add("dragging"));
    });

    li.addEventListener("dragend", () => {
      console.log(`[queue] dragend index=${index} dragSrcIndex=${dragSrcIndex}`);
      li.classList.remove("dragging");
      document
        .querySelectorAll(".queue-item")
        .forEach((el) => el.classList.remove("drag-over"));
      dragSrcIndex = null;
    });

    list.appendChild(li);
  });
}
function toggleQueuePanel() {
  queueVisible = !queueVisible;
  document.getElementById("search-panel")!.style.display = queueVisible
    ? "none"
    : "";
  document.getElementById("queue-panel")!.style.display = queueVisible
    ? "flex"
    : "none";
  document
    .getElementById("queue-toggle")!
    .classList.toggle("active", queueVisible);
}

// ─── Playlist ────────────────────────────────────────────────────────────────

function extractTracksFromPlaylist(tracks: any[]): any[] {
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
  const playlistImage =
    document.querySelector<HTMLImageElement>(".playlist-image-object")!;
  const playlistTitle = document.querySelector(".playlist-main-title")!;
  const playlistDescription = document.querySelector(
    ".playlist-description"
  )!;
  const playlistUL =
    document.querySelector<HTMLUListElement>(".playlist-tracks")!;
  const playButton =
    document.querySelector<HTMLElement>(".play-button")!;

  playButton.style.display = "inline-block";
  playlistUL.innerHTML = "";

  getPlaylist(id).then((playlist) => {
    playlistImage.src = playlist.icon;
    playlistTitle.innerHTML = playlist.name;
    playlistDescription.innerHTML = playlist.description;

    // Build typed QueueItem array once for reuse
    const queueItems: QueueItem[] = playlist.tracks.map((t: any) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists,
      image: t.image,
    }));

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
      add.onclick = (e) => {
        e.stopPropagation();
        addToQueue(queueItems[index]);
      };

      li.append(image, name, artists, duration);
      // Click on track: play from that index, queue the rest
      li.onclick = () => playPlaylist(queueItems, index);

      trackDiv.append(li, add);
      playlistUL.appendChild(trackDiv);
    });

    // Play button: queue entire playlist from the start
    playButton.onclick = () => playPlaylist(queueItems, 0);
  });
}

// ─── Search ──────────────────────────────────────────────────────────────────

async function loadPlaylists() {
  const data = await fetchApi("me/playlists?limit=50");
  const ul = document.querySelector<HTMLUListElement>("#playlist-list")!;
  ul.innerHTML = "";

  data.items.forEach((playlist: any) => {
    const li = document.createElement("li");
    li.className = "sidebar-playlist-item";

    const img = document.createElement("img");
    img.className = "sidebar-playlist-image";
    img.src = playlist.images?.[0]?.url || "";
    img.alt = playlist.name;

    const span = document.createElement("span");
    span.className = "sidebar-playlist-name";
    span.textContent = playlist.name;

    li.appendChild(img);
    li.appendChild(span);

    li.onclick = () => showPlaylist(playlist.id);

    ul.appendChild(li);
  });
}

function handleSearchTracks(tracks: any) {
  const tracksDiv =
    document.querySelector<HTMLElement>(".tracks-results")!;
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
    // Search tracks clear the queue
    div.onclick = () => playSearchTrack(track.uri);
    tracksDiv.appendChild(div);
  });
}

function handleSearchPlaylists(playlists: any) {
  const playlistsDiv =
    document.querySelector<HTMLElement>(".playlists-results")!;
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

// ─── Rust Events ─────────────────────────────────────────────────────────────

listen<TrackInfo>("track_changed", ({ payload }) => {
  document.querySelector(".track-title")!.innerHTML = payload.name;
  document.querySelector(".artists-title")!.innerHTML = payload.artists;
  document.querySelector(".album-title")!.innerHTML = payload.album;
  document.querySelector<HTMLImageElement>(".track-image-object")!.src =
    payload.image_url;
  document.querySelector<HTMLElement>(".track-time")!.innerHTML =
    millisToMinutesAndSeconds(payload.duration_ms);
  currentDurationMs = payload.duration_ms;
  resetDurationValues();
  setPlayingUI(true);

  // For search results we have no QueueItem yet — build one from Rust metadata.
  if (!currentTrack) {
    currentTrack = {
      uri: payload.uri,
      name: payload.name,
      artists: payload.artists,
      image: payload.image_url,
    };
    renderQueue();
  }
});

listen<number>("position_changed", ({ payload }) => {
  const seek = document.querySelector<HTMLInputElement>("#seek")!;
  const timeEl =
    document.querySelector(".track-controller")!.firstElementChild!;
  if (currentDurationMs > 0)
    seek.value = String((payload / currentDurationMs) * 100);
  timeEl.innerHTML = millisToMinutesAndSeconds(payload);
});

listen("player_paused", () => setPlayingUI(false));

listen("player_stopped", () => {
  setPlayingUI(false);
  resetDurationValues();
});

// Rust signals end-of-track; TS decides what to do next.
listen("track_ended", () => {
  if (queue.length > 0) {
    advanceQueue();
  } else {
    setPlayingUI(false);
    resetDurationValues();
  }
});

// ─── Controls ────────────────────────────────────────────────────────────────

async function togglePlay() {
  if (isPlaying) {
    await invoke("player_pause");
    setPlayingUI(false);
  } else {
    await invoke("player_resume");
    setPlayingUI(true);
  }
}

document.getElementById("toggle")!.onclick = togglePlay;
document.getElementById("queue-toggle")!.onclick = toggleQueuePanel;

document.getElementById("nextTrack")!.onclick = () => advanceQueue();

// Previous always restarts the current track.
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
const seekTimeEl =
  document.querySelector(".track-controller")!.firstElementChild!;
seekEl.addEventListener("change", () => {
  const position = (seekEl.valueAsNumber / 100) * currentDurationMs;
  seekTimeEl.innerHTML = millisToMinutesAndSeconds(position);
  invoke("player_seek", { positionMs: Math.floor(position) });
});

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

loadPlaylists();
renderQueue();
initQueueDragListeners(); 

const initialVolume = 50;
volume.style.backgroundSize = `${initialVolume}% 100%`;
invoke("player_set_volume", { volume: initialVolume / 100 });