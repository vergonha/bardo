import { invoke } from "@tauri-apps/api/core";

const statusEl = document.querySelector<HTMLElement>("#login-status");

function setStatus(msg: string) {
  if (statusEl) statusEl.textContent = msg;
}

function navigateTo(page: string) {
  const base = window.location.href.split("/").slice(0, -1).join("/");
  window.location.href = `${base}/${page}`;
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
    navigateTo("dashboard.html");
  } catch {
    setStatus("");
  }
}

async function login() {
  try {
    await invoke<string>("run_spotify_login");
    navigateTo("dashboard.html");
  } catch (e) {
    setStatus(`Error: ${JSON.stringify(e)}`);
  }
}

document.querySelector("#btn-login")?.addEventListener("click", (e) => {
  e.preventDefault();
  login();
});

initialize();