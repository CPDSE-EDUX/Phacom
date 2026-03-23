// === Phacom – Pharma Code Companion ===

const $ = (sel) => document.querySelector(sel);

// --- State ---
let provider = null;   // "gemini" | "mistral"
let apiKey = null;
let history = [];       // { role: "user"|"assistant", content: string }
let conventions = "";   // fetched coding conventions text
let isStreaming = false;
let attachedFile = null; // { name: string, content: string } | null

// --- DOM refs ---
const setupPanel    = $("#setup-panel");
const chatPanel     = $("#chat-panel");
const providerSel   = $("#provider-select");
const keyInput      = $("#api-key-input");
const connectBtn    = $("#connect-btn");
const setupError    = $("#setup-error");
const chatMessages  = $("#chat-messages");
const chatInput     = $("#chat-input");
const sendBtn       = $("#send-btn");
const providerBadge = $("#provider-badge");
const disconnectBtn = $("#disconnect-btn");
const fileInput     = $("#file-input");
const attachBtn     = $("#attach-btn");
const filePreview   = $("#file-preview");
const fileName      = $("#file-name");
const fileRemove    = $("#file-remove");

// --- System Prompt ---
function buildSystemPrompt() {
    let prompt = `You are Phacom, a friendly Pharma Code Companion designed to help pharmacy and pharmaceutical science students learn to code in Python and R.

## Your Teaching Approach
- You are a patient, encouraging coding tutor for beginners.
- NEVER provide complete solutions or full working code directly.
- Instead: explain concepts, give hints, ask guiding questions, and help students figure things out on their own.
- When a student shares an error: explain what the error message means in plain language, hint at the likely cause, and suggest what to investigate — but do NOT just fix it for them.
- When a student asks "how do I do X?": break it down into small steps, explain the first step, and let them try before revealing more.
- Use simple, jargon-free language. When you must use technical terms, briefly define them.
- Celebrate small wins and encourage progress.
- If a student is stuck after multiple hints, you may provide a small code snippet (a few lines at most) as a stepping stone, but never the full solution.

## Scope
- Focus on Python and R programming.
- You can also help with basic data analysis, plotting, file handling, and scripting concepts common in pharma/health sciences.
- If asked about topics outside coding (e.g., medical advice), politely redirect to coding topics.

## Formatting
- Use markdown for formatting: code blocks with language tags, bold for emphasis, bullet lists for steps.
- Keep responses concise and focused. Prefer short paragraphs.`;

    if (conventions) {
        prompt += `\n\n## Coding Conventions Reference
The following coding conventions should guide your advice. When relevant, reference these conventions in your responses:

${conventions}`;
    }

    return prompt;
}

// --- Convention Fetching ---
async function fetchConventions() {
    const url = "https://raw.githubusercontent.com/CPDSE-EDUX/R_documentation/main/R_coding_conventions.html";
    try {
        const resp = await fetch(url);
        if (!resp.ok) return;
        const html = await resp.text();
        // Parse HTML and extract text content
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        // Remove script and style elements
        doc.querySelectorAll("script, style").forEach(el => el.remove());
        conventions = doc.body.textContent.replace(/\s{2,}/g, " ").trim();
        // Limit to reasonable length for system prompt (keep first ~4000 chars)
        if (conventions.length > 4000) {
            conventions = conventions.slice(0, 4000) + "\n[...truncated]";
        }
    } catch (e) {
        console.warn("Could not fetch coding conventions:", e);
    }
}

// --- API Calls ---
async function callGemini(messages) {
    const systemPrompt = buildSystemPrompt();
    const contents = messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));

    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents
            })
        }
    );

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error?.message || `Gemini API error (${resp.status})`);
    }

    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't generate a response. Please try again.";
}

