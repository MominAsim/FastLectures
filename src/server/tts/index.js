"use strict";

// Text-to-Speech system for FastLectures
// Natural female voice that runs 100% locally
// Works in browser via Web Speech API and provides server-side SSML generation

const crypto = require("node:crypto");

// SSML Generation for rich speech markup
function generateSSML(text, options = {}) {
  const {
    voice = "aria",
    rate = 0.95,
    pitch = 1.02,
    volume = 1.0,
    addPauses = true,
    breakDuration = 300,
    language = "en-US"
  } = options;

  // Normalize text
  let content = String(text || "");

  // Handle math symbols - spell them out
  const mathReplacements = [
    [/\bpi\b/gi, "pi"],
    [/\bsquare\b/gi, "squared"],
    [/\bcube\b/gi, "cubed"],
    [/\btheta\b/gi, "theta"],
    [/\bphi\b/gi, "phi"],
    [/\balpha\b/gi, "alpha"],
    [/\bbeta\b/gi, "beta"],
    [/\bgamma\b/gi, "gamma"],
    [/\bdelta\b/gi, "delta"],
    [/\b∞\b/g, "infinity"],
    [/\b∫\b/g, "integral"],
    [/\b∂\b/g, "partial"],
    [/\b∑\b/g, "sigma"],
    [/\b∏\b/g, "product"],
    [/\b∞\b/g, "infinity"],
    [/\b≈\b/g, "approximately equal to"],
    [/\b≠\b/g, "not equal to"],
    [/\b≤\b/g, "less than or equal to"],
    [/\b≥\b/g, "greater than or equal to"],
    [/\b±\b/g, "plus or minus"],
    [/\b×\b/g, "times"],
    [/\b÷\b/g, "divided by"],
    [/\b√\b/g, "square root of"],
    [/\b±\b/g, "plus or minus"],
    [/\b×\b/g, "times"],
    [/\b÷\b/g, "divided by"]
  ];

  for (const [pattern, replacement] of mathReplacements) {
    content = content.replace(pattern, replacement);
  }

  // Add proper punctuation for speech
  if (addPauses) {
    content = addBreaksToContent(content, breakDuration);
  }

  // Build SSML structure
  const ssml = `
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}">
  <voice name="${voice}">
    <prosody rate="${rate}" pitch="${pitch}st" volume="${volume}">
      ${content}
    </prosody>
  </voice>
</speak>`;

  // Estimate duration (rough approximation)
  const wordCount = content.split(/\s+/).filter(w => w.length > 0).length;
  const wordsPerSecond = 150 * rate;
  const durationMs = Math.max(1000, Math.floor((wordCount / wordsPerSecond) * 1000));

  return {
    ssml: ssml.trim(),
    duration: durationMs,
    voice,
    rate,
    pitch,
    volume,
    wordCount
  };
}

// Helper to add break tags between sentences
function addBreaksToContent(content, breakMs) {
  return content
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.length > 0)
    .map((sentence, i, arr) => {
      const tag = i < arr.length - 1 ? `<break time="${breakMs}ms"/>` : "";
      return `${sentence.trim()} ${tag}`;
    })
    .join("\n");
}

// Detect available voices (simulated - browser would have real detection)
function detectVoices() {
  // Common SAPI5/web speech voices
  const voices = [
    // Female voices
    { name: "Microsoft Zira Desktop - English (United States)", lang: "en-US", gender: "female", voiceId: "Microsoft.Zira.Desktop", default: false },
    { name: "Microsoft Aria - English (United States)", lang: "en-US", gender: "female", voiceId: "ARIA", default: true },
    { name: "Samantha", lang: "en-US", gender: "female", voiceId: "Alex", default: false }, // macOS fallback
    { name: "Google UK English Female", lang: "en-GB", gender: "female", voiceId: "Google UK English Female", default: false },
    { name: "Joanna", lang: "en-US", gender: "female", voiceId: "Joanna", default: false }, // AWS Polly
    { name: "Ivy", lang: "en-US", gender: "female", voiceId: "Ivy", default: false }, // AWS Polly
    { name: "Amy", lang: "en-GB", gender: "female", voiceId: "Amy", default: false }, // AWS Polly
    { name: "Bianca", lang: "en-US", gender: "female", voiceId: "Bianca", default: false },

    // Male voices (for comparison / options)
    { name: "Microsoft David Desktop - English (United States)", lang: "en-US", gender: "male", voiceId: "Microsoft.David.Desktop", default: false },
    { name: "Google UK English Male", lang: "en-GB", gender: "male", voiceId: "Google UK English Male", default: false },
    { name: "Brian", lang: "en-GB", gender: "male", voiceId: "Brian", default: false },

    // Science/Math specialized
    { name: "Math Voice", lang: "en-US", gender: "female", voiceId: "math-voice", default: false }
  ];

  return voices;
}

