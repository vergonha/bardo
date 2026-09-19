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

interface TrackArtist {
  id: string;
  name: string;
}

function webTrackRow(track: any) {
  return {
    uri: track.uri,
    name: track.name,
    artists: track.artists.map((a: any) => a.name).join(", "),
    artist_list: track.artists.map((a: any) => ({ id: a.id, name: a.name })),
    album: track.album.name,
    album_id: track.album.id,
    image: track.album.images?.[0]?.url ?? "",
    duration: millisToMinutesAndSeconds(track.duration_ms),
  };
}

const MAX_HISTORY = 5;

let currentDurationMs = 0;
let isPlaying = false;
let currentTrack: QueueItem | null = null;
let queue: QueueItem[] = [];
let history: QueueItem[] = [];
let queueVisible = true;
let dragSrcIndex: number | null = null;
let playlistPlayBtn: HTMLElement | null = null;

const toggleBtn = document.getElementById("toggle") as HTMLButtonElement;
const nextBtn = document.getElementById("nextTrack") as HTMLButtonElement;
const prevBtn = document.getElementById("previousTrack") as HTMLButtonElement;

let playbackReady = false;
let playbackWarned = false;
const playbackWaiters: (() => void)[] = [];

// the rootlist is one of the endpoints the first paint waits on, and it needs
// the connect session, which on a restored login arrives seconds after this
// page. the timeout keeps a dead playback from holding the UI on skeletons.
function waitForPlayback(timeoutMs = 12000): Promise<void> {
  if (playbackReady) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    playbackWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// the connect session takes a few seconds to come up after a restore, so a
// command that lands before it is a wait, not a failure. only a command that
// fails once playback has actually been up is worth telling the user about.
function playerCmd(command: string, args?: Record<string, unknown>) {
  return invoke(command, args).catch((e) => {
    console.error(`[bardo] ${command} failed:`, e);
    if (playbackReady && !playbackWarned) {
      playbackWarned = true;
      showToast("Playback disconnected. Reconnecting...", true, 4000);
    }
  });
}

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

async function getAlbum(id: string) {
  const data = await fetchApi(`albums/${id}`);

  return {
    name: data.name,
    image: data.images?.[0]?.url || "",
    artists: data.artists.map((a: any) => a.name).join(", "),
    tracks: data.tracks.items.map((t: any) => ({
      uri: t.uri,
      name: t.name,
      artists: t.artists.map((a: any) => a.name).join(", "),
      artist_list: t.artists.map((a: any) => ({ id: a.id, name: a.name })),
      image: data.images?.[0]?.url,
      album: data.name,
      duration: millisToMinutesAndSeconds(t.duration_ms),
    })),
  };
}

function showAlbum(id: string) {
  showPage("detail");
  playlistPlayBtn = document.querySelector<HTMLElement>(".play-button")!;

  renderPlaylistHeaderSkeleton();
  renderTrackSkeletons(
    document.querySelector<HTMLUListElement>(".playlist-content .playlist-tracks")!,
  );

  getAlbum(id)
    .then((album) => {
      const playlistImage = document.querySelector<HTMLImageElement>(
        ".playlist-image-object",
      )!;
      const playlistTitle = document.querySelector(".playlist-main-title")!;
      const playlistDescription = document.querySelector(
        ".playlist-description",
      )!;
      const playlistUL =
        document.querySelector<HTMLUListElement>(".playlist-content .playlist-tracks")!;
      const playButton = document.querySelector<HTMLElement>(".play-button")!;

      clearPlaylistHeaderSkeleton();

      playlistImage.src = album.image;
      playlistTitle.innerHTML = album.name;
      playlistDescription.innerHTML = album.artists;

      playButton.style.display = "inline-block";

      const icon = playButton.querySelector("i")!;
      icon.className = "fa-solid fa-circle-play";
      playButton.style.pointerEvents = "";
      playButton.style.opacity = "";

      const ownerEl = document.querySelector(".meta-owner")!;
      const countEl = document.querySelector(".meta-songs")!;

      ownerEl.textContent = "Album";
      countEl.textContent = `${album.tracks.length} tracks`;

      const queueItems: QueueItem[] = album.tracks.map((t: any) => ({
        uri: t.uri,
        name: t.name,
        artists: t.artists,
        image: t.image,
      }));

      playlistUL.innerHTML = "";

      album.tracks.forEach((track: any, index: number) => {
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
        renderArtistLinks(artists, track.artist_list, track.artists);

        const group = document.createElement("div");
        group.classList.add("playlist-track-item");
        group.append(name, artists);

        const add = document.createElement("i");
        add.classList.add("fa-solid", "fa-plus");
        add.onclick = (e) => {
          e.stopPropagation();
          addToQueue(queueItems[index], add);
        };

        const albumName = document.createElement("p");
        albumName.textContent = track.album;
        albumName.classList.add("track-album");

        const duration = document.createElement("p");
        duration.textContent = track.duration;
        duration.classList.add("track-duration");

        li.append(image, group, albumName, duration);
        li.onclick = () => handleTrackClick(li, queueItems, index);

        trackDiv.append(li, add);
        playlistUL.appendChild(trackDiv);
      });

      playButton.onclick = () => {
        setPlaylistPlayBtnLoading(true);
        playPlaylist(queueItems, 0);
      };
    })
    .catch((e) => {
      console.error(e);
      clearPlaylistHeaderSkeleton();
      document.querySelector(".playlist-main-title")!.innerHTML =
        "Failed to load album";
      document.querySelector(".playlist-description")!.innerHTML = "";
      document.querySelector<HTMLUListElement>(".playlist-content .playlist-tracks")!.innerHTML =
        "";
      showToast("Could not load album. Try again.", true);
    });
}

async function getArtistTopTracks(id: string) {
  const data = await fetchApi(`artists/${id}/top-tracks?market=from_token`);
  return data.tracks.map(webTrackRow);
}

async function getArtistAlbums(id: string) {
  const data = await fetchApi(
    `artists/${id}/albums?include_groups=album,single&limit=20`,
  );
  const seen = new Set<string>();
  const albums: any[] = [];
  for (const a of data.items ?? []) {
    const key = a.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    albums.push(a);
  }
  return albums;
}

function showArtist(id: string) {
  showPage("artist");

  const heroImage = document.querySelector<HTMLImageElement>(
    ".artist-image-object",
  )!;
  const heroTitle = document.querySelector(".artist-main-title")!;
  const heroMeta = document.querySelector(".artist-meta")!;
  const shelves = document.querySelector<HTMLElement>(".artist-shelves")!;
  playlistPlayBtn = document.querySelector<HTMLElement>(".artist-play-button")!;

  heroImage.src = "";
  heroImage.classList.add("skeleton");
  heroTitle.innerHTML = `<span class="skeleton skeleton-inline" style="width:220px;height:22px;"></span>`;
  heroMeta.innerHTML = "";
  playlistPlayBtn.style.display = "none";
  shelves.innerHTML = "";

  const popularRow = shelf("Popular", shelves);
  popularRow.classList.add("shelf-tracks", "playlist-tracks");
  const discographyRow = shelf("Discography", shelves);

  renderTrackSkeletons(popularRow, 5);
  renderShelfSkeletons(discographyRow, 6);

  fetchApi(`artists/${id}`)
    .then((artist) => {
      heroImage.classList.remove("skeleton");
      heroImage.src = artist.images?.[0]?.url ?? "";
      heroTitle.textContent = artist.name;
      heroMeta.textContent = artist.followers?.total
        ? `${artist.followers.total.toLocaleString()} followers`
        : "";
    })
    .catch(() => {
      heroImage.classList.remove("skeleton");
      heroTitle.textContent = "Failed to load artist";
    });

  getArtistTopTracks(id)
    .then((tracks) => {
      if (!tracks.length) return shelfMessage(popularRow, "Nothing here yet");
      renderTrackRows(popularRow, tracks.slice(0, 5));

      const queueItems: QueueItem[] = tracks.map((t: any) => ({
        uri: t.uri,
        name: t.name,
        artists: t.artists,
        image: t.image,
      }));

      playlistPlayBtn!.style.display = "inline-block";
      const icon = playlistPlayBtn!.querySelector("i")!;
      icon.className = "fa-solid fa-circle-play";
      playlistPlayBtn!.onclick = () => {
        setPlaylistPlayBtnLoading(true);
        playPlaylist(queueItems, 0);
      };
    })
    .catch(() => shelfMessage(popularRow, "Couldn't load this shelf"));

  getArtistAlbums(id)
    .then((albums) => {
      if (!albums.length) return shelfMessage(discographyRow, "No releases yet");
      discographyRow.innerHTML = "";
      for (const album of albums) {
        discographyRow.appendChild(
          card(
            album.images?.[0]?.url ?? "",
            album.name,
            `${album.release_date?.slice(0, 4) ?? ""} • ${album.album_type}`,
            false,
            () => showAlbum(album.id),
          ),
        );
      }
    })
    .catch(() => shelfMessage(discographyRow, "Couldn't load this shelf"));
}

function renderArtistLinks(
  el: HTMLElement,
  artistList: TrackArtist[] | undefined,
  fallback: string,
) {
  if (!artistList?.length) {
    el.textContent = fallback;
    return;
  }

  el.textContent = "";
  artistList.forEach((artist, index) => {
    if (index > 0) el.append(", ");
    if (!artist.id) {
      el.append(artist.name);
      return;
    }
    const link = document.createElement("span");
    link.className = "entity-link";
    link.textContent = artist.name;
    link.onclick = (e) => {
      e.stopPropagation();
      showArtist(artist.id);
    };
    el.append(link);
  });
}

function linkToAlbum(el: HTMLElement, albumId: string) {
  if (!albumId) return;
  el.classList.add("entity-link");
  el.onclick = (e) => {
    e.stopPropagation();
    showAlbum(albumId);
  };
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

  renderShelfSkeletons(document.querySelector<HTMLElement>(".artists-results")!, 4, true);

  const albumsDiv = document.querySelector<HTMLElement>(".albums-results")!;
  albumsDiv.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    const div = document.createElement("div");
    div.className = "pl-skeleton-card";
    div.innerHTML = `
      <div class="skeleton pl-sk-img"></div>
      <div class="skeleton pl-sk-name" style="width:${55 + Math.random() * 30}%"></div>
      <div class="skeleton pl-sk-sub" style="width:${35 + Math.random() * 20}%"></div>
    `;
    albumsDiv.appendChild(div);
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
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[bardo] ${endpoint} -> ${response.status} ${body}`);
    throw new Error(`API error ${response.status}`);
  }
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
  playerCmd("player_play_track", { uri: item.uri });
  renderQueue();
}

export function playPlaylist(tracks: QueueItem[], startIndex = 0) {
  queue = tracks.slice(startIndex + 1);
  startTrack(tracks[startIndex]);
  setPlaylistPlayBtnLoading(false);
}

let loadingTrackEl: HTMLElement | null = null;

function clearTrackLoading() {
  loadingTrackEl?.classList.remove("track-row-loading");
  loadingTrackEl = null;
}

function handleTrackClick(li: HTMLElement, tracks: QueueItem[], index: number) {
  clearTrackLoading();
  li.classList.add("track-row-loading");
  loadingTrackEl = li;
  playPlaylist(tracks, index);
}

export function playSearchTrack(uri: string) {
  if (currentTrack) pushHistory(currentTrack);
  currentTrack = null;
  queue = [];
  resetDurationValues();
  setPlayingUI(true);
  playerCmd("player_play_track", { uri });
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
  queue.unshift(item);
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
  document.querySelector<HTMLElement>("article")!.style.display = queueVisible
    ? "flex"
    : "none";
  document
    .getElementById("queue-toggle")!
    .classList.toggle("active", queueVisible);
}

function extractInfoFromTrack(track: any) {
  return {
    name: track.name,
    id: track.id,
    album: track.album.name,
    album_id: track.album.id,
    image: track.album.images[0].url,
    uri: track.uri,
    artists: track.artists.map((a: any) => a.name).join(", "),
    artist_list: track.artists.map((a: any) => ({ id: a.id, name: a.name })),
    duration: millisToMinutesAndSeconds(track.duration_ms),
  };
}

function extractTracksFromPlaylist(tracks: any[]): any[] {
  const infos: any[] = [];
  tracks.forEach((item) => {
    try {
      infos.push(extractInfoFromTrack(item.item ?? item.track));
    } catch {}
  });
  return infos;
}

interface SessionPlaylist {
  name: string;
  description: string;
  owner: string;
  icon: string | null;
  tracks: {
    uri: string;
    id: string;
    name: string;
    artists: string;
    artist_list: TrackArtist[];
    album: string;
    album_id: string;
    image: string;
    duration_ms: number;
  }[];
}

async function getPlaylist(id: string) {
  try {
    const playlist = await invoke<SessionPlaylist>("get_session_playlist", { id });
    return {
      description: playlist.description,
      name: playlist.name,
      owner: playlist.owner,
      icon: playlist.icon ?? "",
      tracks: playlist.tracks.map((t) => ({
        ...t,
        duration: millisToMinutesAndSeconds(t.duration_ms),
      })),
    };
  } catch {
    return getPlaylistViaApi(id);
  }
}

async function getPlaylistViaApi(id: string) {
  const [playlist, page] = await Promise.all([
    fetchApi(`playlists/${id}`),
    fetchApi(`playlists/${id}/items?limit=100&additional_types=track,episode`),
  ]);
  return {
    description: playlist.description ?? "",
    name: playlist.name,
    owner: playlist.owner?.display_name ?? "",
    icon: playlist.images?.[0]?.url ?? "",
    tracks: extractTracksFromPlaylist(page.items ?? []),
  };
}

export function showPlaylist(id: string) {
  showPage("detail");
  playlistPlayBtn = document.querySelector<HTMLElement>(".play-button")!;

  renderPlaylistHeaderSkeleton();
  renderTrackSkeletons(
    document.querySelector<HTMLUListElement>(".playlist-content .playlist-tracks")!,
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
        document.querySelector<HTMLUListElement>(".playlist-content .playlist-tracks")!;
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
        renderArtistLinks(artists, track.artist_list, track.artists);

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
        linkToAlbum(album, track.album_id);

        const duration = document.createElement("p");
        duration.textContent = track.duration;
        duration.classList.add("track-duration");

        li.append(image, group, album, duration);
        li.onclick = () => handleTrackClick(li, queueItems, index);

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
      document.querySelector<HTMLUListElement>(".playlist-content .playlist-tracks")!.innerHTML =
        "";
      showToast("Could not load playlist. Try again.", true);
    });
}

interface RootlistPlaylist {
  uri: string;
  name: string;
  image_url: string | null;
  owner: string;
}


let cachedUserId: string | null = null;
async function getCurrentUserId(): Promise<string | null> {
  if (cachedUserId) return cachedUserId;
  try {
    cachedUserId = (await fetchApi("me")).id;
    return cachedUserId;
  } catch {
    return null;
  }
}

async function fetchMadeForYou(): Promise<any[]> {
  const [library, userId] = await Promise.all([
    fetchLibraryPlaylists(),
    getCurrentUserId(),
  ]);
  return library.filter((playlist) => !userId || playlist.owner?.id !== userId);
}

async function fetchRecentlyPlayed(): Promise<any[]> {
  const data = await fetchApi("me/player/recently-played?limit=50");
  const seen = new Set<string>();
  const tracks: any[] = [];
  for (const entry of (data.items ?? []) as any[]) {
    const track = entry.track;
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    tracks.push(track);
    if (tracks.length === 16) break;
  }
  return tracks;
}

const fetchTopArtists = () =>
  fetchApi("me/top/artists?time_range=medium_term&limit=20").then(
    (d) => d.items ?? [],
  );
const fetchTopTracks = () =>
  fetchApi("me/top/tracks?time_range=short_term&limit=20").then(
    (d) => d.items ?? [],
  );

function shelf(
  title: string,
  container: HTMLElement = document.querySelector(".home-content")!,
): HTMLElement {
  const section = document.createElement("section");
  section.className = "shelf";

  const heading = document.createElement("h2");
  heading.className = "shelf-title";
  heading.textContent = title;

  const row = document.createElement("div");
  row.className = "shelf-row";

  section.append(heading, row);
  container.appendChild(section);
  return row;
}

function card(
  image: string,
  name: string,
  subtitle: string,
  round: boolean,
  onClick: () => void,
): HTMLElement {
  const el = document.createElement("div");
  el.className = round ? "shelf-card shelf-card-round" : "shelf-card";
  el.onclick = onClick;

  const img = document.createElement("img");
  img.className = "shelf-card-image";
  img.src = image;
  img.alt = name;

  const title = document.createElement("p");
  title.className = "shelf-card-name";
  title.textContent = name;

  const sub = document.createElement("p");
  sub.className = "shelf-card-subtitle";
  sub.textContent = subtitle;

  el.append(img, title, sub);
  return el;
}

function stripHtml(text: string): string {
  const el = document.createElement("div");
  el.innerHTML = text;
  return (el.textContent ?? "").trim();
}

function renderShelfSkeletons(row: HTMLElement, count = 6, round = false) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = round ? "shelf-card shelf-card-round" : "shelf-card";
    el.innerHTML = `
      <div class="skeleton shelf-card-image"></div>
      <div class="skeleton shelf-sk-line" style="width:${50 + Math.random() * 35}%"></div>
      <div class="skeleton shelf-sk-line" style="width:${30 + Math.random() * 25}%"></div>
    `;
    row.appendChild(el);
  }
}

function shelfMessage(row: HTMLElement, text: string) {
  row.innerHTML = "";
  const p = document.createElement("p");
  p.className = "shelf-empty";
  p.textContent = text;
  row.appendChild(p);
}

function renderTrackRows(container: HTMLElement, tracks: any[]) {
  const queueItems: QueueItem[] = tracks.map((t) => ({
    uri: t.uri,
    name: t.name,
    artists: t.artists,
    image: t.image,
  }));

  container.innerHTML = "";
  tracks.forEach((track, index) => {
    const trackDiv = document.createElement("div");
    trackDiv.className = "track";

    const li = document.createElement("li");

    const image = document.createElement("img");
    image.src = track.image;

    const name = document.createElement("p");
    name.className = "track-name";
    name.textContent = track.name;

    const artists = document.createElement("p");
    artists.className = "track-artists";
    renderArtistLinks(artists, track.artist_list, track.artists);

    const group = document.createElement("div");
    group.className = "playlist-track-item";
    group.append(name, artists);

    const add = document.createElement("i");
    add.classList.add("fa-solid", "fa-plus");
    add.onclick = (e) => {
      e.stopPropagation();
      addToQueue(queueItems[index], add);
    };

    const album = document.createElement("p");
    album.className = "track-album";
    album.textContent = track.album;
    linkToAlbum(album, track.album_id);

    const duration = document.createElement("p");
    duration.className = "track-duration";
    duration.textContent = track.duration;

    li.append(image, group, album, duration);
    li.onclick = () => handleTrackClick(li, queueItems, index);

    trackDiv.append(li, add);
    container.appendChild(trackDiv);
  });
}

function showPage(page: "home" | "detail" | "artist" | "search") {
  document.querySelector<HTMLElement>(".home-content")!.style.display =
    page === "home" ? "block" : "none";
  document.querySelector<HTMLElement>(".playlist-content")!.style.display =
    page === "detail" ? "flex" : "none";
  document.querySelector<HTMLElement>(".artist-content")!.style.display =
    page === "artist" ? "block" : "none";
  document.querySelector<HTMLElement>(".search-page")!.style.display =
    page === "search" ? "block" : "none";
}

export function showHome() {
  showPage("home");
}

const HOME_SHELVES = [
  { key: "made-for-you", title: "Made for you" },
  { key: "recent", title: "Recently played" },
  { key: "top-artists", title: "Your top artists" },
  { key: "top-songs", title: "Your top songs" },
];

function homeRow(key: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-shelf="${key}"] .shelf-row`)!;
}

