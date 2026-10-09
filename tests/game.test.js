import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, joinGame, applyAction, viewGame } from '../src/game.js';
function game() { const g = createGame('ABCDEFGH', { id: 'a', name: 'Alice', tokenHash: 'private-a' }); joinGame(g, { id: 'b', name: 'Bob', tokenHash: 'private-b' }); return g; }
test('neither player sees the word or credential hashes while playing', () => {
  const g = game(); applyAction(g, 'a', { type: 'setWord', round: 1, word: 'BALLOON' });
  for (const id of ['a', 'b']) { const output = JSON.stringify(viewGame(g, id)); assert(!output.includes('BALLOON')); assert(!output.includes('private-')); assert.equal(viewGame(g, id).pattern, '_______'); }
});
test('duplicate guesses count once and repeated letters all reveal', () => {
  const g = game(); applyAction(g, 'a', { type: 'setWord', round: 1, word: 'BALLOON' });
  applyAction(g, 'b', { type: 'guess', round: 1, letter: 'l' }); assert.equal(viewGame(g, 'b').pattern, '__LL___');
  applyAction(g, 'b', { type: 'guess', round: 1, letter: 'Z' }); assert.equal(applyAction(g, 'b', { type: 'guess', round: 1, letter: 'z' }), false); assert.equal(g.wrong, 1);
});
test('a win reveals the answer and swaps the next setter automatically', () => {
  const g = game(); applyAction(g, 'a', { type: 'setWord', round: 1, word: 'A' }); applyAction(g, 'b', { type: 'guess', round: 1, letter: 'A' });
  assert.equal(g.round, 2); assert.equal(g.phase, 'choosing'); assert.equal(g.setterId, 'b'); assert.equal(g.word, null); assert.equal(g.lastResult.word, 'A'); assert.equal(g.lastResult.outcome, 'won');
  applyAction(g, 'b', { type: 'setWord', round: 2, word: 'NEW' }); assert.equal(g.lastResult, null); assert.equal(viewGame(g, 'a').pattern, '___');
});
test('six misses finish the round and swap roles after a loss', () => {
  const g = game(); applyAction(g, 'a', { type: 'setWord', round: 1, word: 'A' });
  for (const letter of 'BCDEFG') applyAction(g, 'b', { type: 'guess', round: 1, letter });
  assert.equal(g.lastResult.wrong, 6); assert.equal(g.lastResult.outcome, 'lost'); assert.equal(g.setterId, 'b');
});
test('wrong role, stale round and invalid inputs cannot change state', () => {
  const g = game(); const before = JSON.stringify(g);
  for (const input of [ { type: 'setWord', round: 0, word: 'YES' }, { type: 'setWord', round: 1, word: '<script>' } ]) assert.throws(() => applyAction(g, 'a', input));
  assert.throws(() => applyAction(g, 'b', { type: 'setWord', round: 1, word: 'YES' })); assert.equal(JSON.stringify(g), before);
  applyAction(g, 'a', { type: 'setWord', round: 1, word: 'CAT' }); const playing = JSON.stringify(g);
  assert.throws(() => applyAction(g, 'a', { type: 'guess', round: 1, letter: 'C' })); assert.throws(() => applyAction(g, 'b', { type: 'guess', round: 1, letter: 'AB' })); assert.equal(JSON.stringify(g), playing);
});
test('a room has exactly two places', () => { const g = game(); assert.throws(() => joinGame(g, { id: 'c', name: 'Carol' })); assert.equal(g.players.length, 2); });
