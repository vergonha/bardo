import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadRoute } from "../../lib/router";

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
let playlistPlayBtn: HTMLElement | null = null;

const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const nextBtn = document.getElementById("nextTrack") as HTMLButtonElement;
const prevBtn = document.getElementById("previousTrack") as HTMLButtonElement;

function showToast(msg: string, isError = false, duration = 2500) {
  let toast = document.getElementById("ux-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "ux-toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.toggle("toast-error", isError);
  toast.classList.add("toast-visible");
  clearTimeout((toast as any)._timer);
  (toast as any)._timer = setTimeout(
    () => toast!.classList.remove("toast-visible"),
    duration,
  );
}

function animatePress(el: HTMLElement) {
  el.classList.remove("btn-pressed");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("btn-pressed");
  el.addEventListener(
    "animationend",
    () => el.classList.remove("btn-pressed"),
    {
      once: true,
    },
  );
}

function lockButton(btn: HTMLButtonElement, ms = 700) {
  btn.disabled = true;
  setTimeout(() => (btn.disabled = false), ms);
}

function setPlaylistPlayBtnLoading(loading: boolean) {
  if (!playlistPlayBtn) return;
  const icon = playlistPlayBtn.querySelector("i")!;
  if (loading) {
    icon.className = "fa-solid fa-spinner";
    (playlistPlayBtn as HTMLAnchorElement).style.pointerEvents = "none";
    (playlistPlayBtn as HTMLAnchorElement).style.opacity = "0.5";
  } else {
    icon.className = "fa-solid fa-circle-play";
    (playlistPlayBtn as HTMLAnchorElement).style.pointerEvents = "";
    (playlistPlayBtn as HTMLAnchorElement).style.opacity = "";
  }
}

function renderPlaylistHeaderSkeleton() {
  const playlistImage = document.querySelector<HTMLImageElement>(
    ".playlist-image-object",
  )!;
  const playlistTitle = document.querySelector(".playlist-main-title")!;
  const playlistDescription = document.querySelector(".playlist-description")!;
  const playButton = document.querySelector<HTMLElement>(".play-button")!;

  playButton.style.display = "none";
  playlistImage.src = "";
  playlistImage.classList.add("skeleton");

  playlistTitle.innerHTML = `<span class="skeleton skeleton-inline" style="width:55%;height:22px;"></span>`;
  playlistDescription.innerHTML = `
    <span class="skeleton skeleton-inline" style="width:82%;height:10px;display:block;margin-bottom:5px;"></span>
    <span class="skeleton skeleton-inline" style="width:60%;height:10px;display:block;"></span>
  `;
}

function clearPlaylistHeaderSkeleton() {
  document
    .querySelector<HTMLImageElement>(".playlist-image-object")!
    .classList.remove("skeleton");
}

function renderTrackSkeletons(container: Element, count = 7) {
  container.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const div = document.createElement("div");
    div.className = "track-skeleton";
    div.innerHTML = `
      <div class="skeleton track-sk-img"></div>
      <div class="track-sk-info">
        <div class="skeleton track-sk-name" style="width:${45 + Math.random() * 30}%"></div>
        <div class="skeleton track-sk-artist" style="width:${25 + Math.random() * 20}%"></div>
      </div>
      <div class="skeleton track-sk-duration"></div>
    `;
    container.appendChild(div);
  }
}

function renderSearchSkeletons() {
  const tracksDiv = document.querySelector<HTMLElement>(".tracks-results")!;
  tracksDiv.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const div = document.createElement("div");
    div.className = "search-track-skeleton";
    div.innerHTML = `
      <div class="skeleton search-sk-img"></div>
      <div class="search-sk-info">
        <div class="skeleton search-sk-name" style="width:${50 + Math.random() * 25}%"></div>
        <div class="skeleton search-sk-artist" style="width:${30 + Math.random() * 20}%"></div>
      </div>
    `;
    tracksDiv.appendChild(div);
  }

  const playlistsDiv =
    document.querySelector<HTMLElement>(".playlists-results")!;
  playlistsDiv.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const div = document.createElement("div");
    div.className = "pl-skeleton-card";
    div.innerHTML = `
      <div class="skeleton pl-sk-img"></div>
      <div class="skeleton pl-sk-name" style="width:${55 + Math.random() * 30}%"></div>
      <div class="skeleton pl-sk-sub" style="width:${35 + Math.random() * 20}%"></div>
    `;
    playlistsDiv.appendChild(div);
  }
}

