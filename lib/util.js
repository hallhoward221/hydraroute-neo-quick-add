(function () {
  'use strict';

  function normalizeBaseUrl(input) {
    let value = String(input || '').trim();
    if (!value) throw new Error('Укажите адрес HRweb, например http://192.168.1.1:2000');
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = 'http://' + value;
    let url;
    try {
      url = new URL(value);
    } catch (e) {
      throw new Error('Некорректный адрес HRweb. Пример: http://192.168.1.1:2000');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Адрес HRweb должен начинаться с http:// или https://');
    }
    return url.origin;
  }

  function originPattern(baseUrl) {
    const url = new URL(normalizeBaseUrl(baseUrl));
    return `${url.protocol}//${url.hostname}/*`;
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    const str = String(text || '');
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function truncate(text, max) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
  }

  function formatTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return '—';
    }
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function errorMessage(error) {
    if (!error) return 'Неизвестная ошибка';
    if (typeof error === 'string') return error;
    return error.message || String(error);
  }

  globalThis.HRUtil = {
    normalizeBaseUrl,
    originPattern,
    hashText,
    sleep,
    truncate,
    formatTime,
    escapeHtml,
    errorMessage
  };
})();