async function callMistral(messages) {
    const systemPrompt = buildSystemPrompt();
    const apiMessages = [
        { role: "system", content: systemPrompt },
        ...messages
    ];

    const resp = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: "mistral-small-latest",
            messages: apiMessages
        })
    });

    if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.message || `Mistral API error (${resp.status})`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || "I couldn't generate a response. Please try again.";
}

async function callLLM(messages) {
    if (provider === "gemini") return callGemini(messages);
    return callMistral(messages);
}

// --- Key Validation ---
async function validateKey(prov, key) {
    const testMsg = [{ role: "user", content: "Say hi in one word." }];
    // Temporarily set globals for the call
    const prevProv = provider, prevKey = apiKey;
    provider = prov;
    apiKey = key;
    try {
        await callLLM(testMsg);
        return true;
    } catch {
        provider = prevProv;
        apiKey = prevKey;
        return false;
    }
}

// --- Markdown Rendering ---
function renderMarkdown(text) {
    // Escape HTML
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Code blocks: ```lang\n...\n``` — wrapped with copy button
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `\n<div class="code-block-wrapper"><button class="copy-btn" onclick="copyCode(this)">Copy</button><pre><code class="language-${lang}">${code.trim()}</code></pre></div>\n`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Headings (must come before bold/italic to avoid conflicts)
    html = html.replace(/^#### (.+)$/gm, "<h4>$1</h4>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Unordered lists (lines starting with - or *)
    html = html.replace(/^[\-\*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

    // Ordered lists
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

    // Split into blocks by double newlines, wrap non-block content in <p>
    const blocks = html.split(/\n{2,}/);
    html = blocks.map(block => {
        const trimmed = block.trim();
        if (!trimmed) return "";
        // Don't wrap block-level elements in <p>
        if (/^<(pre|ul|ol|h[1-4]|li|blockquote)/.test(trimmed)) return trimmed;
        return `<p>${trimmed}</p>`;
    }).join("\n");

    // Single newlines → <br> (but not inside pre or headings)
    const parts = html.split(/(<pre[\s\S]*?<\/pre>)/g);
    for (let i = 0; i < parts.length; i++) {
        if (!parts[i].startsWith("<pre")) {
            parts[i] = parts[i].replace(/(?<!\>)\n(?!\<)/g, "<br>");
        }
    }
    html = parts.join("");

    return html;
}

// --- Copy code block ---
function copyCode(btn) {
    const code = btn.nextElementSibling.querySelector("code");
    navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => {
            btn.textContent = "Copy";
            btn.classList.remove("copied");
        }, 1500);
    });
}

// --- UI Helpers ---
function addMessage(role, content) {
    const div = document.createElement("div");
    div.className = `message ${role === "assistant" ? "bot" : "user"}`;

    if (role === "assistant") {
        div.innerHTML = `<div class="sender"><img src="assets/Phacom.png" alt="" class="bot-avatar">Phacom</div>${renderMarkdown(content)}`;
    } else {
        div.textContent = content;
    }

    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
}

// --- Typewriter effect for bot messages ---
function addMessageAnimated(content) {
    return new Promise((resolve) => {
        const div = document.createElement("div");
        div.className = "message bot";
        div.innerHTML = '<div class="sender"><img src="assets/Phacom.png" alt="" class="bot-avatar">Phacom</div><div class="msg-body"></div>';
        chatMessages.appendChild(div);

        const body = div.querySelector(".msg-body");

        // Split content into words, preserving whitespace/newlines
        const tokens = content.match(/\S+|\s+/g) || [content];
        let idx = 0;
        let accumulated = "";
        const speed = 18; // ms per token
        const tokensPerTick = 2;

        function tick() {
            for (let t = 0; t < tokensPerTick; t++) {
                if (idx >= tokens.length) {
                    // Final render to ensure complete markdown
                    body.innerHTML = renderMarkdown(content);
                    chatMessages.scrollTop = chatMessages.scrollHeight;
                    resolve();
                    return;
                }
                accumulated += tokens[idx];
                idx++;
            }
            body.innerHTML = renderMarkdown(accumulated);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            setTimeout(tick, speed);
        }

        tick();
    });
}

