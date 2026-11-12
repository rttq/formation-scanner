/* Key vault tests: encryption round trip, mask, deletion */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveApiKey, getApiKey, listApiKeys, deleteApiKey } from '../src/keys/vault.js';

const EX = 'test-exchange';

test('vault: save → read → mask → delete', () => {
  saveApiKey(EX, 'ABCDEFGH12345678', 'super-secret-value-000');
  const k = getApiKey(EX);
  assert.ok(k);
  assert.equal(k.apiKey, 'ABCDEFGH12345678');  // gitleaks:allow — test value
  assert.equal(k.apiSecret, 'super-secret-value-000');

  const listed = listApiKeys().find(x => x.exchange === EX);
  assert.ok(listed);
  assert.equal(listed.masked, 'ABCD…5678');                     // neither the secret nor the full key leaks out
  assert.ok(!JSON.stringify(listed).includes('super-secret'));

  assert.equal(deleteApiKey(EX), true);
  assert.equal(getApiKey(EX), null);
  assert.equal(deleteApiKey(EX), false);
});