function millisToMinutesAndSeconds(millis: number): string {
  const minutes = Math.floor(millis / 60000);
  const seconds = ((millis % 60000) / 1000).toFixed(0);
  return minutes + ":" + (Number(seconds) < 10 ? "0" : "") + seconds;
}

function debounce<T extends (...args: any[]) => void>(
  callback: T,
  wait: number,
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
  seek.style.backgroundSize = "0% 100%";
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
      loadRoute("home");
      throw new Error("No session");
    }
  }
}

async function fetchApi(endpoint: string) {
  const token = await getToken();
  const response = await fetch(`https://api.spotify.com/v1/${endpoint}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`API error ${response.status}`);
  return response.json();
}

function pushHistory(item: QueueItem) {
  history.push(item);
  if (history.length > MAX_HISTORY) history.shift();
}

function startTrack(item: QueueItem) {
  if (currentTrack) pushHistory(currentTrack);
  currentTrack = item;
  resetDurationValues();
  setPlayingUI(true);
  invoke("player_play_track", { uri: item.uri });
  renderQueue();
}

export function playPlaylist(tracks: QueueItem[], startIndex = 0) {
  queue = tracks.slice(startIndex + 1);
  startTrack(tracks[startIndex]);
  setPlaylistPlayBtnLoading(false);
}

export function playSearchTrack(uri: string) {
  if (currentTrack) pushHistory(currentTrack);
  currentTrack = null;
  queue = [];
  resetDurationValues();
  setPlayingUI(true);
  invoke("player_play_track", { uri });
  renderQueue();
}

function advanceQueue() {
  if (queue.length === 0) {
    setPlayingUI(false);
    resetDurationValues();
    return;
  }
  startTrack(queue.shift()!);
}

function addToQueue(item: QueueItem, triggerEl?: HTMLElement) {
  queue.push(item);
  renderQueue();

  if (triggerEl) {
    const original = triggerEl.className;
    triggerEl.className = "fa-solid fa-check queue-add-success";
    triggerEl.style.pointerEvents = "none";
    setTimeout(() => {
      triggerEl.className = original;
      triggerEl.style.pointerEvents = "";
    }, 900);
  }
}

function removeFromQueue(index: number) {
  queue.splice(index, 1);
  renderQueue();
}

function reorderQueue(from: number, to: number) {
  const [item] = queue.splice(from, 1);
  queue.splice(to, 0, item);
  renderQueue();
}

function initQueueDragListeners() {
  const list = document.getElementById("queue-list")!;

  list.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    const target = (e.target as HTMLElement).closest<HTMLElement>(
      "li.queue-item:not(.queue-item--current)",
    );
    document
      .querySelectorAll(".queue-item")
      .forEach((el) => el.classList.remove("drag-over"));
    if (target) target.classList.add("drag-over");
  });

  list.addEventListener("dragleave", (e) => {
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
      "li.queue-item:not(.queue-item--current)",
    );
    if (!target) return;
    const toIndex = parseInt(target.dataset.index!);
    if (dragSrcIndex !== null && dragSrcIndex !== toIndex) {
      reorderQueue(dragSrcIndex, toIndex);
    }
  });
}

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
    li.dataset.index = String(index);

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
      requestAnimationFrame(() => li.classList.add("dragging"));
    });

    li.addEventListener("dragend", () => {
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
    } catch {}
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
    saves: playlist.followers.total.toLocaleString(), // Format number with commas
    count: playlist.tracks.total,
    tracks: extractTracksFromPlaylist(playlist.tracks.items),
  };
}

export function showPlaylist(id: string) {
  playlistPlayBtn = document.querySelector<HTMLElement>(".play-button")!;

  renderPlaylistHeaderSkeleton();
  renderTrackSkeletons(
    document.querySelector<HTMLUListElement>(".playlist-tracks")!,
  );

  getPlaylist(id)
    .then((playlist) => {
      const playlistImage = document.querySelector<HTMLImageElement>(
        ".playlist-image-object",
      )!;
      const playlistTitle = document.querySelector(".playlist-main-title")!;
      const playlistDescription = document.querySelector(
        ".playlist-description",
      )!;
      const playlistUL =
        document.querySelector<HTMLUListElement>(".playlist-tracks")!;
      const playButton = document.querySelector<HTMLElement>(".play-button")!;

      clearPlaylistHeaderSkeleton();
      playlistImage.src = playlist.icon;
      playlistTitle.innerHTML = playlist.name;
      playlistDescription.innerHTML = playlist.description;
      playButton.style.display = "inline-block";

      const icon = playButton.querySelector("i")!;
      icon.className = "fa-solid fa-circle-play";
      playButton.style.pointerEvents = "";
      playButton.style.opacity = "";

      const ownerEl = document.querySelector(".meta-owner")!;
      const countEl = document.querySelector(".meta-songs")!;

      ownerEl.textContent = playlist.owner;
      countEl.textContent = `${playlist.tracks.length} tracks`;

      const queueItems: QueueItem[] = playlist.tracks.map((t: any) => ({
        uri: t.uri,
        name: t.name,
        artists: t.artists,
        image: t.image,
      }));

      playlistUL.innerHTML = "";

      playlist.tracks.forEach((track: any, index: number) => {
        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        const li = document.createElement("li");

        const image = document.createElement("img");
        image.src = track.image;

        const name = document.createElement("p");
        name.classList.add("track-name");
        name.textContent = track.name;

        const artists = document.createElement("p");
        artists.classList.add("track-artists");
        artists.textContent = track.artists;

        const group = document.createElement("div");
        group.classList.add("playlist-track-item");
        group.append(name);
        group.append(artists);

        const add = document.createElement("i");
        add.classList.add("fa-solid", "fa-plus");
        add.onclick = (e) => {
          e.stopPropagation();
          addToQueue(queueItems[index], add);
        };

        const album = document.createElement("p");
        album.textContent = track.album;
        album.classList.add("track-album");

        const duration = document.createElement("p");
        duration.textContent = track.duration;
        duration.classList.add("track-duration");

        li.append(image, group, album, duration);
        li.onclick = () => playPlaylist(queueItems, index);

        trackDiv.append(li, add);
        playlistUL.appendChild(trackDiv);
      });

      playButton.onclick = () => {
        setPlaylistPlayBtnLoading(true);
        playPlaylist(queueItems, 0);
      };
    })
    .catch(() => {
      clearPlaylistHeaderSkeleton();
      document.querySelector(".playlist-main-title")!.innerHTML =
        "Failed to load playlist";
      document.querySelector(".playlist-description")!.innerHTML = "";
      document.querySelector<HTMLUListElement>(".playlist-tracks")!.innerHTML =
        "";
      showToast("Could not load playlist. Try again.", true);
    });
}

async function loadPlaylists() {
  const ul = document.querySelector<HTMLUListElement>("#playlist-list")!;
  ul.innerHTML = "";

  for (let i = 0; i < 8; i++) {
    const li = document.createElement("li");
    li.className = "sidebar-playlist-item sidebar-skeleton-item";
    li.innerHTML = `
      <div class="skeleton sidebar-sk-img"></div>
      <div class="skeleton sidebar-sk-name" style="width:${45 + Math.random() * 35}%"></div>
    `;
    ul.appendChild(li);
  }

  try {
    const data = await fetchApi("me/playlists?limit=50");
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

    showPlaylist(data.items[0].id);
  } catch {
    ul.innerHTML = "";
    showToast("Could not load playlists.", true);
  }
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
  setPlaylistPlayBtnLoading(false);

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
  if (currentDurationMs > 0) {
    const pct = (payload / currentDurationMs) * 100;
    seek.value = String(pct);
    seek.style.backgroundSize = `${pct}% 100%`;
  }
  timeEl.innerHTML = millisToMinutesAndSeconds(payload);
});

async function togglePlay() {
  animatePress(toggleBtn);
  lockButton(toggleBtn, 600);
  try {
    if (isPlaying) {
      await invoke("player_pause");
      setPlayingUI(false);
    } else {
      await invoke("player_resume");
      setPlayingUI(true);
    }
  } catch {
    showToast("Playback error. Try again.", true);
    toggleBtn.disabled = false;
  }
}

toggleBtn.onclick = togglePlay;

document.getElementById("queue-toggle")!.onclick = toggleQueuePanel;

nextBtn.onclick = () => {
  animatePress(nextBtn);
  lockButton(nextBtn, 600);
  advanceQueue();
};

prevBtn.onclick = async () => {
  animatePress(prevBtn);
  lockButton(prevBtn, 600);
  try {
    await invoke("player_seek", { positionMs: 0 });
    resetDurationValues();
  } catch {
    showToast("Seek error. Try again.", true);
    prevBtn.disabled = false;
  }
};

const volume = document.querySelector<HTMLInputElement>("#volume-control")!;
volume.addEventListener("input", (e) => {
  const el = e.currentTarget as HTMLInputElement;
  el.style.backgroundSize = `${el.value}% 100%`;
});
volume.addEventListener("change", (e) => {
  const el = e.currentTarget as HTMLInputElement;
  el.style.backgroundSize = `${el.value}% 100%`;
  invoke("player_set_volume", { volume: Number(el.value) / 100 });
});

const seekEl = document.querySelector<HTMLInputElement>("#seek")!;
const seekTimeEl =
  document.querySelector(".track-controller")!.firstElementChild!;

seekEl.addEventListener("input", () => {
  seekEl.style.backgroundSize = `${seekEl.valueAsNumber}% 100%`;
  const position = (seekEl.valueAsNumber / 100) * currentDurationMs;
  seekTimeEl.innerHTML = millisToMinutesAndSeconds(position);
});

seekEl.addEventListener("change", () => {
  const position = (seekEl.valueAsNumber / 100) * currentDurationMs;
  seekTimeEl.innerHTML = millisToMinutesAndSeconds(position);
  invoke("player_seek", { positionMs: Math.floor(position) });
});

const search = document.querySelector<HTMLInputElement>("#search")!;
let searchPending = false;

const doSearch = debounce(() => {
  if (!search.value) return;
  const body = new URLSearchParams({
    q: search.value,
    type: "track,playlist",
    limit: "4",
  });
  fetchApi("search?" + body)
    .then((res) => {
      searchPending = false;
      handleSearchPlaylists(res.playlists);
      handleSearchTracks(res.tracks);
    })
    .catch(() => {
      searchPending = false;
      document.querySelector<HTMLElement>(".tracks-results")!.innerHTML = "";
      document.querySelector<HTMLElement>(".playlists-results")!.innerHTML = "";
      showToast("Search failed. Try again.", true);
    });
}, 900);

search.addEventListener("keyup", () => {
  if (!search.value) {
    document.querySelector<HTMLElement>(".tracks-results")!.innerHTML = "";
    document.querySelector<HTMLElement>(".playlists-results")!.innerHTML = "";
    searchPending = false;
    return;
  }
  if (!searchPending) {
    searchPending = true;
    renderSearchSkeletons();
  }
  doSearch();
});

export function init() {
  loadPlaylists();
  renderQueue();
  initQueueDragListeners();

  listen("smtc_play", () => {
    invoke("player_resume").then(() => setPlayingUI(true));
  });

  listen("smtc_pause", () => {
    invoke("player_pause").then(() => setPlayingUI(false));
  });

  listen("smtc_next", () => advanceQueue());

  listen("smtc_prev", () => {
    invoke("player_seek", { positionMs: 0 });
    resetDurationValues();
  });

  listen("player_paused", () => setPlayingUI(false));

  listen("player_stopped", () => {
    setPlayingUI(false);
    resetDurationValues();
  });

  listen("track_ended", () => {
    if (queue.length > 0) {
      advanceQueue();
    } else {
      setPlayingUI(false);
      resetDurationValues();
    }
  });

  const initialVolume = 50;
  volume.value = String(initialVolume);
  volume.style.backgroundSize = `${initialVolume}% 100%`;
  invoke("player_set_volume", { volume: initialVolume / 100 });

  document.addEventListener("keydown", async (event) => {
    if (event.code !== "Space") return;

    const active = document.activeElement;

    // ignore if typing in input or textarea
    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active?.getAttribute("contenteditable") === "true"
    ) {
      return;
    }

    event.preventDefault(); // stops page scroll on space

    if (isPlaying) {
      await invoke("player_pause");
      setPlayingUI(false);
    } else {
      await invoke("player_resume");
      setPlayingUI(true);
    }
  });
}
