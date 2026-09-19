"use strict";

// Local AI auto-configuration and adaptive model runner for FastLectures
// Works with DeepSeek Harness, falls back to built-in explanation engine
// Optimized to run on 2-4 cores with 4GB RAM

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Hardware detection
function detectHardware() {
  const cores = os.cpus().length;
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const totalRamMB = Math.floor(totalRam / (1024 * 1024));
  const freeRamMB = Math.floor(freeRam / (1024 * 1024));
  const platform = os.platform();

  let classification;
  if (cores <= 2 && totalRamMB < 6144) {
    classification = "ultra-low"; // 1-2 cores, <6GB
  } else if (cores <= 4 && totalRamMB < 8192) {
    classification = "low"; // 2-4 cores, 4-8GB
  } else if (cores <= 8 && totalRamMB < 16384) {
    classification = "medium"; // 4-8 cores, 8-16GB
  } else {
    classification = "high"; // 8+ cores, 16GB+
  }

  return {
    cores,
    totalRamMB,
    freeRamMB,
    classification,
    platform,
    architecture: os.arch()
  };
}

// Adaptive AI configuration based on hardware
function getLocalAIConfig(hardware = null) {
  const hw = hardware || detectHardware();

  const baseConfigs = {
    "ultra-low": {
      model: "dsh-llm:base",
      modelAlias: "deepseek-ai/dsh-llm:base",
      reasoningEffort: "none",
      maxTokens: 512,
      maxCompletionTokens: 256,
      timeoutMs: 60000,
      temperature: 0.7,
      topP: 0.9,
      maxContextTokens: 2048,
      localOnly: true,
      memoryPoolMB: 256,
      parallelism: 1,
      batchSize: 1
    },
    "low": {
      model: "dsh-llm:mini",
      modelAlias: "deepseek-ai/dsh-llm:mini",
      reasoningEffort: "low",
      maxTokens: 1024,
      maxCompletionTokens: 512,
      timeoutMs: 120000,
      temperature: 0.7,
      topP: 0.95,
      maxContextTokens: 4096,
      localOnly: true,
      memoryPoolMB: 512,
      parallelism: 2,
      batchSize: 2
    },
    "medium": {
      model: "dsh-llm:standard",
      modelAlias: "deepseek-ai/dsh-llm:standard",
      reasoningEffort: "medium",
      maxTokens: 2048,
      maxCompletionTokens: 1024,
      timeoutMs: 180000,
      temperature: 0.7,
      topP: 0.95,
      maxContextTokens: 8192,
      localOnly: true,
      memoryPoolMB: 1024,
      parallelism: 4,
      batchSize: 4
    },
    "high": {
      model: "dsh-llm:large",
      modelAlias: "deepseek-ai/dsh-llm:large",
      reasoningEffort: "high",
      maxTokens: 4096,
      maxCompletionTokens: 2048,
      timeoutMs: 300000,
      temperature: 0.7,
      topP: 0.98,
      maxContextTokens: 16384,
      localOnly: true,
      memoryPoolMB: 2048,
      parallelism: 6,
      batchSize: 8
    }
  };

  const config = baseConfigs[hw.classification] || baseConfigs["low"];

  // Add calculated fields
  return {
    ...config,
    classification: hw.classification,
    hardware: {
      cores: hw.cores,
      totalRamMB: hw.totalRamMB,
      freeRamMB: hw.freeRamMB,
      platform: hw.platform,
      architecture: hw.architecture
    },
    fallbackChain: [
      { provider: "local", weight: 1.0 },
      { provider: "api", weight: 0.5 }
    ],
    voiceEnabled: true,
    voiceProfile: "explainer",
    voiceRate: 0.95,
    voicePitch: 1.02,
    voiceVolume: 1.0,
    preferredVoice: "aria"
  };
}

