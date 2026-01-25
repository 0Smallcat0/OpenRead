const frameId = Math.random().toString(36).substring(7);


// ===========================================
// SELECTION-BASED TRANSLATION (Core)
// ===========================================

// Configuration
const ENABLE_LOGGING = false;

// State
let activeIcon = null;
let activePanel = null;
let lastSelectionRange = null;
let activePort = null; // [OIT] Track active connection for race condition handling

// ===========================================
// 1. Detection Logic
// ===========================================

document.addEventListener('mouseup', (event) => {


    // If clicking inside our own UI, ignore
    if (activePanel && activePanel.contains(event.target)) return;
    if (activeIcon && activeIcon.contains(event.target)) return;

    // Wait a tick for selection to settle
    setTimeout(() => {
        const selection = window.getSelection();
        const text = selection.toString().trim();

        // Debug Log
        if (text.length > 0) {

            const range = selection.getRangeAt(0);
            const rects = range.getClientRects();

        } else {

        }

        // Filter: Must be valid text, not too long (avoid accidental full page selects)
        if (text.length > 1 && text.length < 5000) {
            const range = selection.getRangeAt(0);
            lastSelectionRange = range;
            showTranslateIcon(range);
        } else {
            // Invalid/Empty Selection -> Clear Icon (but maybe keep panel if open?)
            // We usually clear icon on any click elsewhere.
            removeIcon();
        }
    }, 50); // Increased timeout slightly for PDF rendering lag
}, true);

// Close panel/icon on outside click
document.addEventListener('mousedown', (event) => {
    // If clicking outside panel, close it
    if (activePanel && !activePanel.contains(event.target)) {
        removePanel();
    }
    // If clicking outside icon, close it
    if (activeIcon && !activeIcon.contains(event.target)) {
        removeIcon();
    }
}, true);

// ===========================================
// 2. UI Components
// ===========================================

/**
 * Show Floating "Trans" Icon
 */
function showTranslateIcon(range) {
    removeIcon(); // Remove existing

    const rects = range.getClientRects();
    if (rects.length === 0) return;

    // Position at the end of the selection
    const lastRect = rects[rects.length - 1];

    const icon = document.createElement('div');
    icon.textContent = '文'; // Icon Character
    icon.id = 'oit-translate-icon';
    icon.style.cssText = `
        position: fixed; /* Must be fixed for PDF viewports */
        left: ${lastRect.right + 5}px;
        top: ${lastRect.top - 30}px;
        z-index: 2147483647; /* Max Safe Integer to beat PDF viewer layers */
        background: #3b82f6;
        color: white;
        width: 28px;
        height: 28px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: sans-serif;
        font-weight: bold;
        font-size: 16px;
        cursor: pointer;
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        transition: transform 0.1s;
        user-select: none;
    `;

    // Bounds check to keep on screen
    const top = lastRect.top - 30;
    if (top < 0) icon.style.top = (lastRect.bottom + 5) + 'px';

    // Hover animation
    icon.onmouseover = () => icon.style.transform = 'scale(1.1)';
    icon.onmouseout = () => icon.style.transform = 'scale(1)';

    // Click Handler
    icon.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = window.getSelection().toString().trim();
        removeIcon(); // Hide icon immediately
        if (text) {
            translateSelection(text, lastRect);
        }
    };

    document.body.appendChild(icon);
    activeIcon = icon;
}

function removeIcon() {
    if (activeIcon) {
        activeIcon.remove();
        activeIcon = null;
    }
}

function removePanel() {
    if (activePanel) {
        activePanel.remove();
        activePanel = null;
    }
}

/**
 * Extract Context (Before/After)
 */
/**
 * Extract Context (Before/After) - PDF Safe Mode
 */
function getContext(range) {
    try {
        if (!range) return null;

        let container = range.commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) {
            container = container.parentNode;
        }

        // Strict Semantic Check (Web Mode)
        // PDF viewers often use raw divs or spans with absolute positioning.
        // We only want context if we are sure it's a semantic paragraph/block.
        const pBlock = container.closest('p, article, section, blockquote, li, dd');

        if (!pBlock) {
            // PDF / Non-Semantic Mode:
            // Risk of hallucination or grabbing unrelated columns is high.
            // Return null or empty context.
            return null;
        }

        // Web Mode: Process Context
        const fullText = pBlock.innerText || "";
        const selectionText = range.toString();

        // Simple split (First occurrence only to avoid complex range math for now)
        const parts = fullText.split(selectionText);
        if (parts.length < 2) return null;

        let before = parts[0];
        let after = parts.slice(1).join(selectionText);

        // Truncate
        if (before.length > 200) before = "..." + before.slice(-200);
        if (after.length > 200) after = after.slice(0, 200) + "...";

        return {
            contextBefore: before.trim(),
            contextAfter: after.trim()
        };

    } catch (e) {
        console.warn("Context extraction failed:", e);
        return null;
    }
}


