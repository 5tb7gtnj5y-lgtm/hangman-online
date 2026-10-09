export const TTL = 24 * 60 * 60 * 1000;
export const MAX_WRONG = 6;
export function nameFor(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') throw new Error('Enter a name using text.');
  const name = value.trim();
  if (name.length > 24 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a name of up to 24 characters.');
  return name || fallback;
}
export function createGame(code, player, now = Date.now()) {
  return { code, players: [player], setterId: player.id, round: 1, phase: 'waiting', word: null, guesses: [], wrong: 0, lastResult: null, revision: 1, expiresAt: now + TTL };
}
export function joinGame(game, player) {
  if (game.players.length !== 1) throw new Error('This room already has two players. Rejoin on your original phone, or create another room.');
  game.players.push(player);
  game.phase = 'choosing';
}
export function applyAction(game, playerId, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid game action.');
  if (!game.players.some(player => player.id === playerId)) throw new Error('Your player session is not valid.');
  if (action.round !== game.round) throw new Error('That round has ended. Your screen will update to the current round.');
  if (action.type === 'setWord') {
    if (game.phase !== 'choosing' || game.setterId !== playerId) throw new Error('It is not your turn to choose the word.');
    if (typeof action.word !== 'string' || !/^[A-Za-z]{1,24}$/.test(action.word.trim())) throw new Error('Enter 1–24 letters, A–Z, with no spaces or numbers.');
    game.word = action.word.trim().toUpperCase();
    game.guesses = [];
    game.wrong = 0;
    game.lastResult = null;
    game.phase = 'playing';
    return true;
  }
  if (action.type === 'guess') {
    if (game.phase !== 'playing' || game.setterId === playerId) throw new Error('It is not your turn to guess.');
    if (typeof action.letter !== 'string' || !/^[A-Za-z]$/.test(action.letter)) throw new Error('Choose one letter, A–Z.');
    const letter = action.letter.toUpperCase();
    if (game.guesses.includes(letter)) return false;
    game.guesses.push(letter);
    if (!game.word.includes(letter)) game.wrong++;
    const won = [...game.word].every(letter => game.guesses.includes(letter));
    if (won || game.wrong === MAX_WRONG) {
      game.lastResult = { round: game.round, word: game.word, guesses: [...game.guesses], wrong: game.wrong, outcome: won ? 'won' : 'lost', guesserName: game.players.find(player => player.id === playerId).name };
      game.setterId = playerId;
      game.round++;
      game.phase = 'choosing';
      game.word = null;
      game.guesses = [];
      game.wrong = 0;
    }
    return true;
  }
  throw new Error('Unknown game action.');
}
export function viewGame(game, playerId, connectedIds = new Set()) {
  const me = game.players.find(player => player.id === playerId);
  if (!me) throw new Error('Your player session is not valid.');
  const opponent = game.players.find(player => player.id !== playerId);
  return {
    code: game.code, round: game.round, phase: game.phase, revision: game.revision,
    role: game.setterId === playerId ? 'setter' : 'guesser',
    me: { name: me.name }, opponent: opponent ? { name: opponent.name, online: connectedIds.has(opponent.id) } : null,
    pattern: game.phase === 'playing' ? [...game.word].map(letter => game.guesses.includes(letter) ? letter : '_').join('') : '',
    guesses: [...game.guesses], wrong: game.wrong, guessesLeft: MAX_WRONG - game.wrong,
    lastResult: game.lastResult, expiresAt: game.expiresAt
  };
}
