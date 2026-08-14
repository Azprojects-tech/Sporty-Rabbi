import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const llm = fs.readFileSync(new URL('../src/services/geminiService.js', import.meta.url), 'utf8');

test('server no longer fabricates H2H scorelines from aggregate counts', () => {
  assert.equal(server.includes('const gH = gpg'), false);
  assert.equal(server.includes('const gA = gpg'), false);
});

test('Groq endpoint/config is no longer part of the LLM call path', () => {
  assert.equal(llm.includes('api.groq.com'), false);
  assert.equal(llm.includes('GROQ_API_KEY'), false);
  assert.equal(llm.includes('GROQ_MODEL'), false);
});

test('analyst fallback is one OpenRouter free-router request', () => {
  assert.equal(llm.includes("const OPENROUTER_MODEL = 'openrouter/free'"), true);
  assert.equal(llm.includes('async function openRouterChat'), true);
});

test('synthetic live/upcoming Gemini fixture exports are disabled', () => {
  assert.match(llm, /Synthetic upcoming-fixture generation is disabled/);
  assert.match(llm, /Synthetic live-match generation is disabled/);
});
