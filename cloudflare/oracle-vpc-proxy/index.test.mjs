import test from 'node:test';
import assert from 'node:assert/strict';
import { __test } from './index.js';

test('preserva caminho e envia a requisição à rede privada', () => {
  const request = new Request('https://origin.example.test/v1/status?x=1', { headers: { origin: 'https://nexussync.pages.dev' } });
  const result = __test.buildOriginRequest(request);
  assert.equal(result.url, 'http://public-router:8080/v1/status?x=1');
  assert.equal(result.headers.get('origin'), 'https://nexussync.pages.dev');
  assert.equal(result.headers.get('x-forwarded-proto'), 'https');
});

test('reescreve somente redirects internos', () => {
  const publicUrl = new URL('https://origin.example.test/app/login');
  assert.equal(__test.rewriteLocation('http://public-router:8080/app/accounts/1', publicUrl), 'https://origin.example.test/app/accounts/1');
  assert.equal(__test.rewriteLocation('https://accounts.google.com/', publicUrl), 'https://accounts.google.com/');
});
