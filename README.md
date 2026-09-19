<h1 align="center">
  <img src="https://i.imgur.com/a70NMbc.png" width="30px">
  bardo ꒰ᐢ. .ᐢ꒱ lightweight player
  <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/1/19/Spotify_logo_without_text.svg/3840px-Spotify_logo_without_text.svg.png" width="22px">
</h1>
<div style="display: flex; align-items: center;">
    <img src="https://i.imgur.com/E07fW9M.png" style="align-self: flex-start;" />
</div>

---

## 𐔌՞. .՞𐦯    a simple way to listen to music

because of microsoft dominance in market standards i have to use windows as my work tool. but thanks to the amount of bloatware in the os eating up resources, i need to build lightweight solutions that dont consume all my ram.

<img align="right" width="334" height="169" alt="image" src="https://github.com/user-attachments/assets/c2a4694c-5c33-413b-aa4e-3f13027b8ded" />

thats how bardo came to be. a player made FOR ME, using tauri, to listen to my playlists and artists directly from my spotify account.

---

### .⋆♱ implementation ── 

i reused the front-end from a 2023 project, when bardo was actually a web app to listen to music inside a vm at the company i used to work for.

<img align="right" width="291" height="125" alt="image" src="https://github.com/user-attachments/assets/3e35ffb4-65ee-4f11-9d47-da5c0ede12a9" />

so yeah, i kept the front-end almost unchanged.

- **front-end**: html, css, js (vanilla)
- **back-end**: tauri v2, using rust
  - it uses librespot and rodio as playback and audio layer.

---

### ⋆𐙚 building on your machine ── 

first of all, you need to register an app on the [spotify developer portal](https://developer.spotify.com/).

make sure to add "http://127.0.0.1:8888/login" to your redirect_uri list

> you need to set an environment variable called SPOTIFY_CLIENT_ID to build.

⤿ clone the repo
```
git clone https://github.com/vergonha/bardo
cd bardo
```

⤿ install dependencies
```
bun install
```

⤿ run or build the app
```
bun run tauri dev
bun run tauri build
```

> if youre on a linux distro, dont forget to install system dependencies according to the [tauri docs](https://v2.tauri.app/start/prerequisites/)

```
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

<div style="display: flex; align-items: center;">
    <img src="https://i.imgur.com/FeG7X4q.png" style="align-self: flex-start;" />
</div>

### ˖ ִֶ♱ to-do ──

- [x] convert from web to a desktop app with tauri
- [x] find a cross-platform audio backend
- [x] playback queue
- [x] smtc bridge to control playback with windows bindings
- [ ] mpris bridge to control playback with linux bindings
- [ ] fix session persistence on linux (`keyring` only has the `windows-native` backend enabled; needs `linux-native`/`sync-secret-service` too)
- [ ] new shortcuts, eg control volume with mouse scroll when focused on the slider
- [x] work around [this rodio/cpal bug](https://github.com/RustAudio/rodio/issues/463) on windows (audio keeps playing on the old output device after you switch it). bardo ships its own librespot sink (`src-tauri/src/sink.rs`) that reopens just the audio stream when the default output changes or the current one dies
- [x] function to render and listen to songs by artist
- [ ] rewrite the css and switch it to something more readable
- [x] fix login/playback breaking after spotify changed their auth api
- [x] split the playback session from the web api session, each with its own oauth grant
- [x] persist both sessions so login survives a restart
- [x] pull playlists straight from librespot's internal mercury/protobuf apis (rootlist + extended metadata) instead of only the public web api, so your own playlists load even when spotify rate limits or throttles the web api
- [x] auto reconnect playback when the spirc session dies instead of leaving it dead until a manual sign-in
- [x] live log panel on the login screen to see what the backend is doing during auth
- [ ] apply the same mercury/protobuf approach to more of the app (search, artist pages) to depend less on the web api
- [ ] handle mercury/protobuf schema drift if spotify changes those internal protocols too

