const { RATE_LIMIT_MS } = require("./config");

// chatId -> timestamp of last upload attempt
const lastUpload = new Map();

/**
 * Returns true if the user is allowed to upload now.
 * Returns false + remaining ms if still in cooldown.
 */
function checkRateLimit(chatId) {
  const id = String(chatId);
  const now = Date.now();
  const last = lastUpload.get(id) || 0;
  const elapsed = now - last;

  if (elapsed < RATE_LIMIT_MS) {
    return { allowed: false, remainingMs: RATE_LIMIT_MS - elapsed };
  }

  lastUpload.set(id, now);
  return { allowed: true, remainingMs: 0 };
}

function resetRateLimit(chatId) {
  lastUpload.delete(String(chatId));
}

module.exports = { checkRateLimit, resetRateLimit };
