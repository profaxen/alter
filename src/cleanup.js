const fs = require("fs");
const path = require("path");
const os = require("os");
const logger = require("./logger");

const PREFIX = "resume_";
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function cleanupOldTempFiles() {
  try {
    const tmpDir = os.tmpdir();
    const now = Date.now();
    const files = fs.readdirSync(tmpDir);
    let removed = 0;

    for (const file of files) {
      if (!file.startsWith(PREFIX)) continue;
      const filePath = path.join(tmpDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch (_) {}
    }

    if (removed > 0) logger.info(`Cleaned up ${removed} stale temp files`);
  } catch (e) {
    logger.error("Temp cleanup error", { error: e.message });
  }
}

function startCleanupScheduler() {
  // Run immediately on startup
  cleanupOldTempFiles();
  // Then every hour
  setInterval(cleanupOldTempFiles, 60 * 60 * 1000);
  logger.info("Temp file cleanup scheduler started");
}

module.exports = { startCleanupScheduler, cleanupOldTempFiles };
