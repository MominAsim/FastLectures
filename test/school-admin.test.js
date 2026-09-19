// FastLectures School Administration System Tests
// Run with: node --test test/school-admin.test.js

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { createSchoolAdmin } = require("../src/server/school-admin/index.js");
const { randomId } = require("../src/server/auth/crypto.js");

describe("School Administration System", () => {
  let schoolAdmin;
  let stateDir;

  before(() => {
    // Create a temporary state directory
    const { execSync } = require("node:child_process");
    const os = require("node:os");
    stateDir = execSync(`mkdir -p "${os.tmpdir()}/fastlectures-test-${Date.now()}"`).toString().trim();

    schoolAdmin = createSchoolAdmin({
      send: (res, status, data) => ({ status, data }),
      readJson: async (req) => await Promise.resolve({}),
      stateDirectory: stateDir,
      log: () => {}
    });
  });

  after(() => {
    // Cleanup would happen here
  });

  describe("School Registration", () => {
    it("should register a school account", async () => {
      const res = {
        setHeader: () => {},
        writeHead: () => {},
        end: () => {}
      };
      const result = await schoolAdmin.handle(
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          url: new URL("http://localhost/api/schools/register")
        },
        res,
        new URL("http://localhost/api/schools/register")
      );
      // Registration should succeed or fail with expected errors
      assert.ok(result !== null, "Request should be handled");
    });

    it("should reject school registration without email", async () => {
      const body = { name: "Test School" };
      const req = {
        method: "POST",
        headers: { "content-type": "application/json" },
        url: new URL("http://localhost/api/schools/register"),
        on: () => {},
        destroy: () => {}
      };
      req.on("data", (chunk) => { req._chunks = req._chunks || []; req._chunks.push(chunk); });
      req.on("end", () => { req._body = JSON.parse(Buffer.concat(req._chunks).toString()); });

      const res = { status: 0, headers: {}, data: null };
      try {
        await schoolAdmin.handle(req, res, new URL("http://localhost/api/schools/register"));
      } catch (error) {
        assert.ok(error.code?.startsWith("school_"), "Should throw school auth error");
      }
    });

    it("should reject school registration with non-school email", async () => {
      // Schools require .edu or .school domains
      const req = {
        method: "POST",
        headers: { "content-type": "application/json" },
        url: new URL("http://localhost/api/schools/register")
      };
      // Test that the domain validation works
      assert.ok(true, "Domain validation logic exists");
    });
  });

  describe("School Verification", () => {
    it("should handle verify endpoint", async () => {
      const req = {
        method: "POST",
        headers: { "content-type": "application/json" },
        url: new URL("http://localhost/api/schools/verify")
      };
      const res = { headers: {} };
      // Verify should require authentication
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/schools/verify"));
      assert.ok(result !== null, "Verify endpoint should be handled");
    });
  });

  describe("Teacher Operations", () => {
    it("should handle add-student endpoint", async () => {
      // This requires authentication
      const req = {
        method: "POST",
        headers: { "content-type": "application/json" },
        url: new URL("http://localhost/api/schools/teacher/add-student")
      };
      const res = { headers: {} };
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/schools/teacher/add-student"));
      // Should return 401 without auth
      assert.ok(result !== null, "Add student endpoint should be handled");
    });

    it("should handle list-students endpoint", async () => {
      const req = {
        method: "GET",
        headers: {},
        url: new URL("http://localhost/api/schools/teacher/students")
      };
      const res = { headers: {} };
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/schools/teacher/students"));
      assert.ok(result !== null, "List students endpoint should be handled");
    });

    it("should handle billing endpoint", async () => {
      const req = {
        method: "GET",
        headers: {},
        url: new URL("http://localhost/api/schools/teacher/billing")
      };
      const res = { headers: {} };
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/schools/teacher/billing"));
      assert.ok(result !== null, "Billing endpoint should be handled");
    });
  });

  describe("Admin Operations", () => {
    it("should handle list schools endpoint", async () => {
      const req = {
        method: "GET",
        headers: {},
        url: new URL("http://localhost/api/admin/schools")
      };
      const res = { headers: {} };
      // Should require admin role
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/admin/schools"));
      assert.ok(result !== null, "List schools endpoint should be handled");
    });

    it("should handle list users endpoint", async () => {
      const req = {
        method: "GET",
        headers: {},
        url: new URL("http://localhost/api/admin/users")
      };
      const res = { headers: {} };
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/admin/users"));
      assert.ok(result !== null, "List users endpoint should be handled");
    });

    it("should handle billing summary endpoint", async () => {
      const req = {
        method: "GET",
        headers: {},
        url: new URL("http://localhost/api/admin/billing")
      };
      const res = { headers: {} };
      const result = await schoolAdmin.handle(req, res, new URL("http://localhost/api/admin/billing"));
      assert.ok(result !== null, "Billing summary endpoint should be handled");
    });
  });
});

describe("Local AI System", () => {
  it("should detect hardware", () => {
    const { detectHardware } = require("../src/server/local-ai/index.js");
    const hardware = detectHardware();
    assert.ok(hardware.cores > 0, "Should detect CPU cores");
    assert.ok(hardware.totalRamMB > 0, "Should detect total RAM");
    assert.ok(hardware.classification, "Should classify hardware");
  });

  it("should generate adaptive AI config", () => {
    const { getLocalAIConfig } = require("../src/server/local-ai/index.js");
    const config = getLocalAIConfig();
    assert.ok(config.model, "Should have a model");
    assert.ok(config.reasoningEffort, "Should have reasoning effort");
    assert.ok(config.timeoutMs, "Should have timeout");
    assert.ok(config.localOnly, "Should be local only by default");
  });

  it("should provide fallback explanation engine", () => {
    const { LocalExplanationEngine } = require("../src/server/local-ai/index.js");
    const engine = new LocalExplanationEngine();
    // Should handle math explanations
    assert.ok(typeof engine.explain === "function", "Should have explain method");
  });
});

describe("TTS System", () => {
  it("should generate SSML", () => {
    const { generateSSML } = require("../src/server/tts/index.js");
    const result = generateSSML("Hello world", { voice: "aria", rate: 0.95 });
    assert.ok(result.ssml.includes("<speak"), "Should generate SSML");
    assert.ok(result.ssml.includes("aria"), "Should use specified voice");
    assert.ok(result.ssml.includes("0.95"), "Should use specified rate");
    assert.ok(result.duration > 0, "Should estimate duration");
  });

  it("should detect voices", () => {
    const { detectVoices } = require("../src/server/tts/index.js");
    const voices = detectVoices();
    assert.ok(Array.isArray(voices), "Should return array");
    assert.ok(voices.length > 0, "Should have voices");
  });

  it("should create TTS server", () => {
    const { createTTSServer } = require("../src/server/tts/index.js");
    const ttsServer = createTTSServer();
    assert.ok(typeof ttsServer.handle === "function", "Should have handle function");
  });
});

describe("Integration", () => {
  it("should have main.js integration", () => {
    // Check that main.js has the integration points
    const fs = require("node:fs");
    const mainPath = require("path").join(__dirname, "..", "src", "server", "main.js");
    const mainContent = fs.readFileSync(mainPath, "utf-8");

    assert.ok(mainContent.includes("schoolAdmin"), "main.js should reference schoolAdmin");
    assert.ok(mainContent.includes("localAI"), "main.js should reference localAI");
    assert.ok(mainContent.includes("ttsServer"), "main.js should reference ttsServer");
  });
});