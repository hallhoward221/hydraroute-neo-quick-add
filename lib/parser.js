(function () {
  'use strict';

  function splitLines(text) {
    const value = String(text == null ? '' : text);
    const eol = value.includes('\r\n') ? '\r\n' : '\n';
    return { eol, lines: value.split(/\r?\n/) };
  }

  function parseRuleLine(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('##')) return null;

    let active = true;
    let body = trimmed;
    if (body.startsWith('#')) {
      active = false;
      body = body.slice(1).trimStart();
    }

    const idx = body.lastIndexOf('/');
    if (idx <= 0) return null;
    const domainsRaw = body.slice(0, idx).trim();
    const policy = body.slice(idx + 1).trim();
    if (!domainsRaw || !policy) return null;

    return {
      active,
      domainsRaw,
      domains: domainsRaw.split(',').map(item => item.trim()).filter(Boolean),
      policy
    };
  }

  function parseDomainFile(text) {
    const { eol, lines } = splitLines(text);
    const entries = [];
    const byPolicy = new Map();

    let pendingDescription = '';
    let pendingDescriptionLine = -1;
    let pendingHeader = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('##')) {
        pendingDescription = trimmed.slice(2).trim();
        pendingDescriptionLine = i;
        pendingHeader = true;
        continue;
      }

      const rule = parseRuleLine(raw);
      if (!rule) continue;

      const entry = {
        lineIndex: i,
        policy: rule.policy,
        active: rule.active,
        domainsRaw: rule.domainsRaw,
        domains: rule.domains,
        description: pendingHeader ? pendingDescription : '',
        descriptionLineIndex: pendingHeader ? pendingDescriptionLine : -1,
        rawLine: raw
      };

      entries.push(entry);
      if (!byPolicy.has(entry.policy)) byPolicy.set(entry.policy, []);
      byPolicy.get(entry.policy).push(entry);

      pendingDescription = '';
      pendingDescriptionLine = -1;
      pendingHeader = false;
    }

    return {
      text: String(text == null ? '' : text),
      eol,
      lines,
      entries,
      byPolicy
    };
  }

  function countDomains(domains) {
    let count = 0;
    for (const item of domains || []) {
      if (!/^(geosite|geoip):/i.test(item)) count++;
    }
    return count;
  }

  function listTargets(parsed) {
    const result = [];
    for (const [policy, entries] of parsed.byPolicy.entries()) {
      const groups = entries.map((entry, index) => ({
        index,
        lineIndex: entry.lineIndex,
        description: entry.description || '',
        active: entry.active,
        count: countDomains(entry.domains),
        total: entry.domains.length,
        label: entry.description || 'Без описания'
      }));
      result.push({
        policy,
        groups,
        totalDomains: groups.reduce((sum, group) => sum + group.count, 0),
        totalEntries: groups.length,
        active: groups.some(group => group.active)
      });
    }
    result.sort((a, b) => a.policy.localeCompare(b.policy, 'ru'));
    return result;
  }

  function normalizeDomainForCompare(domain) {
    return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  }

  function isDirective(domain) {
    return /^(geosite|geoip):/i.test(String(domain || ''));
  }

  function findDuplicate(parsed, domain) {
    const target = normalizeDomainForCompare(domain);
    if (!target || !target.includes('.')) return null;

    for (const entry of parsed.entries) {
      for (const existingRaw of entry.domains) {
        if (isDirective(existingRaw)) continue;
        const existing = normalizeDomainForCompare(existingRaw);
        if (!existing || !existing.includes('.')) continue;

        if (existing === target) {
          return { kind: 'duplicate', existing, entry };
        }
        if (target.endsWith('.' + existing)) {
          return { kind: 'covered', existing, entry };
        }
        if (existing.endsWith('.' + target)) {
          return { kind: 'redundant', existing, entry };
        }
      }
    }
    return null;
  }

  function findEntry(parsed, target) {
    const entries = parsed.byPolicy.get(target.policy) || [];
    if (!entries.length) return null;

    if (Number.isInteger(target.groupIndex)) {
      const byIndex = entries[target.groupIndex];
      if (byIndex && (!target.group || byIndex.description === target.group)) return byIndex;
    }

    if (target.group) {
      const exact = entries.filter(entry => entry.description === target.group);
      if (exact.length) return exact.find(entry => entry.active) || exact[0];
    }

    return null;
  }

  function appendDomain(domains, domain) {
    const list = Array.isArray(domains) ? domains.slice() : [];
    const normalized = normalizeDomainForCompare(domain);
    if (!list.some(item => normalizeDomainForCompare(item) === normalized)) {
      list.push(domain);
    }
    return list;
  }

  function targetLabel(target) {
    if (!target) return '';
    return target.group ? `${target.policy} / ${target.group}` : target.policy;
  }

  function insertDomain(parsed, target, domain) {
    const entries = parsed.byPolicy.get(target.policy);
    if (!entries || !entries.length) {
      const error = new Error(`Папка «${target.policy}» не найдена. Обновите список папок.`);
      error.code = 'TARGET_NOT_FOUND';
      throw error;
    }

    let entry = findEntry(parsed, target);

    if (!entry && target.group) {
      const last = entries[entries.length - 1];
      const insertAt = last.lineIndex + 1;
      const lines = parsed.lines.slice();
      const newLines = [];
      if (insertAt > 0 && lines[insertAt - 1].trim() !== '') newLines.push('');
      newLines.push('##' + target.group);
      newLines.push(domain + '/' + target.policy);
      lines.splice(insertAt, 0, ...newLines);

      return {
        text: lines.join(parsed.eol),
        created: true,
        warning: null,
        entry: {
          lineIndex: insertAt + newLines.length - 1,
          policy: target.policy,
          active: true,
          domainsRaw: domain,
          domains: [domain],
          description: target.group
        }
      };
    }

    if (!entry) {
      entry = entries.find(item => item.active);
    }

    if (!entry) {
      const last = entries[entries.length - 1];
      const insertAt = last.lineIndex + 1;
      const lines = parsed.lines.slice();
      lines.splice(insertAt, 0, domain + '/' + target.policy);
      return {
        text: lines.join(parsed.eol),
        created: true,
        warning: 'Все группы в этой карточке были выключены; создана новая активная запись.',
        entry: {
          lineIndex: insertAt,
          policy: target.policy,
          active: true,
          domainsRaw: domain,
          domains: [domain],
          description: ''
        }
      };
    }

    const newDomains = appendDomain(entry.domains, domain);
    const newRaw = newDomains.join(',');
    const lines = parsed.lines.slice();
    lines[entry.lineIndex] = (entry.active ? '' : '#') + newRaw + '/' + entry.policy;

    return {
      text: lines.join(parsed.eol),
      created: false,
      warning: entry.active ? null : 'Выбранная группа отключена (#), поэтому правило не будет активно.',
      entry: {
        ...entry,
        domainsRaw: newRaw,
        domains: newDomains
      }
    };
  }

  globalThis.HRParser = {
    parseDomainFile,
    listTargets,
    findDuplicate,
    insertDomain,
    targetLabel,
    normalizeDomainForCompare
  };
})();