/**
 * Detect if AI should be bypassed (Same Language Short-Circuit)
 */
function shouldBypassAI(text, targetLang) {
    if (!text || !targetLang) return false;
    const sample = text.trim();
    if (sample.length === 0) return false;

    // Detect Input Scripts (Lightweight Regex)
    const hasChinese = /[\u4e00-\u9fa5]/.test(sample);
    const hasJapanese = /[\u3040-\u30ff]/.test(sample);
    const hasKorean = /[\uac00-\ud7af]/.test(sample);
    // Assume English/Latin if none of the above (simplified for speed)
    const isLatin = !hasChinese && !hasJapanese && !hasKorean && /[a-zA-Z]/.test(sample);

    const target = targetLang.toLowerCase();

    // 2. Chinese Bypass Logic (Smart Script Detection)
    // Goal: Bypass ONLY if the script matches the target (e.g. TC -> TC).
    // If scripts differ (SC -> TC), we MUST NOT bypass.
    if (hasChinese) {
        const script = detectChineseScript(sample); // 'sc', 'tc', or 'unknown'

        // Target: Traditional Chinese
        if (target.includes('traditional') || target.includes('taiwan') || target.includes('繁體')) {
            if (script === 'tc') {
                // console.log("[OIT] Bypass: TC input -> TC target. Returning original.");
                return true;
            }
            // If 'sc', fall through to AI for conversion.
        }

        // Target: Simplified Chinese
        else if (target.includes('simplified') || target.includes('mandarin') || target.includes('简体')) {
            if (script === 'sc') {
                // console.log("[OIT] Bypass: SC input -> SC target. Returning original.");
                return true;
            }
            // If 'tc', fall through to AI for conversion.
        }

        // Target: Generic "Chinese" (Assume User wants to read it as is?)
        else if (target === 'chinese') {
            // Ambiguous. Usually implies "I can read Chinese". Bypass.
            // console.log("[OIT] Bypass: Chinese input -> Generic Chinese target.");
            return true;
        }
    }

    // 3. Japanese to Japanese Bypass
    if (target.includes('japanese') && hasJapanese) {
        // console.log("[OIT] Bypass: Japanese input -> Japanese target. Returning original.");
        return true;
    }

    // 4. Korean to Korean Bypass
    if (target.includes('korean') && hasKorean) {
        // console.log("[OIT] Bypass: Korean input -> Korean target. Returning original.");
        return true;
    }

    return false;
}

/**
 * Heuristic to detect Simplified vs Traditional Chinese
 * Returns: 'sc' (Simplified), 'tc' (Traditional), or 'unknown' (Neutral/Mixed)
 */
