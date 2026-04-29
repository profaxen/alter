const logger = require("./logger");
const {
  MAX_FILE_BYTES,
  MIN_RESUME_CHARS,
  MIN_RESUME_WORDS,
  MIN_JD_CHARS,
  MIN_JD_WORDS,
  ALLOWED_EXTENSIONS,
  IMAGE_EXTENSIONS,
  RESUME_SCORE_PASS,
  RESUME_SCORE_WARN,
} = require("./config");

// ─── Magic bytes → MIME ────────────────────────────────────────────────────
function detectMime(buffer) {
  if (!buffer || buffer.length < 8) return "application/octet-stream";
  const h = buffer.slice(0, 12).toString("hex");
  if (h.startsWith("25504446")) return "application/pdf";
  if (h.startsWith("ffd8ff"))   return "image/jpeg";
  if (h.startsWith("89504e47")) return "image/png";
  if (h.startsWith("47494638")) return "image/gif";
  if (h.startsWith("52494646") && buffer.slice(8, 12).toString("ascii") === "WEBP")
    return "image/webp";
  if (h.startsWith("49492a00") || h.startsWith("4d4d002a")) return "image/tiff";
  if (h.startsWith("424d"))     return "image/bmp";
  return "application/octet-stream";
}

const EXT_MIME = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".bmp": "image/bmp",
  ".tiff": "image/tiff", ".webp": "image/webp",
};

// ─── File validation ────────────────────────────────────────────────────────
function validateFile(buffer, filename, fileSize) {
  const errors = [];

  if (fileSize > MAX_FILE_BYTES) {
    errors.push(`File is too large (${(fileSize / 1024 / 1024).toFixed(1)} MB). Max allowed: 5 MB.`);
    return { valid: false, errors };
  }

  if (!buffer || buffer.length === 0) {
    errors.push("File appears to be empty or corrupt.");
    return { valid: false, errors };
  }

  const ext = require("path").extname(filename || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    errors.push(`Unsupported file type: *${ext || "unknown"}*. Send a PDF or image (JPG, PNG, WEBP, TIFF, BMP).`);
    return { valid: false, errors };
  }

  // Real MIME vs declared extension
  const realMime = detectMime(buffer);
  const expectedMime = EXT_MIME[ext];
  if (expectedMime && realMime !== "application/octet-stream" && realMime !== expectedMime) {
    errors.push(`File content doesn't match its extension (expected ${ext}, got ${realMime}). Please send the correct file.`);
    return { valid: false, errors };
  }

  // Encrypted PDF detection
  if (ext === ".pdf") {
    const header = buffer.slice(0, Math.min(2048, buffer.length)).toString("binary");
    if (header.includes("/Encrypt")) {
      errors.push("This PDF is password-protected. Please remove the password and re-upload.");
      return { valid: false, errors };
    }
  }

  return { valid: true, errors: [], realMime };
}

// ─── Resume quality scorer ─────────────────────────────────────────────────
function scoreResume(text) {
  let score = 0;
  const issues = [];

  if (text.length >= MIN_RESUME_CHARS) score += 20;
  else issues.push("Text is too short");

  const wordCount = text.split(/\s+/).filter((w) => w.length > 1).length;
  if (wordCount >= MIN_RESUME_WORDS) score += 15;
  else issues.push(`Only ${wordCount} words detected (min ${MIN_RESUME_WORDS})`);

  if (/^[A-Z][a-z]+\s+[A-Z][a-z]+/m.test(text)) score += 10;
  else issues.push("No name-like pattern detected");

  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) ||
      /[\+\d][\d\s\-\(\)]{9,}/.test(text)) score += 10;
  else issues.push("No email or phone number detected");

  if (/\b(19|20)\d{2}\b/.test(text)) score += 10;
  else issues.push("No year/date detected");

  const jobKeywords = [
    "experience", "education", "skill", "work", "project", "role",
    "position", "degree", "university", "college", "company", "team",
    "developed", "managed", "led", "built", "designed",
  ];
  const found = jobKeywords.filter((k) => text.toLowerCase().includes(k));
  if (found.length >= 3) score += 15;
  else if (found.length >= 1) score += 7;
  else issues.push("No job-related keywords found");

  const alphaLen = (text.match(/[a-zA-Z\s]/g) || []).length;
  const noiseRatio = 1 - alphaLen / text.length;
  if (noiseRatio < 0.4) score += 5;
  else issues.push("High symbol/noise ratio in extracted text");

  const sectionKeywords = [
    "summary", "experience", "education", "skills", "objective",
    "work history", "qualifications", "certifications",
  ];
  const foundSections = sectionKeywords.filter((s) => text.toLowerCase().includes(s));
  if (foundSections.length >= 2) score += 15;
  else if (foundSections.length >= 1) score += 7;
  else issues.push("No standard resume sections detected");

  let label = "reject";
  if (score >= RESUME_SCORE_PASS) label = "pass";
  else if (score >= RESUME_SCORE_WARN) label = "warn";

  logger.info("Resume quality score", { score, label, issueCount: issues.length });
  return { score, label, issues };
}

// ─── JD validation ─────────────────────────────────────────────────────────
function validateJD(text) {
  const errors = [];
  if (!text || text.trim().length < MIN_JD_CHARS) {
    errors.push(`Job description is too short (min ${MIN_JD_CHARS} characters). Please paste the full JD.`);
  }
  const wordCount = (text || "").split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_JD_WORDS) {
    errors.push(`Job description needs at least ${MIN_JD_WORDS} words (got ${wordCount}).`);
  }
  return { valid: errors.length === 0, errors };
}

// ─── Prompt injection sanitizer ────────────────────────────────────────────
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions?/gi,
  /you\s+are\s+now\s+a/gi,
  /forget\s+(everything|all)/gi,
  /system\s*:/gi,
  /\[INST\]/gi,
  /<<SYS>>/gi,
  /###\s*(system|instruction)/gi,
];

function sanitizeForPrompt(text) {
  let clean = text;
  for (const pattern of INJECTION_PATTERNS) {
    clean = clean.replace(pattern, "[REDACTED]");
  }
  return clean;
}

// ─── AI output validator ────────────────────────────────────────────────────
const REQUIRED_FIELDS = ["FULL_NAME:", "SUMMARY:", "SKILLS:", "EXPERIENCE:"];
const PLACEHOLDER_PATTERNS = [
  "[Candidate", "[Your", "[Insert", "[COMPANY_", "[ROLE_",
  "[DEGREE", "[Achievement", "[List ", "[3-4 ", "[Comma",
];

function validateAIOutput(raw) {
  for (const field of REQUIRED_FIELDS) {
    if (!raw.includes(field)) {
      return { valid: false, reason: `Missing required field: ${field}` };
    }
  }

  for (const p of PLACEHOLDER_PATTERNS) {
    if (raw.includes(p)) {
      return { valid: false, reason: `AI returned unfilled placeholder: "${p}..."` };
    }
  }

  const nameMatch = raw.match(/FULL_NAME:\s*(.+)/i);
  if (!nameMatch || nameMatch[1].trim().length < 2) {
    return { valid: false, reason: "Name field is empty or too short" };
  }

  const skillsBlock = raw.match(/SKILLS:\s*\n([\s\S]+?)(?:\n[A-Z_]+:|$)/);
  if (!skillsBlock || skillsBlock[1].split(",").length < 3) {
    return { valid: false, reason: "Skills section has fewer than 3 skills" };
  }

  return { valid: true };
}

module.exports = {
  validateFile,
  scoreResume,
  validateJD,
  sanitizeForPrompt,
  validateAIOutput,
  detectMime,
};
