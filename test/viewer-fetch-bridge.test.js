"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "public/viewer-fetch.js"), "utf8");
const itemId = "123e4567-e89b-12d3-a456-426614174000";
const origin = "https://penecho.test";
const widgetUrl = "https://data.example/feed.json";

class HeadersMock {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values).map(([name, value]) => [name.toLowerCase(), String(value)]));
  }

  get(name) {
    return this.values.get(String(name).toLowerCase()) ?? null;
  }
}

function response({ status = 200, body = [1, 2, 3], headers = {} } = {}) {
  const bytes = Uint8Array.from(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new HeadersMock(headers),
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeClock {
  constructor() {
    this.now = 1;
    this.nextId = 1;
    this.timeouts = new Map();
    this.intervals = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timeouts.set(id, { callback, at: this.now + delay });
    return id;
  }

  clearTimeout(id) {
    this.timeouts.delete(id);
  }

  setInterval(callback, delay) {
    const id = this.nextId++;
    this.intervals.set(id, { callback, delay, at: this.now + delay });
    return id;
  }

  clearInterval(id) {
    this.intervals.delete(id);
  }

  advance(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      let next = null;
      for (const [id, timer] of this.timeouts) {
        if (timer.at <= target && (!next || timer.at < next.at)) next = { kind: "timeout", id, ...timer };
      }
      for (const [id, timer] of this.intervals) {
        if (timer.at <= target && (!next || timer.at < next.at)) next = { kind: "interval", id, ...timer };
      }
      if (!next) break;
      this.now = next.at;
      if (next.kind === "timeout") this.timeouts.delete(next.id);
      else {
        const timer = this.intervals.get(next.id);
        if (!timer) continue;
        timer.at += timer.delay;
      }
      next.callback();
    }
    this.now = target;
  }
}

function createHarness({ fetchPlan } = {}) {
  const clock = new FakeClock();
  const listeners = new Map();
  const requests = [];
  const replies = [];
  const ownedWindow = {
    postMessage(payload, targetOrigin, transfer) {
      replies.push({ payload, targetOrigin, transfer });
    },
  };
  const frames = [{ contentWindow: ownedWindow, src: "/canvas/widget-host.html" }];
  const document = {
    querySelectorAll(selector) {
      return selector === ".canvas-widget .canvas-widget-frame" ? frames : [];
    },
  };
  const location = { origin, href: `${origin}/canvas/view/${itemId}` };
  const window = {
    addEventListener(type, listener, options) {
      const entries = listeners.get(type) || [];
      entries.push({ listener, options });
      listeners.set(type, entries);
    },
    removeEventListener(type, listener) {
      const entries = listeners.get(type) || [];
      listeners.set(type, entries.filter((entry) => entry.listener !== listener));
    },
    dispatchEvent(event) {
      for (const { listener } of [...(listeners.get(event.type) || [])]) listener.call(window, event);
    },
  };
  let fetchCount = 0;
  const fetchData = (requestPath, options) => {
    const requestUrl = new URL(requestPath, location.href);
    const url = requestUrl.searchParams.get("url");
    const call = { requestPath, url, options, index: fetchCount++ };
    requests.push(call);
    const planned = fetchPlan?.(call);
    return planned && typeof planned.then === "function" ? planned : Promise.resolve(planned || response({
      headers: { "x-penecho-cache-expires-at": String(clock.now + 20 * 60_000) },
    }));
  };
  const context = {
    window,
    document,
    location,
    URL,
    AbortController,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    setInterval: clock.setInterval.bind(clock),
    clearInterval: clock.clearInterval.bind(clock),
  };
  vm.runInNewContext(source, context, { filename: "public/viewer-fetch.js" });
  const connection = window.PenEchoViewerFetch.install({ itemId, fetch: fetchData, clock: () => clock.now });

  return {
    clock,
    document,
    location,
    window,
    ownedWindow,
    frames,
    requests,
    replies,
    connection,
    send({ source: eventSource = ownedWindow, eventOrigin = origin, requestId = "widget-fetch-1", url = widgetUrl } = {}) {
      window.dispatchEvent({
        type: "message",
        source: eventSource,
        origin: eventOrigin,
        data: { type: "penecho-widget-host-public-fetch", requestId, url },
      });
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    async settle() {
      for (let index = 0; index < 6; index++) await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function request(harness, options) {
  harness.send(options);
  await harness.settle();
}

function replyBody(reply) {
  return new Uint8Array(reply.payload.body);
}

test("the bridge rejects non-owned frames and cross-origin messages before fetching", async () => {
  const harness = createHarness();
  const foreignWindow = { postMessage() {} };
  harness.frames.push({ contentWindow: foreignWindow, src: "https://attacker.example/canvas/widget-host.html" });

  harness.send({ source: { postMessage() {} }, requestId: "widget-fetch-1" });
  harness.send({ source: foreignWindow, requestId: "widget-fetch-2" });
  harness.send({ eventOrigin: "https://attacker.example", requestId: "widget-fetch-3" });
  await harness.settle();

  assert.equal(harness.requests.length, 0);
  assert.equal(harness.replies.length, 0);
});

test("same-URL concurrent requests share one fetch and return independent ArrayBuffers", async () => {
  const gate = deferred();
  const harness = createHarness({ fetchPlan: () => gate.promise });
  harness.send({ requestId: "widget-fetch-1" });
  harness.send({ requestId: "widget-fetch-2" });
  assert.equal(harness.requests.length, 1);

  gate.resolve(response({
    body: [10, 20, 30],
    headers: {
      "content-type": "application/json",
      "x-penecho-cache-expires-at": String(harness.clock.now + 20 * 60_000),
    },
  }));
  await harness.settle();

  assert.equal(harness.replies.length, 2);
  assert.deepEqual(harness.replies.map(({ payload }) => payload.requestId), ["widget-fetch-1", "widget-fetch-2"]);
  assert.notStrictEqual(harness.replies[0].payload.body, harness.replies[1].payload.body);
  assert.deepEqual([...replyBody(harness.replies[0])], [10, 20, 30]);
  assert.deepEqual([...replyBody(harness.replies[1])], [10, 20, 30]);
  replyBody(harness.replies[0])[0] = 99;
  assert.equal(replyBody(harness.replies[1])[0], 10);
  assert.equal(harness.replies[0].transfer.length, 1);
  assert.equal(harness.replies[1].transfer.length, 1);
});

test("a cached response is reused during the five-minute refresh interval", async () => {
  const harness = createHarness();
  await request(harness, { requestId: "widget-fetch-1" });
  harness.clock.advance(4 * 60_000);
  await request(harness, { requestId: "widget-fetch-2" });

  assert.equal(harness.requests.length, 1);
  assert.equal(harness.replies.length, 2);
  assert.deepEqual([...replyBody(harness.replies[1])], [1, 2, 3]);
});

test("a cache read does not extend the twenty-minute TTL", async () => {
  const harness = createHarness({ fetchPlan: (call) => {
    if (call.index === 0) return response({ body: [1], headers: { "x-penecho-cache-expires-at": String(harness.clock.now + 20 * 60_000) } });
    return response({ body: [9], headers: { "x-penecho-cache-expires-at": String(harness.clock.now + 20 * 60_000) } });
  } });
  await request(harness, { requestId: "widget-fetch-1" });
  harness.clock.advance(4 * 60_000);
  await request(harness, { requestId: "widget-fetch-2" });
  assert.equal(harness.requests.length, 1);

  harness.clock.advance(16 * 60_000);
  // The third request must wait for a new network result instead of receiving
  // the body that was read at four minutes.
  await request(harness, { requestId: "widget-fetch-3" });
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.replies.length, 3);
  assert.deepEqual([...replyBody(harness.replies[2])], [9]);
});

test("server refresh timestamps shorten the local round and permit a retry after a short 429 hold", async () => {
  const harness = createHarness({ fetchPlan: (call) => {
    if (call.index === 0) return response({
      headers: {
        "x-penecho-refresh-at": String(harness.clock.now + 10_000),
        "x-penecho-cache-expires-at": String(harness.clock.now + 20 * 60_000),
      },
    });
    return response({
      body: [9],
      headers: { "x-penecho-cache-expires-at": String(harness.clock.now + 20 * 60_000) },
    });
  } });
  await request(harness, { requestId: "widget-fetch-1" });
  harness.clock.advance(10_000);
  await request(harness, { requestId: "widget-fetch-2" });
  assert.equal(harness.requests.length, 2);
  assert.deepEqual([...replyBody(harness.replies[1])], [9]);

  const retryHarness = createHarness({ fetchPlan: (call) => call.index === 0
    ? response({
      status: 429,
      headers: { "x-penecho-refresh-at": String(retryHarness.clock.now + 1_000) },
    })
    : response({ body: [7], headers: { "x-penecho-cache-expires-at": String(retryHarness.clock.now + 20 * 60_000) } }) });
  await request(retryHarness, { requestId: "widget-fetch-1" });
  retryHarness.clock.advance(1_000);
  await request(retryHarness, { requestId: "widget-fetch-2" });
  assert.equal(retryHarness.requests.length, 2);
  assert.match(retryHarness.replies[0].payload.error, /429/);
  assert.deepEqual([...replyBody(retryHarness.replies[1])], [7]);
});

test("failed and non-cacheable responses suppress repeated network requests", async () => {
  for (const [name, fetchResponse] of [
    ["failed", response({ status: 503 })],
    ["no-store", response({ body: [4, 5, 6] })],
  ]) {
    const harness = createHarness({ fetchPlan: () => fetchResponse });
    await request(harness, { requestId: "widget-fetch-1", url: `${widgetUrl}?case=${name}` });
    await request(harness, { requestId: "widget-fetch-2", url: `${widgetUrl}?case=${name}` });

    assert.equal(harness.requests.length, 1, `${name}: repeated requests should not fetch again`);
    assert.equal(harness.replies.length, 2, `${name}: both callers should receive a reply`);
    if (name === "failed") {
      assert.match(harness.replies[0].payload.error, /503/);
      assert.match(harness.replies[1].payload.error, /503/);
    } else {
      assert.equal(harness.replies[0].payload.status, 200);
      assert.match(harness.replies[1].payload.error, /cannot be cached/);
    }
  }
});

test("only 32 unique URLs are attempted in one refresh round", async () => {
  const harness = createHarness();
  for (let index = 0; index < 32; index++) {
    await request(harness, { requestId: `widget-fetch-${index + 1}`, url: `https://data.example/item-${index}.json` });
  }
  await request(harness, { requestId: "widget-fetch-33", url: "https://data.example/item-32.json" });

  assert.equal(harness.requests.length, 32);
  assert.equal(harness.replies.length, 33);
  assert.match(harness.replies[32].payload.error, /refresh limit/);
});

test("close removes event handling and aborts in-flight work", async () => {
  const gate = deferred();
  let abortError;
  const harness = createHarness({ fetchPlan: ({ options }) => {
    options.signal.addEventListener("abort", () => {
      abortError = new Error("request aborted");
      gate.reject(abortError);
    });
    return gate.promise;
  } });
  harness.send({ requestId: "widget-fetch-1" });
  assert.equal(harness.requests.length, 1);
  const signal = harness.requests[0].options.signal;

  harness.connection.close();
  assert.equal(signal.aborted, true);
  assert.equal(harness.listenerCount("message"), 0);
  assert.equal(harness.listenerCount("pagehide"), 0);
  harness.send({ requestId: "widget-fetch-2" });
  await harness.settle();

  assert.ok(abortError);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.replies.length, 0);
  harness.window.dispatchEvent({ type: "pagehide" });
  assert.equal(harness.listenerCount("pagehide"), 0);
});
