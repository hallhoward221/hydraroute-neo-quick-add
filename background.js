importScripts(
  'lib/tldts.umd.min.js',
  'lib/util.js',
  'lib/domain.js',
  'lib/parser.js',
  'lib/hrweb.js',
  'lib/settings.js'
);

const DNR_RULE_ID = 1001;
const NOTIFICATION_PREFIX = 'hrneo-quick-add-';
const DEFAULT_TITLE = 'Добавить сайт в HydraRoute Neo';

const RKN_CACHE_KEY = 'rknCache';
const RKN_JOB_KEY = 'rknJob';
const RKN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const RKN_CACHE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RKN_JOB_TTL_MS = 3 * 60 * 1000;

let busy = false;
let starting = false;
let cooldownTimer = null;

function errorPayload(error) {
  return {
    ok: false,
    error: HRUtil.errorMessage(error),
    code: error && error.code ? error.code : 'ERROR'
  };
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    // Badge is cosmetic.
  }
}

async function notify(title, message) {
  const id = NOTIFICATION_PREFIX + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  try {
    await new Promise(resolve => {
      chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message: HRUtil.truncate(message, 220),
        priority: 1
      }, () => resolve());
    });
    setTimeout(() => {
      try {
        chrome.notifications.clear(id, () => {});
      } catch (e) {
        // Ignore.
      }
    }, 7000);
  } catch (e) {
    // Notifications are cosmetic.
  }
}

async function syncDnrRule(settings) {
  const removeRuleIds = [DNR_RULE_ID];
  const addRules = [];

  if (settings && settings.baseUrl) {
    try {
      const origin = HRUtil.normalizeBaseUrl(settings.baseUrl);
      const pattern = HRUtil.originPattern(origin);
      const granted = await chrome.permissions.contains({ origins: [pattern] });
      if (granted) {
        addRules.push({
          id: DNR_RULE_ID,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'Origin', operation: 'remove' },
              { header: 'Referer', operation: 'remove' }
            ]
          },
          condition: {
            initiatorDomains: [chrome.runtime.id],
            requestMethods: ['post'],
            resourceTypes: ['xmlhttprequest'],
            urlFilter: '|' + origin + '/'
          }
        });
      }
    } catch (e) {
      // Invalid URL is handled when saving settings.
    }
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    await chrome.storage.local.set({
      lastError: {
        at: Date.now(),
        message: 'Не удалось обновить правило DNR: ' + HRUtil.errorMessage(e),
        code: 'DNR_ERROR'
      }
    });
  }
}

async function setupContextMenus() {
  await new Promise(resolve => {
    chrome.contextMenus.removeAll(() => resolve());
  });

  chrome.contextMenus.create({
    id: 'add-current',
    title: 'Добавить текущий сайт в папку',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'add-current-no-rkn',
    title: 'Добавить без проверки РКН',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'check-rkn',
    title: 'Проверить текущий сайт в РКН',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'undo-last',
    title: 'Отменить последнее добавление',
    contexts: ['page']
  });
  chrome.contextMenus.create({
    id: 'options',
    title: 'Настройки HydraRoute Neo',
    contexts: ['action']
  });
  chrome.contextMenus.create({
    id: 'options-page',
    title: 'Настройки',
    contexts: ['page']
  });
}

async function renderCooldown(until) {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  const tick = async () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      if (cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
      await setBadge('', null);
      try {
        await chrome.action.setTitle({ title: DEFAULT_TITLE });
      } catch (e) {}
      return;
    }
    await setBadge(String(left), '#f59e0b');
    try {
      await chrome.action.setTitle({ title: `HydraRoute Neo — подождите ${left} сек.` });
    } catch (e) {}
  };

  await tick();
  cooldownTimer = setInterval(tick, 1000);
}

async function startCooldown(ms) {
  const until = Date.now() + (ms || HRSettings.DEFAULT_COOLDOWN_MS);
  await chrome.storage.local.set({ cooldownUntil: until });
  await renderCooldown(until);
}

