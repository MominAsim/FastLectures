"use strict";

(() => {
  const canvasMatch = location.pathname.match(/^\/canvas\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i);
  const communityMatch = location.pathname.match(/^\/canvas\/community\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i);
  if (window.PENECHO_CONFIG?.runtime !== "cloud" || (!canvasMatch && !communityMatch)) return;
  const requestedCanvasId = canvasMatch?.[1] || null;
  const requestedCommunityItemId = communityMatch?.[1] || null;
  const isCommunityCraft = Boolean(requestedCommunityItemId);

  const nativeFetch = window.fetch.bind(window);
  const nativeWebSocket = window.WebSocket;
  const cloudRuntime = window.PENECHO_CONFIG?.runtime === "cloud";
  const nativeCloudCanvasReadsEnabled = window.PENECHO_CONFIG?.remoteCanvasNativeReads === true;
  const deviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const cloudCanvasReadPath = /^\/api\/cloud\/canvases\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const widgetPaintReadyFrames = new WeakSet();
  const widgetPaintReadyWaiters = new Set();
  let bridgeDeviceId = "";
  let browserEditing = false;
  const hostedExecutionSessionId = crypto.randomUUID();
  const hostedExecutionSessionStartedAt = Date.now();
  let hostedGeneration = 0;
  let resolveBridgeGate = null;
  let bridgeGateSettled = !cloudRuntime;
  const bridgeGate = cloudRuntime
    ? new Promise((resolve) => { resolveBridgeGate = resolve; })
    : Promise.resolve({ online:true });
  function settleBridgeGate(state) {
    if (bridgeGateSettled) return;
    bridgeGateSettled = true;
    resolveBridgeGate?.(state);
  }
  function unavailableBridgeResponse(state) {
    const payload = {
      error:"device_offline",
      code:"device_offline",
      message:state?.message || "Your linked PenEcho host is offline.",
    };
    if (typeof Response === "function") return new Response(JSON.stringify(payload), { status:409, headers:{ "content-type":"application/json" } });
    return { ok:false, status:409, headers:new Headers({ "content-type":"application/json" }), json:async () => payload };
  }
  const bridgedPaths = [
    /^\/api\/settings(?:\/|$)/,
    /^\/api\/favorites(?:\/|$)/,
    /^\/api\/canvas-agent\/(?:projects|roots|files)(?:\/|$)/,
    /^\/api\/canvas-projects(?:\/|$)/,
    /^\/api\/canvases(?:\/|$)/,
    /^\/api\/cloud(?:\/|$)/,
    /^\/api\/community\/metadata$/,
    /^\/api\/plugins(?:\/|$)/,
    /^\/canvas\/api\/widget-fetch$/,
    /^\/api\/widget-fetch$/,
    /^\/canvas\/plugins\/private\/[a-z0-9][a-z0-9-]{0,63}(?:\/(?:plugin\.md|styles\.css)|\.md)$/,
  ];
  const nativeCloudPaths = new Set(["/api/ai/command", "/api/plugins/improve"]);
  function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers:{ "content-type":"application/json" } });
  }
  function browserOnlyRequest(sourceUrl, method, options, headers) {
    if (sourceUrl.pathname === "/api/settings" && method === "GET") return Promise.resolve(jsonResponse({ provider:"api", connections:[], connectionLimit:0, hasApiKey:false, cli:{}, requestTrace:false }));
    if (sourceUrl.pathname === "/api/settings/connections" && method === "GET") return Promise.resolve(jsonResponse({ connections:[] }));
    if (sourceUrl.pathname === "/api/canvases" && method === "GET") return Promise.resolve(jsonResponse({ canvases:[] }));
    if (sourceUrl.pathname === "/api/canvas-projects" && method === "GET") return Promise.resolve(jsonResponse({ projects:[] }));
    if (["/canvas/api/widget-fetch", "/api/widget-fetch"].includes(sourceUrl.pathname)) return nativeFetch(`/api/v1/widget-fetch${sourceUrl.search}`, { ...options, method, headers, credentials:"same-origin" });
    if (sourceUrl.pathname.startsWith("/api/cloud/") || sourceUrl.pathname === "/api/plugins") return nativeFetch(sourceUrl.pathname + sourceUrl.search, { ...options, method, headers, credentials:"same-origin" });
    return Promise.resolve(jsonResponse({ error:"linked_device_required", message:"This feature needs a linked PenEcho device. Browser editing supports Cloud saves and PenEcho models; local files, CLI tools and private API forwarding stay on your device." }, 409));
  }

  function notifyWidgetPaintReadyWaiters() {
    for (const resolve of widgetPaintReadyWaiters) resolve();
    widgetPaintReadyWaiters.clear();
  }

  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || !event.source || !event.data || typeof event.data !== "object") return;
    if (event.data.type === "penecho-widget-host-ready") {
      widgetPaintReadyFrames.delete(event.source);
      notifyWidgetPaintReadyWaiters();
    } else if (event.data.type === "penecho-widget-capture-ready") {
      widgetPaintReadyFrames.add(event.source);
      notifyWidgetPaintReadyWaiters();
    }
  });

  function nextCanvasPaint() {
    return new Promise((resolve) => {
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
      else setTimeout(resolve, 0);
    });
  }

  function visibleWidgetFrames() {
    return [...document.querySelectorAll(".canvas-widget:not(.widget-offscreen) .canvas-widget-frame")]
      .filter((frame) => frame?.contentWindow);
  }

  async function waitForVisibleWidgets(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    await nextCanvasPaint();
    while (true) {
      const frames = visibleWidgetFrames();
      if (frames.every((frame) => widgetPaintReadyFrames.has(frame.contentWindow))) {
        await nextCanvasPaint();
        const settledFrames = visibleWidgetFrames();
        if (settledFrames.every((frame) => widgetPaintReadyFrames.has(frame.contentWindow))) return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await new Promise((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          widgetPaintReadyWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, remaining);
        widgetPaintReadyWaiters.add(finish);
      });
    }
  }

  function canvasAgentWebSocketTarget(value) {
    if (!bridgeDeviceId) return value;
    try {
      const target = new URL(String(value), location.href), page = new URL(location.href);
      const expectedProtocol = page.protocol === "https:" ? "wss:" : "ws:";
      if (target.protocol !== expectedProtocol || target.host !== page.host || target.pathname !== "/api/v1/remote-canvas/canvas-agent") return value;
      target.searchParams.set("deviceId", bridgeDeviceId);
      return target.toString();
    } catch { return value; }
  }

  if (typeof nativeWebSocket === "function") {
    window.WebSocket = class PenEchoRemoteCanvasWebSocket extends nativeWebSocket {
      constructor(url, protocols) {
        const target = canvasAgentWebSocketTarget(url);
        if (arguments.length > 1) super(target, protocols);
        else super(target);
      }
    };
  }

  function cookie(name) {
    const prefix = `${encodeURIComponent(name)}=`;
    for (const part of document.cookie.split(";")) {
      const value = part.trim();
      if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
    }
    return "";
  }

  function csrfHeaders(source) {
    const headers = new Headers(source || {}), token = cookie("penecho_csrf");
    if (token && !headers.has("x-penecho-csrf")) headers.set("x-penecho-csrf", token);
    return headers;
  }

  window.fetch = (input, options = {}) => {
    const sourceUrl = new URL(input instanceof Request ? input.url : input, document.baseURI || location.href);
    if (sourceUrl.origin !== location.origin) return nativeFetch(input, options);
    const method = String(options.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const inputHeaders = input instanceof Request ? input.headers : undefined;
    const headers = csrfHeaders(options.headers || inputHeaders);
    const hostedModel = /^hosted:([0-9a-f-]{36})$/i.exec(headers.get("x-penecho-connection") || "");
    if (sourceUrl.pathname === "/api/ai/command" && method === "POST" && hostedModel && requestedCanvasId) {
      const command = JSON.parse(options.body || "{}");
      headers.set("idempotency-key", crypto.randomUUID());
      headers.set("content-type", "application/json");
      const execution = { executionSessionId:hostedExecutionSessionId, executionSessionStartedAt:hostedExecutionSessionStartedAt, generation:++hostedGeneration };
      return nativeFetch(`/api/v1/hosted/canvases/${requestedCanvasId}/execution-fence`, { ...options, method, headers, credentials:"same-origin", body:JSON.stringify(execution) }).then(async (fence) => {
        if (!fence.ok) return fence;
        return nativeFetch("/api/v1/hosted/commands", { ...options, method, headers, credentials:"same-origin", body:JSON.stringify({ modelId:hostedModel[1], canvasId:requestedCanvasId, command, ...execution }) });
      });
    }
    const cloudBuiltInPluginCatalog = nativeCloudCanvasReadsEnabled && method === "GET" && sourceUrl.pathname === "/api/plugins" && !sourceUrl.search;
    const cloudStoredCanvasRead = nativeCloudCanvasReadsEnabled && method === "GET" && !sourceUrl.search && cloudCanvasReadPath.test(sourceUrl.pathname);
    const shouldBridge = !cloudBuiltInPluginCatalog && !cloudStoredCanvasRead && !nativeCloudPaths.has(sourceUrl.pathname) && bridgedPaths.some((pattern) => pattern.test(sourceUrl.pathname));
    const bridgePath = sourceUrl.pathname === "/canvas/api/widget-fetch"
      ? "/api/widget-fetch"
      : sourceUrl.pathname.startsWith("/canvas/plugins/private/")
        ? sourceUrl.pathname.slice("/canvas".length)
        : sourceUrl.pathname;
    const request = () => {
      const target = shouldBridge
        ? `/api/v1/remote-canvas/http?path=${encodeURIComponent(`${bridgePath}${sourceUrl.search}`)}${bridgeDeviceId ? `&deviceId=${encodeURIComponent(bridgeDeviceId)}` : ""}`
        : `${sourceUrl.pathname}${sourceUrl.search}`;
      return nativeFetch(target, { ...options, method, headers, credentials:"same-origin" });
    };
    if (!shouldBridge || !cloudRuntime) return request();
    return bridgeGate.then((state) => browserEditing ? browserOnlyRequest(sourceUrl, method, options, headers) : state?.online ? request() : unavailableBridgeResponse(state));
  };

  const zh = /^zh\b/i.test(navigator.language || "");
  const copy = zh ? {
    eyebrow:"私人云端画布", checking:"正在连接你的 PenEcho 主机…", noHost:"连接 PenEcho 主机后即可打开",
    offline:"已连接的 PenEcho 主机当前离线", failed:"这张画布暂时无法打开",
    dashboard:"连接设备", back:"返回项目",
    connected:"受保护的远程连接", unavailable:"请先连接一台 PenEcho 主机。", opening:"主机在线，正在打开云端画布…",
    offlineStatus:"离线", onlineStatus:"在线",
  } : {
    eyebrow:"Private Cloud Canvas", checking:"Connecting to your PenEcho host…", noHost:"Connect one PenEcho host to open this Canvas",
    offline:"Your linked PenEcho host is offline", failed:"This Canvas could not be opened",
    dashboard:"Link Device", back:"Back to Projects",
    connected:"Protected remote connection", unavailable:"No device is linked yet. Install PenEcho, then connect one main computer from Link Device.", opening:"Host online. Opening your Cloud Canvas…",
    offlineStatus:"Offline", onlineStatus:"Online",
  };
  if (isCommunityCraft) Object.assign(copy, zh ? {
    eyebrow:"公开 Craft", noHost:"连接 PenEcho 主机后即可 Echo 此创作", back:"返回 Echoes",
    failed:"暂时无法继续这个 Craft", opening:"主机在线，正在导入这个 Craft…",
  } : {
    eyebrow:"Public Craft", noHost:"Connect one PenEcho host to Echo this Craft", back:"Back to Echoes",
    failed:"This Craft could not be continued right now", opening:"Host online. Importing this Craft…",
  });

  // The PenEcho brand in the top bar doubles as the way back: the toolbar stays
  // uncluttered and the escape hatch lives where users expect a home control.
  const brandTarget = isCommunityCraft ? "/community.html" : "/dashboard.html";
  const brand = document.querySelector(".brand");
  if (brand) {
    brand.setAttribute("data-home-link", "true");
    brand.setAttribute("role", "link");
    brand.setAttribute("tabindex", "0");
    brand.title = copy.back;
    brand.setAttribute("aria-label", copy.back);
    brand.addEventListener("click", () => { location.assign(brandTarget); });
    brand.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); location.assign(brandTarget); } });
  }

  // The gate is a compact status view, not a landing page. The only action it
  // ever offers is Link Device, revealed solely while no device is linked
  // (gate.dataset.state === "unlinked"); checking, offline, opening and error
  // states render no actions at all.
  const gate = document.createElement("div");
  gate.className = "remote-canvas-gate";
  gate.setAttribute("role", "status");
  gate.setAttribute("aria-live", "polite");
  gate.dataset.state = "checking";

  const card = document.createElement("section");
  card.className = "remote-canvas-card";
  card.setAttribute("aria-labelledby", "remoteCanvasTitle");

  const head = document.createElement("div");
  head.className = "remote-canvas-head";
  const dot = document.createElement("span");
  dot.className = "remote-canvas-dot";
  dot.setAttribute("aria-hidden", "true");
  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = copy.eyebrow;
  head.append(dot, eyebrow);

  const title = document.createElement("h2");
  title.id = "remoteCanvasTitle";
  title.textContent = copy.checking;

  const detail = document.createElement("p");
  detail.className = "remote-canvas-detail";
  detail.textContent = `${location.origin}${location.pathname}`;

  const actions = document.createElement("div");
  actions.className = "remote-canvas-actions";
  const link = document.createElement("a");
  link.className = "primary";
  link.dataset.action = "link";
  link.href = "/dashboard.html#devices";
  link.textContent = copy.dashboard;
  actions.append(link);

  card.append(head, title, detail, actions);
  gate.append(card);
  document.body.append(gate);

  function publishCloudHeaderStatus(result) {
    const detail = Object.freeze({
      accountName:String(result.account?.name || "").slice(0, 100),
      credits:Number.isFinite(result.account?.credits) ? result.account.credits : null,
      deviceOnline:Boolean(result.device?.online),
      deviceId:bridgeDeviceId,
    });
    window.PENECHO_REMOTE_CLOUD_STATUS = detail;
    if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("penecho:remote-cloud-status", { detail }));
    }
  }

  async function openRequestedCanvas() {
    const deadline = Date.now() + 15_000;
    while (isCommunityCraft ? !window.PenEchoCommunityUI?.takeFurther : !window.PenEchoCloudProjects?.openCanvas) {
      if (Date.now() >= deadline) throw new Error("PenEcho Canvas did not finish loading.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isCommunityCraft) await window.PenEchoCommunityUI.takeFurther(requestedCommunityItemId);
    else await window.PenEchoCloudProjects.openCanvas(requestedCanvasId);
  }

  async function connect() {
    gate.dataset.state = "checking";
    title.textContent = copy.checking;
    detail.textContent = `${location.origin}${location.pathname}`;
    gate.hidden = false;
    try {
      const response = await nativeFetch("/api/v1/remote-canvas/status", { cache:"no-store", credentials:"same-origin", headers:csrfHeaders({ accept:"application/json" }) });
      if (response.status === 401) {
        settleBridgeGate({ online:false, message:copy.unavailable });
        return location.assign(`/auth.html?returnTo=${encodeURIComponent(location.pathname)}`);
      }
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
      if (typeof result.capabilities?.hostedCanvasAgent === "boolean") {
        window.PENECHO_CONFIG.hostedCanvasAgent=result.capabilities.hostedCanvasAgent;
      }
      bridgeDeviceId = deviceIdPattern.test(String(result.device?.id || "")) ? String(result.device.id) : "";
      publishCloudHeaderStatus(result);
      if (!result.device?.online && nativeCloudCanvasReadsEnabled && !isCommunityCraft) {
        browserEditing = true;
        window.PENECHO_CONFIG.canvasAgent = false;
        window.PENECHO_CONFIG.browserCanvasEditing = true;
        window.dispatchEvent(new CustomEvent("penecho:capabilities-changed"));
        gate.dataset.state = "opening";
        title.textContent = zh ? "正在浏览器中打开云端画布…" : "Opening your Cloud Canvas in this browser…";
        settleBridgeGate({ online:false, browserEditing:true });
        await openRequestedCanvas();
        window.dispatchEvent(new CustomEvent("penecho:capabilities-changed"));
        gate.hidden = true;
        return;
      }
      if (!result.device) {
        settleBridgeGate({ online:false, message:copy.unavailable });
        gate.dataset.state = "unlinked";
        title.textContent = copy.noHost;
        detail.textContent = copy.unavailable;
        return;
      }
      if (!result.device.online) {
        settleBridgeGate({ online:false, message:copy.offline });
        gate.dataset.state = "offline";
        title.textContent = copy.offline;
        detail.textContent = `${result.device.name} · ${result.device.platform} · ${copy.offlineStatus}`;
        return;
      }
      gate.dataset.state = "opening";
      title.textContent = copy.opening;
      detail.textContent = `${result.device.name} · ${result.device.platform} · ${copy.onlineStatus}`;
      settleBridgeGate({ online:true });
      await openRequestedCanvas();
      if (nativeCloudCanvasReadsEnabled && !isCommunityCraft) await waitForVisibleWidgets();
      gate.hidden = true;
    } catch (error) {
      settleBridgeGate({ online:false, message:String(error?.message || error || copy.unavailable).slice(0, 500) });
      gate.dataset.state = "error";
      title.textContent = copy.failed;
      detail.textContent = String(error?.message || error || copy.unavailable).slice(0, 500);
    }
  }
  void connect();
})();
