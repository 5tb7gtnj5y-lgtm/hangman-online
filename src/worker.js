import { DurableObject } from 'cloudflare:workers';
import { TTL, createGame, joinGame, applyAction, viewGame, nameFor } from './game.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
function randomCode() { return Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => ALPHABET[byte % ALPHABET.length]).join(''); }
function json(value, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } }); }
async function bodyFor(request) {
  const text = await request.text();
  if (text.length > 2048) throw new Error('That request is too large.');
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request.');
  return body;
}
async function hash(token) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), byte => byte.toString(16).padStart(2, '0')).join(''); }
async function makePlayer(name, fallback) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { token, player: { id: crypto.randomUUID(), name: nameFor(name, fallback), tokenHash: await hash(token) } };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'Open the game on its own website.' }, 403);
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      try {
        const body = await bodyFor(request);
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = randomCode();
          const response = await env.ROOMS.getByName(code).fetch(new Request(url.origin + '/internal/create', { method: 'POST', body: JSON.stringify({ code, name: body.name }) }));
          if (response.status !== 409) return response;
        }
        return json({ error: 'Could not create a room. Please try again.' }, 503);
      } catch (_) { return json({ error: 'Enter a name of up to 24 characters and try again.' }, 400); }
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(join|resume|socket)$/);
    if (!match || !ROOM_CODE.test(match[1])) return json({ error: 'Room not found. Check the eight-character code.' }, 404);
    const [, code, action] = match;
    if ((action === 'socket' && request.method !== 'GET') || (action !== 'socket' && request.method !== 'POST')) return json({ error: 'Method not allowed.' }, 405);
    return env.ROOMS.getByName(code).fetch(new Request(url.origin + '/internal/' + action, request));
  }
};

export class HangmanRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = null;
    this.tail = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => { this.game = await ctx.storage.get('game') || null; });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async serial(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  live() { return this.game && this.game.expiresAt > Date.now(); }
  async save() {
    this.game.revision++;
    this.game.expiresAt = Date.now() + TTL;
    await this.ctx.storage.put('game', this.game);
    await this.ctx.storage.setAlarm(this.game.expiresAt);
  }
  async playerFor(token) {
    if (!this.live() || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const digest = await hash(token);
    return this.game.players.find(player => player.tokenHash === digest) || null;
  }
  send(ws, message) { try { ws.send(JSON.stringify(message)); } catch (_) {} }
  view(id, except = null) {
    const online = new Set(this.ctx.getWebSockets().filter(ws => ws !== except).map(ws => ws.deserializeAttachment()?.playerId).filter(Boolean));
    return viewGame(this.game, id, online);
  }
  broadcast(except = null) {
    if (!this.live()) return;
    for (const ws of this.ctx.getWebSockets()) {
      const id = ws.deserializeAttachment()?.playerId;
      if (id && ws !== except) this.send(ws, { type: 'state', state: this.view(id, except) });
    }
  }
  async fetch(request) {
    return this.serial(async () => {
      const action = new URL(request.url).pathname.split('/').pop();
      try {
        if (action === 'create') {
          if (this.live()) return json({ error: 'Room already exists.' }, 409);
          const body = await bodyFor(request);
          const { token, player } = await makePlayer(body.name, 'Player 1');
          this.game = createGame(body.code, player);
          await this.save();
          return json({ code: this.game.code, token, state: this.view(player.id) }, 201);
        }
        if (!this.live()) return json({ error: 'This room has expired. Create a new game.' }, 404);
        if (action === 'join') {
          const body = await bodyFor(request);
          if (this.game.players.length === 2) return json({ error: 'This room already has two players. Rejoin on your original phone, or create another room.' }, 409);
          const { token, player } = await makePlayer(body.name, 'Player 2');
          joinGame(this.game, player);
          await this.save();
          this.broadcast();
          return json({ code: this.game.code, token, state: this.view(player.id) }, 201);
        }
        if (action === 'resume') {
          const body = await bodyFor(request);
          const player = await this.playerFor(body.token);
          if (!player) return json({ error: 'That player session is no longer available. Create a new room.' }, 401);
          return json({ state: this.view(player.id) });
        }
        if (action === 'socket') {
          if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'A live connection is required.' }, 426);
          if (this.ctx.getWebSockets().length >= 8) return json({ error: 'Close another game tab and reconnect.' }, 429);
          const pair = new WebSocketPair();
          const [client, server] = Object.values(pair);
          this.ctx.acceptWebSocket(server);
          server.serializeAttachment({});
          return new Response(null, { status: 101, webSocket: client });
        }
        return json({ error: 'Not found.' }, 404);
      } catch (error) { return json({ error: error instanceof SyntaxError ? 'Invalid request.' : error.message }, 400); }
    });
  }
  async webSocketMessage(ws, message) {
    return this.serial(async () => {
      let command;
      try {
        if (!this.live()) { this.send(ws, { type: 'error', error: 'This room has expired. Create a new game.' }); ws.close(1008, 'Room expired'); return; }
        if (typeof message !== 'string' || message.length > 2048) throw new Error('Invalid game message.');
        command = JSON.parse(message);
        const attachment = ws.deserializeAttachment() || {};
        if (command.type === 'hello') {
          const player = await this.playerFor(command.token);
          if (!player) { this.send(ws, { type: 'error', error: 'That player session is no longer available.' }); ws.close(1008, 'Invalid player'); return; }
          ws.serializeAttachment({ playerId: player.id });
          this.broadcast();
          return;
        }
        if (!attachment.playerId) { ws.close(1008, 'Authenticate first'); return; }
        if (typeof command.id !== 'string' || command.id.length > 80) throw new Error('Invalid game action.');
        const changed = applyAction(this.game, attachment.playerId, command);
        if (changed) await this.save();
        this.send(ws, { type: 'ack', id: command.id });
        this.broadcast();
      } catch (error) {
        this.send(ws, { type: 'error', id: command?.id, error: error instanceof SyntaxError ? 'Invalid game message.' : error.message });
        const id = ws.deserializeAttachment()?.playerId;
        if (id && this.live()) this.send(ws, { type: 'state', state: this.view(id) });
      }
    });
  }
  webSocketClose(ws, code, reason) { try { ws.close(code, reason); } catch (_) {} this.broadcast(ws); }
  webSocketError(ws) { try { ws.close(1011, 'Connection interrupted'); } catch (_) {} this.broadcast(ws); }
  async alarm() {
    return this.serial(async () => {
      if (this.live()) { await this.ctx.storage.setAlarm(this.game.expiresAt); return; }
      for (const ws of this.ctx.getWebSockets()) { this.send(ws, { type: 'error', error: 'This room has expired. Create a new game.' }); ws.close(1008, 'Room expired'); }
      await this.ctx.storage.deleteAll();
      this.game = null;
    });
  }
}