async function restoreCooldown() {
  const stored = await chrome.storage.local.get(['cooldownUntil']);
  const until = stored.cooldownUntil || 0;
  if (until > Date.now()) {
    await renderCooldown(until);
  } else {
    await setBadge('', null);
    try {
      await chrome.action.setTitle({ title: DEFAULT_TITLE });
    } catch (e) {}
  }
}

async function rememberError(error) {
  await chrome.storage.local.set({
    lastError: {
      at: Date.now(),
      message: HRUtil.errorMessage(error),
      code: error && error.code ? error.code : 'ERROR'
    }
  });
}

function duplicateLabel(result) {
  const entry = result.duplicate && result.duplicate.entry;
  if (!entry) return '';
  const policy = entry.policy || '';
  const group = entry.description ? ` / ${entry.description}` : '';
  return policy + group;
}

function matchesText(matches) {
  return Array.isArray(matches) && matches.length
    ? ` Совпадения: ${matches.slice(0, 3).join(', ')}${matches.length > 3 ? '…' : ''}.`
    : '';
}

function rknCacheKey(domain) {
  return HRDomain.normalizeHost(domain);
}

function rknUrl(domain) {
  return 'https://2whois.ru/rkn/?data=' + encodeURIComponent(domain);
}

function uniqueRknDomains(site) {
  const list = [site.domain, site.root]
    .filter(Boolean)
    .map(rknCacheKey)
    .filter(Boolean);
  return [...new Set(list)];
}

async function getRknCache(domain) {
  const key = rknCacheKey(domain);
  if (!key) return null;
  const stored = await chrome.storage.local.get(RKN_CACHE_KEY);
  const cache = stored[RKN_CACHE_KEY] || {};
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - (entry.at || 0) > RKN_CACHE_TTL_MS) {
    delete cache[key];
    await chrome.storage.local.set({ [RKN_CACHE_KEY]: cache });
    return null;
  }
  return entry;
}

async function setRknCache(domain, result) {
  const key = rknCacheKey(domain);
  if (!key) return;
  const stored = await chrome.storage.local.get(RKN_CACHE_KEY);
  const cache = stored[RKN_CACHE_KEY] || {};
  cache[key] = {
    found: !!result.found,
    matches: Array.isArray(result.matches) ? result.matches.slice(0, 10) : [],
    at: Date.now()
  };

  const cutoff = Date.now() - RKN_CACHE_RETENTION_MS;
  for (const [name, entry] of Object.entries(cache)) {
    if (!entry || !entry.at || entry.at < cutoff) delete cache[name];
  }
  const entries = Object.entries(cache).sort((a, b) => b[1].at - a[1].at);
  for (let i = 500; i < entries.length; i++) delete cache[entries[i][0]];

  await chrome.storage.local.set({ [RKN_CACHE_KEY]: cache });
}

async function setRknCacheForJob(job, result) {
  for (const domain of job.domains || [job.domain]) {
    await setRknCache(domain, result);
  }
}

async function getRknCacheCount() {
  const stored = await chrome.storage.local.get(RKN_CACHE_KEY);
  return Object.keys(stored[RKN_CACHE_KEY] || {}).length;
}

async function clearRknCache() {
  await chrome.storage.local.remove([RKN_CACHE_KEY, 'lastRknError', 'lastRknResult']);
}

async function readRknJobRaw() {
  const stored = await chrome.storage.session.get(RKN_JOB_KEY);
  return stored[RKN_JOB_KEY] || null;
}

async function saveRknJob(job) {
  await chrome.storage.session.set({ [RKN_JOB_KEY]: job });
}

async function removeRknJob() {
  await chrome.storage.session.remove(RKN_JOB_KEY);
}

async function closeRknTab(job) {
  if (!job || !job.tabId) return;
  try {
    await chrome.tabs.remove(job.tabId);
  } catch (e) {
    // The tab may already be closed.
  }
}

