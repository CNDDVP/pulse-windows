// @vitest-environment jsdom
// Round 5c 项目一：t() 纯函数单测——缺 key 回退 zh、vars 插值、<html lang> 同步。
import {afterEach, describe, expect, it} from 'vitest';
import {applyDocumentLang, dictionaries, documentLang, getLang, normalizeLang, setLang, t, translate} from './i18n';

afterEach(() => {
  setLang('zh');
  delete dictionaries.zh['test.only_zh'];
});

describe('t() 语言选择与回退', () => {
  it('默认语言是 zh', () => {
    expect(getLang()).toBe('zh');
    expect(t('spend.scan')).toBe('读取使用记录');
  });

  it('setLang(en) 后 t() 返回英文', () => {
    setLang('en');
    expect(t('spend.scan')).toBe('Read usage records');
    expect(t('spend.title')).toBe('Token Spend');
  });

  it('en 缺 key 回退 zh（诚实文案不弱化：回退即中文原文）', () => {
    dictionaries.zh['test.only_zh'] = '仅中文登记的诚实口径';
    expect(translate('en', 'test.only_zh')).toBe('仅中文登记的诚实口径');
    setLang('en');
    expect(t('test.only_zh')).toBe('仅中文登记的诚实口径');
  });

  it('两边都缺 key 原样返回 key，绝不静默编造文案', () => {
    expect(translate('zh', 'spend.no_such_key')).toBe('spend.no_such_key');
    expect(translate('en', 'spend.no_such_key')).toBe('spend.no_such_key');
  });

  it('translate() 是纯函数：不读写模块级当前语言', () => {
    setLang('en');
    expect(translate('zh', 'spend.scan')).toBe('读取使用记录');
    expect(getLang()).toBe('en');
    expect(t('spend.scan')).toBe('Read usage records');
  });
});

describe('t() vars 插值', () => {
  it('zh 插值', () => {
    expect(t('spend.days_option', {days: 30})).toBe('最近 30 天');
  });

  it('en 插值', () => {
    setLang('en');
    expect(t('spend.days_option', {days: 7})).toBe('Last 7 days');
    expect(t('spend.exported_to', {path: 'D:\\x\\a.csv'})).toBe('Exported to D:\\x\\a.csv');
  });

  it('vars 缺某占位符时保留 {name} 原文，不吞不编', () => {
    expect(translate('zh', 'spend.exported_to')).toBe('已导出到 {path}');
    expect(translate('zh', 'spend.exported_to', {other: 1})).toBe('已导出到 {path}');
  });

  it('vars 接受字符串与数字', () => {
    expect(translate('en', 'spend.days_option', {days: '90'})).toBe('Last 90 days');
  });
});

describe('语言规范化与 <html lang> 同步', () => {
  it('normalizeLang 白名单：仅 en 通过，其余（含脏值）回落 zh', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('zh')).toBe('zh');
    expect(normalizeLang('EN')).toBe('zh');
    expect(normalizeLang('fr')).toBe('zh');
    expect(normalizeLang(undefined)).toBe('zh');
    expect(normalizeLang(null)).toBe('zh');
    expect(normalizeLang(42)).toBe('zh');
  });

  it('documentLang 映射：zh→zh-CN，en→en', () => {
    expect(documentLang('zh')).toBe('zh-CN');
    expect(documentLang('en')).toBe('en');
  });

  it('setLang 同步 document.documentElement.lang；applyDocumentLang 可独立调用', () => {
    setLang('en');
    expect(document.documentElement.lang).toBe('en');
    setLang('zh');
    expect(document.documentElement.lang).toBe('zh-CN');
    applyDocumentLang('en');
    expect(document.documentElement.lang).toBe('en');
    applyDocumentLang('zh');
  });
});
