(function () {
  'use strict';

  function stripTrailingDot(host) {
    return String(host || '').replace(/\.$/, '');
  }

  function normalizeHost(host) {
    return stripTrailingDot(String(host || '').trim().toLowerCase());
  }

  function isIPv4(host) {
    const parts = String(host || '').split('.');
    if (parts.length !== 4) return false;
    return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  }

  function isIPv6(host) {
    const value = String(host || '').replace(/^\[|\]$/g, '');
    if (!value.includes(':')) return false;
    return /^[0-9a-f:]+$/i.test(value) && (value.match(/:/g) || []).length >= 2;
  }

  function isIp(host) {
    return isIPv4(host) || isIPv6(host);
  }

  function isValidDomain(domain) {
    const value = normalizeHost(domain);
    if (!value || value.length > 253 || !value.includes('.')) return false;
    const labels = value.split('.');
    return labels.every(label => {
      if (!label || label.length > 63) return false;
      return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
    });
  }

  function fallbackRootDomain(host) {
    const parts = normalizeHost(host).split('.');
    if (parts.length <= 2) return parts.join('.');
    return parts.slice(-2).join('.');
  }

  function getRootDomain(host) {
    const value = normalizeHost(host);
    try {
      if (globalThis.tldts && typeof globalThis.tldts.getDomain === 'function') {
        const root = globalThis.tldts.getDomain(value, { allowPrivateDomains: true });
        if (root) return root;
      }
    } catch (e) {
      // fall through to the simple heuristic
    }
    return fallbackRootDomain(value);
  }

  function extractDomain(pageUrl, options) {
    const opts = options || {};
    let url;
    try {
      url = new URL(pageUrl);
    } catch (e) {
      const error = new Error('Не удалось прочитать адрес текущей страницы.');
      error.code = 'INVALID_URL';
      throw error;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      const error = new Error('Это не обычный сайт: расширение работает только с http/https.');
      error.code = 'NOT_HTTP';
      throw error;
    }

    const host = normalizeHost(url.hostname);
    const bareHost = host.replace(/^\[|\]$/g, '');
    if (isIp(bareHost)) {
      return { kind: 'ip', host: bareHost, display: bareHost };
    }
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) {
      return { kind: 'local', host, display: host };
    }

    const withoutWww = host.replace(/^www\./, '');
    let domain;
    if (opts.mode === 'exact') {
      domain = opts.stripWww ? withoutWww : host;
    } else {
      const root = getRootDomain(host);
      domain = opts.stripWww ? root.replace(/^www\./, '') : root;
    }

    if (!isValidDomain(domain)) {
      const error = new Error(`Не удалось определить домен для «${host}».`);
      error.code = 'INVALID_DOMAIN';
      throw error;
    }

    return {
      kind: 'domain',
      host,
      domain,
      root: getRootDomain(host),
      display: domain
    };
  }

  globalThis.HRDomain = {
    extractDomain,
    getRootDomain,
    isValidDomain,
    isIp,
    normalizeHost
  };
})();