async function closeRknTabIfBackground(job) {
  if (!job || !job.tabId) return;
  try {
    const tab = await chrome.tabs.get(job.tabId);
    if (tab.pinned) return;
    let windowFocused = true;
    if (tab.windowId != null) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        windowFocused = !!win.focused;
      } catch (e) {
        windowFocused = true;
      }
    }
    const foreground = !!tab.active && windowFocused;
    if (!foreground) {
      await chrome.tabs.remove(job.tabId);
    }
  } catch (e) {
    // The tab may already be closed.
  }
}

async function focusRknTab(job) {
  if (!job || !job.tabId) return;
  try {
    const tab = await chrome.tabs.update(job.tabId, { active: true });
    if (tab && tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    // The tab may be gone.
  }
}

async function getRknJob() {
  const job = await readRknJobRaw();
  if (!job) return null;
  if (Date.now() - (job.createdAt || 0) > RKN_JOB_TTL_MS) {
    await removeRknJob();
    await closeRknTab(job);
    await restoreCooldown();
    return null;
  }
  return job;
}

function scheduleRknTimeout(jobId) {
  setTimeout(async () => {
    try {
      const job = await readRknJobRaw();
      if (!job || job.id !== jobId) return;
      await removeRknJob();
      await closeRknTab(job);
      await notify('Проверка РКН не завершена', `${job.domain}: 2whois не ответил вовремя. Попробуйте ещё раз.`);
      await restoreCooldown();
    } catch (e) {
      // Ignore.
    }
  }, RKN_JOB_TTL_MS + 1000);
}

async function pollRknJob(jobId, tabId) {
  for (let i = 0; i < 180; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const job = await getRknJob();
    if (!job || job.id !== jobId) return;
    try {
      const state = await chrome.tabs.sendMessage(tabId, { type: 'getRknState' });
      if (state && state.type === 'rknPageState') {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) await handleRknPageState(state, { tab });
      }
    } catch (e) {
      // The content script may not be ready yet.
    }
  }
}

async function startRknJob(site, settings, mode) {
  const existing = await getRknJob();
  if (existing) {
    await focusRknTab(existing);
    await notify('Уже проверяю РКН', `${existing.domain}: дождитесь результата или подтвердите проверку на 2whois.`);
    return { status: 'busy', job: existing };
  }

  const domains = uniqueRknDomains(site);
  if (!domains.length) throw new Error('Не удалось определить домен для проверки РКН.');

  const job = {
    id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    createdAt: Date.now(),
    domain: domains[0],
    targetDomain: site.domain,
    domains,
    index: 0,
    target: settings && settings.target ? settings.target : null,
    mode,
    tabId: null,
    stage: 'loading',
    challenged: false
  };

  const tab = await chrome.tabs.create({
    url: rknUrl(job.domain),
    active: false
  });
  job.tabId = tab.id;

  await saveRknJob(job);
  await setBadge('РКН', '#0ea5e9');
  await chrome.storage.local.remove('lastRknError').catch(() => {});
  await notify('Проверяю РКН', `${job.domain}: проверяю реестр 2whois…`);
  scheduleRknTimeout(job.id);
  pollRknJob(job.id, job.tabId).catch(() => {});
  return { status: 'started', job };
}

async function finishRknJob(job, result) {
  await removeRknJob();
  await setRknCacheForJob(job, result);
  await chrome.storage.local.remove('lastRknError').catch(() => {});
  const targetDomain = job.targetDomain || job.domain;
  await chrome.storage.local.set({
    lastRknResult: {
      domain: targetDomain,
      found: !!result.found,
      matches: Array.isArray(result.matches) ? result.matches.slice(0, 10) : [],
      at: Date.now()
    }
  }).catch(() => {});

  if (job.mode === 'check') {
    await notify(
      result.found ? 'РКН: найден' : 'РКН: не найден',
      result.found
        ? `${targetDomain} найден в реестре РКН.${matchesText(result.matches)}`
        : `${targetDomain} не найден в реестре РКН.`
    );
    await restoreCooldown();
    await closeRknTabIfBackground(job);
    return;
  }

  if (!result.found) {
    await notify(
      'В РКН не найден',
      `${targetDomain} не найден в реестре РКН. Добавлять не нужно.`
    );
    await closeRknTab(job);
    await restoreCooldown();
    return;
  }

  await notify(
    'В РКН найден',
    `${targetDomain} найден в реестре РКН.${matchesText(result.matches)} Добавляю в HydraRoute Neo…`
  );

  const settings = await HRSettings.getSettings();
  const stored = await chrome.storage.local.get(['cooldownUntil']);
  if (stored.cooldownUntil && stored.cooldownUntil > Date.now()) {
    const left = Math.ceil((stored.cooldownUntil - Date.now()) / 1000);
    await notify('Пауза', `Домен найден, но следующее добавление будет доступно через ${left} сек. Повторите позже.`);
    await closeRknTab(job);
    await restoreCooldown();
    return;
  }

  try {
    await addDomainToHrneo(settings, job.target, { domain: targetDomain });
  } finally {
    await closeRknTab(job);
  }
}

