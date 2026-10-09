(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const keys = new Map();
  let session = null, state = null, socket = null, online = false, pending = null;
  let retryTimer = null, heartbeat = null, retryCount = 0, active = false, httpBusy = false;
  let lastView = null;
  let hadOpponent = false, joinNoticeTimer = null;
  const storageKey = 'hangman-online-rooms-v1';
  let stored = { rooms: {}, current: null };
  try { const value = JSON.parse(localStorage.getItem(storageKey)); if (value?.rooms && typeof value.rooms === 'object') stored = value; } catch (_) {}
  function saveLocal() { try { localStorage.setItem(storageKey, JSON.stringify(stored)); } catch (_) {} }
  function remember(value) {
    session = { code: value.code, token: value.token };
    stored.rooms[value.code] = { ...session, savedAt: Date.now() };
    stored.current = value.code;
    for (const [code, room] of Object.entries(stored.rooms)) if (Date.now() - room.savedAt > 24 * 60 * 60 * 1000 && code !== value.code) delete stored.rooms[code];
    saveLocal();
  }
  const normalCode = value => value.toUpperCase().replace(/[\s-]/g, '');
  function error(message, welcome = false) {
    const element = $(welcome ? 'welcome-error' : 'room-error');
    element.textContent = message || '';
    element.hidden = !message;
  }
  function status(message, connected = false) {
    $('connection').textContent = message;
    $('connection').className = 'header-note' + (connected ? '' : ' connection-off');
  }
  async function api(path, data) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) { const fail = new Error(result.error || 'Could not connect to the game.'); fail.status = response.status; throw fail; }
      return result;
    } catch (fail) {
      if (fail.name === 'AbortError' || fail instanceof TypeError) throw new Error('Could not connect. Check your internet connection and try again.');
      throw fail;
    } finally { clearTimeout(timeout); }
  }
  function closeSocket() {
    clearTimeout(retryTimer); clearInterval(heartbeat);
    retryTimer = null; heartbeat = null;
    const old = socket; socket = null;
    if (old) old.close();
    online = false;
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }
  function showWelcome() {
    active = false; closeSocket(); state = null; lastView = null;
    clearTimeout(joinNoticeTimer); hadOpponent = false;
    $('join-notification').hidden = true; $('join-notification').textContent = '';
    $('welcome').hidden = false; $('room').hidden = true;
    status('Two phones. Anywhere.', true);
    const current = stored.current && stored.rooms[stored.current];
    $('rejoin').hidden = !current;
    $('rejoin').textContent = current ? 'Rejoin ' + current.code : '';
    history.replaceState(null, '', location.pathname);
  }
  function startRoom(value) {
    closeSocket(); remember(value); active = true; retryCount = 0;
    state = value.state; online = false;
    clearTimeout(joinNoticeTimer); hadOpponent = !!state.opponent;
    $('join-notification').hidden = true; $('join-notification').textContent = '';
    $('welcome').hidden = true; $('room').hidden = false;
    $('invite-box').hidden = true;
    history.replaceState(null, '', '?room=' + encodeURIComponent(session.code));
    error(''); error('', true);
    render(); connect();
  }
  async function resume(saved) {
    if (httpBusy) return;
    httpBusy = true; setWelcomeBusy(true); error('', true); status('Rejoining…');
    try {
      const value = await api('/api/rooms/' + saved.code + '/resume', { token: saved.token });
      startRoom({ ...saved, state: value.state });
    } catch (fail) {
      if (fail.status === 401 || fail.status === 404) { delete stored.rooms[saved.code]; if (stored.current === saved.code) stored.current = null; saveLocal(); }
      showWelcome(); $('code').value = saved.code; error(fail.message, true);
    } finally { httpBusy = false; setWelcomeBusy(false); }
  }
  function setWelcomeBusy(value) { $('create-button').disabled = value; $('join-button').disabled = value; $('rejoin').disabled = value; }
  async function openRoom(create) {
    if (httpBusy) return;
    const code = normalCode($('code').value);
    if (!create && !/^[A-HJ-NP-Z2-9]{8}$/.test(code)) { error('Enter the eight-character room code.', true); $('code').focus(); return; }
    if (!create && stored.rooms[code]) { await resume(stored.rooms[code]); return; }
    httpBusy = true; setWelcomeBusy(true); error('', true);
    try {
      const value = await api(create ? '/api/rooms' : '/api/rooms/' + code + '/join', { name: $('name').value });
      startRoom(value);
    } catch (fail) { error(fail.message, true); }
    finally { httpBusy = false; setWelcomeBusy(false); }
  }
  function retry() {
    if (!active || retryTimer) return;
    const delay = Math.min(15000, 1000 * 2 ** Math.min(retryCount++, 4));
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      if (!active) return;
      try {
        const value = await api('/api/rooms/' + session.code + '/resume', { token: session.token });
        if (!active) return;
        state = value.state; render(); connect();
      } catch (fail) {
        if (!active) return;
        if (fail.status === 401 || fail.status === 404) {
          const code = session.code; delete stored.rooms[code]; if (stored.current === code) stored.current = null; saveLocal();
          showWelcome(); error(fail.message, true);
        } else { status('Reconnecting…'); retry(); }
      }
    }, delay);
  }
  function connect() {
    if (!active || !session) return;
    const endpoint = new URL('/api/rooms/' + session.code + '/socket', location.origin);
    endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const current = new WebSocket(endpoint);
    socket = current; status('Connecting…');
    current.addEventListener('open', () => {
      if (socket !== current) return;
      current.send(JSON.stringify({ type: 'hello', token: session.token }));
      clearInterval(heartbeat);
      heartbeat = setInterval(() => { if (current.readyState === WebSocket.OPEN && socket === current) current.send('ping'); }, 25000);
    });
    current.addEventListener('message', event => {
      if (socket !== current || event.data === 'pong') return;
      let message; try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'state') {
        if (!online) error('');
        state = message.state; online = true; retryCount = 0;
        status('Connected', true); render();
      } else if (message.type === 'ack') {
        if (pending?.id === message.id) {
          if (pending.type === 'setWord') clearSecret();
          clearTimeout(pending.timer); pending = null; error(''); render();
        }
      } else if (message.type === 'error') {
        if (pending?.id === message.id) { clearTimeout(pending.timer); pending = null; }
        error(message.error); render();
      }
    });
    current.addEventListener('close', () => {
      if (socket !== current) return;
      clearInterval(heartbeat); heartbeat = null; socket = null; online = false;
      if (pending) clearTimeout(pending.timer); pending = null;
      if (active) { status('Reconnecting…'); render(); retry(); }
    });
    current.addEventListener('error', () => { if (socket === current) status('Reconnecting…'); });
  }
  function send(type, values) {
    if (!online || pending || socket?.readyState !== WebSocket.OPEN) return;
    const id = crypto.randomUUID();
    pending = { id, type, timer: setTimeout(() => {
      if (pending?.id !== id) return;
      pending = null; online = false; socket?.close();
      error('The connection was interrupted. Reconnecting to check your game.'); render();
    }, 8000) };
    socket.send(JSON.stringify({ ...values, type, round: state.round, id }));
    error(''); render();
  }
  function clearSecret() {
    $('secret').value = ''; $('secret').type = 'password';
    $('show-word').textContent = 'Show'; $('show-word').setAttribute('aria-pressed', 'false'); $('show-word').setAttribute('aria-label', 'Show secret word');
  }
  function drawWord(target, pattern, missing = []) {
    target.replaceChildren();
    for (const letter of pattern) {
      const slot = document.createElement('span'); slot.className = 'letter-slot' + (missing.includes(letter) ? ' missing' : ''); slot.textContent = letter === '_' ? '' : letter; target.appendChild(slot);
    }
  }
  function notifyJoin() {
    if (!hadOpponent && state.opponent) {
      const notice = $('join-notification');
      notice.hidden = false;
      notice.textContent = state.opponent.name + ' joined your room. You’re ready to play!';
      clearTimeout(joinNoticeTimer);
      joinNoticeTimer = setTimeout(() => { notice.hidden = true; notice.textContent = ''; }, 10000);
    }
    hadOpponent = !!state.opponent;
  }
  function render() {
    if (!state) return;
    notifyJoin();
    const canChoose = state.phase === 'choosing' && state.role === 'setter';
    const playing = state.phase === 'playing';
    const guessing = playing && state.role === 'guesser';
    const last = state.lastResult;
    $('room-code').textContent = state.code;
    $('players').textContent = state.me.name + (state.opponent ? ' vs ' + state.opponent.name : ' · waiting for a friend');
    $('round-number').textContent = 'Round ' + state.round;
    $('role-label').textContent = state.phase === 'waiting' ? 'Invite a friend' : canChoose ? 'Your turn · Choose a word' : guessing ? 'Your turn · Guess the word' : 'Your opponent’s turn';
    $('round-heading').textContent = state.phase === 'waiting' ? 'Your room is ready.' : canChoose ? 'Keep it a secret.' : state.phase === 'choosing' ? 'Waiting for a word.' : guessing ? 'What’s the word?' : 'Watch ' + state.opponent.name + ' guess.';
    $('waiting').hidden = state.phase !== 'waiting'; $('choosing').hidden = !canChoose;
    $('waiting-word').hidden = state.phase !== 'choosing' || canChoose;
    $('waiting-word-copy').textContent = (state.opponent?.name || 'Your opponent') + ' is choosing your next word. It will appear here as blanks when they send it.';
    $('playing').hidden = !playing;
    $('send-word').disabled = !online || !!pending || !canChoose;
    $('send-word').textContent = pending?.type === 'setWord' ? 'Sending…' : 'Send hidden word';
    if (!canChoose) clearSecret();
    $('last-result').hidden = !last;
    if (last) {
      $('last-result').className = 'result' + (last.outcome === 'lost' ? ' lost' : '');
      $('result-heading').textContent = last.outcome === 'won' ? last.guesserName + ' got it!' : 'Out of guesses!';
      $('result-copy').textContent = 'The word was ' + last.word + '. ' + last.wrong + ' wrong ' + (last.wrong === 1 ? 'guess' : 'guesses') + '.';
      drawWord($('result-word'), last.word, [...last.word].filter(letter => !last.guesses.includes(letter)));
    }
    const boardVisible = playing || !!last;
    $('board').hidden = !boardVisible;
    $('layout').className = 'game-layout' + (boardVisible ? '' : ' no-board');
    $('layout').dataset.stage = state.phase;
    const wrong = playing ? state.wrong : last?.wrong || 0;
    $('board').dataset.outcome = last?.outcome === 'lost' ? 'lost' : '';
    $('board-label').textContent = playing ? 'Wrong guesses: ' + wrong + ' / 6' : 'Round ' + (last?.round || 1) + ' complete';
    $('chances').textContent = (6 - wrong) + (wrong === 5 ? ' guess left' : ' guesses left');
    $('drawing-title').textContent = wrong + ' of 6 hangman parts drawn.';
    document.querySelectorAll('[data-part]').forEach(part => part.classList.toggle('visible', Number(part.dataset.part) <= wrong));
    if (playing) {
      drawWord($('word'), state.pattern);
      $('word-status').textContent = state.pattern.length + ' letters: ' + [...state.pattern].map(letter => letter === '_' ? 'blank' : letter).join(', ') + '. ' + state.guessesLeft + ' wrong guesses left.';
      for (const [letter, key] of keys) {
        const used = state.guesses.includes(letter);
        const correct = used && state.pattern.includes(letter);
        key.className = 'key' + (used ? correct ? ' correct' : ' wrong' : '');
        key.disabled = !guessing || !online || !!pending || used;
        key.setAttribute('aria-label', used ? letter + (correct ? ', correct guess' : ', wrong guess') : 'Guess ' + letter);
      }
      const recent = state.guesses.at(-1);
      $('feedback').className = 'feedback' + (recent ? state.pattern.includes(recent) ? ' correct' : ' wrong' : '');
      $('feedback').textContent = recent ? recent + (state.pattern.includes(recent) ? ' is in the word.' : ' isn’t in the word. ' + state.guessesLeft + ' wrong guesses left.') : guessing ? 'Choose your first letter.' : 'Waiting for the first guess.';
      $('keyboard-note').textContent = guessing ? 'Tap a letter, or use your keyboard.' : 'You’re watching live. It’s your opponent’s turn to guess.';
    }
    $('opponent-status').textContent = !state.opponent ? 'Your friend can join using the link or code.' : state.opponent.name + (state.opponent.online ? ' is connected.' : ' is offline. Their place is saved so they can rejoin.');
    const view = state.round + ':' + state.phase + ':' + state.role;
    if (lastView !== view) { $('round-heading').focus({preventScroll:true}); lastView = view; }
  }
  for (const letters of ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']) {
    const row = document.createElement('div'); row.className = 'key-row';
    for (const letter of letters) {
      const key = document.createElement('button'); key.type = 'button'; key.className = 'key'; key.textContent = letter; key.dataset.letter = letter;
      key.addEventListener('click', () => { if (state?.phase === 'playing' && state.role === 'guesser' && !state.guesses.includes(letter)) send('guess', { letter }); });
      keys.set(letter, key); row.appendChild(key);
    }
    $('keyboard').appendChild(row);
  }
  async function share(home = false) {
    const inRoom = !home && active && session;
    if (!home && !inRoom) return;
    const link = new URL(location.pathname, location.origin);
    if (inRoom) link.searchParams.set('room', session.code);
    const prefix = home ? 'home-' : '';
    $(prefix + 'invite-link').value = link.href;
    try {
      if (navigator.share) { await navigator.share({ title: 'Play Hangman with me', text: inRoom ? 'Join my hangman game. Room code: ' + session.code : 'Play Hangman Online with a friend', url: link.href }); return; }
      await navigator.clipboard.writeText(link.href);
      $(prefix + 'invite-note').textContent = 'Link copied. Send it to your friend.';
    } catch (fail) {
      if (fail.name === 'AbortError') return;
      $(prefix + 'invite-note').textContent = 'Select and copy this link, then send it to your friend.';
    }
    $(prefix + 'invite-box').hidden = false;
  }
  $('create-form').addEventListener('submit', event => { event.preventDefault(); openRoom(true); });
  $('join-form').addEventListener('submit', event => { event.preventDefault(); openRoom(false); });
  $('word-form').addEventListener('submit', event => {
    event.preventDefault();
    const word = $('secret').value.trim();
    if (!/^[A-Za-z]{1,24}$/.test(word)) { error('Enter 1–24 letters, A–Z, with no spaces or numbers.'); $('secret').focus(); return; }
    send('setWord', { word });
  });
  $('show-word').addEventListener('click', () => {
    const show = $('secret').type === 'password'; $('secret').type = show ? 'text' : 'password';
    $('show-word').textContent = show ? 'Hide' : 'Show'; $('show-word').setAttribute('aria-pressed', String(show)); $('show-word').setAttribute('aria-label', show ? 'Hide secret word' : 'Show secret word');
  });
  $('share').addEventListener('click', () => share()); $('invite-friend').addEventListener('click', () => share());
  $('share-home').addEventListener('click', () => share(true));
  $('leave').addEventListener('click', () => { clearSecret(); showWelcome(); });
  $('rejoin').addEventListener('click', () => { const saved = stored.rooms[stored.current]; if (saved) resume(saved); });
  document.addEventListener('keydown', event => {
    if (state?.phase !== 'playing' || state.role !== 'guesser' || event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
    if (/^[A-Za-z]$/.test(event.key)) { event.preventDefault(); const letter = event.key.toUpperCase(); if (!state.guesses.includes(letter)) send('guess', { letter }); }
  });
  window.addEventListener('online', () => { if (active && !online) { clearTimeout(retryTimer); retryTimer = null; retryCount = 0; retry(); } });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && active && !online) { clearTimeout(retryTimer); retryTimer = null; retry(); } });
  window.addEventListener('pagehide', () => closeSocket());
  window.addEventListener('pageshow', event => { if (event.persisted && active) connect(); });
  const requested = normalCode(new URL(location.href).searchParams.get('room') || '');
  showWelcome();
  if (requested) { $('code').value = requested; if (stored.rooms[requested]) resume(stored.rooms[requested]); }
  else if (stored.current && stored.rooms[stored.current]) resume(stored.rooms[stored.current]);
})();
