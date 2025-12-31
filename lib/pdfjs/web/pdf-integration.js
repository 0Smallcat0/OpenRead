
import { translateStream } from '../../../utils/ai-client.js';

console.log("[OIT-PDF] PDF Integration Script Loaded");

// ===========================================
// SELECTION-BASED TRANSLATION (Core)
// ===========================================

// Configuration
const ENABLE_LOGGING = true;

// State
let activeIcon = null;
let activePanel = null;
let activePanelController = null; // For aborting streams if needed
let lastSelectionRange = null;

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

        // Filter: Must be valid text, not too long
        if (text.length > 1 && text.length < 5000) {
            if (selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                lastSelectionRange = range;
                showTranslateIcon(range);
            }
        } else {
            removeIcon();
        }
    }, 50);
}, true);

// Close panel/icon on outside click
document.addEventListener('mousedown', (event) => {
    if (activePanel && !activePanel.contains(event.target)) {
        removePanel();
    }
    if (activeIcon && !activeIcon.contains(event.target)) {
        removeIcon();
    }
}, true);

// ===========================================
// 2. UI Components
// ===========================================

function showTranslateIcon(range) {
    removeIcon();

    const rects = range.getClientRects();
    if (rects.length === 0) return;

    const lastRect = rects[rects.length - 1];

    const icon = document.createElement('div');
    icon.textContent = '文';
    icon.id = 'oit-translate-icon';
    icon.style.cssText = `
        position: fixed;
        left: ${lastRect.right + 5}px;
        top: ${lastRect.top - 30}px;
        z-index: 2147483647;
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

    // Bounds check
    const top = lastRect.top - 30;
    if (top < 0) icon.style.top = (lastRect.bottom + 5) + 'px';

    icon.onmouseover = () => icon.style.transform = 'scale(1.1)';
    icon.onmouseout = () => icon.style.transform = 'scale(1)';

    icon.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = window.getSelection().toString().trim();
        removeIcon();
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

// PDF Context extraction is simpler simply because we are in PDF.js text layer
function getContext(range) {
    try {
        if (!range) return null;
        let container = range.commonAncestorContainer;
        if (container.nodeType === Node.TEXT_NODE) {
            container = container.parentNode;
        }

        // In PDF.js, text is often in spans inside .textLayer
        // We can try to grab the whole page text or nearby spans.
        // For simplicity, we just return null or improve logic later.
        // The original logic looked for p, article, etc. 
        // PDF.js structure is usually div.textLayer > span

        // Let's just try to get the parent div's text if it's not too huge
        if (container.classList.contains('textLayer')) {
            return null; // Too big
        }

        // Try to find the line? 
        // PDF.js renders lines primarily.
        const page = container.closest('.page');
        if (!page) return null;

        return null; // TODO: Implement PDF specific context
    } catch (e) {
        return null;
    }
}

function shouldBypassAI(text, targetLang) {
    if (!text) return false;
    const sample = text.trim();
    if (sample.length === 0) return false;

    // 1. Check for English/Latin Echo (Keep this)
    const hasChinese = /[\u4e00-\u9fa5]/.test(sample);
    const isLatin = !hasChinese && /[a-zA-Z]/.test(sample);
    const target = (targetLang || '').toLowerCase();

    if (target.includes('english') && isLatin) {
        console.log("[OIT-PDF] Bypass: English -> English.");
        return true;
    }

    // 2. CRITICAL: DO NOT BYPASS CHINESE
    // If we are here, it might be Chinese. We MUST send it to AI for conversion.
    // Explicitly returning false ensures we trigger the translation stream.

    // 3. Junk Filter (Optional, strict check for PDF artifacts)
    // PDF selections often have spaces like "t e x t". 
    // If it looks like garbage (e.g., length < 2 and not a known word), bypass.
    if (sample.length < 2 && !hasChinese) {
        return true;
    }

    return false; // Proceed to AI
}

async function translateSelection(text, rect, retryCount = 0) {
    const loadingText = retryCount > 0 ? "Retrying (Anti-Echo)..." : "Preparing...";
    showPanel(rect, loadingText, true);

    try {
        const defaults = { modelId: 'google/gemini-2.0-flash-exp', targetLang: 'Traditional Chinese' };
        const settings = await chrome.storage.sync.get(['apiKey', 'modelId', 'targetLang']);
        const apiKey = settings.apiKey;

        if (!apiKey) {
            updatePanel("Please set your API Key in the extension popup.", false, true);
            return;
        }

        const model = settings.modelId || defaults.modelId;
        const targetLang = settings.targetLang || defaults.targetLang;

        if (shouldBypassAI(text, targetLang)) {
            updatePanel(text, false, false);
            return;
        }

        const contextObj = getContext(lastSelectionRange);

        // Using Port for streaming
        const port = chrome.runtime.connect({ name: "stream-translate" });
        if (chrome.runtime.lastError) throw new Error(chrome.runtime.lastError.message);

        let fullTranslation = "";
        let isFirstChunk = true;

        port.onMessage.addListener((msg) => {
            if (msg.status === 'streaming') {
                if (isFirstChunk) {
                    updatePanel("", false, false);
                    isFirstChunk = false;
                }
                fullTranslation += msg.chunk;
                appendToPanel(msg.chunk);
            } else if (msg.status === 'done') {
                port.disconnect();
                // Echo check could be here
            } else if (msg.status === 'error') {
                updatePanel("Translation Error: " + msg.message, false, true);
            }
        });

        port.postMessage({
            type: 'START_STREAM',
            text: text,
            apiKey: apiKey,
            model: model,
            targetLang: targetLang,
            contextObj: contextObj,
            retryCount: retryCount
        });

    } catch (err) {
        updatePanel("Error: " + err.message, false, true);
    }
}

function appendToPanel(chunk) {
    if (!activePanel) return;
    let contentDiv = activePanel.querySelector('.content-div');
    if (!contentDiv) {
        contentDiv = document.createElement('div');
        contentDiv.className = 'content-div';
        contentDiv.style.whiteSpace = "pre-wrap";
        contentDiv.style.marginBottom = "8px";
        activePanel.insertBefore(contentDiv, activePanel.querySelector('.oit-close-btn'));
    }
    contentDiv.appendChild(document.createTextNode(chunk));
    activePanel.scrollTop = activePanel.scrollHeight;
}

function showPanel(rect, initialText, isLoading = false) {
    removePanel();

    const panel = document.createElement('div');
    panel.id = 'oit-translate-panel';
    panel.style.cssText = `
        position: fixed;
        left: ${rect.left}px;
        top: ${rect.bottom + 10}px;
        z-index: 2147483647;
        background: white;
        color: #333;
        
        /* [OIT Update] Match Web Version Styles */
        min-width: 400px;
        max-width: 600px;
        width: auto;
        max-height: 80vh;
        overflow-y: auto;
        
        padding: 24px;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.25);
        
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 16px;
        line-height: 1.6;
        border: 1px solid #e2e8f0;
        box-sizing: border-box;
        
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.2s, transform 0.2s;
    `;

    // [OIT] Smart Positioning System (Auto-Flip & Auto-Resize)
    const padding = 10;
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Reset
    panel.style.top = 'auto';
    panel.style.bottom = 'auto';
    panel.style.maxHeight = '80vh';

    // Decision Logic: Flip if bottom is tight (< 300px) AND top has more space
    if (spaceBelow < 300 && spaceAbove > spaceBelow) {
        // SHOW ABOVE
        // Calculate bottom position (distance from bottom edge)
        const bottomPos = viewportHeight - rect.top + padding;
        panel.style.bottom = bottomPos + 'px';
        panel.style.maxHeight = Math.min(600, spaceAbove - 20) + 'px';

        // Reverse animation for visual consistency (slide up)
        panel.style.transform = 'translateY(-10px)';
    } else {
        // SHOW BELOW (Standard)
        panel.style.top = (rect.bottom + padding) + 'px';
        panel.style.maxHeight = Math.min(600, spaceBelow - 20) + 'px';

        // Standard animation
        panel.style.transform = 'translateY(10px)';
    }

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
                .oit-spinner { width: 16px; height: 16px; border: 2px solid #e2e8f0; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; }
                @keyframes spin{to{transform:rotate(360deg)}}
            </style>`;
    } else {
        panel.textContent = initialText;
    }

    document.body.appendChild(panel);
    activePanel = panel;

    requestAnimationFrame(() => {
        panel.style.opacity = '1';
        panel.style.transform = 'translateY(0)';
    });
}