async function handleRknPageState(message, sender) {
  if (!message || message.type !== 'rknPageState') return;
  const job = await getRknJob();
  if (!job || !sender.tab || sender.tab.id !== job.tabId) return;

  if (message.domain) {
    const pageDomain = rknCacheKey(message.domain);
    if (pageDomain && pageDomain !== job.domain) return;
  }

  if (message.state === 'blocked') {
    await removeRknJob();
    await closeRknTab(job);
    await notify(
      '2whois временно недоступен',
      '2whois ограничил доступ к проверке. Попробуйте позже или добавьте домен без проверки РКН.'
    );
    await restoreCooldown();
    return;
  }

  if (message.state === 'challenge') {
    if (!job.challenged) {
      job.challenged = true;
      job.stage = 'challenge';
      await saveRknJob(job);
      await focusRknTab(job);
      await notify(
        'Подтвердите проверку',
        '2whois просит подтвердить, что вы человек. Нажмите «Я человек» на открывшейся странице — дальше проверка продолжится автоматически.'
      );
    }
    return;
  }

  if (message.state === 'unknown') {
    if (!job.unknownSince) {
      job.unknownSince = Date.now();
      await saveRknJob(job);
    } else if (!job.unknownNotified && Date.now() - job.unknownSince > 20000) {
      job.unknownNotified = true;
      await saveRknJob(job);
      await notify(
        '2whois не вернул результат',
        `${job.domain}: страница загрузилась, но результат не распознан. Если на вкладке есть проверка «Я человек», подтвердите её.`
      );
    }
    return;
  }

  if (message.state === 'found') {
    await finishRknJob(job, {
      found: true,
      matches: Array.isArray(message.matches) ? message.matches : []
    });
    return;
  }

  if (message.state === 'not_found') {
    await setRknCache(job.domain, { found: false, matches: [] });

    if (job.index + 1 < job.domains.length) {
      const previous = job.domain;
      job.index += 1;
      job.domain = job.domains[job.index];
      job.stage = 'loading';
      job.challenged = false;
      await saveRknJob(job);
      try {
        await chrome.tabs.update(job.tabId, { url: rknUrl(job.domain) });
      } catch (e) {
        await notify('Проверка РКН', `${job.domain}: не удалось открыть страницу 2whois.`);
        return;
      }
      await notify('Проверяю РКН', `${previous} не найден, проверяю ${job.domain}…`);
      return;
    }

    await finishRknJob(job, { found: false, matches: [] });
  }
}

async function restoreRknJob() {
  const job = await readRknJobRaw();
  if (!job) return;
  if (Date.now() - (job.createdAt || 0) > RKN_JOB_TTL_MS) {
    await removeRknJob();
    await closeRknTab(job);
    await restoreCooldown();
    return;
  }
  try {
    await chrome.tabs.get(job.tabId);
  } catch (e) {
    await removeRknJob();
    await restoreCooldown();
    return;
  }
  await setBadge('РКН', '#0ea5e9');
  scheduleRknTimeout(job.id);
}

