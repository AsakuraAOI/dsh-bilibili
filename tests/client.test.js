import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BilibiliClient, extractCookies, parseJson, writeJson, isBilibiliInput, PRIVATE_SEND_INTERVAL_MS } from '../src/client.js';

const BV = 'BV1xx411c7mD';
const metadata = { bvid: BV, aid: 170001, title: '演示', desc: '简介', owner: { name: '作者' }, duration: 120, pages: [{ page: 1, cid: 1, duration: 60, part: '上' }, { page: 2, cid: 2, duration: 60, part: '下' }] };
const ok = data => Response.json({ code: 0, data });
async function fixture(t, fetcher, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bili-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const accountFile = join(dir, 'account.json');
  await writeJson(accountFile, { cookies: { SESSDATA: 'secret-session', bili_jct: 'csrf-value', DedeUserID: '42' }, deviceId: 'test-device' });
  return new BilibiliClient({ accountFile, fetcher, ...options });
}
test('64-bit IDs preserve exact decimal source tokens without changing strings', () => {
  const data = parseJson('{"id":6984393491767669026,"text":"12345678901234567890","count":42}');
  assert.equal(data.id, '6984393491767669026'); assert.equal(data.text, '12345678901234567890'); assert.equal(data.count, 42);
});
test('login extracts nested credentials and Set-Cookie, never exposing URL in success', () => {
  const nested = `https://passport.bilibili.com/redirect?next=${encodeURIComponent('https://passport.bilibili.com/crossDomain?SESSDATA=a%2Cb&bili_jct=j&DedeUserID=42')}`;
  assert.deepEqual(extractCookies(nested), { SESSDATA: 'a%2Cb', bili_jct: 'j', DedeUserID: '42' });
  assert.equal(extractCookies('', ['SESSDATA=abc; HttpOnly','bili_jct=j; Path=/']).SESSDATA, 'abc');
});
test('QR polling stores credentials but returns only public identity', async t => {
  const api = await fixture(t, async url => url.includes('/qrcode/poll') ? ok({ code: 0, url: 'https://passport.bilibili.com/crossDomain?SESSDATA=PRIVATE&bili_jct=JCT&DedeUserID=42' }) : ok({ isLogin: true, mid: 42, uname: '机器人' }));
  const result = await api.pollLogin('KEY');
  assert.equal(result.status, 'success'); assert.equal(result.name, '机器人');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|JCT|SESSDATA/);
  assert.match(await readFile(api.accountFile, 'utf8'), /PRIVATE/);
});
test('BV, full URL and multi-part query resolve one canonical part', async t => {
  const api = await fixture(t, async () => ok(metadata));
  for (const input of [BV + '?p=2', `https://www.bilibili.com/video/${BV}/?p=2`, `【分享】https://www.bilibili.com/video/${BV}/?p=2`]) {
    const result = await api.resolveVideo(input); assert.equal(result.page, 2); assert.equal(result.cid, '2'); assert.equal(result.videoId, `bilibili-${BV}-p2`);
  }
  await assert.rejects(() => api.resolveVideo(BV, 3), { code: 'VIDEO_PART_MISSING' });
});
test('host lookalikes and shortlink redirects cannot receive account cookies', async t => {
  const requests = [];
  const api = await fixture(t, async (url, init) => { requests.push({ url, init }); return new Response(null, { status: 302, headers: { location: 'https://evil.example/video/' + BV } }); });
  await assert.rejects(() => api.resolveVideo('https://b23.tv/abc'), { code: 'INVALID_VIDEO_URL' });
  assert.equal(requests.length, 1); assert.equal(requests[0].init.headers.Cookie, undefined);
  await assert.rejects(() => api.resolveVideo(`https://www.bilibili.com.evil.example/video/${BV}`), { code: 'INVALID_VIDEO_URL' });
  assert.equal(isBilibiliInput(`https://www.bilibili.com.evil.example/video/${BV}`), false);
});
test('media requests never contain Cookie and validate every redirect', async t => {
  const api = await fixture(t, async (_url, init) => { assert.equal(init.headers.Cookie, undefined); return new Response(null, { status: 302, headers: { location: 'https://evil.example/media.mp4' } }); });
  await assert.rejects(() => api.mediaResponse('https://cdn.bilivideo.com/a.mp4'), { code: 'INVALID_MEDIA_HOST' });
});
test('comment writes include CSRF and correct reply IDs, only one POST', async t => {
  const calls = [];
  const api = await fixture(t, async (url, init) => { calls.push({url, init}); return ok(url.includes('/view') ? metadata : { rpid_str: '6984393491767669026' }); });
  const result = await api.comment(BV, '测试内容', '900', '901');
  const post = calls.find(c => c.init.method === 'POST');
  assert.equal(post.init.body.get('csrf'), 'csrf-value'); assert.equal(post.init.body.get('root'), '900'); assert.equal(post.init.body.get('parent'), '901'); assert.equal(post.init.body.get('oid'), '170001');
  assert.equal(result.commentId, '6984393491767669026'); assert.equal(calls.filter(c => c.init.method === 'POST').length, 1);
  await assert.rejects(() => api.comment(BV, 'bad', undefined, '901'), { code: 'INVALID_ARGUMENT' });
});
test('network failure on writes is ambiguous and never retried', async t => {
  let posts = 0;
  const api = await fixture(t, async (url, init) => { if (init.method === 'POST') { posts++; throw new Error('network'); } return ok(metadata); });
  await assert.rejects(() => api.comment(BV, '测试'), { code: 'WRITE_RESULT_UNKNOWN' }); assert.equal(posts, 1);
});
test('private messages use account sender and full UID, signed query and CSRF', async t => {
  let post;
  const api = await fixture(t, async (url, init) => {
    if (init.method === 'POST') { post = {url: new URL(url), init}; return new Response('{"code":0,"data":{"msg_key":6984393491767669026}}'); }
    return ok({ wbi_img: { img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png', sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png' } });
  });
  const result = await api.sendMessage('3546910497441845', '你好');
  assert.equal(result.messageKey, '6984393491767669026'); assert.equal(post.init.body.get('msg[sender_uid]'), '42'); assert.equal(post.init.body.get('msg[receiver_id]'), '3546910497441845'); assert.equal(post.init.body.get('csrf'), 'csrf-value'); assert.equal(post.url.searchParams.get('w_rid').length, 32);
});
test('mentions resolve video from notification subject, not unrelated BV in comment text', async t => {
  const api = await fixture(t, async () => ok({ items: [{ id: 1, at_time: 200, item: { business_id: 1, subject_id: 170001, source_id: 88, root_id: 77, source_content: 'look BV1xx411c7mD' } }, { id: 2, at_time: 201, item: { business_id: 17, subject_id: 123, source_content: BV } }], cursor: { is_end: true } }));
  const result = await api.mentions(); assert.equal(result.items[0].video, 'av170001'); assert.equal(result.items[0].parent, '88'); assert.equal(result.items[1].video, null);
});
test('risk control fails without retrying', async t => {
  let calls = 0; const api = await fixture(t, async () => { calls++; return Response.json({ code: -412, message: '风控' }); });
  await assert.rejects(() => api.resolveVideo(BV), { code: 'RISK_CONTROL' }); assert.equal(calls, 1);
});
test('server failures and corrupt write responses remain ambiguous', async t => {
  for (const response of [new Response('unavailable',{status:503}),new Response('bad json')]) {
    const api=await fixture(t,async url=>url.includes('/view')?ok(metadata):response);
    await assert.rejects(()=>api.comment(BV,'test'),{code:'WRITE_RESULT_UNKNOWN'});
  }
});
test('private inbox lists direct conversations with pagination and preserves exact message IDs',async t=>{
 let params;
 const api=await fixture(t,async url=>{params=new URL(url).searchParams;return new Response('{"code":0,"data":{"has_more":1,"session_list":[{"talker_id":99,"session_type":1,"session_ts":1700000000000000,"system_msg_type":0,"last_msg":{"timestamp":1700000000,"msg_key":6984393491767669026}}]}}');});
 const result=await api.privateSessions('1700000001000000');
 assert.equal(params.get('session_type'),'1');assert.equal(params.get('end_ts'),'1700000001000000');
 assert.equal(result.hasMore,true);assert.equal(result.sessions[0].lastKey,'6984393491767669026');assert.equal(result.sessions[0].system,false);
});

