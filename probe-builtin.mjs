import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const profile=mkdtempSync(join(tmpdir(),'oit-bi2-'));
const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',
 ['--remote-debugging-port=9351',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','about:blank'],{stdio:'ignore'});
let browser;
const done=(o)=>{console.log(JSON.stringify(o,null,1));};
try{
  await sleep(4000);
  browser=await puppeteer.connect({browserURL:'http://127.0.0.1:9351',defaultViewport:null});
  const page=await browser.newPage();
  await page.goto('https://example.com/',{waitUntil:'domcontentloaded'});
  const r=await Promise.race([
    page.evaluate(async()=>{
      const out={
        chrome: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
        Translator: 'Translator' in self,
        LanguageDetector: 'LanguageDetector' in self,
        LanguageModel: 'LanguageModel' in self,
      };
      if(out.Translator){
        for(const [k,pair] of Object.entries({
          en_zhHant:{sourceLanguage:'en',targetLanguage:'zh-Hant'},
          en_zh:{sourceLanguage:'en',targetLanguage:'zh'},
          en_ja:{sourceLanguage:'en',targetLanguage:'ja'},
        })){
          try{ out[k]=await Translator.availability(pair); }catch(e){ out[k]='ERR '+e.name; }
        }
      }
      return out;
    }),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('evaluate timed out after 45s')),45000)),
  ]);
  done(r);
}catch(e){ done({error:String(e.message||e)}); }
finally{ await browser?.disconnect(); chrome.kill(); }
