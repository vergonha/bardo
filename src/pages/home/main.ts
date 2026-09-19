import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadRoute } from "../../lib/router";

function navigateTo(page: string) {
  loadRoute(page);
}

function appendLog(line: string) {
  const log = document.querySelector<HTMLElement>("#login-log");
  if (!log) return;
  log.textContent += `${line}\n`;
  log.scrollTop = log.scrollHeight;
}

async function hasRestoredSession(): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await invoke<string>("get_access_token");
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function init() {
  document.querySelector("#btn-login")?.addEventListener("click", (e) => {
    e.preventDefault();
    login();
  });

  await listen<string>("bardo-log", (event) => {
    appendLog(event.payload);
  });

  if (await invoke<boolean>("has_saved_credentials")) {
    appendLog("checking for a saved session...");
    if (await hasRestoredSession()) {
      navigateTo("dashboard");
      return;
    }
  }

  appendLog("ready to login");
}

async function login() {
  try {
    await invoke<string>("run_spotify_login");
    navigateTo("dashboard");
  } catch (e) {
    const message = typeof e === "string" ? e : JSON.stringify(e);
    appendLog(`error: ${message}`);
  }
}

init();