function detectChineseScript(text) {
    const sample = text.slice(0, 100);

    // Distinct Simplified-only characters (Expanded List)
    const scMarkers = /[爱罢备笔毕边参仓产长尝车齿虫刍从窜达带单当导灯点东斗独顿夺堕儿尔尧乐厉虑乱马买卖门亩内宁农呕盘赔鹏骗贫扑热认荣肉闰润洒三伞丧扫色杀晒闪伤舍摄沈声胜师湿实势视适书术树帅松苏素岁孙条铁听厅图团椭洼袜网卫稳务雾袭习系戏虾吓献乡响向协写谢辛新兴休休修修秀秀绣须虚轩悬选学雪压亚言严岩颜阎艳厌燕扬阳杨瑶业叶仪艺亿忆义隐阴瘾樱婴鹰应莹颖哟拥优邮犹游友有余鱼娱誉预元园员圆缘远愿约月岳云运韵杂灾暂脏凿责择则泽贼赠扎札轧闸诈斋债毡盏斩展占战栈帐胀找赵折哲这珍珍真真诊镇阵争执职植纸指制质钟终种肿众昼朱猪诸诛烛主筑住注专砖转赚庄装壮状锥赘坠准卓拙资姿兹总纵邹走奏租足族阻组钻嘴最罪尊尊遵昨左作坐座做]/;

    // Distinct Traditional-only characters
    const tcMarkers = /[愛罷備筆畢邊參倉產長嘗車齒蟲芻從竄達帶單當導燈點東鬥獨頓奪墮兒爾堯樂厲慮亂馬買賣門畝內寧農嘔盤賠鵬騙貧撲熱認榮肉閏潤灑三傘喪掃色殺曬閃傷捨攝沈聲勝師濕實勢視適書術樹帥松蘇素歲孫條鐵聽廳圖團橢窪襪網衛穩務霧襲習係戲蝦嚇獻鄉響向協寫謝辛新興休修秀繡須虛軒懸選學雪壓亞言嚴岩顏閻艷厭燕揚陽楊瑤業葉儀藝億憶義隱陰癮櫻嬰鷹應瑩穎喲擁優郵猶遊友有餘魚娛譽預元園員圓緣遠願約月岳雲運韻雜災暫臟鑿責擇則澤賊贈紮札軋閘詐齋債氈盞斬展占戰棧帳脹找趙折哲這珍真診鎮陣爭執職植紙指製質鐘終種腫眾晝朱豬諸誅燭主築住注專磚轉賺莊裝壯狀錐贅墜準卓拙資姿茲總縱邹鄒走奏租足族阻組鑽嘴最罪尊遵昨左作坐座做]/;

    if (scMarkers.test(sample)) return 'sc';
    if (tcMarkers.test(sample)) return 'tc';

    // Fallback if no distinct markers found in sample (e.g. only neutral chars like "我", "人")
    return 'unknown';
}

/**
 * Perform Translation & Show Panel (STREAMING)
 */
async function translateSelection(text, rect, retryCount = 0) {
    // 1. Show Loading Panel
    // If retrying, maybe update text?
    const loadingText = retryCount > 0 ? "Retrying (Anti-Echo)..." : "Preparing...";
    showPanel(rect, loadingText, true);

    try {
        // 2. Get Credentials & Settings dynamically
        // CRASH RISK: This line throws "Extension context invalidated" if extension was reloaded.
        const defaults = { modelId: 'google/gemini-2.0-flash-exp', targetLang: 'Traditional Chinese' };
        const settings = await chrome.storage.sync.get(['apiKey', 'modelId', 'targetLang']);
        const apiKey = settings.apiKey;

        if (!apiKey) {
            updatePanel("Please set your API Key in the extension popup.", false, true);
            return;
        }

        const model = settings.modelId || defaults.modelId;
        const targetLang = settings.targetLang || defaults.targetLang;

        // --- CLIENT-SIDE BYPASS (Zero Latency) ---
        if (shouldBypassAI(text, targetLang)) {
            // Directly show original text, no API call
            updatePanel(text, false, false);
            return;
        }
        // -----------------------------------------

        // 3. Extract Context
        const contextObj = getContext(lastSelectionRange);
        if (ENABLE_LOGGING && contextObj) {
            // console.log("[Context]", contextObj);
        }



        // 4. Start Streaming Connection
        // [OIT] Cancel previous port connection if exists
        if (activePort) {
            try {
                activePort.disconnect();
            } catch (e) { /* ignore */ }
            activePort = null;
        }

        const port = chrome.runtime.connect({ name: "stream-translate" });
        activePort = port;

        // Handle Invalidation immediately after connect?
        if (chrome.runtime.lastError) {
            throw new Error(chrome.runtime.lastError.message);
        }

        let fullTranslation = "";
        let isFirstChunk = true;

        port.onMessage.addListener((msg) => {
            if (msg.status === 'streaming') {
                if (isFirstChunk) {
                    updatePanel("", false, false); // Clear "Preparing..." and set up for streaming
                    isFirstChunk = false;
                }
                fullTranslation += msg.chunk;

                // Real-time cleanup (simple check for "Translation:" prefix if it appears at start)
                // This is a bit risky during streaming but we can try to suppress it if it's the very first chunk(s)
                // For now, we trust the prompt + post-check, just append.

                appendToPanel(msg.chunk);
            } else if (msg.status === 'done') {
                port.disconnect();
                if (activePort === port) activePort = null;

                // ECHO DETECTION
                const normInput = text.trim().toLowerCase();
                const normOutput = fullTranslation.trim().toLowerCase();

                // Simple equality check, ensuring length is significant enough to care
                if (normInput.length > 4 && normInput === normOutput) {
                    // console.log("[OIT] Echo detected. User requested to allow this. Displaying original text.");
                }

            } else if (msg.status === 'error') {
                updatePanel("Translation Error: " + msg.message, false, true);
            }
        });

        // Send Initial Payload
        port.postMessage({
            type: 'START_STREAM',
            text: text,
            apiKey: apiKey,
            model: model,
            targetLang: targetLang,
            contextObj: contextObj,
            retryCount: retryCount // PASS RETRY COUNT
        });

    } catch (err) {
        const errorMessage = err.message || String(err);

        // Handle "Extension context invalidated" (e.g. after update/reload)
        if (errorMessage.includes("invalidated")) {
            console.warn("[OIT] Extension context invalidated. Requesting reload.");
            updatePanel(
                "Extension updated. Please refresh the page to continue.<br><br>" +
                "<button style='background:#3b82f6;color:white;border:none;padding:5px 10px;border-radius:4px;cursor:pointer' onclick='location.reload()'>Refresh Page</button>",
                true,
                true
            );
        } else {
            // Only log actual unexpected errors
            console.error("Translation Error (Global):", err);
            updatePanel("Error: " + errorMessage, false, true);
        }
    }
}