function updatePanel(text, isHTML = false, isError = false) {
    if (!activePanel) return;
    activePanel.innerHTML = "";

    const statusColor = isError ? '#ef4444' : '#3b82f6';
    activePanel.style.borderLeft = `4px solid ${statusColor}`;

    const content = document.createElement('div');
    content.className = "content-div";
    content.style.marginBottom = "8px";
    content.style.whiteSpace = "pre-wrap";

    if (isHTML) {
        content.innerHTML = text;
    } else {
        content.textContent = text;
    }
    activePanel.appendChild(content);

    const closeBtn = document.createElement('div');
    closeBtn.textContent = '×';
    closeBtn.className = 'oit-close-btn'; // Add class for selection
    closeBtn.style.cssText = `
        position: absolute;
        top: 12px;
        right: 16px;
        cursor: pointer;
        color: #94a3b8;
        font-size: 24px;
        line-height: 1;
        font-weight: bold;
    `;
    closeBtn.onclick = removePanel;
    activePanel.appendChild(closeBtn);
}

// [OIT Patch] Force hide the file input overlay if a file is loaded via URL
window.addEventListener('load', function () {
    const params = new URLSearchParams(window.location.search);
    if (params.has('file')) {
        console.log("[OIT] File parameter detected. Attempting to hide overlay...");

        // Strategy 1: Hide by ID (including our custom hint)
        const possibleIDs = ['fileInputContainer', 'overlayContainer', 'errorWrapper', 'oit-drop-hint'];
        possibleIDs.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.style.display = 'none';
                console.log(`[OIT] Hidden element: #${id}`);
            }
        });

        // Strategy 2: Hide by Text Content (Fallback)
        const allDivs = document.querySelectorAll('div, span');
        for (let div of allDivs) {
            // Check for direct text or first child text to avoid hiding huge containers unnecessarily
            if (div.childNodes.length > 0 && div.childNodes[0].nodeType === Node.TEXT_NODE) {
                const text = div.innerText;
                if (text && (text.includes('Open local PDF') || text.includes('Drop your PDF file here'))) {
                    // Walk up to find the container if it's a small label
                    let target = div;
                    // Heuristic to find the wrapper (e.g., if it has 'container' class)
                    if (target.parentElement && (target.parentElement.id.includes('Container') || target.parentElement.className.includes('container'))) {
                        target = target.parentElement;
                    }
                    target.style.display = 'none';
                    console.log("[OIT] Hidden overlay by text content:", text.substring(0, 20));
                    // Don't break immediately, may be multiple elements
                }
            }
        }
    }
});
