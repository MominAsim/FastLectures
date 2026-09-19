"use strict";
// Shared authentication state and helpers for FastLectures. Persists the session
// cookie via the browser (HttpOnly cookie is set by the server on /login). Loaded
// first on every auth page so `window.FASTLECTURES_AUTH` is usable immediately.
(function() {
  "use strict";

  const API = "/api/auth";
  let _user = null, _bootPromise = null;

  function now() { return Date.now(); }

  async function readJson(resp) {
    const text = await resp.text();
    try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
  }

  function onUnauthorized(json) {
    if (json?.error === "Accounts are disabled on this instance. Set FASTLECTURES_AUTH_ENABLED=true to enable.") {
      window.alert("Accounts are disabled on this FastLectures instance. Enable FASTLECTURES_AUTH_ENABLED=true to use sign-in, study sync, and device sync.");
      return true;
    }
    return false;
  }

  async function bootstrap() {
    if (_bootPromise) return _bootPromise;
    _bootPromise = (async () => {
      try {
        const response = await fetch(`${API}/me`, { credentials: "same-origin", headers: { accept: "application/json" } });
        const { json } = await readJson(response);
        _user = json?.authenticated ? json.user : null;
      } catch { _user = null; }
      return _user;
    })();
    return _bootPromise;
  }

  function whoami() { return _user ? { ..._user } : null; }
  function get user() { return _user; }
  function get authenticated() { return !!_user; }

  async function login(email, password) {
    try {
      const response = await fetch(`${API}/login`, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: String(email).trim(), password: String(password) }),
      });
      const { json } = await readJson(response);
      if (!response.ok) throw new Error(json?.error || "Sign-in failed.");
      _user = json.user;
      return { user: json.user };
    } catch (err) {
      throw new Error(err?.message || "Connection failed. Make sure FastLectures is running.");
    }
  }

  async function register(email, password, name) {
    try {
      const response = await fetch(`${API}/register`, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: String(email).trim(), password: String(password), name: String(name || "").trim() }),
      });
      const { json } = await readJson(response);
      if (!response.ok) {
        if (onUnauthorized(json)) throw new Error("Auth unavailable.");
        throw new Error(json?.error || "Registration failed.");
      }
      _user = json.user;
      return json;
    } catch (err) {
      throw new Error(err?.message || "Connection failed. Make sure FastLectures is running.");
    }
  }

  async function verify(token) {
    const response = await fetch(`${API}/verify`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token }),
    });
    const { json } = await readJson(response);
    if (!response.ok) {
      if (onUnauthorized(json)) throw new Error("Auth unavailable.");
      throw new Error(json?.error || "Verification failed.");
    }
    _user = json.user;
    return json;
  }

  async function forgot(email) {
    const response = await fetch(`${API}/forgot`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: String(email).trim() }),
    });
    const { json } = await readJson(response);
    if (!response.ok) {
      if (onUnauthorized(json)) throw new Error("Auth unavailable.");
      throw new Error(json?.error || "Request failed.");
    }
    return json;
  }

  async function reset(token, password) {
    const response = await fetch(`${API}/reset`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token, password: String(password) }),
    });
    const { json } = await readJson(response);
    if (!response.ok) {
      if (onUnauthorized(json)) throw new Error("Auth unavailable.");
      throw new Error(json?.error || "Reset failed.");
    }
    _user = null;
    return json;
  }

  async function logout() {
    const response = await fetch(`${API}/logout`, { method: "POST", credentials: "same-origin", headers: { accept: "application/json" } });
    const { json } = await readJson(response);
    _user = null;
    return json;
  }

  function clearLocal() { _user = null; _bootPromise = null; }

  // Wire up 401 responses globally so auth-aware pages can redirect to /login.html.
  if (typeof window !== "undefined") {
    const originalFetch = window.fetch;
    window.fetch = function(resource, options = {}) {
      const resp = originalFetch.call(this, resource, options);
      if (resource === "/api/auth/me" || String(resource).includes("/api/auth/")) return resp;
      return resp.then(result => {
        if (result.status === 401) clearLocal();
        return result;
      });
    };
  }

  window.FASTLECTURES_AUTH = Object.freeze({ bootstrap, whoami, get user() { return _user; }, get authenticated() { return !!_user; }, login, register, verify, forgot, reset, logout, clearLocal });
  if (typeof bootstrap === "function" && document.readyState === "loading") document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  else bootstrap().catch(() => {});
})();