// Get best female voice for education
function getBestEducationVoice(preferredGender = "female") {
  const voices = detectVoices();
  const femaleVoices = voices.filter(v => v.gender === preferredGender);

  // Prioritize natural, clear voices for education
  const priority = ["aria", "zira", "ivy", "bianca", "joanna", "samantha", "amy", "brian"];

  for (const name of priority) {
    const voice = femaleVoices.find(v => v.name.toLowerCase().includes(name.split("-")[0]) || v.voiceId.toLowerCase().includes(name));
    if (voice) return voice;
  }

  return femaleVoices[0] || { name: "Default", lang: "en-US", gender: "female", voiceId: "default" };
}

// Voice profiles for different contexts
const VOICE_PROFILES = {
  "explainer": {
    name: "Explainer Voice",
    rate: 0.92,
    pitch: 1.0,
    volume: 1.0,
    description: "Clear, patient voice ideal for step-by-step explanations and drawing narration",
    useCase: "Explaining concepts, walking through problems, narration during drawing"
  },
  "teacher": {
    name: "Teacher Voice",
    rate: 0.95,
    pitch: 1.05,
    volume: 1.0,
    description: "Warm, engaging voice for lectures and presentations",
    useCase: "Full lectures, problem walkthroughs, student interactions"
  },
  "quick": {
    name: "Quick Summary",
    rate: 1.1,
    pitch: 1.0,
    volume: 0.9,
    description: "Faster pace for summaries and brief explanations",
    useCase: "Quick summaries, brief notifications, timers"
  },
  "emphatic": {
    name: "Emphatic Voice",
    rate: 0.85,
    pitch: 1.1,
    volume: 1.0,
    description: "Slower, more dramatic for important points",
    useCase: "Key concepts, important warnings, presentation highlights"
  }
};

// Main TTS handler factory
function createTTSServer(options = {}) {
  const cache = new Map();
  const maxSize = options.cacheSize || 100;

  function getCacheKey(text, params) {
    return crypto.createHash("md5").update(text + JSON.stringify(params)).digest("hex");
  }

  function handle(req, res) {
    const url = req.url;

    if (url === "/api/tts/voices" && req.method === "GET") {
      return sendVoices(res);
    }

    if (url === "/api/tts/speak" && req.method === "POST") {
      return handleSpeak(req, res);
    }

    if (url === "/api/tts/ssml" && req.method === "POST") {
      return handleSSML(req, res);
    }

    if (url === "/api/tts/preload" && req.method === "POST") {
      return handlePreload(req, res);
    }

    return null; // Not handled
  }

  async function handleSpeak(req, res) {
    try {
      const body = await readJson(req);
      const { text, voice, rate, pitch, volume, language, profile } = body;

      if (!text) {
        return sendJson(res, 400, { error: "Text is required" });
      }

      const prof = VOICE_PROFILES[profile] || VOICE_PROFILES.explainer;

      // Create cache key
      const params = { voice, rate, pitch, volume, profile };
      const key = getCacheKey(text, params);

      // Check cache
      if (cache.has(key)) {
        const cached = cache.get(key);
        return sendJson(res, 200, {
          ...cached,
          fromCache: true,
          status: "cached"
        });
      }

      // Generate SSML
      const ssmlResult = generateSSML(text, {
        voice: voice || getBestEducationVoice().voiceId,
        rate: rate !== undefined ? rate : prof.rate,
        pitch: pitch !== undefined ? pitch : prof.pitch,
        volume: volume !== undefined ? volume : prof.volume,
        language: language || "en-US",
        addPauses: true
      });

      const result = {
        text,
        ssml: ssmlResult.ssml,
        duration: ssmlResult.duration,
        voice: ssmlResult.voice,
        rate: ssmlResult.rate,
        pitch: ssmlResult.pitch,
        volume: ssmlResult.volume,
        wordCount: ssmlResult.wordCount,
        profile: profile || "explainer"
      };

      // Cache result (LRU-like)
      if (cache.size >= maxSize) {
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
      }
      cache.set(key, result);

      return sendJson(res, 200, result);
    } catch (e) {
      return sendJson(res, 500, { error: e.message || "TTS generation failed" });
    }
  }

  async function handleSSML(req, res) {
    try {
      const body = await readJson(req);
      const { text, voice, rate, pitch, volume, language, addPauses = true, sentenceBreakMs = 300 } = body;

      if (!text) {
        return sendJson(res, 400, { error: "Text is required" });
      }

      const result = generateSSML(text, {
        voice: voice || "aria",
        rate: rate !== undefined ? rate : 0.95,
        pitch: pitch !== undefined ? pitch : 1.02,
        volume: volume !== undefined ? volume : 1.0,
        language: language || "en-US",
        addPauses: addPauses,
        breakDuration: sentenceBreakMs
      });

      return sendJson(res, 200, {
        ssml: result.ssml,
        duration: result.duration,
        voice: result.voice,
        wordCount: result.wordCount
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message || "SSML generation failed" });
    }
  }

  async function handlePreload(req, res) {
    try {
      const body = await readJson(req);
      const { text, maxPhrases = 10 } = body;

      if (!text) {
        return sendJson(res, 400, { error: "Text is required" });
      }

      const phrases = [];
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);
      const toCache = sentences.slice(0, maxPhrases);

      for (const sentence of toCache) {
        const trimmed = sentence.trim();
        if (trimmed) {
          const result = generateSSML(trimmed, { addPauses: true });
          const key = getCacheKey(trimmed, {});
          cache.set(key, result);
          phrases.push({ original: trimmed, cached: true });
        }
      }

      return sendJson(res, 200, { preloaded: phrases.length, phrases });
    } catch (e) {
      return sendJson(res, 500, { error: e.message || "Preload failed" });
    }
  }

  function sendVoices(res) {
    const voices = detectVoices();
    const educationVoices = voices.filter(v => v.gender === "female");

    return sendJson(res, 200, {
      all: voices,
      female: educationVoices,
      male: voices.filter(v => v.gender === "male"),
      education: getBestEducationVoice(),
      profiles: VOICE_PROFILES
    });
  }

  return {
    handle,
    cache,
    clearCache: () => cache.clear()
  };
}

