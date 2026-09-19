// Browser-side Text-to-Speech Controller for FastLectures
// Uses Web Speech API (built-in to Chrome/Edge)
// Runs 100% locally, no network requests needed

// TTS Controller class for browser
class TTSController {
  constructor(options = {}) {
    this.speechSynthesis = window.speechSynthesis || null;
    this.voices = [];
    this.currentUtterance = null;
    this.isSpeaking = false;
    this.isPaused = false;
    this.queue = [];
    this.options = {
      voice: null,
      rate: 0.95,
      pitch: 1.02,
      volume: 1.0,
      onstart: null,
      onend: null,
      onerror: null,
      onpause: null,
      onresume: null
    };

    // Apply any initial options
    if (options.rate !== undefined) this.options.rate = options.rate;
    if (options.pitch !== undefined) this.options.pitch = options.pitch;
    if (options.volume !== undefined) this.options.volume = options.volume;

    // Initialize voices on load
    this._initVoices();
  }

  _initVoices() {
    if (!this.speechSynthesis) return;

    const load = () => {
      this.voices = this.speechSynthesis.getVoices() || [];
      if (this.options.voice === "auto") {
        this._setBestFemaleVoice();
      }
      // Fire custom event when voices are loaded
      if (this.voices.length > 0) {
        this.dispatchEvent(new CustomEvent('ttsvoicesloaded', { detail: { voices: this.voices } }));
      }
    };

    // Try immediate load
    if (this.voices.length > 0) {
      this.voices = this.speechSynthesis.getVoices();
    }

    // Listen for voiceschanged event
    if (this.speechSynthesis.onvoiceschanged !== undefined) {
      this.speechSynthesis.onvoiceschanged = load;
    }

    // Fallback: use setTimeout to catch late-loaded voices
    setTimeout(load, 500);
  }

  _setBestFemaleVoice() {
    const femaleVoices = this.voices.filter(v => v.gender === "female" || v.name.toLowerCase().includes("aria") || v.name.toLowerCase().includes("zira"));

    // Priority list for education-friendly voices
    const priority = ["aria", "zira", "ivy", "bianca", "jenny", "sora", "freya", "amy"];

    for (const name of priority) {
      const voice = femaleVoices.find(v =>
        v.name.toLowerCase().includes(name) ||
        v.voiceURI.toLowerCase().includes(name) ||
        (typeof v.default === "boolean" && v.default)
      );
      if (voice) {
        this.options.voice = voice;
        return;
      }
    }

    // Fallback to first female voice
    if (femaleVoices.length > 0) {
      this.options.voice = femaleVoices[0];
    }
  }

  async speak(text, voiceOptions = {}) {
    if (!this.speechSynthesis) {
      console.warn("Speech synthesis not available in this browser");
      return { success: false, error: "speech_synthesis_unavailable", message: "Your browser doesn't support speech synthesis." };
    }

    // Cancel any current speech if we're not queuing
    if (!this.options.queueWhileSpeaking && this.isSpeaking && !this.isPaused) {
      this.stop();
    }

    const opts = { ...this.options, ...voiceOptions };
    const utterance = new SpeechSynthesisUtterance(String(text));

    utterance.voice = this._getVoiceForSettings(opts.voice);
    utterance.rate = opts.rate || 0.95;
    utterance.pitch = opts.pitch || 1.02;
    utterance.volume = opts.volume !== undefined ? opts.volume : 1.0;

    const result = {
      success: true,
      text: text,
      voice: utterance.voice?.name || 'default',
      rate: utterance.rate,
      pitch: utterance.pitch,
      volume: utterance.volume,
      queued: this.queue.length > 0
    };

    utterance.onstart = () => {
      this.isSpeaking = true;
      this.isPaused = false;
      this.currentUtterance = utterance;
      if (opts.onstart) opts.onstart(result);
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      this.currentUtterance = null;
      // Remove the completed utterance from queue if it was queued
      if (this.queue.length > 0 && this.queue[0] === utterance) {
        this.queue.shift();
      }
      // Play next in queue
      if (this.queue.length > 0) {
        this._playNext();
      }
      if (opts.onend) opts.onend(result);
    };

    utterance.onerror = (e) => {
      console.error("TTS Error:", e.error);
      this.isSpeaking = false;
      this.currentUtterance = null;
      if (opts.onerror) opts.onerror(e.error);
    };

    this.queue.push(utterance);
    this._playNext();

    return result;
  }

  _playNext() {
    if (this.queue.length === 0 || this.isSpeaking && this.isPaused) return;
    const next = this.queue.shift();
    this.speechSynthesis.speak(next);
  }

  stop(force = false) {
    if (this.speechSynthesis) {
      if (force) {
        this.queue = [];
      }
      if (this.isPaused) {
        this.speechSynthesis.resume();
        this.isPaused = false;
      }
      this.speechSynthesis.cancel();
      this.isSpeaking = false;
      this.isPaused = false;
      this.currentUtterance = null;
    }
  }

  pause() {
    if (this.speechSynthesis && this.isSpeaking) {
      this.speechSynthesis.pause();
      this.isPaused = true;
      if (this.options.onpause) this.options.onpause();
    }
  }

  resume() {
    if (this.speechSynthesis && this.isPaused) {
      this.speechSynthesis.resume();
      this.isPaused = false;
      if (this.options.onresume) this.options.onresume();
    }
  }

  getVoices() {
    return [...this.voices];
  }

  getFemaleVoices() {
    return this.voices.filter(v => v.gender === "female" || v.name.toLowerCase().includes("aria") || v.name.toLowerCase().includes("zira"));
  }