function renderHomeSkeleton() {
  const home = document.querySelector<HTMLElement>(".home-content")!;
  home.innerHTML = "";

  for (const { key, title } of HOME_SHELVES) {
    const row = shelf(title);
    row.parentElement!.setAttribute("data-shelf", key);
    if (key === "recent" || key === "top-songs") {
      row.classList.add("shelf-tracks", "playlist-tracks");
      renderTrackSkeletons(row, 5);
    } else {
      renderShelfSkeletons(row, 6, key === "top-artists");
    }
  }
}

function fetchHome() {
  return Promise.allSettled([
    fetchMadeForYou(),
    fetchRecentlyPlayed(),
    fetchTopArtists(),
    fetchTopTracks(),
  ]);
}

function fillShelf(
  key: string,
  result: PromiseSettledResult<any[]>,
  empty: string,
  render: (row: HTMLElement, items: any[]) => void,
) {
  const row = homeRow(key);
  if (result.status === "rejected") {
    return shelfMessage(row, "Couldn't load this shelf");
  }
  if (!result.value.length) return shelfMessage(row, empty);
  render(row, result.value);
}

function renderHome(results: PromiseSettledResult<any[]>[]) {
  const [madeForYou, recent, artists, topSongs] = results;

  fillShelf("made-for-you", madeForYou, "Nothing here yet", (row, playlists) => {
    row.innerHTML = "";
    for (const playlist of playlists) {
      const description = stripHtml(playlist.description ?? "");
      row.appendChild(
        card(
          playlist.images?.[0]?.url ?? "",
          playlist.name,
          description || `By ${playlist.owner?.display_name ?? "Spotify"}`,
          false,
          () => showPlaylist(playlist.id),
        ),
      );
    }
  });

  fillShelf("recent", recent, "Nothing played yet", (row, tracks) => {
    renderTrackRows(row, tracks.slice(0, 10).map(webTrackRow));
  });

  fillShelf("top-artists", artists, "Nothing here yet", (row, list) => {
    row.innerHTML = "";
    for (const artist of list) {
      row.appendChild(
        card(artist.images?.[0]?.url ?? "", artist.name, "Artist", true, () =>
          showArtist(artist.id),
        ),
      );
    }
  });

  fillShelf("top-songs", topSongs, "Nothing here yet", (row, tracks) => {
    renderTrackRows(row, tracks.slice(0, 10).map(webTrackRow));
  });
}