function showTyping() {
    const div = document.createElement("div");
    div.className = "message bot";
    div.id = "typing";
    div.innerHTML = `<div class="sender"><img src="assets/Phacom.png" alt="" class="bot-avatar">Phacom</div><div class="typing-indicator"><span></span><span></span><span></span></div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideTyping() {
    const el = $("#typing");
    if (el) el.remove();
}

function showIntro() {
    addMessage("assistant",
        "Hi! I'm **Phacom**, your **Pharma Code Companion**. I'm here to support you on your coding journey in Python and R.\n\n" +
        "I won't give you instant answers — instead, I'll help you understand concepts, debug errors, and build your skills step by step.\n\n" +
        "What would you like to work on today?"
    );
}

// --- Auto-resize textarea ---
chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
});

// --- Connect ---
connectBtn.addEventListener("click", async () => {
    const prov = providerSel.value;
    const key = keyInput.value.trim();

    if (!key) {
        setupError.textContent = "Please enter an API key.";
        setupError.hidden = false;
        return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting…";
    setupError.hidden = true;

    // Fetch conventions in parallel with key validation
    const [valid] = await Promise.all([
        validateKey(prov, key),
        fetchConventions()
    ]);

    if (!valid) {
        setupError.textContent = "Could not connect. Please check your API key and try again.";
        setupError.hidden = false;
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect";
        return;
    }

    // Success
    provider = prov;
    apiKey = key;
    history = [];

    providerBadge.textContent = prov === "gemini" ? "Google Gemini" : "Mistral AI";
    setupPanel.hidden = true;
    chatPanel.hidden = false;

    showIntro();
    chatInput.focus();
});

// --- Disconnect ---
disconnectBtn.addEventListener("click", () => {
    provider = null;
    apiKey = null;
    history = [];
    conventions = "";
    chatMessages.innerHTML = "";
    chatPanel.hidden = true;
    setupPanel.hidden = false;
    keyInput.value = "";
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
});

// --- Send Message ---
async function sendMessage() {
    const text = chatInput.value.trim();
    if (!text || isStreaming) return;

    // Build the display and LLM message
    let displayText = text;
    let llmContent = text;

    if (attachedFile) {
        displayText = `📎 ${attachedFile.name}\n\n${text}`;
        llmContent = `[The student uploaded a file named "${attachedFile.name}". Here is its content:]\n\`\`\`\n${attachedFile.content}\n\`\`\`\n\n${text}`;
        // Clear the attachment
        attachedFile = null;
        fileInput.value = "";
        filePreview.hidden = true;
    }

    addMessage("user", displayText);
    history.push({ role: "user", content: llmContent });
    chatInput.value = "";
    chatInput.style.height = "auto";

    isStreaming = true;
    sendBtn.disabled = true;
    showTyping();

    try {
        const reply = await callLLM(history);
        hideTyping();
        await addMessageAnimated(reply);
        history.push({ role: "assistant", content: reply });
    } catch (err) {
        hideTyping();
        addMessage("assistant", `Sorry, something went wrong: ${err.message}\n\nPlease try again.`);
    }

    isStreaming = false;
    sendBtn.disabled = false;
    chatInput.focus();
}

sendBtn.addEventListener("click", sendMessage);

chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// --- Allow Enter on API key input to connect ---
keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") connectBtn.click();
});

// --- File Upload ---
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (!file) return;

    // 500 KB limit for text files
    if (file.size > 500 * 1024) {
        alert("File is too large. Please upload files under 500 KB.");
        fileInput.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        attachedFile = { name: file.name, content: reader.result };
        fileName.textContent = file.name;
        filePreview.hidden = false;
    };
    reader.readAsText(file);
});

fileRemove.addEventListener("click", () => {
    attachedFile = null;
    fileInput.value = "";
    filePreview.hidden = true;
});
