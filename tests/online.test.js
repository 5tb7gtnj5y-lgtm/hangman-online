import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
// A local-runtime compatibility workaround for containers without interface enumeration.
try { os.networkInterfaces(); } catch (_) { os.networkInterfaces = () => ({lo:[{address:'127.0.0.1',netmask:'255.0.0.0',family:'IPv4',mac:'00:00:00:00:00:00',internal:true,cidr:'127.0.0.1/8'}]}); }
const dependencies = createRequire(process.env.HANGMAN_WRANGLER_PATH || require.resolve('wrangler'));
const { Miniflare } = dependencies('miniflare');
const esbuild = dependencies('esbuild');
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(project, '.test-'));
const script = path.join(temp, 'worker.mjs');
await esbuild.build({entryPoints:[path.join(project, 'src/worker.js')],outfile:script,bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers']});
let mf;
const sockets = [];
function runtime() { return new Miniflare({ modules:true,scriptPath:script,compatibilityDate:'2026-05-15',host:'127.0.0.1',durableObjects:{ROOMS:{className:'HangmanRoom',useSQLite:true}},durableObjectsPersist:path.join(temp,'state'),assets:{directory:path.join(project,'public'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true}} }); }
async function post(route, data, expected=200, headers={}) {
  const response = await mf.dispatchFetch('http://game.test' + route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
  assert.equal(response.status,expected,await response.clone().text());return response.json();
}
async function connect(code,token) {
  const response=await mf.dispatchFetch('http://game.test/api/rooms/'+code+'/socket',{headers:{Upgrade:'websocket',Origin:'http://game.test'}});
  assert.equal(response.status,101); const ws=response.webSocket;const messages=[];ws.accept();sockets.push(ws);
  ws.addEventListener('message',event=>{messages.push(event.data==='pong'?'pong':JSON.parse(event.data));});
  const client={ws,messages,wait:async(predicate)=>{
    const start=Date.now();while(Date.now()-start<5000){const found=messages.find(predicate);if(found)return found;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('Timed out waiting for a game update.');
  },send(command){ws.send(JSON.stringify(command));},latest(){return messages.filter(m=>m.type==='state').at(-1)?.state;}};
  client.send({type:'hello',token});await client.wait(m=>m.type==='state');return client;
}
let serial=0;
async function action(client,type,values,expectError=false) {
  const id='test-'+(++serial);client.send({type,id,round:client.latest().round,...values});
  const response=await client.wait(m=>m.id===id);assert.equal(response.type,expectError?'error':'ack');return response;
}
const pass=name=>console.log('PASS '+name);
try {
  mf=runtime();await mf.ready;
  const page=await mf.dispatchFetch('http://game.test/');assert.equal(page.status,200);assert((await page.text()).includes('Hangman Online'));
  for(const file of ['style.css','app.js','favicon.svg'])assert.equal((await mf.dispatchFetch('http://game.test/'+file)).status,200);
  pass('the actual Worker serves the game and all assets');
  const alice=await post('/api/rooms',{name:'Alice'},201);assert.match(alice.code,/^[A-HJ-NP-Z2-9]{8}$/);assert.match(alice.token,/^[a-f0-9]{64}$/);
  const bob=await post('/api/rooms/'+alice.code+'/join',{name:'Bob'},201);assert.notEqual(alice.token,bob.token);
  await post('/api/rooms/'+alice.code+'/join',{name:'Third player'},409);
  await post('/api/rooms/'+alice.code+'/resume',{token:'0'.repeat(64)},401);
  await post('/api/rooms',{name:'Blocked'},403,{Origin:'https://another-site.test'});
  pass('room creation, two-player limit, player credentials and origin checks');
  let a=await connect(alice.code,alice.token);let b=await connect(alice.code,bob.token);
  await a.wait(m=>m.type==='state'&&m.state.opponent?.online===true);
  a.send({type:'chat',id:'chat-one',text:'Hello Bob <script>!',round:999,name:'Imposter'});
  await a.wait(m=>m.type==='chatAck'&&m.id==='chat-one');
  for(const client of [a,b])await client.wait(m=>m.type==='state'&&m.state.chat?.length===1);
  assert.equal(a.latest().chat[0].name,'Alice');assert.equal(a.latest().chat[0].mine,true);assert.equal(b.latest().chat[0].mine,false);
  assert.equal(b.latest().chat[0].text,'Hello Bob <script>!');
  a.send({type:'chat',id:'chat-one',text:'Duplicate'});
  a.send({type:'chat',id:'too-fast',text:'Too fast'});
  await a.wait(m=>m.type==='error'&&m.id==='too-fast');assert.equal(a.latest().chat.length,1);
  b.send({type:'chat',id:'invalid-chat',text:'x'.repeat(501)});
  await b.wait(m=>m.type==='error'&&m.id==='invalid-chat');
  b.send({type:'chat',id:'chat-two',text:'Hello Alice'});
  await b.wait(m=>m.type==='chatAck'&&m.id==='chat-two');
  await a.wait(m=>m.type==='state'&&m.state.chat?.length===2);
  const other=await post('/api/rooms',{name:'Other'},201);assert.deepEqual(other.state.chat,[]);
  assert(!JSON.stringify(a.latest().chat).includes(alice.token));
  pass('private live chat, server-assigned names, per-player messages, duplicate protection, rate and length limits');
  await action(b,'setWord',{word:'CHEAT'},true);
  await action(a,'setWord',{word:'123'},true);
  await action(a,'setWord',{word:'BALLOON'});
  for(const client of [a,b])await client.wait(m=>m.type==='state'&&m.state.phase==='playing');
  assert.equal(a.latest().pattern,'_______');assert.equal(b.latest().pattern,'_______');
  for(const client of [a,b])assert(!JSON.stringify(client.messages).includes('BALLOON'));
  pass('the secret never appears in either player’s live network state');
  await action(a,'guess',{letter:'B'},true);
  await action(b,'guess',{letter:'L'});
  for(const client of [a,b])await client.wait(m=>m.type==='state'&&m.state.pattern==='__LL___');
  await action(b,'guess',{letter:'Z'});
  await b.wait(m=>m.type==='state'&&m.state.wrong===1);
  const before=b.latest().revision;await action(b,'guess',{letter:'Z'});assert.equal(b.latest().wrong,1);assert.equal(b.latest().revision,before);
  b.ws.send('ping');await b.wait(m=>m==='pong');
  pass('both phones see guesses live, duplicate guesses are free, and hibernating heartbeat works');
  b.ws.close(1000,'Test disconnect');
  await a.wait(m=>m.type==='state'&&m.state.opponent?.online===false);
  const restored=await post('/api/rooms/'+alice.code+'/resume',{token:bob.token});assert.equal(restored.state.pattern,'__LL___');assert.equal(restored.state.wrong,1);assert(!JSON.stringify(restored).includes('BALLOON'));
  b=await connect(alice.code,bob.token);assert.equal(b.latest().pattern,'__LL___');
  pass('a disconnected phone returns to the same round and the opponent sees its connection status');
  for(const letter of ['B','A','O','N'])await action(b,'guess',{letter});
  for(const client of [a,b])await client.wait(m=>m.type==='state'&&m.state.round===2);
  assert.equal(b.latest().role,'setter');assert.equal(a.latest().role,'guesser');assert.equal(a.latest().lastResult.word,'BALLOON');assert.equal(a.latest().lastResult.outcome,'won');
  await action(b,'guess',{letter:'X',round:1},true);
  await action(b,'setWord',{word:'CAT'});
  await a.wait(m=>m.type==='state'&&m.state.phase==='playing'&&m.state.round===2);
  for(const letter of 'BDEFGH')await action(a,'guess',{letter});
  for(const client of [a,b])await client.wait(m=>m.type==='state'&&m.state.round===3);
  assert.equal(a.latest().role,'setter');assert.equal(a.latest().lastResult.outcome,'lost');assert.equal(a.latest().lastResult.wrong,6);assert.equal(a.latest().lastResult.word,'CAT');
  pass('wins and six-miss losses reveal the answer and automatically swap roles; stale moves are rejected');
  await action(a,'setWord',{word:'PERSIST'});await b.wait(m=>m.type==='state'&&m.state.phase==='playing'&&m.state.round===3);
  for(const client of [a,b])client.ws.close(1000,'Runtime restart');
  await mf.dispose();mf=runtime();await mf.ready;
  const after=await post('/api/rooms/'+alice.code+'/resume',{token:bob.token});assert.equal(after.state.round,3);assert.equal(after.state.pattern,'_______');assert(!JSON.stringify(after).includes('PERSIST'));
  const reconnect=await connect(alice.code,bob.token);assert.equal(reconnect.latest().role,'guesser');
  assert.equal(after.state.chat.length,2);assert.equal(reconnect.latest().chat[0].text,'Hello Bob <script>!');
  pass('chat history survives round swaps, reconnecting and a runtime restart');
  pass('a Cloudflare runtime restart preserves room membership and the active round in SQLite');
  console.log('All Cloudflare runtime integration checks passed.');
} finally {
  for(const ws of sockets)try{ws.close(1000,'Tests complete')}catch(_){}
  if(mf)await mf.dispose();await fs.rm(temp,{recursive:true,force:true});
}