async function fetchWebApiPlaylists(): Promise<any[]> {
  const items: any[] = [];
  let offset = 0;
  const limit = 50;
  for (;;) {
    const page = await fetchApi(`me/playlists?limit=${limit}&offset=${offset}`);
    items.push(...page.items);
    if (page.items.length < limit || items.length >= page.total) break;
    offset += limit;
  }
  return items;
}

async function fetchLibraryPlaylists(): Promise<any[]> {
  const [rootlist, web] = await Promise.all([
    invoke<RootlistPlaylist[]>("get_rootlist_playlists").catch((e) => {
      console.error("[bardo] rootlist failed:", e);
      return [] as RootlistPlaylist[];
    }),
    fetchWebApiPlaylists().catch((e) => {
      console.error("[bardo] me/playlists failed:", e);
      return [] as any[];
    }),
  ]);
  if (!rootlist.length && !web.length) {
    throw new Error("no playlist source answered");
  }
  const byUri = new Map(web.map((p) => [p.uri, p]));

  const items = rootlist.map((p) => {
    const listed = byUri.get(p.uri);
    byUri.delete(p.uri);
    return {
      ...listed,
      id: p.uri.split(":")[2],
      uri: p.uri,
      name: listed?.name || p.name,
      images: listed?.images?.length
        ? listed.images
        : p.image_url
          ? [{ url: p.image_url }]
          : [],
      owner: listed?.owner ?? { id: p.owner, display_name: p.owner },
      description: listed?.description ?? "",
    };
  });
  return [...items, ...byUri.values()];
}