test('single-message limits reject excess characters and escaped JSON bytes before writing',async t=>{
 let writes=0;const api=await fixture(t,async()=>{writes++;assert.fail('must reject before network');});
 await assert.rejects(()=>api.sendMessage('99','文'.repeat(501)),{code:'MESSAGE_TOO_LONG'});
 await assert.rejects(()=>api.sendMessage('99','\u0000'.repeat(500)),{code:'MESSAGE_TOO_LONG'});
 await assert.rejects(()=>api.comment(BV,'文'.repeat(1001)),{code:'MESSAGE_TOO_LONG'});
 assert.equal(writes,0);
});

test('comment and private writes preserve segment boundary whitespace',async t=>{
 const bodies=[],api=await fixture(t,async(url,init)=>{
  if(init.method==='POST') {bodies.push(init.body);return ok({rpid_str:'123',msg_key:'456'});}
  if(url.includes('/view')) return ok(metadata);
  return ok({wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png'}});
 });
 const content='【1/2】\n  正文 \n';await api.comment(BV,content,'77','88');await api.sendMessage('99',content);
 assert.equal(bodies[0].get('message'),content);assert.equal(JSON.parse(bodies[1].get('msg[content]')).content,content);
});

test('private writes across client instances share a queue and wait after each acknowledgement',async t=>{
 let now=1700000000200,inFlight=0,maxInFlight=0;const sleeps=[],posts=[];
 const clock={now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}};
 const api=await fixture(t,async(_url,init)=>{
  if(init.method==='POST') {
   inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
   posts.push({time:now,timestamp:Number(init.body.get('msg[timestamp]')),content:JSON.parse(init.body.get('msg[content]')).content});
   await new Promise(resolve=>setImmediate(resolve));now+=100;inFlight--;
   return ok({msg_key:String(posts.length)});
  }
  return ok({wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png'}});
 },{clock});
 const secondClient=new BilibiliClient({accountFile:api.accountFile,fetcher:api.fetcher,clock});
 const results=await Promise.all([api.sendMessage('99','【1/3】'),secondClient.sendMessage('99','【2/3】'),api.sendMessage('99','【3/3】')]);
 assert.equal(maxInFlight,1);assert.deepEqual(posts.map(p=>p.content),['【1/3】','【2/3】','【3/3】']);
 assert.deepEqual(sleeps,[PRIVATE_SEND_INTERVAL_MS,PRIVATE_SEND_INTERVAL_MS]);
 for(let i=1;i<posts.length;i++){assert.ok(posts[i].time-results[i-1].acknowledgedAt>=PRIVATE_SEND_INTERVAL_MS);assert.ok(posts[i].timestamp>posts[i-1].timestamp);}
 results.forEach((result,index)=>{assert.equal(result.timestamp,Math.floor(posts[index].time/1000));assert.equal(result.acknowledgedAt,posts[index].time+100);});
});

test('resumed private writes wait for persisted acknowledgements without inventing future timestamps',async t=>{
 let now=1700000000000;const waits=[];
 const clock={now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;}};
 let timestamp;
 const api=await fixture(t,async(_url,init)=>{
  if(init.method==='POST'){timestamp=Number(init.body.get('msg[timestamp]'));return ok({msg_key:'1'});}
  return ok({wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png'}});
 },{clock});
 const notBefore=now+1400;
 await api.sendMessage('99','续发',{notBefore});assert.deepEqual(waits,[1400]);assert.equal(timestamp,Math.floor(notBefore/1000));assert.equal(now,notBefore);
});

test('cancelling a queued wait never sends its message and leaves the queue usable',async t=>{
 let now=1700000000000,writes=0;const controller=new AbortController();
 const clock={now:()=>now,sleep:async(_ms,signal)=>{controller.abort();signal.throwIfAborted();}};
 const api=await fixture(t,async()=>{writes++;assert.fail('no request after cancelled wait');},{clock,signal:controller.signal});
 await assert.rejects(()=>api.sendMessage('99','不要发',{notBefore:now+1500}),{name:'AbortError'});assert.equal(writes,0);
 const next=new BilibiliClient({accountFile:api.accountFile,fetcher:async(_url,init)=>init.method==='POST'?ok({msg_key:'ok'}):ok({wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png'}}),clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
 assert.equal((await next.sendMessage('99','后续明确发送')).sent,true);
});