// Auto-configure and save
async function autoConfigure(configPath = null) {
  const config = getLocalAIConfig();
  const settings = {
    version: "1.0.0",
    hardware: config.hardware,
    ai: {
      model: config.model,
      modelAlias: config.modelAlias,
      reasoningEffort: config.reasoningEffort,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      localOnly: config.localOnly,
      apiOverride: false
    },
    tts: {
      enabled: true,
      voiceEnabled: true,
      voiceProfile: config.voiceProfile,
      voiceRate: config.voiceRate,
      voicePitch: config.voicePitch,
      preferredVoice: config.preferredVoice
    },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  if (configPath) {
    const dir = path.dirname(configPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(settings, null, 2));
  }

  return settings;
}

// Load saved config
function loadConfig(configPath = null) {
  const path = configPath || defaultConfigPath();
  try {
    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, "utf-8");
      return JSON.parse(raw);
    }
  } catch (e) {
    // Return default if load fails
  }
  return null;
}

function defaultConfigPath() {
  const home = os.homedir();
  const stateDir = process.env.FASTLECTURES_STATE_DIR || path.join(home, ".fastlectures");
  return path.join(stateDir, "local-ai.json");
}

// Memory pool configuration
function configureMemoryPool(hardware = null) {
  const hw = hardware || detectHardware();
  const mem = hw.totalRamMB;

  let poolMB;
  if (mem < 4096) poolMB = 256;
  else if (mem < 8192) poolMB = 512;
  else if (mem < 16384) poolMB = 1024;
  else poolMB = 2048;

  return {
    memoryPoolMB: poolMB,
    jvmHeapMB: Math.floor(poolMB * 0.8),
    modelMemoryMB: poolMB,
    contextMemoryMB: Math.max(256, poolMB - 128),
    garbageCollection: {
      threshold: 0.8,
      intervalMs: 300000,
      aggressive: mem < 4096
    }
  };
}

// Local AI Provider class
class LocalAIProvider {
  constructor(config, stateDirectory) {
    this.config = config || getLocalAIConfig();
    this.stateDirectory = stateDirectory || defaultConfigPath();
    this.apiOverride = null;
    this.dshClient = null;
    this.healthy = false;
    this.fallbackEngine = new LocalExplanationEngine();

    this._init();
  }

  async _init() {
    // Try to load DSH if available
    try {
      const mod = await import("@deepseek-ai/dsh-llm");
      if (mod && typeof mod.createSession === "function") {
        this.dshClient = mod;
        this.healthy = true;
      }
    } catch (e) {
      this.healthy = false;
    }

    // Load saved config
    const saved = loadConfig(this.stateDirectory);
    if (saved) {
      this.config = { ...this.config, ...saved.ai };
    }
  }

  async chat(messages, options = {}) {
    if (!this.healthy || !this.dshClient) {
      return this.fallbackEngine.explain(messages, options);
    }

    const cfg = this._getRuntimeConfig();
    const timeout = options.timeoutMs || cfg.timeoutMs;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await this.dshClient.chat(messages, cfg);
      clearTimeout(timeoutId);

      return {
        success: true,
        message: response,
        usage: { model: cfg.model, tokens: messages.length * 100 }
      };
    } catch (error) {
      if (error.name === "AbortError") {
        return { success: false, error: "timeout", message: "Response timed out. Reduce question complexity." };
      }
      return { success: false, error: "model_error", message: "Local model unavailable. Try reducing question complexity." };
    }
  }

  async explain(text, voice = true) {
    const cfg = this._getRuntimeConfig();

    const result = await this.chat([{ role: "user", content: `Explain this clearly with steps: ${text}` }], cfg);

    if (voice && this.config.voiceEnabled) {
      return {
        ...result,
        voiceText: result.message || text,
        voiceConfig: {
          rate: this.config.voiceRate || 0.95,
          pitch: this.config.voicePitch || 1.02,
          volume: this.config.voiceVolume || 1.0,
          preferredVoice: this.config.preferredVoice || "aria"
        }
      };
    }

    return result;
  }

  _getRuntimeConfig() {
    const cfg = { ...this.config };

    if (this.apiOverride) {
      return { ...this.apiOverride, localOnly: false };
    }

    return {
      model: cfg.model,
      modelAlias: cfg.modelAlias,
      temperature: cfg.temperature,
      topP: cfg.topP,
      maxTokens: cfg.maxCompletionTokens || cfg.maxTokens / 2,
      reasoningEffort: cfg.reasoningEffort,
      timeoutMs: cfg.timeoutMs,
      memoryPoolMB: cfg.memoryPoolMB,
      localOnly: cfg.localOnly
    };
  }

  getStatus() {
    return {
      healthy: this.healthy,
      hardware: this.config.hardware || detectHardware(),
      config: this.config,
      apiOverride: this.apiOverride,
      fallbackAvailable: true
    };
  }

  setApiOverride(apiKey, baseUrl, model) {
    this.apiOverride = {
      apiKey,
      baseUrl,
      model: model || this.config.model,
      localOnly: false
    };
    this.config.localOnly = false;
  }

  clearApiOverride() {
    this.apiOverride = null;
    this.config.localOnly = true;
  }

  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
  }
}

