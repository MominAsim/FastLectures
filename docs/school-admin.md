# FastLectures School Administration System

## Overview

This document describes the school administration, billing, and local AI system for FastLectures. The system enables schools to register, manage students, and provides global admin dashboards for the platform.

## Architecture

### Backend Components

- **`src/server/school-admin/index.js`**: Main school administration and billing server
- **`src/server/local-ai/index.js`**: Local AI auto-configuration and adaptive model runner
- **`src/server/tts/index.js`**: Text-to-Speech server with SSML generation
- **`public/tts.js`**: Browser-side TTS controller using Web Speech API
- **`public/admin.css`**: Admin dashboard styles

### Database

School data is stored in a separate SQLite database at `{stateDir}/school.db` with the following schema:

#### Tables

1. **schools**
   - `id` (TEXT, PRIMARY KEY)
   - `name` (TEXT NOT NULL)
   - `email` (TEXT NOT NULL UNIQUE)
   - `address` (TEXT)
   - `password_hash` (TEXT NOT NULL)
   - `verification_token_hash` (TEXT)
   - `verified_at` (INTEGER)
   - `last_login_at` (INTEGER)
   - `created_at` (INTEGER NOT NULL)
   - `updated_at` (INTEGER NOT NULL)
   - `stripe_customer_id` (TEXT)
   - `total_students` (INTEGER DEFAULT 0)
   - `total_revenue` (REAL DEFAULT 0)

2. **user_schools**
   - `user_id` (TEXT, FK → users.id)
   - `school_id` (TEXT, FK → schools.id)
   - `role` (TEXT: 'school_admin', 'teacher', 'student')
   - `created_at` (INTEGER)

3. **billing_transactions**
   - `id` (TEXT, PRIMARY KEY)
   - `school_id` (TEXT, FK → schools.id)
   - `user_id` (TEXT, FK → users.id)
   - `amount` (REAL)
   - `type` (TEXT: 'school_enrollment', 'individual_enrollment', 'school_rebate', etc.)
   - `description` (TEXT)
   - `created_at` (INTEGER)

4. **school_sessions**
   - `id` (INTEGER AUTOINCREMENT PRIMARY KEY)
   - `token_hash` (TEXT UNIQUE)
   - `school_id` (TEXT, FK → schools.id)
   - `created_at` (INTEGER)
   - `expires_at` (INTEGER)
   - `user_agent` (TEXT)
   - `ip` (TEXT)

5. **school_settings**
   - `school_id` (TEXT, PK FK → schools.id)
   - `settings_json` (TEXT)
   - `updated_at` (INTEGER)

## Pricing Model

| Account Type | Price | Notes |
|-------------|-------|-------|
| School student account | $14/month | Discounted for schools |
| Individual student | $20/month | Full price |
| School rebate | $2/student | Credited back to school |

**Example**: A school with 10 students pays $140/month ($14 × 10), gets $20/month rebate ($2 × 10), net cost = $120/month.

## API Endpoints

### School Registration & Auth

- `POST /api/schools/register` - Register a new school or student
- `POST /api/schools/verify` - Verify school with token
- `POST /api/schools/login` - School login
- `POST /api/schools/logout` - Logout
- `GET /api/schools/me` - Current school info

### Teacher Operations (requires teacher/school_admin role)

- `POST /api/schools/teacher/add-student` - Add a student to school
- `GET /api/schools/teacher/students` - List all students
- `DELETE /api/schools/teacher/students/{student_id}` - Remove student
- `GET /api/schools/teacher/billing` - Get billing summary

### Admin Operations (requires admin/super_admin role)

- `GET /api/admin/schools` - List all schools
- `GET /api/admin/schools/{id}` - Get school details
- `GET /api/admin/users` - List all users
- `GET /api/admin/billing` - Global billing summary
- `POST /api/admin/billing/transaction` - Create billing transaction
- `GET /api/admin/me` - Current admin info

