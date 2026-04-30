const { v4: uuidv4 } = require("uuid");
const db = require("./db");
const ai = require("./ai");
const logger = require("./logger");

async function handleMessage(chatId, username, firstName, text, bot) {
  // 1. Ensure User & Session exist
  await db.upsertUser(chatId, username, firstName);
  let session = await db.getSession(chatId);
  
  if (!session) {
    const sessionId = uuidv4();
    await db.createSession(sessionId, chatId);
    session = await db.getSession(chatId);
  }

  const sessionId = session.id;

  // Concurrency check
  if (session.processing) {
    await bot.sendMessage(chatId, "⏳ Still thinking about your last message. Please wait a moment.");
    return;
  }

  await db.updateSessionState(chatId, session.current_state, { processing: true });

  try {
    // 2. Command overrides
    if (text === "/start") {
      session.current_state = "GREETING";
      await db.updateSessionState(chatId, session.current_state);
      
      const p = await db.getProfile(chatId);
      const hasData = p && (p.full_name || p.summary || p.skills || p.experience);
      
      let greeting = "✨ *Welcome to ResumePro AI* ✨\n\nI'm your premium career coach and resume expert. I'll help you build an industry-level, ATS-optimized resume through a natural conversation.";
      
      if (hasData) {
        greeting += `\n\nWelcome back, *${p.full_name || firstName}*! I still have your details saved. Would you like to continue refining your resume or start fresh?`;
      } else {
        greeting += "\n\nTo get started, you can:\n1️⃣ Send me your *full name*\n2️⃣ Paste your *current resume text*\n3️⃣ Upload your *old resume (PDF/Image)*";
      }

      const buttons = [
        [{ text: "🚀 Start Building", callback_data: "action_start" }],
        [{ text: "📄 Improve Existing Resume", callback_data: "action_improve" }],
        [{ text: "❓ Help & Commands", callback_data: "action_help" }]
      ];

      await bot.sendMessage(chatId, greeting, { 
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: buttons }
      });
      
      if (!p) {
        await db.upsertProfile(uuidv4(), chatId, {});
      }
      
      await db.addMessage(sessionId, "assistant", greeting);
      return;
    }

    if (text === "/help") {
      const helpMsg = "🛠 *ResumePro AI Help*\n\n" +
        "• *Chat naturally*: Just tell me about your work, skills, or education.\n" +
        "• *Upload files*: Send me your old resume (PDF/JPG) and I'll extract the facts.\n" +
        "• *Commands*:\n" +
        "  /start - Restart or begin\n" +
        "  /profile - View collected data\n" +
        "  /generate - Create your final PDF\n" +
        "  /reset - Clear all data\n\n" +
        "I'll automatically upgrade your casual notes into professional, recruiter-ready language.";
      await bot.sendMessage(chatId, helpMsg, { parse_mode: "Markdown" });
      return;
    }

    if (text === "/reset") {
      session.current_state = "GREETING";
      await db.updateSessionState(chatId, session.current_state);
      await db.clearChatHistory(sessionId);
      await db.clearProfile(chatId);
      await db.upsertProfile(uuidv4(), chatId, {});
      
      const greeting = "🔄 *Profile Reset.* I've cleared your history. Let's start building your new premium resume! What's your target role?";
      await bot.sendMessage(chatId, greeting, { parse_mode: "Markdown" });
      await db.addMessage(sessionId, "assistant", greeting);
      return;
    }

    if (text === "/profile") {
      const p = await db.getProfile(chatId);
      if (!p || (!p.full_name && !p.summary)) {
        await bot.sendMessage(chatId, "📭 Your profile is currently empty. Start by sharing your name or experience!");
        return;
      }
      
      const sections = [];
      if (p.full_name) sections.push(`👤 *Name:* ${p.full_name}`);
      if (p.summary) sections.push(`📝 *Summary:* ${p.summary.substring(0, 100)}...`);
      if (p.skills && p.skills.length) sections.push(`🛠 *Skills:* ${p.skills.join(", ")}`);
      if (p.experience && p.experience.length) sections.push(`💼 *Experience:* ${p.experience.length} roles added`);
      if (p.projects && p.projects.length) sections.push(`🚀 *Projects:* ${p.projects.length} projects added`);

      const msg = `📋 *Your Current Profile:*\n\n${sections.join("\n")}\n\nSay *'generate'* when you're ready for the final PDF!`;
      await bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
      return;
    }

    // 3. Save User Message
    await db.addMessage(sessionId, "user", text);

    // 4. Intent & Profile fetching
    const profile = (await db.getProfile(chatId)) || {};
    const chatHistory = await db.getChatHistory(sessionId, 6);
    const chatHistoryText = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n");

    const intent = await ai.analyzeIntent(text);
    logger.info(`User intent analyzed`, { chatId, intent });

    if (intent === "REQUEST_GENERATE" || text.toLowerCase().includes("generate")) {
      if (!profile || (!profile.full_name && !profile.experience && !profile.summary)) {
        const errMsg = "⚠️ Your profile is currently empty! Please tell me your name, experience, or upload your old resume text before generating.";
        await bot.sendMessage(chatId, errMsg);
        return;
      }
      
      session.current_state = "WAITING_TEMPLATE";
      await db.updateSessionState(chatId, session.current_state);
      await bot.sendMessage(chatId, "📄 *Choose a resume template to generate your PDF:*", {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "📋 Professional", callback_data: "template_professional" },
              { text: "🎨 Modern",       callback_data: "template_modern" },
            ],
            [
              { text: "⚡ ATS-Friendly (Minimal)", callback_data: "template_minimal" }
            ]
          ],
        },
      });
      return;
    }

    // 5. Data Extraction
    if (["PROVIDE_INFO", "EDIT_FIELD", "UNKNOWN"].includes(intent)) {
      const extracted = await ai.extractProfileData(text, profile, chatHistoryText);
      if (extracted && Object.keys(extracted).length > 0) {
        // Merge extracted data safely. For arrays, we should probably append if it's experience/education
        // But for simplicity, we'll let UPSERT overwrite or let the AI send the merged version.
        // Actually, AI is instructed to return the updated fields. 
        // For array fields, we assume AI merges them in the JSON based on the prompt's context.
        if (!profile.id) profile.id = uuidv4();
        await db.upsertProfile(profile.id, chatId, extracted);
      }
    }

    // 6. Generate Conversational Response
    const updatedProfile = await db.getProfile(chatId) || {};
    // Check completeness
    const isComplete = updatedProfile.full_name && updatedProfile.summary && updatedProfile.skills && updatedProfile.experience;
    
    const responseText = await ai.generateChatResponse(updatedProfile, chatHistoryText, isComplete);
    await bot.sendMessage(chatId, responseText);
    await db.addMessage(sessionId, "assistant", responseText);

  } catch (error) {
    logger.error("Error in state machine", { error: error.message, stack: error.stack });
    
    // Professional generic error for users
    let userFriendlyError = "❌ *Service Temporarily Unavailable*\n\nI'm having a bit of trouble processing that. Please try again in a moment. If the issue persists, feel free to use /reset to start fresh.";
    
    // Show technical details ONLY to the admin
    const isAdmin = String(chatId) === String(process.env.ADMIN_ID);
    
    if (isAdmin) {
      if (error.message.includes("index")) {
        userFriendlyError = "⚙️ *Admin Debug: Firestore Index Missing*\n\nPlease check Firebase console to create the required composite index.";
      } else if (error.message.includes("401") || error.message.includes("api_key")) {
        userFriendlyError = "🔑 *Admin Debug: AI API Key Error*\n\nCheck your `GROQ_API_KEY` in environment variables.";
      } else {
        userFriendlyError = `🛠 *Admin Debug: Error*\n\n\`${error.message}\``;
      }
    }

    await bot.sendMessage(chatId, userFriendlyError, { parse_mode: "Markdown" });
  } finally {
    // Release concurrency lock
    await db.updateSessionState(chatId, session.current_state, { processing: false });
  }
}

module.exports = { handleMessage };