async function addDomainToHrneo(settings, target, site) {
  if (busy) {
    await notify('Сейчас занято', 'Дождитесь завершения текущей операции.');
    return { status: 'busy' };
  }

  busy = true;
  await setBadge('…', '#0ea5e9');

  try {
    const client = new HRWebClient(settings);
    const result = await client.addDomain(target, site.domain);
    const label = HRParser.targetLabel(target);

    if (result.status === 'duplicate' || result.status === 'covered') {
      const where = duplicateLabel(result);
      await notify(
        'Уже есть в правилах',
        `${site.domain} уже добавлен${where ? ` в «${where}»` : ''}.`
      );
      await setBadge('', null);
      return result;
    }

    if (result.status === 'added') {
      const undo = {
        at: Date.now(),
        beforeDomainFile: result.beforeDomainFile,
        beforeCidrFile: result.beforeCidrFile,
        policyOrder: result.state.policyOrder || '',
        afterHash: HRUtil.hashText(result.afterDomainFile),
        domain: site.domain,
        target
      };
      try {
        await chrome.storage.local.set({ lastUndo: undo });
      } catch (e) {
        await chrome.storage.local.remove('lastUndo').catch(() => {});
      }

      const warning = result.warning || (result.inserted && result.inserted.warning);
      await startCooldown(settings.cooldownMs || HRSettings.DEFAULT_COOLDOWN_MS);
      await chrome.storage.local.remove('lastError').catch(() => {});
      await notify(
        'Добавлено',
        `${site.domain} → ${label}${warning ? `\n${warning}` : ''}`
      );
    }

    return result;
  } catch (error) {
    await rememberError(error);
    await setBadge('!', '#ef4444');
    setTimeout(() => {
      restoreCooldown().catch(() => {});
    }, 2500);
    await notify('Ошибка добавления', HRUtil.errorMessage(error));
    return { status: 'error', error };
  } finally {
    busy = false;
  }
}

async function checkRkn(site, settings, options) {
  const opts = options || {};
  const cached = await getRknCache(site.domain);

  if (cached && !opts.force) {
    if (opts.mode === 'check') {
      await notify(
        cached.found ? 'РКН: найден' : 'РКН: не найден',
        cached.found
          ? `${site.domain} найден в реестре РКН.${matchesText(cached.matches)}`
          : `${site.domain} не найден в реестре РКН.`
      );
      return;
    }

    if (cached.found) {
      await notify('В РКН найден', `${site.domain} найден в реестре РКН.${matchesText(cached.matches)} Добавляю…`);
      await addDomainToHrneo(settings, settings.target, site);
    } else {
      await notify('В РКН не найден', `${site.domain} не найден в реестре РКН. Добавлять не нужно.`);
    }
    return;
  }

  await startRknJob(site, settings, opts.mode || 'add');
}

