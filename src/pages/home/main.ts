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

async function init() {
  document.querySelector("#btn-login")?.addEventListener("click", (e) => {
    e.preventDefault();
    login();
  });

  await listen<string>("bardo-log", (event) => {
    appendLog(event.payload);
  });

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
