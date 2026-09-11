"use strict";

// One owner for the complete View page, shared by all its Widget host frames.
// The server owns refresh epochs and shared quotas; this cache avoids sending
// repeated iframe retries to Cloud in the first place.
(() => {
  const REFRESH_MS = 5 * 60_000;
  const MAX_BYTES = 32 * 1024 * 1024;
  const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
  const MAX_URLS = 32;
  window.PenEchoViewerFetch = {
    install({ itemId, fetch: fetchData = window.fetch.bind(window), clock = () => Date.now() }) {
      const entries = new Map(), requests = new Map(), controllers = new Set();
      let bytes = 0, stopped = false, active = 0, pendingReplies = 0;
      let roundRefreshAt = 0, attempts = new Set();
      const queue = [];

      function purge() {
        const now = clock();
        for (const [url, entry] of entries) {
          if (entry.expiresAt > now) continue;
          bytes -= entry.body?.byteLength || 0;
          entries.delete(url);
        }
      }
      function remember(url, entry) {
        bytes -= entries.get(url)?.body?.byteLength || 0;
        entries.delete(url);
        entries.set(url, entry);
        bytes += entry.body?.byteLength || 0;
        while (bytes > MAX_BYTES || entries.size > MAX_URLS) {
          const [oldUrl, old] = entries.entries().next().value;
          entries.delete(oldUrl);
          bytes -= old.body?.byteLength || 0;
        }
      }
      function owns(source) {
        return [...document.querySelectorAll(".canvas-widget .canvas-widget-frame")].some(frame => {
          if (frame.contentWindow !== source) return false;
          try {
            const url = new URL(frame.src, location.href);
            return url.origin === location.origin && url.pathname === "/canvas/widget-host.html";
          } catch { return false; }
        });
      }
      async function download(url) {
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 10_000);
        const started = clock();
        let refreshAt = started + REFRESH_MS;
        try {
          const response = await fetchData(`/api/v1/community/items/${itemId}/widget-fetch?url=${encodeURIComponent(url)}`, {
            method:"GET", credentials:"omit", cache:"no-store", signal:controller.signal,
          });
          const serverRefresh = Number(response.headers.get("x-penecho-refresh-at"));
          if (serverRefresh > started) {
            refreshAt = Math.min(serverRefresh, started + REFRESH_MS);
            // A visitor can join an existing server round near its end. Never
            // start a new five-minute lock merely because this tab is new.
            roundRefreshAt = Math.min(roundRefreshAt || refreshAt, refreshAt);
          }
          if (!response.ok) throw Error(`Public data is temporarily unavailable (${response.status}).`);
          const length = Number(response.headers.get("content-length"));
          if (length > MAX_RESPONSE_BYTES) throw Error("The public data response is too large.");
          // Bound streaming bytes too: content-length may be absent or compressed.
          const reader = response.body?.getReader();
          let body;
          if (reader) {
            const chunks = []; let total = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw Error("The public data response is too large."); }
              chunks.push(value);
            }
            const joined = new Uint8Array(total); let offset = 0;
            for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
            body = joined.buffer;
          } else {
            body = await response.arrayBuffer();
            if (body.byteLength > MAX_RESPONSE_BYTES) throw Error("The public data response is too large.");
          }
          const headers = {};
          for (const name of ["content-type", "x-penecho-upstream-status", "x-penecho-final-url"]) {
            const value = response.headers.get(name);
            if (value) headers[name] = value;
          }
          const expiresAt = Math.min(Number(response.headers.get("x-penecho-cache-expires-at")) || 0, started + 20 * 60_000);
          const result = { status:response.status, headers, body, refreshAt, expiresAt };
          if (!stopped) {
            if (expiresAt > clock()) remember(url, result);
            else remember(url, { error:"This data cannot be cached. Try again after the refresh interval.", refreshAt, expiresAt:refreshAt });
          }
          return result;
        } catch (error) {
          if (!stopped) remember(url, { error:String(error.message || "Public data is unavailable."), refreshAt, expiresAt:refreshAt });
          throw error;
        } finally {
          clearTimeout(timer);
          controllers.delete(controller);
        }
      }
      function drain() {
        while (!stopped && active < 4 && queue.length) {
          const job = queue.shift();
          active++;
          download(job.url).then(job.resolve, job.reject).finally(() => { active--; drain(); });
        }
      }
      function get(url) {
        purge();
        const now = clock(), hit = entries.get(url);
        if (hit && now < hit.refreshAt) return hit.error ? Promise.reject(Error(hit.error)) : Promise.resolve(hit);
        if (requests.has(url)) return requests.get(url);
        if (now >= roundRefreshAt) { roundRefreshAt = now + REFRESH_MS; attempts = new Set(); }
        if (attempts.has(url) || attempts.size >= MAX_URLS) return Promise.reject(Error("This page has reached its refresh limit. Try again in five minutes."));
        attempts.add(url);
        const promise = new Promise((resolve, reject) => { queue.push({ url, resolve, reject }); });
        requests.set(url, promise);
        promise.finally(() => requests.delete(url)).catch(() => {});
        drain();
        return promise;
      }
      function receive(event) {
        const message = event.data;
        if (stopped || event.origin !== location.origin || !event.source || !owns(event.source)
          || message?.type !== "penecho-widget-host-public-fetch"
          || typeof message.requestId !== "string" || !/^widget-fetch-\d{1,16}$/.test(message.requestId)
          || typeof message.url !== "string" || message.url.length > 4096) return;
        let url;
        try { url = new URL(message.url); } catch { return; }
        if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return;
        const reply = (payload, transfer = []) => {
          if (!stopped && owns(event.source)) event.source.postMessage({ type:"penecho-widget-host-public-fetch-result", requestId:message.requestId, ...payload }, location.origin, transfer);
        };
        if (pendingReplies >= 64) { reply({ error:"Too many pending public data requests." }); return; }
        pendingReplies++;
        get(url.href).then(result => {
          // Transfer a copy: the cached buffer must remain usable by other Widgets.
          const body = result.body.slice(0);
          reply({ status:result.status, headers:result.headers, body }, [body]);
        }, error => reply({ error:String(error.message || "Public data is unavailable.").slice(0, 300) }))
          .finally(() => { pendingReplies--; });
      }
      const sweep = setInterval(purge, 60_000);
      function close() {
        stopped = true;
        clearInterval(sweep);
        window.removeEventListener("message", receive);
        window.removeEventListener("pagehide", pagehide);
        for (const controller of controllers) controller.abort();
        for (const job of queue.splice(0)) job.reject(Error("View closed."));
        entries.clear(); bytes = 0;
      }
      function pagehide(event) { if (!event.persisted) close(); }
      window.addEventListener("message", receive);
      window.addEventListener("pagehide", pagehide);
      return { close };
    },
  };
})();
