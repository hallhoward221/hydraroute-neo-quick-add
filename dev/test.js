(function () {
  'use strict';

  const lines = [];
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      passed++;
      lines.push(`✓ ${name}`);
    } catch (error) {
      failed++;
      lines.push(`✗ ${name}\n  ${error && error.stack ? error.stack : error}`);
    }
  }

  function eq(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`${label || 'value'}: expected ${e}, got ${a}`);
  }

  function ok(value, label) {
    if (!value) throw new Error(`${label || 'value'} is falsy`);
  }

  const sample = [
    '##Youtube',
    'youtube.com,googlevideo.com/HydraRoute',
    '',
    '##Discord',
    'discord.com/HydraRoute',
    '#disabled.example/Other',
    ''
  ].join('\n');

  test('parse: policies and entries', () => {
    const parsed = HRParser.parseDomainFile(sample);
    eq(parsed.entries.length, 3, 'entries');
    eq([...parsed.byPolicy.keys()].sort(), ['HydraRoute', 'Other'], 'policies');
    eq(parsed.entries[0].description, 'Youtube', 'description');
    eq(parsed.entries[0].domains, ['youtube.com', 'googlevideo.com'], 'domains');
    eq(parsed.entries[2].active, false, 'disabled');
  });

  test('parse: listTargets', () => {
    const parsed = HRParser.parseDomainFile(sample);
    const targets = HRParser.listTargets(parsed);
    eq(targets.length, 2, 'targets');
    const hr = targets.find(t => t.policy === 'HydraRoute');
    eq(hr.groups.length, 2, 'groups');
    eq(hr.groups[0].label, 'Youtube', 'first label');
    eq(hr.groups[0].count, 2, 'first count');
    eq(hr.totalDomains, 3, 'total domains');
  });

  test('duplicates: exact, covered, redundant, none', () => {
    const parsed = HRParser.parseDomainFile(sample);
    eq(HRParser.findDuplicate(parsed, 'youtube.com').kind, 'duplicate', 'exact');
    eq(HRParser.findDuplicate(parsed, 'www.youtube.com').kind, 'covered', 'covered');
    eq(HRParser.findDuplicate(parsed, 'google.com'), null, 'none');
    eq(HRParser.findDuplicate(parsed, 'com'), null, 'root none');
  });

  test('insert: into existing group', () => {
    const parsed = HRParser.parseDomainFile(sample);
    const result = HRParser.insertDomain(parsed, { policy: 'HydraRoute', group: 'Youtube', groupIndex: 0 }, 'example.com');
    ok(result.text.includes('youtube.com,googlevideo.com,example.com/HydraRoute'), 'new line');
    ok(!result.created, 'not created');
  });

  test('insert: auto into first active group', () => {
    const parsed = HRParser.parseDomainFile(sample);
    const result = HRParser.insertDomain(parsed, { policy: 'HydraRoute', group: null, groupIndex: null }, 'example.com');
    ok(result.text.includes('youtube.com,googlevideo.com,example.com/HydraRoute'), 'auto line');
  });

  test('insert: new group', () => {
    const parsed = HRParser.parseDomainFile(sample);
    const result = HRParser.insertDomain(parsed, { policy: 'HydraRoute', group: 'Новая', groupIndex: null }, 'example.com');
    ok(result.created, 'created');
    ok(result.text.includes('##Новая\nexample.com/HydraRoute'), 'new block');
  });

  test('insert: all groups disabled creates active entry', () => {
    const parsed = HRParser.parseDomainFile(sample);
    const result = HRParser.insertDomain(parsed, { policy: 'Other', group: null, groupIndex: null }, 'example.com');
    ok(result.warning, 'warning');
    ok(result.created, 'created');
    ok(result.text.includes('#disabled.example/Other'), 'old disabled line');
    ok(result.text.includes('example.com/Other'), 'new active line');
  });

  test('insert: missing policy throws', () => {
    const parsed = HRParser.parseDomainFile(sample);
    let code = '';
    try {
      HRParser.insertDomain(parsed, { policy: 'Missing', group: null, groupIndex: null }, 'example.com');
    } catch (error) {
      code = error.code;
    }
    eq(code, 'TARGET_NOT_FOUND', 'code');
  });

  test('domain: root, exact, www, private suffix, multi-label suffix', () => {
    eq(HRDomain.extractDomain('https://music.youtube.com/watch', { mode: 'root', stripWww: true }).domain, 'youtube.com', 'root');
    eq(HRDomain.extractDomain('https://music.youtube.com/watch', { mode: 'exact', stripWww: true }).domain, 'music.youtube.com', 'exact');
    eq(HRDomain.extractDomain('https://www.example.com/', { mode: 'root', stripWww: true }).domain, 'example.com', 'www root');
    eq(HRDomain.extractDomain('https://www.example.com/', { mode: 'exact', stripWww: true }).domain, 'example.com', 'www exact');
    eq(HRDomain.extractDomain('https://www.example.com/', { mode: 'exact', stripWww: false }).domain, 'www.example.com', 'www exact keep');
    eq(HRDomain.extractDomain('https://music.youtube.com/', { mode: 'exact', stripWww: false }).domain, 'music.youtube.com', 'exact keep');
    eq(HRDomain.extractDomain('https://foo.github.io/', { mode: 'root', stripWww: true }).domain, 'foo.github.io', 'private');
    eq(HRDomain.extractDomain('https://example.co.uk/', { mode: 'root', stripWww: true }).domain, 'example.co.uk', 'co.uk');
  });

  test('domain: IP and local', () => {
    eq(HRDomain.extractDomain('http://192.168.1.1/', { mode: 'root' }).kind, 'ip', 'ip');
    eq(HRDomain.extractDomain('http://localhost:2000/', { mode: 'root' }).kind, 'local', 'local');
    let code = '';
    try { HRDomain.extractDomain('chrome://extensions/', { mode: 'root' }); } catch (error) { code = error.code; }
    eq(code, 'NOT_HTTP', 'chrome');
  });

  const el = document.getElementById('results');
  el.textContent = lines.join('\n') + `\n\nPassed: ${passed}, failed: ${failed}`;
  document.title = failed ? 'FAIL' : 'OK';
})();
