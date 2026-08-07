import puppeteer from 'puppeteer-core';
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = await browser.pages();
const mdn = pages.find((p) => p.url().includes('developer.mozilla.org'));
const popup = pages.find((p) => p.url().includes('popup.html'));
const press = async () => popup.evaluate(async () => {
  const tabs = await chrome.tabs.query({ url: '*://developer.mozilla.org/*' });
  await chrome.tabs.sendMessage(tabs[0].id, { type: 'TRANSLATE_PAGE' });
});
const look = () => mdn.evaluate(() => ({
  badge: document.getElementById('oit-page-progress')?.textContent ?? null,
  n: document.querySelectorAll('.oit-bilingual').length,
  lang: document.querySelector('.oit-bilingual')?.getAttribute('lang') ?? null,
}));

await popup.evaluate(async () => chrome.storage.sync.set({ targetLang: 'Traditional Chinese' }));
await mdn.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);
await press();
await sleep(8000);
console.log('translated zh-Hant:', JSON.stringify(await look()));

// Now the reader changes language in the popup, as anyone would.
await popup.evaluate(async () => chrome.storage.sync.set({ targetLang: 'Vietnamese' }));
await sleep(1500);
console.log('after switching language, no press:', JSON.stringify(await look()));

await press();
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  console.log(`${(i + 1) * 5}s after one press:`, JSON.stringify(await look()));
  const s = await look();
  if (s.lang === 'vi' && s.n > 2) break;
}
await browser.disconnect();
