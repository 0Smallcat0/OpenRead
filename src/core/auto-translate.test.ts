/**
 * Auto-translation is the one feature here whose failure mode is the extension
 * damaging a page nobody asked it to touch. These tests are mostly about the
 * cases where the honest answer is "I do not know", and what it does then.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldAutoTranslate,
  compareLanguage,
  isExcepted,
  type AutoTranslateContext,
} from './auto-translate';

function context(
  overrides: Partial<AutoTranslateContext> = {},
): AutoTranslateContext {
  return {
    mode: 'foreign',
    host: 'example.com',
    except: [],
    pageLang: 'en',
    sample: 'The first paragraph of the article body.',
    targetLang: 'Traditional Chinese',
    ...overrides,
  };
}

describe('compareLanguage', () => {
  it('reads a region as a script where the tag omits one', () => {
    // `zh-TW` outnumbers `zh-Hant-TW` on the real web by a wide margin, and a
    // reader of Traditional Chinese must not have zh-TW pages translated at
    // them.
    expect(compareLanguage('zh-TW', 'Traditional Chinese')).toBe('same');
    expect(compareLanguage('zh-HK', 'Traditional Chinese')).toBe('same');
    expect(compareLanguage('zh-CN', 'Traditional Chinese')).toBe('different');
    expect(compareLanguage('zh-Hans', 'Traditional Chinese')).toBe('different');
  });

  it('calls bare zh unknown rather than guessing a script', () => {
    // Both scripts are common under this tag. The text decides, not the tag.
    expect(compareLanguage('zh', 'Traditional Chinese')).toBe('unknown');
    expect(compareLanguage('zh', 'Simplified Chinese')).toBe('unknown');
  });

  it('ignores region for everything that is not Chinese', () => {
    // Austrian German is German, and a reader who asked for German does not
    // want de-AT pages rewritten at them.
    expect(compareLanguage('en-GB', 'English')).toBe('same');
    expect(compareLanguage('en-US', 'English')).toBe('same');
    expect(compareLanguage('de-AT', 'German')).toBe('same');
    expect(compareLanguage('de-AT', 'English')).toBe('different');
  });

  it('is case- and whitespace-insensitive, as `lang` attributes are', () => {
    expect(compareLanguage(' EN-us ', 'English')).toBe('same');
    expect(compareLanguage('ZH-hant', 'Traditional Chinese')).toBe('same');
  });
});

describe('isExcepted', () => {
  it('covers subdomains of a listed host', () => {
    // "Never on this site" is what the checkbox says. Nobody means "never on
    // the exact hostname I happened to be on".
    expect(isExcepted('news.example.com', ['example.com'])).toBe(true);
    expect(isExcepted('example.com', ['example.com'])).toBe(true);
  });

  it('ignores www on either side', () => {
    expect(isExcepted('www.example.com', ['example.com'])).toBe(true);
    expect(isExcepted('example.com', ['www.example.com'])).toBe(true);
  });

  it('does not match a host that merely ends in the same letters', () => {
    expect(isExcepted('notexample.com', ['example.com'])).toBe(false);
    expect(isExcepted('example.com.evil.test', ['example.com'])).toBe(false);
  });

  it('ignores blank entries rather than excluding everything', () => {
    expect(isExcepted('example.com', ['', '   '])).toBe(false);
  });
});

describe('shouldAutoTranslate', () => {
  it('does nothing at all when off', () => {
    expect(shouldAutoTranslate(context({ mode: 'off', pageLang: 'fr' }))).toBe(
      false,
    );
  });

  it('translates a page that says it is in another language', () => {
    expect(shouldAutoTranslate(context({ pageLang: 'en' }))).toBe(true);
  });

  it('leaves a page that is already in the target language alone', () => {
    expect(shouldAutoTranslate(context({ pageLang: 'zh-TW' }))).toBe(false);
  });

  it('leaves a page alone when it does not say what it is', () => {
    // Reading the text would mean guessing which Latin-script language it is,
    // and that guess ends with an English page translated into English on
    // every load. A missed auto-translation costs one keypress.
    expect(shouldAutoTranslate(context({ pageLang: null }))).toBe(false);
    expect(shouldAutoTranslate(context({ pageLang: '  ' }))).toBe(false);
  });

  it('reads the text when the tag is an ambiguous zh', () => {
    const traditional = context({
      pageLang: 'zh',
      sample: '這是一段繁體中文的內容，用來測試偵測。',
    });
    const simplified = context({
      pageLang: 'zh',
      sample: '这是一段简体中文的内容，用来测试检测。',
    });
    expect(shouldAutoTranslate(traditional)).toBe(false);
    expect(shouldAutoTranslate(simplified)).toBe(true);
  });

  it('translates everything on `always`, including the target language', () => {
    // For a reader whose language no page declares, and for the templated
    // sites that declare `en` on pages that are not.
    expect(
      shouldAutoTranslate(context({ mode: 'always', pageLang: 'zh-TW' })),
    ).toBe(true);
    expect(
      shouldAutoTranslate(context({ mode: 'always', pageLang: null })),
    ).toBe(true);
  });

  it('honours an excluded host even on `always`', () => {
    expect(
      shouldAutoTranslate(
        context({
          mode: 'always',
          host: 'news.example.com',
          except: ['example.com'],
        }),
      ),
    ).toBe(false);
  });
});