function renderSidebarSkeleton() {
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
}

function renderSidebar(result: PromiseSettledResult<any[]>) {
  const ul = document.querySelector<HTMLUListElement>("#playlist-list")!;
  ul.innerHTML = "";

  if (result.status === "rejected") {
    showToast("Could not load playlists.", true);
    return;
  }

  result.value.forEach((playlist: any) => {
    const li = document.createElement("li");
    li.className = "sidebar-playlist-item";

    const img = document.createElement("img");
    img.className = "sidebar-playlist-image";
    img.src = playlist.images?.[0]?.url || "";
    img.alt = playlist.name;

    const info = document.createElement("div");
    info.className = "sidebar-playlist-info";

    const span = document.createElement("span");
    span.className = "sidebar-playlist-name";
    span.textContent = playlist.name;

    const meta = document.createElement("span");
    meta.className = "sidebar-playlist-meta";
    meta.textContent = `Playlist • ${playlist.owner?.display_name || "Spotify"}`;

    info.appendChild(span);
    info.appendChild(meta);

    li.appendChild(img);
    li.appendChild(info);
    li.onclick = () => showPlaylist(playlist.id);

    ul.appendChild(li);
  });
}

// nothing paints until every endpoint has answered: a sidebar that fills in
// before the shelves, or a shelf at a time, reads as the app glitching rather
// than loading.
async function loadEverything() {
  renderSidebarSkeleton();
  renderHomeSkeleton();

  const [[playlists], shelves] = await Promise.all([
    Promise.allSettled([fetchLibraryPlaylists()]),
    fetchHome(),
  ]);

  renderSidebar(playlists);
  renderHome(shelves);
}

