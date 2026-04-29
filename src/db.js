const mysql = require("mysql2/promise");
const logger = require("./logger");

let pool;

async function initDB() {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_NAME || "resume_bot",
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    // Create database if it doesn't exist
    const tempPool = mysql.createPool({
      host: process.env.DB_HOST || "localhost",
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || "root",
      password: process.env.DB_PASSWORD || "",
    });
    await tempPool.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME || "resume_bot"}\`;`);
    await tempPool.end();

    // Initialize Schema
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR(36) PRIMARY KEY,
        user_id BIGINT NOT NULL,
        current_state VARCHAR(50) DEFAULT 'IDLE',
        selected_template VARCHAR(50) DEFAULT NULL,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        processing BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        session_id VARCHAR(36) NOT NULL,
        role ENUM('user', 'assistant', 'system') NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS resume_profiles (
        id VARCHAR(36) PRIMARY KEY,
        user_id BIGINT NOT NULL,
        target_jd TEXT,
        full_name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(50),
        location VARCHAR(255),
        links JSON,
        summary TEXT,
        skills JSON,
        experience JSON,
        education JSON,
        projects JSON,
        certifications JSON,
        languages JSON,
        is_complete BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Handle existing tables by adding missing columns
    const [columns] = await pool.query("SHOW COLUMNS FROM resume_profiles");
    const columnNames = columns.map(c => c.Field);
    const newColumns = {
      location: "VARCHAR(255)",
      links: "JSON",
      projects: "JSON",
      certifications: "JSON",
      languages: "JSON"
    };

    for (const [col, type] of Object.entries(newColumns)) {
      if (!columnNames.includes(col)) {
        await pool.query(`ALTER TABLE resume_profiles ADD COLUMN ${col} ${type}`);
        logger.info(`Added missing column ${col} to resume_profiles`);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS generated_files (
        id VARCHAR(36) PRIMARY KEY,
        user_id BIGINT NOT NULL,
        file_path VARCHAR(255) NOT NULL,
        template_name VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
    `);

    // Ensure generated_files has the user_id column and indices
    try {
      await pool.query(`CREATE INDEX idx_user_created ON generated_files(user_id, created_at);`);
    } catch (e) {
      // Index likely already exists
    }

    logger.info("✅ Database initialized successfully.");
  } catch (error) {
    logger.error("❌ Database initialization failed. Check your MySQL connection:", { 
      message: error.message,
      code: error.code,
      stack: error.stack 
    });
    pool = null; // Ensure pool is null if init fails
  }
}

// ─── User & Session Management ─────────────────────────────────────────────

async function upsertUser(chatId, username, firstName) {
  if (!pool) throw new Error("Database not initialized. Check connection.");
  await pool.query(
    `INSERT INTO users (id, username, first_name) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE username = VALUES(username), first_name = VALUES(first_name)`,
    [chatId, username || null, firstName || null]
  );
}

async function getSession(chatId) {
  if (!pool) return null;
  const [rows] = await pool.query(`SELECT * FROM sessions WHERE user_id = ?`, [chatId]);
  return rows[0] || null;
}

async function createSession(sessionId, chatId) {
  if (!pool) throw new Error("Database not initialized");
  await pool.query(
    `INSERT INTO sessions (id, user_id, current_state) VALUES (?, ?, 'IDLE')
     ON DUPLICATE KEY UPDATE current_state = 'IDLE', last_active = CURRENT_TIMESTAMP`,
    [sessionId, chatId]
  );
}

async function updateSessionState(chatId, state, additional = {}) {
  if (!pool) throw new Error("Database not initialized");
  const updates = ["current_state = ?"];
  const params = [state];

  if (additional.processing !== undefined) {
    updates.push("processing = ?");
    params.push(additional.processing);
  }
  if (additional.selected_template !== undefined) {
    updates.push("selected_template = ?");
    params.push(additional.selected_template);
  }

  params.push(chatId);
  await pool.query(
    `UPDATE sessions SET ${updates.join(", ")} WHERE user_id = ?`,
    params
  );
}

// ─── Messaging ──────────────────────────────────────────────────────────────

async function addMessage(sessionId, role, content) {
  if (!pool) throw new Error("Database not initialized");
  await pool.query(
    `INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)`,
    [sessionId, role, content]
  );
}

async function getChatHistory(sessionId, limit = 10) {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
    [sessionId, limit]
  );
  return rows.reverse();
}

async function clearChatHistory(sessionId) {
  if (!pool) throw new Error("Database not initialized");
  await pool.query(`DELETE FROM messages WHERE session_id = ?`, [sessionId]);
}

// ─── Profile Management ─────────────────────────────────────────────────────

async function getProfile(chatId) {
  if (!pool) return null;
  const [rows] = await pool.query(`SELECT * FROM resume_profiles WHERE user_id = ?`, [chatId]);
  return rows[0] || null;
}

async function upsertProfile(profileId, chatId, data) {
  if (!pool) throw new Error("Database not initialized");
  
  const updates = [];
  const params = [];

  const fields = ['target_jd', 'full_name', 'email', 'phone', 'location', 'summary'];
  const jsonFields = ['skills', 'experience', 'education', 'projects', 'certifications', 'languages', 'links'];

  for (const field of fields) {
    if (data[field] !== undefined) {
      updates.push(`${field} = ?`);
      params.push(data[field]);
    }
  }

  for (const field of jsonFields) {
    if (data[field] !== undefined) {
      updates.push(`${field} = ?`);
      params.push(JSON.stringify(data[field]));
    }
  }

  if (updates.length === 0) {
    await pool.query(
      `INSERT IGNORE INTO resume_profiles (id, user_id) VALUES (?, ?)`,
      [profileId, chatId]
    );
    return;
  }

  const activeFields = fields.concat(jsonFields).filter(f => data[f] !== undefined);
  const query = `
    INSERT INTO resume_profiles (id, user_id, ${activeFields.join(", ")})
    VALUES (?, ?, ${activeFields.map(() => "?").join(", ")})
    ON DUPLICATE KEY UPDATE ${updates.join(", ")}
  `;

  const values = [profileId, chatId];
  for (const field of fields) if (data[field] !== undefined) values.push(data[field]);
  for (const field of jsonFields) if (data[field] !== undefined) values.push(JSON.stringify(data[field]));

  // For ON DUPLICATE KEY UPDATE, we need the update values as well
  const updateValues = [];
  for (const field of fields) if (data[field] !== undefined) updateValues.push(data[field]);
  for (const field of jsonFields) if (data[field] !== undefined) updateValues.push(JSON.stringify(data[field]));

  await pool.query(query, [...values, ...updateValues]);
}

async function clearProfile(chatId) {
  if (!pool) throw new Error("Database not initialized");
  await pool.query(`DELETE FROM resume_profiles WHERE user_id = ?`, [chatId]);
}

// ─── Generation Limits & Tracking ──────────────────────────────────────────

async function checkGenerationLimit(userId, limit = 6) {
  if (!pool) throw new Error("Database not initialized");
  
  // Count PDFs generated in the last 24 hours
  const [rows] = await pool.query(
    `SELECT COUNT(*) as count FROM generated_files 
     WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 DAY)`,
    [userId]
  );
  
  const count = rows[0]?.count || 0;
  return {
    allowed: count < limit,
    count,
    remaining: Math.max(0, limit - count)
  };
}

async function recordGeneration(userId, filePath, templateName) {
  if (!pool) throw new Error("Database not initialized");
  const { v4: uuidv4 } = require("uuid");
  await pool.query(
    `INSERT INTO generated_files (id, user_id, file_path, template_name) VALUES (?, ?, ?, ?)`,
    [uuidv4(), userId, filePath, templateName]
  );
}

module.exports = {
  initDB,
  upsertUser,
  getSession,
  createSession,
  updateSessionState,
  addMessage,
  getChatHistory,
  clearChatHistory,
  getProfile,
  upsertProfile,
  clearProfile,
  checkGenerationLimit,
  recordGeneration
};