// Helper functions
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Browser-side TTS controller (would be in public/tts.js)
class TTSController {
  constructor(options = {}) {
    this.speechSynthesis = window.speechSynthesis || null;
    this.voices = [];
    this.currentUtterance = null;
    this.isSpeaking = false;
    this.queue = [];
    this.options = {
      voice: null,
      rate: 0.95,
      pitch: 1.02,
      volume: 1.0,
      onstart: null,
      onend: null,
      onerror: null
    };

    this._initVoices();
  }

  _initVoices() {
    if (!this.speechSynthesis) return;

    const load = () => {
      this.voices = this.speechSynthesis.getVoices();
      if (this.options.voice === "auto") {
        this._setBestFemaleVoice();
      }
    };

    if (this.speechSynthesis.onvoiceschanged !== undefined) {
      this.speechSynthesis.onvoiceschanged = load;
    }
    load();
  }

  _setBestFemaleVoice() {
    const female = this.voices.find(v => v.gender === "female" && /aria|zira|jenny/i.test(v.name));
    if (female) {
      this.options.voice = female;
    } else if (this.voices.length > 0) {
      const first = this.voices.find(v => v.lang.startsWith("en"));
      if (first) this.options.voice = first;
    }
  }

  async speak(text, voiceOptions = {}) {
    return new Promise((resolve, reject) => {
      if (!this.speechSynthesis) {
        resolve({ success: false, error: "speech_synthesis_unavailable" });
        return;
      }

      const opts = { ...this.options, ...voiceOptions };
      const utterance = new SpeechSynthesisUtterance(text);

      utterance.voice = opts.voice || this._getDefaultVoice();
      utterance.rate = opts.rate || 0.95;
      utterance.pitch = opts.pitch || 1.02;
      utterance.volume = opts.volume || 1.0;

      utterance.onstart = () => {
        this.isSpeaking = true;
        if (opts.onstart) opts.onstart();
      };

      utterance.onend = () => {
        this.isSpeaking = false;
        this._playNext();
        if (opts.onend) opts.onend();
        resolve({ success: true, duration: utterance.duration || 2000 });
      };

      utterance.onerror = (e) => {
        this.isSpeaking = false;
        if (opts.onerror) opts.onerror(e);
        reject(new Error(e.error));
      };

      this.queue.push(utterance);
      this._playNext();
    });
  }

  _getDefaultVoice() {
    if (this.options.voice && typeof this.options.voice === "object") return this.options.voice;
    const female = this.voices.find(v => v.gender === "female");
    return female || this.voices[0] || null;
  }

  _playNext() {
    if (this.queue.length === 0 || this.isSpeaking) return;
    const next = this.queue.shift();
    this.speechSynthesis.speak(next);
  }

  stop() {
    if (this.speechSynthesis) {
      this.speechSynthesis.cancel();
      this.queue = [];
      this.isSpeaking = false;
    }
  }

  pause() {
    if (this.speechSynthesis && this.speechSynthesis.speaking) {
      this.speechSynthesis.pause();
    }
  }

  resume() {
    if (this.speechSynthesis && this.speechSynthesis.paused) {
      this.speechSynthesis.resume();
    }
  }

  getVoices() {
    return [...this.voices];
  }

  setVoice(voiceName) {
    const voice = this.voices.find(v => v.name === voiceName);
    if (voice) {
      this.options.voice = voice;
      return true;
    }
    return false;
  }

  setOptions(opts) {
    Object.assign(this.options, opts);
  }
}

// Combine SSML helper with addBreaksToContent
const ttsUtils = {
  generateSSML: function(text, options) {
    return generateSSML.call({ _addBreaksToContent: addBreaksToContent }, text, options);
  },
  detectVoices,
  VOICE_PROFILES,
  getBestEducationVoice
};

module.exports = {
  createTTSServer,
  generateSSML,
  detectVoices,
  VOICE_PROFILES,
  TTSController,
  ttsUtils
};