### TTS API

- `GET /api/tts/voices` - List available voices
- `POST /api/tts/speak` - Generate speech from text
- `POST /api/tts/ssml` - Generate SSML
- `POST /api/tts/preload` - Preload phrases for caching

## Local AI System

### Hardware Detection

The system auto-detects hardware and adjusts AI settings:

| Hardware Class | Cores | RAM | Max Tokens | Timeout | Memory Pool |
|---------------|-------|-----|------------|---------|-------------|
| ultra-low | ≤2 | <4GB | 512 | 60s | 256MB |
| low | ≤4 | 4-8GB | 1024 | 120s | 512MB |
| medium | ≤8 | 8-16GB | 2048 | 180s | 1024MB |
| high | >8 | >16GB | 4096 | 300s | 2048MB |

### AI Provider Integration

```javascript
const { LocalAIProvider } = require("./local-ai/index.js");
const localAI = new LocalAIProvider();

// Explain text with voice
const result = await localAI.explain("Explain calculus derivatives");
console.log(result.message);
console.log(result.voiceText); // For TTS
```

### Fallback Engine

If DeepSeek Harness is not available, the system falls back to a template-based explanation engine that handles:
- Math explanations (step-by-step)
- Programming concepts
- General knowledge

## TTS System

### Server-Side (SSML Generation)

```javascript
const { generateSSML, VOICE_PROFILES } = require("./tts/index.js");

const result = generateSSML("Hello, welcome to the lesson", {
  voice: "aria",
  rate: 0.95,
  pitch: 1.0,
  addPauses: true
});
```

### Browser-Side (Web Speech API)

```javascript
const tts = new TTSController();

// Speak with profile
tts.speakWithProfile("Let me explain this concept...", "explainer");

// Custom options
tts.speak("Custom text", {
  voice: "Microsoft Zira",
  rate: 0.9,
  pitch: 1.0
});
```

### Voice Profiles

- **explainer** (0.92 rate, 1.0 pitch): Clear, patient for step-by-step
- **teacher** (0.95 rate, 1.05 pitch): Warm, engaging for lectures
- **quick** (1.1 rate, 1.0 pitch): Faster for summaries
- **emphatic** (0.85 rate, 1.1 pitch): Slower for important points

## Integration with Main Server

In `src/server/main.js`:

```javascript
// Imports
const { createSchoolAdmin } = require("./school-admin/index.js");
const { LocalAIProvider } = require("./local-ai/index.js");
const { createTTSServer } = require("./tts/index.js");

// Initialization (inside AUTH_ENABLED block)
schoolAdmin = createSchoolAdmin({ send, readJson, stateDirectory, log });
localAI = new LocalAIProvider();
ttsServer = createTTSServer();

// Request routing
if (schoolAdmin && await schoolAdmin.handle(req, res, url)) return;
if (ttsServer && url.pathname.startsWith("/api/tts/") && await ttsServer.handle(req, res, url)) return;
```

## Security Features

1. **Email verification**: Schools must verify their .edu/.school domain
2. **Rate limiting**: 10 attempts per hour per IP
3. **Password strength**: 10+ characters, letter + number required
4. **Session management**: 30-day sessions with secure cookies
5. **School domain validation**: .edu and .school endings required for school accounts
6. **RBAC**: Strict role checks (school_admin, teacher, student, admin, super_admin)

## Testing

```bash
# Run all tests
node --test test/school-admin.test.js

# Run specific test suite
node --test --test-name-pattern="School Registration" test/school-admin.test.js
```

## Future Enhancements

1. **Stripe integration**: Full payment processing with webhooks
2. **Email delivery**: Integration with SendGrid/AWS SES for verification emails
3. **Advanced TTS**: Offline TTS model for Windows (SAPI5 with local model)
4. **Canvas integration**: Narration triggered by drawing events
5. **Parent accounts**: Family sharing and billing
6. **District management**: Multi-school organization support