function handleSearchArtists(artists: any) {
  const artistsDiv = document.querySelector<HTMLElement>(".artists-results")!;
  artistsDiv.innerHTML = "";
  artists.items.forEach((artist: any) => {
    if (!artist.images.length) return;
    artistsDiv.appendChild(
      card(artist.images[0].url, artist.name, "Artist", true, () =>
        showArtist(artist.id),
      ),
    );
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
    name.classList.add("track-result-name");
    name.textContent = track.name;

    const artists = document.createElement("p");
    artists.classList.add("track-result-artists");
    renderArtistLinks(
      artists,
      track.artists.map((a: any) => ({ id: a.id, name: a.name })),
      "",
    );

    const info = document.createElement("div");
    info.classList.add("track-result-info");
    info.append(name, artists);

    const add = document.createElement("i");
    add.classList.add("fa-solid", "fa-plus");
    add.onclick = (e) => {
      e.stopPropagation();
      addToQueue(extractInfoFromTrack(track), add);
    };

    div.append(icon, info, add);
    div.onclick = () => playSearchTrack(track.uri);
    tracksDiv.appendChild(div);
  });
}

function handleSearchAlbums(albums: any) {
  const albumsDiv = document.querySelector<HTMLElement>(".albums-results")!;
  albumsDiv.innerHTML = "";
  albums.items.forEach((item: any) => {
    if (!item) return;

    const div = document.createElement("div");
    div.classList.add("playlist-result");

    const icon = document.createElement("img");
    icon.src = item.images[0].url;

    const name = document.createElement("h3");
    name.textContent = item.name;

    const artists = document.createElement("p");
    artists.textContent = item.artists.map((a: any) => a.name).join(", ");

    div.append(icon, name, artists);
    div.onclick = () => showAlbum(item.id);
    albumsDiv.appendChild(div);
  });
}

