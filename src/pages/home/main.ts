import { invoke } from "@tauri-apps/api/core";
import { loadRoute } from "../../lib/router";

const statusEl = document.querySelector<HTMLElement>("#login-status");

function setStatus(msg: string) {
  if (statusEl) statusEl.textContent = msg;
}

function navigateTo(page: string) {
  loadRoute(page);
}

async function init() {
  document.querySelector("#btn-login")?.addEventListener("click", (e) => {
    e.preventDefault();
    login();
  });

  setStatus("Ready to login");
}

async function login() {
  try {
    await invoke<string>("run_spotify_login");
    navigateTo("dashboard");
  } catch (e) {
    setStatus(`Error: ${JSON.stringify(e)}`);
  }
}

init();
