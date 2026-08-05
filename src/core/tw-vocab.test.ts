import { describe, it, expect } from 'vitest';
import { toTaiwanVocabulary, wantsTaiwanVocabulary } from './tw-vocab';

describe('toTaiwanVocabulary', () => {
  it('fixes the words a real page actually produced', () => {
    // Counted over one translated Wikipedia article, 44 blocks: 12 x 本地,
    // 10 x 運行, 4 x 代碼, 3 x 用戶, 2 x 項目, 1 x 配置.
    expect(toTaiwanVocabulary('允許用戶在本地機器上運行模型')).toBe(
      '允許使用者在本機上執行模型',
    );
    expect(toTaiwanVocabulary('該項目的代碼與配置')).toBe(
      '該專案的程式碼與設定',
    );
  });

  it('leaves 本地化 alone, because that is correct Taiwan usage', () => {
    // The bug a bare replace would introduce: "localisation" becoming
    // "本機化", which is not a word.
    expect(toTaiwanVocabulary('台灣在地化與本地化')).toBe('台灣在地化與本地化');
  });

  it('leaves 用戶端 alone, which Taiwan says as-is', () => {
    expect(toTaiwanVocabulary('用戶端連線')).toBe('用戶端連線');
    expect(toTaiwanVocabulary('用戶與用戶端')).toBe('使用者與用戶端');
  });

  it('covers the rest of the common software vocabulary', () => {
    expect(toTaiwanVocabulary('軟件、硬件、界面、網絡、視頻')).toBe(
      '軟體、硬體、介面、網路、影片',
    );
    expect(
      toTaiwanVocabulary('線程、進程、端口、字符串、數組、函數、對象'),
    ).toBe('執行緒、行程、連接埠、字串、陣列、函式、物件');
    expect(toTaiwanVocabulary('服務器、內存、緩存、默認、兼容、集成')).toBe(
      '伺服器、記憶體、快取、預設、相容、整合',
    );
  });

  it('does not stutter when the phrase already carries the word', () => {
    // The first version of this table produced 本機機器 from 本地機器, one
    // word at a time. Found by re-reading the corrected page.
    expect(toTaiwanVocabulary('在本地機器上執行')).toBe('在本機上執行');
  });

  it('covers what a second pass over the corrected page turned up', () => {
    expect(toTaiwanVocabulary('操作系統與文檔')).toBe('作業系統與文件');
    expect(toTaiwanVocabulary('穩定釋放')).toBe('穩定版本');
  });

  it('is a no-op on text that already reads as Taiwan Chinese', () => {
    const text = '使用者在本機執行程式，介面與伺服器都正常。';
    expect(toTaiwanVocabulary(text)).toBe(text);
  });

  it('leaves English and empty input untouched', () => {
    expect(toTaiwanVocabulary('The user runs a local model.')).toBe(
      'The user runs a local model.',
    );
    expect(toTaiwanVocabulary('')).toBe('');
  });
});

describe('wantsTaiwanVocabulary', () => {
  it('is true for every way the target can name Traditional Chinese', () => {
    for (const value of [
      'Traditional Chinese',
      '繁體中文',
      'Chinese (Taiwan)',
      'zh-Hant',
      'zh-TW',
    ]) {
      expect(wantsTaiwanVocabulary(value), value).toBe(true);
    }
  });

  it('is false for anything else, including Simplified', () => {
    // Simplified is OpenCC's job. Running both would be two transforms
    // fighting over the same string.
    for (const value of ['Simplified Chinese', 'zh', 'Japanese', 'English']) {
      expect(wantsTaiwanVocabulary(value), value).toBe(false);
    }
  });
});