function appendToPanel(chunk) {
    if (!activePanel) return;
    // Find the content div created by updatePanel
    let contentDiv = activePanel.querySelector('.content-div');
    if (!contentDiv) {
        // Fallback if not found (unexpected)
        contentDiv = document.createElement('div');
        contentDiv.className = 'content-div';
        contentDiv.style.whiteSpace = "pre-wrap";
        contentDiv.style.marginBottom = "8px";
        activePanel.insertBefore(contentDiv, activePanel.querySelector('.oit-close-btn')); // Insert before close button if possible
    }

    // Append the chunk as a text node to avoid re-parsing HTML and for performance
    contentDiv.appendChild(document.createTextNode(chunk));

    // Auto Scroll to bottom
    activePanel.scrollTop = activePanel.scrollHeight;
}

/**
 * Show/Create the Result Panel
 */
function showPanel(rect, initialText, isLoading = false) {
    removePanel();

    const panel = document.createElement('div');
    panel.id = 'oit-translate-panel';
    // Style
    panel.style.cssText = `
        position: fixed; /* Must be fixed for PDF viewports */
        left: ${rect.left}px;
        /* Top/Bottom set dynamically below */
        z-index: 2147483647; /* Max Safe Integer to beat PDF viewer layers */
        background: white;
        color: #333;
        
        /* [OIT Update] Sizing & Typography */
        min-width: 400px;
        max-width: min(600px, 90vw); /* Responsive cap */
        width: auto;
        /* max-height handled dynamically */
        overflow-y: auto;
        padding: 24px;
        box-sizing: border-box; /* Ensure padding doesn't affect calculation */
        
        border-radius: 12px; /* Slightly more rounded */
        box-shadow: 0 10px 30px rgba(0,0,0,0.25); /* Stronger shadow for "card" feel */
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 16px;
        line-height: 1.6;
        border: 1px solid #e2e8f0;
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.2s, transform 0.2s;
    `;

    // [OIT] Smart Positioning System (Auto-Flip & Auto-Resize)
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;
    const minRequired = 300; // Minimum pixels to feel "comfortable"

    // Reset previous positioning defaults
    panel.style.top = 'auto';
    panel.style.bottom = 'auto';

    // Default max-height cap
    const comfortableHeight = 600;

    if (spaceBelow >= minRequired || spaceBelow >= spaceAbove) {
        // SCENARIO A: Show Below (Standard)
        panel.style.top = (rect.bottom + 10) + 'px';

        // Dynamic Height Cap: Use available space, but don't exceed comfortable max
        // Subtract 20px for margin/gutters
        const availableHeight = spaceBelow - 20;
        panel.style.maxHeight = Math.min(comfortableHeight, availableHeight) + 'px';

    } else {
        // SCENARIO B: Flip to Above (Space below is tight)
        // Position fixed 'bottom' is distance from viewport bottom
        // Target bottom position = (viewportHeight - rect.top) + margin

        const bottomPos = viewportHeight - rect.top + 10;
        panel.style.bottom = bottomPos + 'px';

        // Dynamic Height Cap for Top
        const availableHeight = spaceAbove - 20;
        panel.style.maxHeight = Math.min(comfortableHeight, availableHeight) + 'px';

        // Reverse animation for visual consistency (slide up instead of down)
        panel.style.transform = 'translateY(-10px)';
    }

    // Adjust position if off-screen (right edge)
    const viewportWidth = window.innerWidth;
    if (rect.left + 320 > viewportWidth) {
        panel.style.left = 'auto';
        panel.style.right = '20px';
    }

    if (isLoading) {
        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;color:#64748b;">
                <div class="oit-spinner"></div> 
                <span style="font-weight:500;">Translating...</span>
            </div>
            <style>
                .oit-spinner {
                    width: 16px;
                    height: 16px;
                    border: 2px solid #e2e8f0;
                    border-top-color: #3b82f6;
                    border-radius: 50%;
                    animation: spin 0.8s linear infinite;
                }
                @keyframes spin{to{transform:rotate(360deg)}}
            </style>`;
    } else {
        panel.textContent = initialText;
    }

    document.body.appendChild(panel);
    activePanel = panel;

    // Animate In
    requestAnimationFrame(() => {
        panel.style.opacity = '1';
        panel.style.transform = 'translateY(0)';
    });
}

function updatePanel(text, isHTML = false, isError = false) {
    if (!activePanel) return;

    activePanel.innerHTML = ""; // Clear loader

    // Header Color Bar
    const statusColor = isError ? '#ef4444' : '#3b82f6';
    activePanel.style.borderLeft = `4px solid ${statusColor}`;

    // Content container
    const content = document.createElement('div');
    content.className = "content-div"; // Class for streaming append
    content.style.marginBottom = "8px"; // Spacing for possible footer
    content.style.whiteSpace = "pre-wrap"; // Preserve line breaks
    // content.textContent = text; // Don't set textContent directly if HTML provided
    if (isHTML) {
        content.innerHTML = text;
    } else {
        content.textContent = text;
    }
    activePanel.appendChild(content);

    // Close Button
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
        position: absolute;
        top: 12px; /* Adjusted for corner radius */
        right: 16px; /* Adjusted for padding */
        cursor: pointer;
        color: #94a3b8;
        font-size: 24px; /* Larger hit area */
        line-height: 1;
        font-weight: bold;
    `;
    closeBtn.title = "Close";
    closeBtn.onmouseover = () => closeBtn.style.color = '#475569';
    closeBtn.onmouseout = () => closeBtn.style.color = '#94a3b8';
    closeBtn.onclick = removePanel;
    activePanel.appendChild(closeBtn);
}


// ===========================================
// LISTENERS (Legacy / External support)
// ===========================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // If YouTube support is requested but we purged logic, at least log it or handle basic alert.
    if (request.type === 'TRANSLATE_YOUTUBE') {

        // TODO: Re-integrate YouTube logic if needed.
        // For now, alerting user if feature is missing.
        // alert("YouTube Translation Logic is currently being refactored.");
    }

    // Just in case popup tries to send Translate Page
    if (request.type === 'TRANSLATE_PAGE') {
        alert("Please use the 'Highlight to Translate' feature (Selection Mode).");
    }
});