listen<TrackInfo>("track_changed", ({ payload }) => {
  clearTrackLoading();
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
      await playerCmd("player_pause");
      setPlayingUI(false);
    } else {
      await playerCmd("player_resume");
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
    await playerCmd("player_seek", { positionMs: 0 });
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
  playerCmd("player_set_volume", { volume: Number(el.value) / 100 });
});

// an empty value means "follow whatever windows calls the default output";
// picking a device pins playback to it instead.
const outputDevice = document.querySelector<HTMLSelectElement>("#output-device")!;
outputDevice.addEventListener("change", () => {
  invoke("set_output_device", { name: outputDevice.value || null });
});

async function loadOutputDevices() {
  const [devices, selected] = await Promise.all([
    invoke<string[]>("list_output_devices"),
    invoke<string | null>("get_output_device"),
  ]);
  outputDevice.length = 1;
  for (const name of devices) outputDevice.add(new Option(name, name));
  outputDevice.value = selected ?? "";
}

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
  playerCmd("player_seek", { positionMs: Math.floor(position) });
});

const search = document.querySelector<HTMLInputElement>("#search")!;
let searchPending = false;
let lastSearchTerm = "";

const doSearch = debounce(() => {
  if (!search.value || search.value === lastSearchTerm) return;
  lastSearchTerm = search.value;
  const body = new URLSearchParams({
    q: search.value,
    type: "track,album,artist",
    limit: "4",
  });
  fetchApi("search?" + body)
    .then((res) => {
      searchPending = false;
      handleSearchArtists(res.artists);
      handleSearchAlbums(res.albums);
      handleSearchTracks(res.tracks);
    })
    .catch((e) => {
      console.error(e);
      searchPending = false;
      document.querySelector<HTMLElement>(".tracks-results")!.innerHTML = "";
      document.querySelector<HTMLElement>(".artists-results")!.innerHTML = "";
      document.querySelector<HTMLElement>(".albums-results")!.innerHTML = "";
      showToast("Search failed. Try again.", true);
    });
}, 900);

