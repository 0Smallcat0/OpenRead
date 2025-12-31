/**
 * Rendering and synchronization logic for subtitles.
 */

// Global state for sync loop
let syncInterval = null;
let currentSubtitles = [];

/**
 * Initializes the subtitle layer in the YouTube player.
 */
export function initSubtitleLayer() {
    // Determine the video container. Usually #movie_player
    const player = document.querySelector('#movie_player');
    if (!player) {
        console.warn('YouTube player element #movie_player not found.');
        return null;
    }

    let layer = document.getElementById('oit-subtitle-layer');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'oit-subtitle-layer';
        player.appendChild(layer);
    }
    return layer;
}

/**
 * Updates the text displayed in the subtitle layer.
 * @param {string} original 
 * @param {string} translated 
 */
export function renderCaption(original, translated) {
    const layer = document.getElementById('oit-subtitle-layer');
    if (!layer) return;

    // Build HTML safely
    // We expect plain text, but let's be safe against injection if we ever change sources.
    // Ideally use textContent but we want structure.

    // Clear previous
    layer.innerHTML = '';

    if (original) {
        const oDiv = document.createElement('span');
        oDiv.className = 'oit-original-text';
        oDiv.textContent = original;
        layer.appendChild(oDiv);
        layer.appendChild(document.createElement('br'));
    }

    if (translated) {
        const tDiv = document.createElement('span');
        tDiv.className = 'oit-translated-text';
        tDiv.textContent = translated;
        layer.appendChild(tDiv);
    }
}

/**
 * Starts the synchronization loop to update subtitles based on video time.
 * @param {HTMLVideoElement} videoElement 
 * @param {Array} subtitles 
 */
export function startSubtitleSync(videoElement, subtitles) {
    if (!videoElement || !subtitles || subtitles.length === 0) return;

    currentSubtitles = subtitles;
    stopSubtitleSync(); // Clear existing

    // Use requestAnimationFrame or a high-frequency interval?
    // YouTube's timeupdate fires periodically (250ms), which might be too slow for precise start/end.
    // requestAnimationFrame is better for smoothness.

    // Using a fast interval for simplicity and low overhead compared to rAF loops if tab hidden.
    // But rAF is standard for visual sync. Let's use timeupdate + rAF.

    const update = () => {
        if (!videoElement || videoElement.paused) return;

        const currentTime = videoElement.currentTime * 1000; // ms

        // Find active subtitle
        // Optimization: Could remember last index, but binary search or simple find is fine for N < 2000 usually.
        // Let's do simple find for robustness first.
        const activeSub = currentSubtitles.find(s => {
            const start = parseFloat(s.start);
            const duration = parseFloat(s.duration);
            return currentTime >= start && currentTime < (start + duration);
        });

        if (activeSub) {
            renderCaption(activeSub.original, activeSub.translated);
        } else {
            renderCaption('', ''); // Clear if no sub
        }
    };

    // Attach to timeupdate for general sync
    videoElement.addEventListener('timeupdate', update);

    // Also use an interval to catch checks between timeupdates if needed (rarely needed for subtitles, timeupdate is usually enough for visual text)
    // Actually, timeupdate on YouTube might be enough. Let's stick to timeupdate to save CPU.
    // Wait, standard HTML5 timeupdate is 4Hz-ish. That's 250ms error.
    // We want snappier start.

    const highFreqUpdate = setInterval(update, 100); // 10Hz

    syncInterval = {
        video: videoElement,
        handler: update,
        intervalId: highFreqUpdate
    };
}

/**
 * Stops the current synchronization loop.
 */
export function stopSubtitleSync() {
    if (syncInterval) {
        syncInterval.video.removeEventListener('timeupdate', syncInterval.handler);
        clearInterval(syncInterval.intervalId);
        syncInterval = null;
    }
    renderCaption('', '');
}

/**
 * Toggles the visibility of native YouTube captions.
 * @param {boolean} shouldHide 
 */
export function toggleNativeSubtitles(shouldHide) {
    if (shouldHide) {
        document.body.classList.add('oit-hide-native-captions');
    } else {
        document.body.classList.remove('oit-hide-native-captions');
    }
}
