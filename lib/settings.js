(function () {
  'use strict';

  const STORAGE_KEY = 'settings';
  const DEFAULT_COOLDOWN_MS = 10000;

  const DEFAULTS = {
    baseUrl: 'http://192.168.1.1:2000',
    login: 'admin',
    password: '',
    target: null,
    domainMode: 'exact',
    stripWww: false,
    rknCheck: true,
    cooldownMs: DEFAULT_COOLDOWN_MS
  };

  async function getSettings() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const settings = stored && stored[STORAGE_KEY] ? stored[STORAGE_KEY] : {};
    return { ...DEFAULTS, ...settings, cooldownMs: DEFAULT_COOLDOWN_MS };
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const next = { ...current };

    if (patch.baseUrl !== undefined) next.baseUrl = HRUtil.normalizeBaseUrl(patch.baseUrl);
    if (patch.login !== undefined) next.login = String(patch.login || '').trim();
    if (patch.password !== undefined) next.password = String(patch.password || '');
    if (patch.target !== undefined) next.target = patch.target || null;
    if (patch.domainMode !== undefined) {
      next.domainMode = patch.domainMode === 'exact' ? 'exact' : 'root';
    }
    if (patch.stripWww !== undefined) next.stripWww = !!patch.stripWww;
    if (patch.rknCheck !== undefined) next.rknCheck = !!patch.rknCheck;
    next.cooldownMs = DEFAULT_COOLDOWN_MS;

    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return next;
  }

  async function clearPassword() {
    return saveSettings({ password: '' });
  }

  function sanitizeSettings(settings) {
    return {
      baseUrl: settings.baseUrl,
      login: settings.login,
      target: settings.target,
      domainMode: settings.domainMode,
      stripWww: settings.stripWww,
      rknCheck: settings.rknCheck !== false,
      cooldownMs: settings.cooldownMs,
      hasPassword: !!settings.password
    };
  }

  async function getState() {
    const settings = await getSettings();
    const stored = await chrome.storage.local.get([
      'cooldownUntil',
      'lastUndo',
      'lastError',
      'targetsCache'
    ]);
    return {
      settings: sanitizeSettings(settings),
      cooldownUntil: stored.cooldownUntil || 0,
      lastUndo: stored.lastUndo || null,
      lastError: stored.lastError || null,
      targetsCache: stored.targetsCache || null
    };
  }

  globalThis.HRSettings = {
    DEFAULTS,
    DEFAULT_COOLDOWN_MS,
    getSettings,
    saveSettings,
    clearPassword,
    sanitizeSettings,
    getState
  };
})();