async function handleAdd(tab, options) {
  const opts = options || {};

  if (starting) {
    await notify('Уже обрабатываю', 'Дождитесь завершения текущей операции.');
    return;
  }
  starting = true;

  try {
    const settings = await HRSettings.getSettings();

    if (!opts.checkOnly) {
      const stored = await chrome.storage.local.get(['cooldownUntil']);
      if (stored.cooldownUntil && stored.cooldownUntil > Date.now()) {
        const left = Math.ceil((stored.cooldownUntil - Date.now()) / 1000);
        await notify('Подождите', `Следующее добавление будет доступно через ${left} сек.`);
        return;
      }

      if (!settings.baseUrl || !settings.login || !settings.password) {
        await notify('Нужна настройка', 'Укажите адрес HRweb, логин и пароль роутера в настройках расширения.');
        chrome.runtime.openOptionsPage();
        return;
      }

      if (!settings.target || !settings.target.policy) {
        await notify('Нужна настройка', 'Выберите папку правил в настройках расширения.');
        chrome.runtime.openOptionsPage();
        return;
      }
    }

    let currentTab = tab;
    if ((!currentTab || (!currentTab.pendingUrl && !currentTab.url)) && currentTab && currentTab.id != null) {
      try {
        currentTab = await chrome.tabs.get(currentTab.id);
      } catch (e) {
        // Keep the event tab object.
      }
    }

    let pageUrl = currentTab && (currentTab.pendingUrl || currentTab.url);
    if (pageUrl && /^(chrome|edge)-error:/i.test(pageUrl) && currentTab.url && /^https?:/i.test(currentTab.url)) {
      pageUrl = currentTab.url;
    }
    if (!pageUrl) {
      await notify('Не удалось определить сайт', 'Начните переход на сайт (нажмите Enter) и повторите.');
      return;
    }

    const site = HRDomain.extractDomain(pageUrl, {
      mode: settings.domainMode,
      stripWww: settings.stripWww
    });

    if (site.kind === 'ip') {
      throw new Error('Это IP-адрес. Расширение пока добавляет только домены.');
    }
    if (site.kind === 'local') {
      throw new Error('Локальные адреса (localhost/.local) не добавляются в правила.');
    }

    if (opts.checkOnly) {
      await checkRkn(site, settings, { mode: 'check', force: true });
      return;
    }

    if (!opts.skipRkn && settings.rknCheck !== false) {
      await checkRkn(site, settings, { mode: 'add', force: false });
      return;
    }

    await addDomainToHrneo(settings, settings.target, site);
  } catch (error) {
    await rememberError(error);
    await setBadge('!', '#ef4444');
    setTimeout(() => {
      restoreCooldown().catch(() => {});
    }, 2500);
    await notify('Ошибка добавления', HRUtil.errorMessage(error));
  } finally {
    starting = false;
  }
}

async function undoLast() {
  if (busy) {
    await notify('Сейчас занято', 'Дождитесь завершения текущей операции.');
    return;
  }
  busy = true;

  try {
    const settings = await HRSettings.getSettings();
    const stored = await chrome.storage.local.get(['lastUndo', 'cooldownUntil']);

    if (stored.cooldownUntil && stored.cooldownUntil > Date.now()) {
      const left = Math.ceil((stored.cooldownUntil - Date.now()) / 1000);
      await notify('Подождите', `Отмена будет доступна через ${left} сек.`);
      return;
    }

    const undo = stored.lastUndo;
    if (!undo) {
      await notify('Нечего отменять', 'Последнее добавление не найдено.');
      return;
    }
    if (Date.now() - undo.at > 5 * 60 * 1000) {
      await chrome.storage.local.remove('lastUndo');
      await notify('Отмена недоступна', 'Прошло больше 5 минут. Измените правило в HRweb вручную.');
      return;
    }

    if (!settings.baseUrl || !settings.login || !settings.password) {
      throw new Error('Укажите адрес HRweb, логин и пароль роутера в настройках расширения.');
    }

    await setBadge('↺', '#0ea5e9');

    const client = new HRWebClient(settings);
    await client.ensureSession();
    const config = await client.getConfig();

    if (HRUtil.hashText(config.domainFile || '') !== undo.afterHash) {
      throw new Error('Правила изменились после добавления. Отмена отменена, чтобы не потерять правки.');
    }

    await client.saveConfig({
      domainFile: undo.beforeDomainFile,
      cidrFile: undo.beforeCidrFile,
      policyOrder: undo.policyOrder
    });

    await chrome.storage.local.remove('lastUndo');
    await startCooldown(settings.cooldownMs || HRSettings.DEFAULT_COOLDOWN_MS);
    await chrome.storage.local.remove('lastError').catch(() => {});
    await notify('Отменено', `${undo.domain} удалён из правил.`);
  } catch (error) {
    await rememberError(error);
    await setBadge('!', '#ef4444');
    setTimeout(() => {
      restoreCooldown().catch(() => {});
    }, 2500);
    await notify('Ошибка отмены', HRUtil.errorMessage(error));
  } finally {
    busy = false;
  }
}

