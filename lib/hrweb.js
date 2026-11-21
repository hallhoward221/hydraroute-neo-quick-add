(function () {
  'use strict';

  class HRWebError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = 'HRWebError';
      this.code = code || 'ERROR';
      this.status = status || 0;
    }
  }

  const sleep = HRUtil.sleep;

  class HRWebClient {
    constructor(settings) {
      this.baseUrl = HRUtil.normalizeBaseUrl(settings.baseUrl);
      this.loginName = String(settings.login || '').trim();
      this.password = String(settings.password || '');
      this.csrf = null;
    }

    async readCsrf() {
      try {
        const cookie = await chrome.cookies.get({ url: this.baseUrl + '/', name: 'csrf' });
        return cookie && cookie.value ? cookie.value : null;
      } catch (e) {
        return null;
      }
    }

    async ensureCsrf() {
      let csrf = await this.readCsrf();
      if (csrf) return csrf;

      try {
        await fetch(this.baseUrl + '/', {
          credentials: 'include',
          cache: 'no-store'
        });
      } catch (e) {
        // The login request below will produce a better error.
      }

      csrf = await this.readCsrf();
      return csrf;
    }

    async waitForCsrf() {
      for (let i = 0; i < 12; i++) {
        const csrf = await this.readCsrf();
        if (csrf) return csrf;
        await sleep(100);
      }
      return null;
    }

    async login() {
      if (!this.loginName || !this.password) {
        throw new HRWebError('Укажите логин и пароль роутера в настройках расширения.', 'AUTH_REQUIRED');
      }

      const body = new URLSearchParams();
      body.set('login', this.loginName);
      body.set('password', this.password);

      let response;
      try {
        response = await fetch(this.baseUrl + '/login', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString()
        });
      } catch (e) {
        throw new HRWebError('Роутер недоступен: ' + e.message, 'NETWORK');
      }

      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.success) {
        const message = data && data.error ? data.error : `Не удалось войти в HRweb (HTTP ${response.status}).`;
        throw new HRWebError(message, 'AUTH_FAILED', response.status);
      }

      this.csrf = await this.waitForCsrf();
      if (!this.csrf) {
        throw new HRWebError('Вход выполнен, но CSRF-cookie не найден. Проверьте версию HRweb.', 'CSRF_MISSING');
      }
    }

    async api(method, params, options) {
      const opts = options || {};
      const retry = opts.retry !== false;
      const timeout = opts.timeout || 180000;

      if (!this.csrf) {
        this.csrf = await this.ensureCsrf();
      }
      if (!this.csrf) {
        await this.login();
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      let response;
      try {
        response = await fetch(this.baseUrl + '/api', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF': this.csrf
          },
          body: JSON.stringify({ m: method, p: params || {} }),
          signal: controller.signal
        });
      } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') {
          throw new HRWebError('Роутер не ответил вовремя. Возможно, HRweb перезапускает hrneo.', 'TIMEOUT');
        }
        throw new HRWebError('Роутер недоступен: ' + e.message, 'NETWORK');
      }
      clearTimeout(timer);

      const data = await response.json().catch(() => null);

      if (response.status === 401) {
        if (retry) {
          await this.login();
          return this.api(method, params, { retry: false, timeout });
        }
        throw new HRWebError('Сессия HRweb истекла.', 'AUTH_REQUIRED', 401);
      }

      if (!data) {
        throw new HRWebError(`HRweb вернул не JSON (HTTP ${response.status}).`, 'BAD_RESPONSE', response.status);
      }

      if (data.ok !== true) {
        const message = String(data.error || `HTTP ${response.status}`);
        const lower = message.toLowerCase();

        if (lower.includes('csrf') && retry) {
          this.csrf = await this.ensureCsrf();
          if (this.csrf) return this.api(method, params, { retry: false, timeout });
        }

        if (/(unauthorized|authorization|session|auth)/.test(lower) && retry) {
          await this.login();
          return this.api(method, params, { retry: false, timeout });
        }

        if (lower.includes('origin')) {
          throw new HRWebError(
            'HRweb отклонил запрос (Origin). Проверьте, что расширение имеет доступ к роутеру, и обновите настройки.',
            'ORIGIN',
            response.status
          );
        }

        throw new HRWebError(message, data.code || 'API_ERROR', response.status);
      }

      return data.data;
    }

    async ensureSession() {
      const csrf = await this.ensureCsrf();
      if (csrf) {
        this.csrf = csrf;
        try {
          await this.api('system.ping', null, { retry: false, timeout: 10000 });
          return;
        } catch (error) {
          if (error.code === 'ORIGIN' || error.code === 'NETWORK' || error.code === 'TIMEOUT') throw error;
          // 401, 404 or another API error: perform a fresh login.
        }
      }
      await this.login();
    }

    async getInfo() {
      return this.api('system.info', null, { timeout: 20000 });
    }

    async getConfig() {
      return this.api('config.get');
    }

    async getHrNeoConfig() {
      return this.api('hrneo.config.get');
    }

    async getTargets() {
      const config = await this.getConfig();
      const parsed = HRParser.parseDomainFile(config.domainFile || '');

      let policyOrder = '';
      try {
        const hrneo = await this.getHrNeoConfig();
        policyOrder = (hrneo && hrneo.config && hrneo.config.policyOrder) || '';
      } catch (e) {
        // config.save can work without policyOrder; keep it empty.
      }

      let info = null;
      try {
        info = await this.getInfo();
      } catch (e) {
        // Version information is optional.
      }

      return {
        config,
        parsed,
        targets: HRParser.listTargets(parsed),
        policyOrder,
        info
      };
    }

    async saveConfig(payload) {
      const data = {
        domainFile: payload.domainFile,
        cidrFile: payload.cidrFile || '',
        renames: {}
      };
      // Do not overwrite a custom PolicyOrder with an empty value if it could
      // not be read. HRweb will keep its current order in that case.
      if (payload.policyOrder) data.policyOrder = payload.policyOrder;
      return this.api('config.save', data, { timeout: 180000 });
    }

    async addDomain(target, domain) {
      const state = await this.getTargets();
      const duplicate = HRParser.findDuplicate(state.parsed, domain);

      if (duplicate && duplicate.kind !== 'redundant') {
        return {
          status: duplicate.kind,
          duplicate,
          state
        };
      }

      const inserted = HRParser.insertDomain(state.parsed, target, domain);
      const saveResult = await this.saveConfig({
        domainFile: inserted.text,
        cidrFile: state.config.cidrFile,
        policyOrder: state.policyOrder
      });

      return {
        status: 'added',
        inserted,
        saveResult,
        state,
        beforeDomainFile: state.config.domainFile || '',
        beforeCidrFile: state.config.cidrFile || '',
        afterDomainFile: inserted.text,
        warning: inserted.warning || (saveResult && saveResult.warning) || null
      };
    }
  }

  globalThis.HRWebClient = HRWebClient;
  globalThis.HRWebError = HRWebError;
})();