  getBestEducationVoice() {
    const female = this.getFemaleVoices();
    const priority = ["aria", "zira", "ivy", "bianca", "jenny", "sora"];
    for (const name of priority) {
      const voice = female.find(v => v.name.toLowerCase().includes(name));
      if (voice) return voice;
    }
    return female[0] || null;
  }

  setVoice(voiceName) {
    if (!voiceName) {
      this.options.voice = null;
      return true;
    }
    const voice = this.voices.find(v => v.name === voiceName || v.voiceURI === voiceName);
    if (voice) {
      this.options.voice = voice;
      return true;
    }
    return false;
  }

  setOptions(opts) {
    if (opts.voice !== undefined) this.options.voice = opts.voice;
    if (opts.rate !== undefined) this.options.rate = opts.rate;
    if (opts.pitch !== undefined) this.options.pitch = opts.pitch;
    if (opts.volume !== undefined) this.options.volume = opts.volume;
    if (opts.onstart !== undefined) this.options.onstart = opts.onstart;
    if (opts.onend !== undefined) this.options.onend = opts.onend;
    if (opts.onerror !== undefined) this.options.onerror = opts.onerror;
  }

  setQueueWhileSpeaking(shouldQueue) {
    this.options.queueWhileSpeaking = shouldQueue;
  }

  // Predefined voice profiles for education
  getProfile(name) {
    const profiles = {
      "explainer": { rate: 0.90, pitch: 0.98, volume: 1.0, description: "Clear, patient voice for step-by-step explanations" },
      "teacher": { rate: 0.95, pitch: 1.05, volume: 1.0, description: "Warm, engaging voice for lectures" },
      "quick": { rate: 1.1, pitch: 1.0, volume: 0.9, description: "Fast pace for summaries" },
      "emphatic": { rate: 0.85, pitch: 1.1, volume: 1.0, description: "Slower, dramatic for important points" }
    };
    return profiles[name] || profiles.explainer;
  }

  speakWithProfile(text, profileName = "explainer") {
    const profile = this.getProfile(profileName);
    return this.speak(text, profile);
  }

  // Get current status
  getStatus() {
    return {
      isSpeaking: this.isSpeaking,
      isPaused: this.isPaused,
      queueLength: this.queue.length,
      voice: this.options.voice,
      rate: this.options.rate,
      pitch: this.options.pitch,
      volume: this.options.volume,
      voicesAvailable: this.voices.length,
      femaleVoices: this.getFemaleVoices().length
    };
  }

  // Dispatch custom events
  dispatchEvent(event) {
    window.dispatchEvent(event);
  }

  // Listen for tts commands from canvas
  bindToCanvas(canvasController) {
    this.canvasController = canvasController;

    // When canvas starts interaction, pause narration
    if (canvasController.onDrawStart) {
      canvasController.onDrawStart(() => this.pause());
    }

    // When canvas idle for 2s, resume narration
    if (canvasController.onIdle) {
      canvasController.onIdle(() => this.resume());
    }
  }
}

// SSML generation for server
function generateSSML(text, options = {}) {
  const {
    voice = "aria",
    rate = 0.95,
    pitch = 1.02,
    volume = 1.0,
    addPauses = true,
    breakMs = 300,
    language = "en-US"
  } = options;

  let content = String(text || "");

  // Handle math symbols - spell them out
  const replacements = [
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
    [/\b∑\b/g, "sigma"],
    [/\b∏\b/g, "product"],
    [/\b≤\b/g, "less than or equal to"],
    [/\b≥\b/g, "greater than or equal to"],
    [/\b±\b/g, "plus or minus"],
    [/\b×\b/g, "times"],
    [/\b÷\b/g, "divided by"],
    [/\b√\b/g, "square root of"]
  ];

  for (const [pattern, replacement] of replacements) {
    content = content.replace(pattern, replacement);
  }

  // Add pauses between sentences
  let processed = '';
  if (addPauses) {
    const sentences = content.split(/([.!?])\s*/g);
    processed = sentences.map((s, i) => {
      if (s.match(/[.!?]/)) return s;
      return s.trim() + (i < sentences.length - 2 ? `<break time="${breakMs}ms"/>` : '');
    }).join(' ');
  } else {
    processed = content;
  }

  const wordCount = content.trim().split(/\s+/).filter(w => w.length > 0).length;
  const durationMs = Math.max(1000, Math.floor((wordCount / (150 * rate)) * 1000));

  return {
    ssml: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${language}"><voice name="${voice}"><prosody rate="${rate}" pitch="${pitch}st" volume="${volume}">${processed}</prosody></voice></speak>`,
    duration: durationMs,
    voice,
    rate,
    pitch,
    volume,
    wordCount
  };
}

// Voice profiles for different contexts
const VOICE_PROFILES = {
  "explainer": {
    name: "Explainer Voice",
    rate: 0.92,
    pitch: 1.0,
    volume: 1.0,
    description: "Clear, patient voice ideal for step-by-step explanations"
  },
  "teacher": {
    name: "Teacher Voice",
    rate: 0.95,
    pitch: 1.05,
    volume: 1.0,
    description: "Warm, engaging voice for lectures and presentations"
  },
  "quick": {
    name: "Quick Summary",
    rate: 1.1,
    pitch: 1.0,
    volume: 0.9,
    description: "Faster pace for summaries and brief explanations"
  },
  "emphatic": {
    name: "Emphatic Voice",
    rate: 0.85,
    pitch: 1.1,
    volume: 1.0,
    description: "Slower, more dramatic for important points"
  }
};

// Export globally
if (typeof window !== "undefined") {
  window.TTSController = TTSController;
  window.VOICE_PROFILES = VOICE_PROFILES;
}

// Export for module systems
if (typeof module !== "undefined" && module.exports) {
  module.exports = { TTSController, generateSSML, VOICE_PROFILES };
}