import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const statusEl = document.querySelector<HTMLElement>("#login-status");

function setStatus(msg: string) {
  if (statusEl) statusEl.textContent = msg;
}

async function initialize() {
  try {
    await invoke("check_config");
  } catch (e) {
    setStatus(`Missing configuration: ${e}`);
    return;
  }

  try {
    await invoke<string>("refresh_token");
    window.location.href = "/dashboard.html";
  } catch {
    setStatus("");
  }
}

async function login() {
  let clientId: string;

  try {
    clientId = await invoke<string>("get_client_id");
  } catch (e) {
    setStatus(`Configuration error: ${e}`);
    return;
  }

  const scopes = [
    "user-library-read",
    "playlist-read-private",
    "user-follow-read",
    "streaming",
    "user-read-email",
    "user-read-private",
    "app-remote-control",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: scopes,
    redirect_uri: "http://127.0.0.1:8080",
  });

  setStatus("Waiting for browser authorization...");
  await openUrl(`https://accounts.spotify.com/authorize?${params}`);

  try {
    await invoke<string>("run_spotify_login");
    console.log("[bardo] invoke ok, calling navigateTo");
    navigateTo("dashboard.html");
  } catch (e) {
    console.error("[bardo] invoke error:", e);
    setStatus(`Error: ${JSON.stringify(e)}`);
  }
}

function navigateTo(page: string) {
  const base = window.location.href.split("/").slice(0, -1).join("/");
  const target = `${base}/${page}`;
  console.log("[bardo] navigating to:", target);
  console.log("[bardo] current href:", window.location.href);
  window.location.href = target;
}

document.querySelector("#btn-login")?.addEventListener("click", (e) => {
  e.preventDefault();
  login();
});

initialize();