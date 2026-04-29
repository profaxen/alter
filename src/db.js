const admin = require("firebase-admin");
const logger = require("./logger");
const { v4: uuidv4 } = require("uuid");

let db;

async function initDB() {
  try {
    if (!admin.apps.length) {
      if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // Production: Use Service Account JSON from env
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          projectId: serviceAccount.project_id
        });
      } else {
        // Development: Fallback to Project ID (Requires local gcloud auth)
        admin.initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID || "laborconnect-95921"
        });
      }
    }
    db = admin.firestore();
    logger.info("✅ Firestore initialized successfully.");
  } catch (error) {
    logger.error("❌ Firestore initialization failed:", { 
      message: error.message,
      stack: error.stack 
    });
    db = null;
  }
}

// ─── User & Session Management ─────────────────────────────────────────────

async function upsertUser(chatId, username, firstName) {
  if (!db) throw new Error("Firestore not initialized");
  const userRef = db.collection("users").doc(String(chatId));
  await userRef.set({
    username: username || null,
    first_name: firstName || null,
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function getSession(chatId) {
  if (!db) return null;
  const sessionRef = db.collection("sessions").doc(String(chatId));
  const doc = await sessionRef.get();
  return doc.exists ? doc.data() : null;
}

async function createSession(sessionId, chatId) {
  if (!db) throw new Error("Firestore not initialized");
  const sessionRef = db.collection("sessions").doc(String(chatId));
  await sessionRef.set({
    id: sessionId,
    user_id: chatId,
    current_state: "IDLE",
    last_active: admin.firestore.FieldValue.serverTimestamp(),
    processing: false
  });
}

async function updateSessionState(chatId, state, additional = {}) {
  if (!db) throw new Error("Firestore not initialized");
  const sessionRef = db.collection("sessions").doc(String(chatId));
  const updateData = {
    current_state: state,
    last_active: admin.firestore.FieldValue.serverTimestamp()
  };

  if (additional.processing !== undefined) updateData.processing = additional.processing;
  if (additional.selected_template !== undefined) updateData.selected_template = additional.selected_template;

  await sessionRef.update(updateData);
}

// ─── Messaging ──────────────────────────────────────────────────────────────

async function addMessage(sessionId, role, content) {
  if (!db) throw new Error("Firestore not initialized");
  await db.collection("messages").add({
    session_id: sessionId,
    role: role,
    content: content,
    created_at: admin.firestore.FieldValue.serverTimestamp()
  });
}

async function getChatHistory(sessionId, limit = 10) {
  if (!db) return [];
  const snapshot = await db.collection("messages")
    .where("session_id", "==", sessionId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .get();
  
  const messages = [];
  snapshot.forEach(doc => messages.push(doc.data()));
  return messages.reverse();
}

async function clearChatHistory(sessionId) {
  if (!db) throw new Error("Firestore not initialized");
  const batch = db.batch();
  const snapshot = await db.collection("messages")
    .where("session_id", "==", sessionId)
    .get();
  
  snapshot.forEach(doc => {
    batch.delete(doc.ref);
  });
  await batch.commit();
}

// ─── Profile Management ─────────────────────────────────────────────────────

async function getProfile(chatId) {
  if (!db) return null;
  const profileRef = db.collection("resume_profiles").doc(String(chatId));
  const doc = await profileRef.get();
  return doc.exists ? doc.data() : null;
}

async function upsertProfile(profileId, chatId, data) {
  if (!db) throw new Error("Firestore not initialized");
  const profileRef = db.collection("resume_profiles").doc(String(chatId));
  
  const updateData = {
    user_id: chatId,
    updated_at: admin.firestore.FieldValue.serverTimestamp()
  };

  // Map fields and ensure they are not undefined for Firestore
  const fields = ['target_jd', 'full_name', 'email', 'phone', 'location', 'summary', 
                  'skills', 'experience', 'education', 'projects', 'certifications', 'languages', 'links'];

  fields.forEach(field => {
    if (data[field] !== undefined) {
      updateData[field] = data[field];
    }
  });

  await profileRef.set(updateData, { merge: true });
}

async function clearProfile(chatId) {
  if (!db) throw new Error("Firestore not initialized");
  await db.collection("resume_profiles").doc(String(chatId)).delete();
}

// ─── Generation Limits & Tracking ──────────────────────────────────────────

async function checkGenerationLimit(userId, limit = 6) {
  if (!db) throw new Error("Firestore not initialized");
  
  const oneDayAgo = new Date();
  oneDayAgo.setDate(oneDayAgo.getDate() - 1);

  const snapshot = await db.collection("generated_files")
    .where("user_id", "==", userId)
    .where("created_at", ">", oneDayAgo)
    .get();
  
  const count = snapshot.size;
  return {
    allowed: count < limit,
    count,
    remaining: Math.max(0, limit - count)
  };
}

async function recordGeneration(userId, filePath, templateName) {
  if (!db) throw new Error("Firestore not initialized");
  await db.collection("generated_files").add({
    user_id: userId,
    file_path: filePath,
    template_name: templateName,
    created_at: admin.firestore.FieldValue.serverTimestamp()
  });
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