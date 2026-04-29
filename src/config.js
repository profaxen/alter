module.exports = {
  TELEGRAM_MSG_LIMIT: 4096,
  MAX_RESUME_TEXT_LEN: 6000,
  MAX_JD_LEN: 3000,
  MIN_RESUME_CHARS: 150,
  MIN_RESUME_WORDS: 30,
  MIN_JD_CHARS: 100,
  MIN_JD_WORDS: 20,
  MAX_FILE_BYTES: 5 * 1024 * 1024,          // 5 MB
  GROQ_MODEL: "llama-3.3-70b-versatile",
  GROQ_MAX_TOKENS: 2048,
  GROQ_URL: "https://api.groq.com/openai/v1/chat/completions",
  GROQ_TIMEOUT: 60000,
  GROQ_RETRY_MAX: 3,
  GROQ_RETRY_BASE_DELAY: 2000,
  OCR_CONFIDENCE_MIN: 50,
  RESUME_SCORE_PASS: 70,
  RESUME_SCORE_WARN: 40,
  SESSION_TTL_MS: 30 * 60 * 1000,           // 30 minutes
  RATE_LIMIT_MS: 2000,                 // 2 seconds between uploads
  SESSION_FILE: "./data/sessions.json",
  ALLOWED_EXTENSIONS: [".pdf", ".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"],
  IMAGE_EXTENSIONS: [".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"],
};
