// popup.js

/**
 * Constants for default values
 */
const DEFAULTS = {
    modelId: 'google/gemini-2.0-flash-exp',
    targetLang: 'Traditional Chinese'
};

document.addEventListener('DOMContentLoaded', async () => {
    // DOM Elements
    const form = document.getElementById('settingsForm');
    const apiKeyInput = document.getElementById('apiKey');
    const modelIdInput = document.getElementById('modelId');
    const targetLangSelect = document.getElementById('targetLang');
    const statusDiv = document.getElementById('status');
    // const transportPageBtn = document.getElementById('translatePageBtn'); // REMOVED
    const translateYouTubeBtn = document.getElementById('btn-translate-youtube'); // Updated ID
    const saveBtn = document.getElementById('saveBtn');

    // Helper to show status message
    function showStatus(message, isSuccess) {
        statusDiv.textContent = message;
        statusDiv.style.color = isSuccess ? 'var(--success-color)' : '#ef4444';
        statusDiv.classList.add('visible');

        if (isSuccess) {
            setTimeout(() => {
                statusDiv.classList.remove('visible');
            }, 2000);
        }
    }

    // 1. Load saved settings from chrome.storage.sync
    try {
        const result = await chrome.storage.sync.get(['apiKey', 'modelId', 'targetLang']);

        // Fill fields with saved values or defaults
        apiKeyInput.value = result.apiKey || '';
        modelIdInput.value = result.modelId || DEFAULTS.modelId;
        targetLangSelect.value = result.targetLang || DEFAULTS.targetLang;

    } catch (error) {
        console.error('Error loading settings:', error);
        showStatus('Error loading settings', false);
    }

    // 2. Check current URL for YouTube (To Enable YouTube Button)
    if (translateYouTubeBtn) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.url?.includes('youtube.com/watch')) {
                translateYouTubeBtn.disabled = false;
                translateYouTubeBtn.style.opacity = '1';
                translateYouTubeBtn.style.cursor = 'pointer';
            } else {
                translateYouTubeBtn.disabled = true;
                translateYouTubeBtn.style.opacity = '0.6';
                translateYouTubeBtn.style.cursor = 'not-allowed';
            }
        } catch (error) {
            console.error('Error checking tab URL:', error);
        }

        // Handle YouTube Click
        translateYouTubeBtn.addEventListener('click', async () => {
            try {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                if (!tab) {
                    showStatus('No active tab found', false);
                    return;
                }

                await chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATE_YOUTUBE' });
                window.close();
            } catch (error) {
                console.error('Error triggering YouTube translation:', error);
                showStatus('Failed to start YouTube translation', false);
            }
        });
    }

    // 3. Handle Save Settings
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const apiKey = apiKeyInput.value.trim();
        const modelId = modelIdInput.value.trim();
        const targetLang = targetLangSelect.value;

        if (!apiKey) {
            showStatus('Please enter an API Key', false);
            return;
        }

        // Disable button while saving
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        try {
            await chrome.storage.sync.set({
                apiKey,
                modelId,
                targetLang
            });

            showStatus('Settings saved!', true);
        } catch (error) {
            console.error('Error saving settings:', error);
            showStatus('Failed to save settings', false);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
        }
    });

    // 4. Handle PDF Permission Link
    const openExtensionsLink = document.getElementById('open-extensions');
    if (openExtensionsLink) {
        openExtensionsLink.addEventListener('click', (e) => {
            e.preventDefault();
            chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
        });
    }

    // Removed "Translate Page" logic as per pivot.
});
