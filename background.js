import { translateBatch, translateStream, translateText } from './utils/ai-client.js';

const VIEWER_URL = chrome.runtime.getURL("lib/pdfjs/web/viewer.html");

function isPdf(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.toLowerCase().endsWith('.pdf');
  } catch (e) {
    return false;
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && tab.url) {
    if (isPdf(tab.url)) {
      if (tab.url.startsWith(VIEWER_URL)) {
        return;
      }
      if (tab.url.startsWith('file://')) {
        const isAllowed = await chrome.extension.isAllowedFileSchemeAccess();
        if (!isAllowed) {
          return;
        }
      }
      const targetUrl = `${VIEWER_URL}?file=${encodeURIComponent(tab.url)}`;
      chrome.tabs.update(tabId, { url: targetUrl });
    }
  }
});


// STREAMING LISTENER (Long-lived connection)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "stream-translate") {
    port.onMessage.addListener(async (msg) => {
      if (msg.type === 'START_STREAM') {
        const { text, apiKey, model, targetLang, contextObj, retryCount } = msg;

        try {
          await translateStream(text, apiKey, model, targetLang, contextObj, (chunk) => {
            port.postMessage({ status: 'streaming', chunk: chunk });
          }, retryCount); // Pass retryCount

          port.postMessage({ status: 'done' });
        } catch (error) {
          console.error("Streaming Error:", error);
          port.postMessage({ status: 'error', message: error.message });
        }
      }
    });
  }
});

// LEGACY/FALLBACK LISTENERS (Message passing)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'TRANSLATE_BATCH_REQUEST') {
    handleBatchTranslation(request).then(sendResponse).catch((error) => {
      sendResponse({ error: error.message });
    });
    return true; // Keep the message channel open for async response
  }

  if (request.type === 'TRANSLATE_REQUEST') {
    handleTranslation(request).then(sendResponse).catch((error) => {
      sendResponse({ error: error.message });
    });
    return true;
  }

  // Handle Manual PDF Switcher Request from content.js
  if (request.type === 'OPEN_PDF_VIEWER') {
    (async () => {
      const isAllowed = await chrome.extension.isAllowedFileSchemeAccess();
      if (isAllowed) {
        // Redirect
        const targetUrl = `${VIEWER_URL}?file=${encodeURIComponent(request.url)}`;
        chrome.tabs.update(sender.tab.id, { url: targetUrl });
        sendResponse({ success: true });
      } else {
        // Tell content script to show instructions
        sendResponse({ error: "PERMISSION_DENIED" });
      }
    })();
    return true; // Async response
  }
});

async function handleBatchTranslation(request) {
  const { textArray, apiKey, model, targetLang } = request;
  try {

    const results = await translateBatch(textArray, apiKey, model, targetLang);

    return { success: true, data: results };
  } catch (error) {
    console.error("Translation Error in Background:", error);
    return { success: false, error: error.message };
  }
}

// import { translateText } from './utils/ai-client.js'; // Removed duplicate

async function handleTranslation(request) {
  const { text, apiKey, model, targetLang } = request;
  try {

    const result = await translateText(text, apiKey, model, targetLang);
    return { success: true, data: result };
  } catch (error) {
    console.error("Single Translation Error:", error);
    return { success: false, error: error.message };
  }
}
