const fs = require("fs");
const path = require("path");
const logger = require("./logger");
const { SESSION_TTL_MS, SESSION_FILE } = require("./config");

const dataDir = path.dirname(SESSION_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let store = {};

function persist() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    logger.error("Session persist failed", { error: e.message });
  }
}

function evictExpired() {
  const now = Date.now();
  let evicted = 0;
  for (const [id, s] of Object.entries(store)) {
    if (now - (s._lastActivity || 0) > SESSION_TTL_MS) {
      delete store[id];
      evicted++;
    }
  }
  if (evicted > 0) logger.info(`Evicted ${evicted} expired sessions`);
}

// Load on startup
try {
  if (fs.existsSync(SESSION_FILE)) {
    store = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    evictExpired();
    logger.info(`Loaded ${Object.keys(store).length} sessions from disk`);
  }
} catch (e) {
  logger.warn("Could not load sessions, starting fresh", { error: e.message });
  store = {};
}

// Evict expired sessions every 10 minutes
setInterval(() => { evictExpired(); persist(); }, 10 * 60 * 1000);

function getSession(chatId) {
  const id = String(chatId);
  const now = Date.now();
  if (!store[id] || now - (store[id]._lastActivity || 0) > SESSION_TTL_MS) {
    store[id] = { state: "IDLE", _lastActivity: now };
  } else {
    store[id]._lastActivity = now;
  }
  persist();
  return store[id];
}

function resetSession(chatId) {
  const id = String(chatId);
  store[id] = { state: "IDLE", _lastActivity: Date.now() };
  persist();
}

function updateSession(chatId, updates) {
  const id = String(chatId);
  const s = getSession(chatId);
  Object.assign(s, updates, { _lastActivity: Date.now() });
  persist();
  return s;
}

module.exports = { getSession, resetSession, updateSession };
