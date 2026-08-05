import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const profile=mkdtempSync(join(tmpdir(),'oit-bt-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
 ['--remote-debugging-port=9352',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
let browser;
try{
  await sleep(4000);
  browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9352',defaultViewport:null});
  const page=await browser.newPage();
  page.on('console',m=>console.log('[page]',m.text()));
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  const r=await page.evaluate(async()=>{
    const t0=performance.now();
    const tr=await Translator.create({
      sourceLanguage:'en', targetLanguage:'zh-Hant',
      monitor(m){ m.addEventListener('downloadprogress', e=>console.log('download', (e.loaded*100).toFixed(0)+'%')); },
    });
    const ready=performance.now()-t0;
    const samples=[
      'The fetch() method starts the process of fetching a resource from the network.',
      'Ollama is an open-source software platform for running large language models on local computers.',
      'Set the user interface language and the database connection string before you continue.',
    ];
    const out=[];
    for(const s of samples){
      const t1=performance.now();
      out.push({src:s.slice(0,50), zh:await tr.translate(s), ms:Math.round(performance.now()-t1)});
    }
    return {readyMs:Math.round(ready), out};
  });
  console.log(JSON.stringify(r,null,1));
}catch(e){ console.log('ERROR', e.message); }
finally{ await browser?.disconnect(); chrome.kill(); }
