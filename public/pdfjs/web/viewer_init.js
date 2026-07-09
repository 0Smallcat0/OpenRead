import { GlobalWorkerOptions } from '../build/pdf.mjs';
GlobalWorkerOptions.workerSrc = '../build/pdf.worker.mjs';

window.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('file')) {
        // Show a visual hint
        const viewer = document.getElementById('viewerContainer');
        if (viewer) {
            const hint = document.createElement('div');
            hint.innerHTML = '<div style="text-align:center; padding: 50px; color: #666; font-family: sans-serif;"><h1>OpenRead</h1><p>Drag &amp; Drop a PDF here to start.</p></div>';
            viewer.prepend(hint);
        }
    }
});
