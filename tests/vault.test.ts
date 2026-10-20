/* Тесты хранилища ключей: шифрование туда-обратно, маска, удаление */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveApiKey, getApiKey, listApiKeys, deleteApiKey } from '../src/keys/vault.js';

const EX = 'test-exchange';

test('vault: сохранение → чтение → маска → удаление', () => {
  saveApiKey(EX, 'ABCDEFGH12345678', 'super-secret-value-000');
  const k = getApiKey(EX);
  assert.ok(k);
  assert.equal(k.apiKey, 'ABCDEFGH12345678');  // gitleaks:allow — тестовое значение
  assert.equal(k.apiSecret, 'super-secret-value-000');

  const listed = listApiKeys().find(x => x.exchange === EX);
  assert.ok(listed);
  assert.equal(listed.masked, 'ABCD…5678');                     // секрет и полный ключ наружу не выходят
  assert.ok(!JSON.stringify(listed).includes('super-secret'));

  assert.equal(deleteApiKey(EX), true);
  assert.equal(getApiKey(EX), null);
  assert.equal(deleteApiKey(EX), false);
});
