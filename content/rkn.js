(function () {
  'use strict';

  if (window.top !== window) return;

  try {
    document.documentElement.dataset.hrneoRkn = 'loaded';
  } catch (e) {
    // Ignore.
  }

  let lastSignature = '';
  let stopped = false;

  function getDomain() {
    try {
      const url = new URL(location.href);
      const data = url.searchParams.get('data');
      if (data) return data.trim().toLowerCase();
      const input = document.getElementById('twowhois-data');
      if (input && input.value) return input.value.trim().toLowerCase();
    } catch (e) {
      // Ignore.
    }
    return null;
  }

  function looksLikeTarget(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 253) return false;
    if (/^\*?\.[a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) return true;
    if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(text)) return true;
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(text)) return true;
    if (text.includes(':') && /^[0-9a-f:]+(?:\/\d{1,3})?$/i.test(text)) return true;
    return false;
  }

  function extractMatches(text) {
    const matches = [];
    const add = value => {
      const item = String(value || '').trim();
      if (!item || !looksLikeTarget(item)) return;
      if (!matches.includes(item)) matches.push(item);
    };

    for (const row of document.querySelectorAll('tr')) {
      for (const cell of row.querySelectorAll('td, th')) {
        add(cell.innerText || cell.textContent);
      }
    }

    const start = text.indexOf('Совпадения в реестре');
    if (start !== -1) {
      const end = text.indexOf('Что можно сделать', start);
      const block = text.slice(start, end === -1 ? start + 3000 : end);
      for (const line of block.split('\n')) add(line);
    }

    return matches.slice(0, 10);
  }

  function readState() {
    const text = (document.body && document.body.innerText) || '';
    const domain = getDomain();

    if (/Доступ временно ограничен|Защита сайта остановила этот запрос|Доступ ограничен/i.test(text)) {
      return { domain, state: 'blocked', matches: [], url: location.href, title: document.title };
    }

    if (/Проверяем, что вы не робот|Подтвердите, что вы человек|Проверка доступа/i.test(text) &&
        !/Сводная информация|В реестре не найден|найден в реестре РКН/i.test(text)) {
      return { domain, state: 'challenge', matches: [], url: location.href, title: document.title };
    }

    if (/не найден в реестре РКН|В реестре не найден/i.test(text)) {
      return { domain, state: 'not_found', matches: [], url: location.href, title: document.title };
    }

    if (/Есть совпадение в реестре РКН|найден в реестре РКН/i.test(text)) {
      return { domain, state: 'found', matches: extractMatches(text), url: location.href, title: document.title };
    }

    return { domain, state: 'unknown', matches: [], url: location.href, title: document.title };
  }

  function payload() {
    return { type: 'rknPageState', ...readState(), at: Date.now() };
  }

  function sendState(force) {
    if (stopped) return;
    const state = payload();
    if (!state.domain && state.state !== 'challenge') return;
    const signature = JSON.stringify([state.domain, state.state, state.matches, state.title]);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;
    try {
      chrome.runtime.sendMessage(state, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // The service worker may be restarting.
    }
  }

  let debounce = null;
  function scheduleSend() {
    clearTimeout(debounce);
    debounce = setTimeout(() => sendState(true), 150);
  }

  try {
    const observer = new MutationObserver(scheduleSend);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(() => observer.disconnect(), 175000);
  } catch (e) {
    // Ignore.
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'getRknState') {
      sendResponse(payload());
      return false;
    }
    return false;
  });

  sendState(true);

  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
    if (ticks > 115) {
      stopped = true;
      clearInterval(timer);
      return;
    }
    sendState(true);
  }, 1500);
})();
