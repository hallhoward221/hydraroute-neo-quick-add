(function () {
  'use strict';

  const out = [];
  let passed = 0;
  let failed = 0;

  function check(name, condition, detail) {
    if (condition) {
      passed++;
      out.push('✓ ' + name);
    } else {
      failed++;
      out.push('✗ ' + name + (detail ? '\n  ' + detail : ''));
    }
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, options || {});
    const data = await response.json();
    if (!response.ok) throw new Error('HTTP ' + response.status + ': ' + JSON.stringify(data));
    return data;
  }

  async function run() {
    try {
      await fetchJson('/reset', { method: 'POST' });

      const client = new HRWebClient({
        baseUrl: location.origin,
        login: 'admin',
        password: 'secret'
      });

      await client.ensureSession();
      check('ensureSession / login', true);

      const initial = await client.getTargets();
      check('getTargets: policies', initial.targets.length === 1, JSON.stringify(initial.targets.map(t => t.policy)));
      const youtube = initial.targets.find(t => t.policy === 'HydraRoute');
      check('getTargets: groups', youtube && youtube.groups.length === 3, JSON.stringify(youtube));

      const added = await client.addDomain(
        { policy: 'HydraRoute', group: 'Youtube', groupIndex: 0 },
        'example.com'
      );
      check('addDomain: added', added.status === 'added', JSON.stringify(added));
      check(
        'addDomain: text contains domain',
        added.afterDomainFile.includes('youtube.com,googlevideo.com,example.com/HydraRoute'),
        added.afterDomainFile
      );

      const state1 = await fetchJson('/state');
      check('config.save: persisted', state1.domainFile.includes('example.com/HydraRoute'), state1.domainFile);
      check('config.save: restart once', state1.restartCount === 1, String(state1.restartCount));

      const duplicate = await client.addDomain(
        { policy: 'HydraRoute', group: 'Youtube', groupIndex: 0 },
        'example.com'
      );
      check('addDomain: duplicate blocked', duplicate.status === 'duplicate', JSON.stringify(duplicate));

      const newGroup = await client.addDomain(
        { policy: 'HydraRoute', group: 'Новая', groupIndex: null },
        'new.example'
      );
      check('addDomain: new group', newGroup.status === 'added' && newGroup.afterDomainFile.includes('##Новая'), newGroup.afterDomainFile);

      const state2 = await fetchJson('/state');
      check('config.save: restart twice', state2.restartCount === 2, String(state2.restartCount));

      const secondSession = new HRWebClient({
        baseUrl: location.origin,
        login: 'admin',
        password: 'secret'
      });
      const again = await secondSession.getTargets();
      check('existing session reused', again.targets.length === 1);
    } catch (error) {
      failed++;
      out.push('✗ fatal\n  ' + (error && error.stack ? error.stack : error));
    }

    const el = document.getElementById('results');
    el.textContent = out.join('\n') + '\n\nPassed: ' + passed + ', failed: ' + failed;
    document.title = failed ? 'FAIL' : 'OK';
  }

  run();
})();