// ===========================================
// PDF NATIVE VIEWER DETECTION (The Ghost Shell Fix)
// ===========================================
if (document.contentType === 'application/pdf') {

    injectPDFSwitcher();
}

function injectPDFSwitcher() {
    // Check if we are already in our viewer (unlikely if contentType is application/pdf, but safety first)
    // Our viewer is HTML, not PDF. content.js shouldn't run there usually due to matches, 
    // but if it does, contentType would be text/html.

    const switcher = document.createElement('div');
    switcher.id = 'oit-pdf-switcher';
    switcher.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 2147483647;
        background: #2563eb;
        color: white;
        padding: 12px 20px;
        border-radius: 8px;
        font-family: system-ui, sans-serif;
        font-weight: 600;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        transition: transform 0.2s;
    `;
    switcher.innerHTML = `
        <span>📄 Open Enhanced Viewer</span>
    `;

    switcher.onclick = () => {
        // We need to tell background to force the redirect or help user
        // Send message to background
        chrome.runtime.sendMessage({ type: 'OPEN_PDF_VIEWER', url: window.location.href }, (response) => {
            if (chrome.runtime.lastError) {
                alert("Please reload the extension or page.");
                return;
            }
            if (response && response.error) {
                // Likely Permission Denied
                alert("Please enable 'Allow access to file URLs' in extension settings for automatic translation, or use the extension icon to open the viewer manually.");
            }
        });
    };

    switcher.onmouseover = () => switcher.style.transform = 'scale(1.05)';
    switcher.onmouseout = () => switcher.style.transform = 'scale(1)';

    document.body.appendChild(switcher);
}

