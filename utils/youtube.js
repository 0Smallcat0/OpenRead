
/**
 * Helper to retrieve the value of a global variable from the main world.
 * Since content scripts live in an isolated world, we must inject a script
 * to access variables like 'ytInitialPlayerResponse'.
 * @param {string} variableName
 * @returns {Promise<any>}
 */
function getPageVariable(variableName) {
    return new Promise((resolve, reject) => {
        const scriptId = 'tmp_script_' + Math.random().toString(36).substr(2, 9);
        const script = document.createElement('script');

        // We'll use window.postMessage to communicate back to the content script
        script.textContent = `
      (function() {
        try {
          const value = window['${variableName}'];
          window.postMessage({
            type: '${scriptId}',
            result: value ? JSON.stringify(value) : null
          }, '*');
        } catch (e) {
          window.postMessage({
            type: '${scriptId}',
            error: e.toString()
          }, '*');
        }
      })();
    `;
        script.id = scriptId;

        const handler = (event) => {
            if (event.source === window && event.data && event.data.type === scriptId) {
                window.removeEventListener('message', handler);
                script.remove();
                if (event.data.error) {
                    reject(new Error(event.data.error));
                } else {
                    try {
                        resolve(JSON.parse(event.data.result));
                    } catch (e) {
                        resolve(null);
                    }
                }
            }
        };

        window.addEventListener('message', handler);
        (document.head || document.documentElement).appendChild(script);

        // Safety timeout
        setTimeout(() => {
            window.removeEventListener('message', handler);
            if (script.parentNode) script.remove();
            reject(new Error('Timeout waiting for page variable: ' + variableName));
        }, 5000);
    });
}

/**
 * Fetches subtitles for the current YouTube video.
 * @returns {Promise<Array<{start: string, duration: string, content: string}>>}
 */
export async function fetchYouTubeSubtitles() {
    // console.log('[YouTube Utils] Fetching ytInitialPlayerResponse...');
    let playerResponse = await getPageVariable('ytInitialPlayerResponse');

    if (!playerResponse) {
        console.warn('[YouTube Utils] ytInitialPlayerResponse not found.');
        return null;
    }

    // Parse captions path
    const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (!captionTracks || captionTracks.length === 0) {
        // console.log('[YouTube Utils] No caption tracks found.');
        return null;
    }

    // console.log(`[YouTube Utils] Found ${captionTracks.length} caption tracks.`);

    // Strategy: Find English ('en') first, otherwise look for auto-generated, or perform a smart fallback.
    // captionTracks structure usually has: languageCode, name, baseUrl, kind, etc.

    // 1. Exact match for 'en'
    let track = captionTracks.find(t => t.languageCode === 'en');

    // 2. If not, try any English variant (en-US, en-GB)
    if (!track) {
        track = captionTracks.find(t => t.languageCode && t.languageCode.startsWith('en'));
    }

    // 3. Fallback to first available if strictly needed, but let's prioritize readable ones.
    // Actually, let's stick to the prompt: "Find English (en) or automatic"
    // "kind" === 'asr' is automatic speech recognition.
    if (!track) {
        // Try to find the auto-generated one (often usually is English if the video is English)
        // Or just take the first one?
        // Let's look for one that is set as default?
        // For now, prompt said: "Find English (en) or automatic"
        track = captionTracks.find(t => t.kind === 'asr');
    }

    // 4. Last resort: just picking the first one might NOT be english, but it's "a subtitle".
    // Let's default to the first one if nothing else matches, assuming the user wants *some* context.
    if (!track) {
        track = captionTracks[0];
    }

    if (!track) {
        console.warn('[YouTube Utils] No suitable track found.');
        return null;
    }

    // console.log(`[YouTube Utils] Selected track: ${track.languageCode || 'unknown'} (${track.name?.simpleText})`);

    // Construct URL for JSON3 format
    let baseUrl = track.baseUrl;
    if (!baseUrl.includes('fmt=json3')) {
        baseUrl += '&fmt=json3';
    }

    try {
        // Use fetch with credentials to ensure we have access (though standard public captions usually don't need auth, correct handling is safer)
        const response = await fetch(baseUrl, { credentials: 'include' });
        if (!response.ok) {
            throw new Error(`Failed to fetch captions: ${response.status}`);
        }
        const json = await response.json();

        // The JSON3 format usually relies on 'events'
        // Structure: { events: [ { tStartMs: 123, dDurationMs: 123, segs: [ { utf8: "text" } ] } ] }
        return parseJson3Captions(json);

    } catch (err) {
        console.error('[YouTube Utils] Error fetching subtitle content:', err);
        return null;
    }
}

/**
 * Parses JSON3 caption format into a simpler structure.
 * @param {object} json 
 */
function parseJson3Captions(json) {
    if (!json || !json.events) return [];

    return json.events
        .filter(event => event.segs && event.segs.length > 0) // Filter out empty events
        .map(event => {
            const startMs = event.tStartMs;
            const durationMs = event.dDurationMs || 0;
            const text = event.segs.map(s => s.utf8).join(''); // simple concatenation

            return {
                start: startMs,
                duration: durationMs,
                text: text // prompt called it "拿到字幕檔", we return structured data
            };
        });
}
