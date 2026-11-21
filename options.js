(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  let state = {
    settings: null,
    targetsCache: null,
    lastUndo: null,
    lastError: null,
    cooldownUntil: 0,
    hasPassword: false,
    rknCacheCount: 0,
    rknJob: null,
    lastRknError: null,
    lastRknResult: null
  };
  let cooldownTimer = null;
  let connectedInfo = null;

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...(payload || {}) }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('Нет ответа от фонового скрипта расширения.'));
          return;
        }
        if (response.ok === false) {
          const error = new Error(response.error || 'Ошибка расширения');
          error.code = response.code;
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }

  function setStatus(message, type) {
    const el = $('connection-status');
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'status';
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.className = 'status' + (type ? ' ' + type : '');
  }

  function setConnectionPill(text, type) {
    const el = $('connection-pill');
    el.textContent = text;
    el.className = 'pill' + (type ? ' ' + type : '');
  }

  function versionText(value) {
    if (!value) return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (value.version) return String(value.version);
    if (value.hrweb || value.hrneo) {
      return [value.hrweb && `web ${value.hrweb}`, value.hrneo && `neo ${value.hrneo}`]
        .filter(Boolean)
        .join(', ');
    }
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  function targetPreviewText(target) {
    if (!target || !target.policy) return 'Папка не выбрана.';
    return target.group ? `Карточка: ${target.policy} · группа: ${target.group}` : `Карточка: ${target.policy} · группа: авто`;
  }

  async function persistTarget() {
    const target = currentTarget();
    if (!target) return;
    try {
      const saved = await send('saveSettings', { settings: { target } });
      state.settings = saved.settings;
    } catch (e) {
      // Target will be saved by the explicit Save button.
    }
  }

  function updateTargetPreview() {
    const target = currentTarget();
    const el = $('target-preview');
    if (!target.policy) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const cache = state.targetsCache;
    const policy = cache && cache.targets ? cache.targets.find(item => item.policy === target.policy) : null;
    const group = policy && target.groupIndex != null && policy.groups[target.groupIndex]
      ? policy.groups[target.groupIndex]
      : null;
    el.textContent = targetPreviewText(target) + (group ? ` · ${group.count} дом.` : policy ? ` · ${policy.totalDomains} дом.` : '');
  }

  function currentTarget() {
    const policy = $('policy-select').value;
    if (!policy) return null;
    const raw = $('group-select').value;
    if (!raw || raw === 'auto') return { policy, group: null, groupIndex: null };
    try {
      const parsed = JSON.parse(raw);
      return {
        policy,
        group: parsed.group || '',
        groupIndex: Number.isInteger(parsed.groupIndex) ? parsed.groupIndex : null
      };
    } catch (e) {
      return { policy, group: null, groupIndex: null };
    }
  }

  function updatePasswordHint() {
    const hint = $('password-hint');
    if (state.hasPassword) {
      hint.textContent = 'Пароль уже сохранён. Оставьте поле пустым, чтобы не менять его.';
      $('password').placeholder = 'Сохранён — оставьте пустым';
    } else {
      hint.textContent = 'Пароль хранится локально в профиле браузера.';
      $('password').placeholder = 'Пароль роутера';
    }
  }

  function populateTargets(cache, preferredTarget) {
    const policySelect = $('policy-select');
    const groupSelect = $('group-select');
    const targets = cache && Array.isArray(cache.targets) ? cache.targets : [];

    policySelect.replaceChildren();
    groupSelect.replaceChildren();

    if (!targets.length) {
      policySelect.appendChild(new Option('Папки не найдены', ''));
      groupSelect.appendChild(new Option('Сначала загрузите папки', ''));
      policySelect.disabled = true;
      groupSelect.disabled = true;
      updateTargetPreview();
      return;
    }

    for (const item of targets) {
      const label = `${item.policy} · ${item.totalDomains} дом.${item.active ? '' : ' · выкл.'}`;
      policySelect.appendChild(new Option(label, item.policy));
    }

    let policy = preferredTarget && preferredTarget.policy;
    if (!policy || !targets.some(item => item.policy === policy)) {
      policy = targets[0].policy;
    }
    policySelect.value = policy;
    policySelect.disabled = false;

    renderGroups(policy, preferredTarget);
    updateTargetPreview();
  }

  function renderGroups(policyName, preferredTarget) {
    const groupSelect = $('group-select');
    const cache = state.targetsCache;
    const policy = cache && cache.targets
      ? cache.targets.find(item => item.policy === policyName)
      : null;

    groupSelect.replaceChildren();
    if (!policy) {
      groupSelect.appendChild(new Option('Нет данных', ''));
      groupSelect.disabled = true;
      return;
    }

    groupSelect.appendChild(new Option('Авто: первая активная группа', 'auto'));

    for (const group of policy.groups) {
      const suffix = group.active ? '' : ' · выкл.';
      const label = `${group.label} · ${group.count} дом.${suffix}`;
      const value = JSON.stringify({ group: group.description || '', groupIndex: group.index });
      groupSelect.appendChild(new Option(label, value));
    }

    let selected = 'auto';
    if (preferredTarget && preferredTarget.policy === policyName) {
      if (Number.isInteger(preferredTarget.groupIndex)) {
        const match = policy.groups.find(group => group.index === preferredTarget.groupIndex);
        if (match) selected = JSON.stringify({ group: match.description || '', groupIndex: match.index });
      } else if (preferredTarget.group) {
        const match = policy.groups.find(group => group.description === preferredTarget.group);
        if (match) selected = JSON.stringify({ group: match.description || '', groupIndex: match.index });
      }
    }

    groupSelect.value = selected;
    groupSelect.disabled = false;
  }

  function updateDiagnostics() {
    const cache = state.targetsCache;
    const info = connectedInfo || (cache && cache.info) || null;

    $('diag-hrweb').textContent = info ? versionText(info.hrweb || info.web || info) : '—';
    $('diag-hrneo').textContent = info ? versionText(info.hrneo || info.neo) : '—';

    const hasTarget = state.settings && state.settings.target && state.settings.target.policy;
    $('diag-session').textContent = connectedInfo ? 'активна' : (cache ? 'список загружен ранее' : '—');

    if (state.rknJob) {
      $('diag-rkn').textContent = `проверяю ${state.rknJob.domain}${state.rknJob.stage === 'challenge' ? ' — нужно подтверждение' : ''}`;
    } else {
      let text = `кэш: ${state.rknCacheCount || 0} проверок`;
      if (state.lastRknResult) {
        text += ` · последняя: ${state.lastRknResult.domain} — ${state.lastRknResult.found ? 'найден' : 'не найден'}`;
      }
      if (state.lastRknError) {
        text += ` · ошибка: ${state.lastRknError.message}`;
      }
      $('diag-rkn').textContent = text;
    }

    $('diag-last').textContent = state.lastUndo
      ? `${state.lastUndo.domain} → ${state.lastUndo.target ? state.lastUndo.target.policy : '?'} (${HRUtil.formatTime(state.lastUndo.at)})`
      : '—';
    $('diag-error').textContent = state.lastError
      ? `${state.lastError.message} (${HRUtil.formatTime(state.lastError.at)})`
      : '—';

    if (cache && !state.lastUndo && !hasTarget) {
      $('footer-state').textContent = `Загружено папок: ${cache.targets.length}`;
    }
  }

  function updateCooldown(until) {
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) {
        if (cooldownTimer) {
          clearInterval(cooldownTimer);
          cooldownTimer = null;
        }
        $('footer-state').textContent = '';
        return;
      }
      $('footer-state').textContent = `Следующее добавление через ${left} сек.`;
    };
    tick();
    if (until > Date.now()) cooldownTimer = setInterval(tick, 1000);
  }

  function ensurePermission(baseUrl) {
    const pattern = HRUtil.originPattern(baseUrl);
    return new Promise((resolve, reject) => {
      chrome.permissions.request({ origins: [pattern] }, granted => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!granted) {
          reject(new Error('Без доступа к адресу роутера расширение не сможет подключаться к HRweb.'));
          return;
        }
        resolve();
      });
    });
  }

  function readBaseUrl() {
    const raw = $('base-url').value.trim();
    if (!raw) throw new Error('Укажите адрес HRweb, например http://192.168.1.1:2000');
    return HRUtil.normalizeBaseUrl(raw);
  }

  function settingsPatch(baseUrl, includePassword) {
    const patch = {
      baseUrl,
      login: $('login').value.trim(),
      domainMode: document.querySelector('input[name="domain-mode"]:checked').value,
      stripWww: $('strip-www').checked,
      rknCheck: $('rkn-check').checked,
      target: currentTarget()
    };
    if (includePassword) patch.password = $('password').value;
    return patch;
  }

  async function loadState() {
    const response = await send('getState');
    state = {
      ...response.state,
      settings: response.state.settings,
      hasPassword: !!response.state.settings.hasPassword
    };

    const settings = state.settings;
    $('version-pill').textContent = 'v' + chrome.runtime.getManifest().version;
    $('base-url').value = settings.baseUrl || '';
    $('login').value = settings.login || '';
    $('password').value = '';
    $('strip-www').checked = settings.stripWww === true;
    $('rkn-check').checked = settings.rknCheck !== false;

    const mode = settings.domainMode === 'root' ? 'root' : 'exact';
    const radio = document.querySelector(`input[name="domain-mode"][value="${mode}"]`);
    if (radio) radio.checked = true;

    updatePasswordHint();
    updateCooldown(state.cooldownUntil || 0);

    if (state.targetsCache) {
      populateTargets(state.targetsCache, settings.target);
    }

    updateDiagnostics();

    if (state.lastError) {
      setStatus('Последняя ошибка: ' + state.lastError.message, 'err');
    }
  }

  async function connect() {
    let baseUrl;
    try {
      baseUrl = readBaseUrl();
      if (!$('login').value.trim()) throw new Error('Укажите логин роутера.');
      if (!$('password').value && !state.hasPassword) {
        throw new Error('Укажите пароль роутера. Он нужен для автоматического входа в HRweb.');
      }
    } catch (error) {
      setStatus(error.message, 'err');
      return;
    }

    setStatus('Запрашиваю доступ к роутеру…', 'warn');
    try {
      await ensurePermission(baseUrl);
    } catch (error) {
      setStatus(error.message, 'err');
      setConnectionPill('нет доступа', 'bad');
      return;
    }

    setStatus('Сохраняю настройки и подключаюсь…', 'warn');
    setConnectionPill('подключение…');

    try {
      const patch = settingsPatch(baseUrl, !!$('password').value);
      const saved = await send('saveSettings', { settings: patch });
      state.settings = saved.settings;
      state.hasPassword = !!saved.settings.hasPassword;
      updatePasswordHint();

      const test = await send('testConnection');
      connectedInfo = test.info || null;
      setConnectionPill('подключено', 'ok');

      const targetsResponse = await send('getTargets');
      state.targetsCache = targetsResponse.cache;
      populateTargets(state.targetsCache, currentTarget());
      await persistTarget();
      state.lastError = null;
      updateDiagnostics();

      const count = state.targetsCache.targets.length;
      setStatus(`Подключено. Загружено папок: ${count}.`, 'ok');
      $('password').value = '';
    } catch (error) {
      connectedInfo = null;
      setConnectionPill('ошибка', 'bad');
      setStatus(error.message, 'err');
      state.lastError = { at: Date.now(), message: error.message };
      updateDiagnostics();
    }
  }

  async function saveOnly() {
    let baseUrl;
    try {
      baseUrl = readBaseUrl();
      if (!$('login').value.trim()) throw new Error('Укажите логин роутера.');
    } catch (error) {
      setStatus(error.message, 'err');
      return;
    }

    try {
      await ensurePermission(baseUrl);
    } catch (error) {
      setStatus(error.message, 'err');
      return;
    }

    try {
      const patch = settingsPatch(baseUrl, !!$('password').value);
      const saved = await send('saveSettings', { settings: patch });
      state.settings = saved.settings;
      state.hasPassword = !!saved.settings.hasPassword;
      updatePasswordHint();
      $('password').value = '';
      setStatus('Настройки сохранены.', 'ok');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  async function refreshTargets() {
    let baseUrl;
    try {
      baseUrl = readBaseUrl();
    } catch (error) {
      setStatus(error.message, 'err');
      return;
    }

    try {
      await ensurePermission(baseUrl);
    } catch (error) {
      setStatus(error.message, 'err');
      return;
    }

    setStatus('Загружаю список папок…', 'warn');
    try {
      const response = await send('getTargets');
      state.targetsCache = response.cache;
      populateTargets(state.targetsCache, currentTarget());
      await persistTarget();
      connectedInfo = state.targetsCache.info || connectedInfo;
      setConnectionPill('подключено', 'ok');
      state.lastError = null;
      updateDiagnostics();
      setStatus(`Список обновлён. Папок: ${state.targetsCache.targets.length}.`, 'ok');
    } catch (error) {
      setConnectionPill('ошибка', 'bad');
      setStatus(error.message, 'err');
      state.lastError = { at: Date.now(), message: error.message };
      updateDiagnostics();
    }
  }

  async function forgetPassword() {
    try {
      const response = await send('clearPassword');
      state.settings = response.settings;
      state.hasPassword = !!response.settings.hasPassword;
      $('password').value = '';
      updatePasswordHint();
      setStatus('Сохранённый пароль удалён.', 'ok');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  async function clearRknCache() {
    try {
      await send('clearRknCache');
      state.rknCacheCount = 0;
      state.lastRknError = null;
      state.lastRknResult = null;
      updateDiagnostics();
      setStatus('Кэш проверок РКН очищен.', 'ok');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  function initEvents() {
    $('connect-btn').addEventListener('click', connect);
    $('save-btn').addEventListener('click', saveOnly);
    $('refresh-btn').addEventListener('click', refreshTargets);
    $('forget-btn').addEventListener('click', forgetPassword);
    $('clear-rkn-cache').addEventListener('click', clearRknCache);

    $('password-toggle').addEventListener('click', () => {
      const input = $('password');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    $('policy-select').addEventListener('change', async () => {
      renderGroups($('policy-select').value, null);
      updateTargetPreview();
      await persistTarget();
    });
    $('group-select').addEventListener('change', async () => {
      updateTargetPreview();
      await persistTarget();
    });

    for (const radio of document.querySelectorAll('input[name="domain-mode"]')) {
      radio.addEventListener('change', updateTargetPreview);
    }
  }

  initEvents();
  loadState().catch(error => {
    setStatus('Не удалось загрузить настройки: ' + error.message, 'err');
  });
})();
