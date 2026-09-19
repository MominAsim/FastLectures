"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = "fastlectures:update-state";

function invoke(channel) {
  return ipcRenderer.invoke(channel);
}

const updateApi = Object.freeze({
  getState:() => invoke("fastlectures:get-update-state"),
  check:() => invoke("fastlectures:update-check"),
  download:() => invoke("fastlectures:update-download"),
  dismiss:() => invoke("fastlectures:update-dismiss"),
  install:() => invoke("fastlectures:update-install"),
  onStateChange:listener => {
    if (typeof listener !== "function") return () => {};
    const handler = (_event, state) => listener(state);
    ipcRenderer.on(CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANNEL, handler);
  },
});

contextBridge.exposeInMainWorld("fastlecturesDesktopUpdate", updateApi);
contextBridge.exposeInMainWorld("fastlecturesDesktop", Object.freeze({
  onShowConnections:listener => {
    if (typeof listener !== "function") return () => {};
    const handler = () => listener();
    ipcRenderer.on("fastlectures:show-connections", handler);
    return () => ipcRenderer.removeListener("fastlectures:show-connections", handler);
  },
  installCli:provider => ipcRenderer.invoke("fastlectures:install-cli", provider),
  pickProjectFile:() => ipcRenderer.invoke("fastlectures:pick-project-file"),
  hasClipboardFile:() => ipcRenderer.sendSync("fastlectures:has-clipboard-file"),
  readClipboardFile:() => ipcRenderer.invoke("fastlectures:read-clipboard-file"),
  readClipboardFiles:() => ipcRenderer.invoke("fastlectures:read-clipboard-files"),
  openProjectFile:projectId => ipcRenderer.invoke("fastlectures:open-project-file", projectId),
  setPageScale:scale => ipcRenderer.invoke("fastlectures:set-page-scale", scale),
}));

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value) node.textContent = value;
  return node;
}

function installDesktopUpdatePrompt() {
  if (!["darwin", "win32"].includes(process.platform) || !document.body) return;
  const link = element("link");
  link.rel = "stylesheet";
  link.href = "/desktop-update.css";
  document.head.append(link);

  const prompt = element("aside", "desktop-update-prompt");
  prompt.setAttribute("role", "status");
  prompt.setAttribute("aria-live", "polite");
  prompt.hidden = true;

  const row = element("div", "desktop-update-row"),
    copy = element("div", "desktop-update-copy"),
    title = element("strong", "desktop-update-title"),
    detail = element("span", "desktop-update-detail"),
    progress = element("progress", "desktop-update-progress"),
    actions = element("div", "desktop-update-actions"),
    primaryButton = element("button", "desktop-update-primary"),
    closeButton = element("button", "desktop-update-close", "\u00d7");

  progress.hidden = true;
  primaryButton.type = closeButton.type = "button";
  copy.append(title, detail, progress);
  actions.append(primaryButton, closeButton);
  row.append(copy, actions);
  prompt.append(row);
  const footer = document.querySelector("main > footer");
  (footer || document.body).append(prompt);

  let currentState = null, language = "en";
  const translations = Object.freeze({
    en:{
      dismiss:"Dismiss update notification until next launch",
      newVersion:version => `New${version} \u00b7 Upgrade`,
      downloading:version => `Downloading FastLectures${version}...`,
      keepWorking:"You can keep working.",
      downloaded:progressValue => `${progressValue}% downloaded`,
      ready:version => `FastLectures${version} is ready`,
      readyDetail:"Install the update and restart FastLectures.",
      install:"Install & restart",
      installing:version => `Installing FastLectures${version}...`,
      installingDetail:"FastLectures will restart when installation finishes.",
      checking:"Checking for FastLectures updates...",
      current:version => `FastLectures v${version} is up to date`,
      failed:"FastLectures update failed",
      tryLater:"Try again later.",
      retryInstall:"Retry install",
      retry:"Retry",
    },
    zh:{
      dismiss:"本次启动不再提示更新",
      newVersion:version => `新版本${version} \u00b7 升级`,
      downloading:version => `正在下载 FastLectures${version}...`,
      keepWorking:"下载期间可以继续使用。",
      downloaded:progressValue => `已下载 ${progressValue}%`,
      ready:version => `FastLectures${version} 已准备好`,
      readyDetail:"安装更新并重启 FastLectures。",
      install:"安装并重启",
      installing:version => `正在安装 FastLectures${version}...`,
      installingDetail:"安装完成后 FastLectures 将重新启动。",
      checking:"正在检查 FastLectures 更新...",
      current:version => `FastLectures v${version} 已是最新版本`,
      failed:"FastLectures 更新失败",
      tryLater:"请稍后重试。",
      retryInstall:"重试安装",
      retry:"重试",
    },
  });

  function detectLanguage(event) {
    const requested = event?.detail?.language || localStorage.getItem("fastlectures-language") || document.documentElement.lang;
    return String(requested || "").toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  function setLanguage(event) {
    language = detectLanguage(event);
    const words = translations[language];
    closeButton.setAttribute("aria-label", words.dismiss);
    closeButton.title = words.dismiss;
    if (currentState) render(currentState);
  }
  closeButton.addEventListener("click", () => void updateApi.dismiss());
  primaryButton.addEventListener("click", () => {
    if (currentState?.status === "available") void updateApi.download();
    else if (currentState?.status === "ready") void updateApi.install();
    else if (currentState?.status === "error") void (currentState.ready ? updateApi.install() : updateApi.check());
  });

  function render(state) {
    currentState = state;
    const visible = Boolean(state?.visible);
    prompt.hidden = !visible;
    footer?.classList.toggle("fastlectures-desktop-update-visible", visible);
    if (!visible) return;

    const words = translations[language], version = state.version ? ` v${state.version}` : "";
    prompt.classList.toggle("is-available", state.status === "available");
    copy.hidden = state.status === "available";
    primaryButton.hidden = false;
    closeButton.hidden = state.status === "downloading";
    detail.textContent = "";
    progress.hidden = true;

    if (state.status === "available") {
      primaryButton.textContent = words.newVersion(version);
    } else if (state.status === "downloading") {
      title.textContent = words.downloading(version);
      detail.textContent = state.progress === null ? words.keepWorking : words.downloaded(Math.round(state.progress));
      progress.hidden = false;
      if (state.progress === null) progress.removeAttribute("value");
      else progress.value = state.progress;
      progress.max = 100;
      primaryButton.hidden = true;
    } else if (state.status === "ready") {
      title.textContent = words.ready(version);
      detail.textContent = words.readyDetail;
      primaryButton.textContent = words.install;
    } else if (state.status === "installing") {
      title.textContent = words.installing(version);
      detail.textContent = words.installingDetail;
      primaryButton.hidden = true;
      closeButton.hidden = true;
    } else if (state.status === "checking") {
      title.textContent = words.checking;
      primaryButton.hidden = true;
    } else if (state.status === "up-to-date") {
      title.textContent = words.current(state.currentVersion);
      primaryButton.hidden = true;
    } else {
      title.textContent = words.failed;
      detail.textContent = state.error || words.tryLater;
      primaryButton.textContent = state.ready ? words.retryInstall : words.retry;
    }
  }

  setLanguage();
  window.addEventListener("fastlectures:languagechange", setLanguage);
  updateApi.onStateChange(render);
  void updateApi.getState().then(render);
}

window.addEventListener("DOMContentLoaded", installDesktopUpdatePrompt, { once:true });