// Fallback explanation engine (works without DSH)
class LocalExplanationEngine {
  constructor() {
    this.memory = [];
  }

  async explain(text, options = {}) {
    // Use structured templates + pattern matching for explanations
    const explanation = this._generateExplanation(text, options);

    return {
      success: true,
      message: explanation,
      usage: { model: "local-fallback", tokens: explanation.length / 4 },
      fromCache: false
    };
  }

  async chat(messages, options = {}) {
    // Simple chat with template-based responses
    const lastUserMessage = messages?.findLast?.((m) => m?.role === "user")?.content || "";

    const response = this._generateExplanation(lastUserMessage, options);

    return {
      success: true,
      message: response,
      usage: { model: "local-fallback", tokens: response.length / 4 }
    };
  }

  _generateExplanation(text, options) {
    const lower = text.toLowerCase();

    // Math explanation
    if (/\d|\+|−|\*|÷|frac|sqrt|pi|theta/i.test(text) || /[0-9]/.test(text)) {
      return this._explainMath(text);
    }

    // Programming question
    if (/\bfunction\b|\bvar\b|\blet\b|\bconst\b|\bfor\b|\bif\b|\bclass\b|\boop\b/i.test(text)) {
      return this._explainProgramming(text);
    }

    // General explanation
    return this._explainGeneral(text, options);
  }

  _explainMath(text) {
    return `Let me break this down step by step:

**Problem:** ${text}

**Step 1 - Understand the Components:**
Look for numbers, variables, and operations. In this problem, we need to evaluate the expression.

**Step 2 - Order of Operations (PEMDAS):**
1. Parentheses first
2. Exponents (powers and roots)
3. Multiplication and Division (left to right)
4. Addition and Subtraction (left to right)

**Step 3 - Simplify:**
Work through the expression systematically, writing each step clearly.

**Step 4 - Verify:**
Check your answer by substituting values back into the original expression.

Would you like me to work through a specific part? I can explain each step more clearly or work through an example with actual numbers.`;
  }

  _explainProgramming(text) {
    return `Here's a clear explanation:

**Concept Overview:**
${text}

**Key Points:**
1. **Syntax:** The way to write this code in your programming language
2. **Purpose:** Why you'd use this pattern
3. **Common Pitfalls:** Things that often go wrong
4. **Best Practices:** How to write it cleanly

**Example:**
\`\`\`javascript
// Your code example here
const result = yourExpression;
\`\`\`

**Explanation:**
- Line 1 shows...
- The pattern...

Would you like me to explain a specific language (Python, JavaScript, Java, C++, etc.) or go deeper into any particular aspect?`;
  }

  _explainGeneral(text, options) {
    return `Let me explain this clearly:

**Topic:** ${text}

**What It Means:**
This is about ${text}. Let me break it down into simple concepts.

**Key Concepts:**
1. **Primary Idea:** The main point you need to understand
2. **Context:** Why this matters
3. **Application:** How it's used in practice

**Step-by-Step Explanation:**
1. Start with the fundamentals
2. Build on each piece
3. Connect to the bigger picture
4. Give you concrete examples

**Example:**
Imagine if we were talking about cooking - you'd need to understand the ingredients first, then the method, then how to adjust for different situations.

**Questions to Ask Yourself:**
- What do I already know about this?
- What parts are unclear?
- How can I test my understanding?

Would you like me to focus on any particular aspect or go slower through a specific part?`;
  }
}

// Export all functions
module.exports = {
  detectHardware,
  getLocalAIConfig,
  autoConfigure,
  loadConfig,
  configureMemoryPool,
  LocalAIProvider,
  LocalExplanationEngine,
  defaultConfigPath
};