function setSearchResultsVisible(visible: boolean) {
  document.querySelector<HTMLElement>(".search-page-results")!.style.display =
    visible ? "block" : "none";
}

search.addEventListener("keyup", () => {
  if (!search.value) {
    document.querySelector<HTMLElement>(".tracks-results")!.innerHTML = "";
    document.querySelector<HTMLElement>(".artists-results")!.innerHTML = "";
    document.querySelector<HTMLElement>(".albums-results")!.innerHTML = "";
    searchPending = false;
    lastSearchTerm = "";
    setSearchResultsVisible(false);
    return;
  }
  setSearchResultsVisible(true);
  if (search.value === lastSearchTerm) return;
  if (!searchPending) {
    searchPending = true;
    renderSearchSkeletons();
  }
  doSearch();
});

export function showSearch() {
  showPage("search");
  setSearchResultsVisible(!!search.value);
  search.focus();
}

export function init() {
  // the rootlist and every player command need the connect session, which on
  // a restored login comes up seconds after this page does. reload what
  // depends on it once the backend says it is there.
  listen("playback_ready", () => {
    playbackReady = true;
    playbackWarned = false;
    playbackWaiters.splice(0).forEach((resume) => resume());
    playerCmd("player_set_volume", { volume: Number(volume.value) / 100 });
  });

  listen("playback_lost", () => {
    playbackReady = false;
  });

  showHome();
  renderSidebarSkeleton();
  renderHomeSkeleton();
  waitForPlayback().then(loadEverything);

  renderQueue();
  initQueueDragListeners();

  document.getElementById("home-link")!.onclick = () => showHome();
  document.getElementById("search-link")!.onclick = () => showSearch();

  listen("smtc_play", () => {
    playerCmd("player_resume").then(() => setPlayingUI(true));
  });

  listen("smtc_pause", () => {
    playerCmd("player_pause").then(() => setPlayingUI(false));
  });

  listen("smtc_next", () => advanceQueue());

  listen("smtc_prev", () => {
    playerCmd("player_seek", { positionMs: 0 });
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
  playerCmd("player_set_volume", { volume: initialVolume / 100 });

  loadOutputDevices();
  // devices come and go while the app is open, so refresh the list when the
  // user is about to look at it.
  outputDevice.addEventListener("mousedown", loadOutputDevices);

  document.addEventListener("keydown", async (event) => {
    if (event.code !== "Space") return;

    const active = document.activeElement;

    if (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active?.getAttribute("contenteditable") === "true"
    ) {
      return;
    }

    event.preventDefault();

    if (isPlaying) {
      await playerCmd("player_pause");
      setPlayingUI(false);
    } else {
      await playerCmd("player_resume");
      setPlayingUI(true);
    }
  });
}
