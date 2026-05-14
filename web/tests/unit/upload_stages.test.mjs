// upload_stages.test.mjs — regression fence for the "stage emitted by
// upload.js but not rendered by ide.js" bug class.
//
// The OTA progress UI (build log + progress bar) is driven by
// onStage(name, detail) callbacks from updateFirmware in upload.js.
// ide.js looks each stage up in upload.js's STAGES table via
// stageDescriptor(); a missing entry would leave the progress bar
// stuck on the previous stage's label.
//
// The first test below parses upload.js source for every stage('name')
// emission and asserts the STAGES table has a matching key. Adding a
// new stage without a row in the table fails CI loudly.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, makeWindow, webRoot } from './_load.mjs';

test('upload: every stage() emission in updateFirmware has a STAGES entry', () => {
  const win = makeWindow();
  loadModule('upload.js', win);
  const STAGES = win.Conduit.uploadStages;
  assert.ok(STAGES, 'upload.js must export window.Conduit.uploadStages');

  const src = readFileSync(join(webRoot, 'upload.js'), 'utf8');
  // Match stage('name'), stage("name"), or stage(`name`) — single,
  // double, or backtick quoted. Captures the literal stage name.
  // Anchored on the bare identifier so test cases that mention
  // "stage" in comments don't false-match.
  const emitted = new Set();
  for (const m of src.matchAll(/\bstage\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/gi)) {
    emitted.add(m[1]);
  }
  assert.ok(emitted.size > 0,
    'regex should find at least one stage() emission in upload.js');

  for (const name of emitted) {
    assert.ok(STAGES[name] != null,
      `stage '${name}' is emitted by upload.js but has no entry in ` +
      `STAGES — add one to keep the IDE's progress bar in sync ` +
      `(currently emitted: ${[...emitted].join(', ')}; ` +
      `STAGES keys: ${Object.keys(STAGES).join(', ')})`);
  }
});

test('upload: stageDescriptor returns null for unknown stage', () => {
  const win = makeWindow();
  loadModule('upload.js', win);
  assert.equal(win.Conduit.stageDescriptor('bogus'), null);
  assert.equal(win.Conduit.stageDescriptor(''), null);
});

test('upload: stageDescriptor splices detail into waiting label', () => {
  const win = makeWindow();
  loadModule('upload.js', win);
  const d = win.Conduit.stageDescriptor('waiting', '3/30');
  assert.ok(d, 'waiting must have a descriptor');
  assert.match(d.label, /3\/30/, 'waiting label should contain the detail string');
  assert.equal(d.pct, 95);
});

test('upload: stageDescriptor ignores non-string detail on waiting', () => {
  const win = makeWindow();
  loadModule('upload.js', win);
  // updateFirmware passes a status object as detail on `verifying`;
  // confirm we don't accidentally splice arbitrary objects into labels.
  const d = win.Conduit.stageDescriptor('waiting', { version: '1.0.0' });
  assert.ok(d);
  assert.doesNotMatch(d.label, /\[object/);
});

test('upload: every known stage has a label string and a pct number', () => {
  const win = makeWindow();
  loadModule('upload.js', win);
  for (const [name, row] of Object.entries(win.Conduit.uploadStages)) {
    assert.equal(typeof row.label, 'string',
      `stage '${name}' must have a string label`);
    assert.equal(typeof row.pct, 'number',
      `stage '${name}' must have a number pct`);
    assert.ok(row.pct >= 0 && row.pct <= 100,
      `stage '${name}' pct ${row.pct} must be in [0, 100]`);
  }
});