async function handleMessage(message) {
  switch (message && message.type) {
    case 'getState': {
      const state = await HRSettings.getState();
      if (state.lastUndo) {
        state.lastUndo = {
          at: state.lastUndo.at,
          domain: state.lastUndo.domain,
          target: state.lastUndo.target
        };
      }
      state.rknCacheCount = await getRknCacheCount();
      const rknMeta = await chrome.storage.local.get(['lastRknError', 'lastRknResult']);
      state.lastRknError = rknMeta.lastRknError || null;
      state.lastRknResult = rknMeta.lastRknResult || null;
      const rawJob = await readRknJobRaw();
      state.rknJob = rawJob
        ? { domain: rawJob.domain, mode: rawJob.mode, stage: rawJob.stage, createdAt: rawJob.createdAt }
        : null;
      state.dnrRule = await chrome.declarativeNetRequest.getDynamicRules()
        .then(rules => rules.find(rule => rule.id === DNR_RULE_ID) || null)
        .catch(() => null);
      return { ok: true, state };
    }

    case 'saveSettings': {
      const settings = await HRSettings.saveSettings(message.settings || {});
      await syncDnrRule(settings);
      return { ok: true, settings: HRSettings.sanitizeSettings(settings) };
    }

    case 'testConnection': {
      const settings = await HRSettings.getSettings();
      const client = new HRWebClient(settings);
      await client.ensureSession();
      const info = await client.getInfo();
      await chrome.storage.local.remove('lastError').catch(() => {});
      return { ok: true, info };
    }

    case 'getTargets': {
      const settings = await HRSettings.getSettings();
      const client = new HRWebClient(settings);
      const data = await client.getTargets();
      const cache = {
        at: Date.now(),
        info: data.info,
        targets: data.targets,
        policyOrder: data.policyOrder
      };
      await chrome.storage.local.set({ targetsCache: cache });
      await chrome.storage.local.remove('lastError').catch(() => {});
      return { ok: true, cache };
    }

    case 'clearPassword': {
      const settings = await HRSettings.clearPassword();
      return { ok: true, settings: HRSettings.sanitizeSettings(settings) };
    }

    case 'clearRknCache': {
      await clearRknCache();
      return { ok: true };
    }

    case 'undoLast': {
      await undoLast();
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Неизвестный метод' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'rknPageState') {
    handleRknPageState(message, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(async error => {
        await chrome.storage.local.set({
          lastRknError: {
            at: Date.now(),
            message: HRUtil.errorMessage(error),
            stack: error && error.stack ? String(error.stack).slice(0, 2000) : ''
          }
        }).catch(() => {});
        sendResponse({ ok: false, error: HRUtil.errorMessage(error) });
      });
    return true;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch(error => sendResponse(errorPayload(error)));
  return true;
});

chrome.action.onClicked.addListener(tab => {
  handleAdd(tab).catch(error => rememberError(error));
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'add-current') return;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs && tabs[0]) await handleAdd(tabs[0]);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'add-current') {
    await handleAdd(tab);
  } else if (info.menuItemId === 'add-current-no-rkn') {
    await handleAdd(tab, { skipRkn: true });
  } else if (info.menuItemId === 'check-rkn') {
    await handleAdd(tab, { checkOnly: true });
  } else if (info.menuItemId === 'undo-last') {
    await undoLast();
  } else if (info.menuItemId === 'options' || info.menuItemId === 'options-page') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const job = await readRknJobRaw();
  if (!job || job.tabId !== tabId) return;
  await removeRknJob();
  if (job.mode === 'add') {
    await notify('Проверка РКН отменена', `${job.domain}: вкладка 2whois закрыта.`);
  }
  await restoreCooldown();
});

// Deliberately do not cancel the RKN job on tabs.onUpdated: the 2whois WAF
// can redirect through intermediate URLs. The job is cancelled on tab close
// or by its timeout.

chrome.runtime.onInstalled.addListener(async details => {
  await setupContextMenus();
  const settings = await HRSettings.getSettings();
  await syncDnrRule(settings);
  await restoreCooldown();
  await restoreRknJob();

  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await setupContextMenus();
  const settings = await HRSettings.getSettings();
  await syncDnrRule(settings);
  await restoreCooldown();
  await restoreRknJob();
});

restoreCooldown().catch(() => {});
