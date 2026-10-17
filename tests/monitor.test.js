import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionMonitor, ensureMonitor, MONITOR_PROMPT, refreshMonitorPrompts, concludeIfQuiet } from '../src/monitor.js';
import { readJson } from '../src/client.js';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(),'bili-monitor-')); t.after(() => rm(dir,{recursive:true,force:true})); return new MentionMonitor(join(dir,'state.json')); }
function api(items, uid = '42') { return { account: async () => ({ cookies: { DedeUserID: uid } }), mentions: async () => ({ items, cursor: { is_end: true } }), privateSessions:async()=>({sessions:[],hasMore:false}) }; }
const now = () => Math.floor(Date.now()/1000);
test('initialization persists start time before first scheduled check', async t => {
  const m = await fixture(t); await m.initialize(api([])); const stored = await readJson(m.file);
  assert.equal(stored.accounts['42'].since, now());
});
test('successful reads persist across restart; read failure remains retryable and unchanged failure quiet', async t => {
  const m = await fixture(t), items = [{ id:'1', time:now(), video:'BV1xx411c7mD' }], a = api(items);
  await m.initialize(a);
  let calls = 0;
  const read = async () => { calls++; if (calls < 3) throw new Error('offline'); return '内容'; };
  assert.equal((await m.check(a,read)).results[0].status,'failed');
  assert.equal((await m.check(a,read)).quiet,true);
  assert.equal((await m.check(a,read)).results[0].status,'read');
  const restarted = new MentionMonitor(m.file);
  assert.equal((await restarted.check(a,read)).quiet,true); assert.equal(calls,3);
});
test('read budget keeps remaining notifications for next run; listing does not acknowledge', async t => {
  const m=await fixture(t), a=api([1,2,3].map(i=>({id:String(i),time:now(),video:'av'+i}))); await m.initialize(a);
  const listing=await m.check(a,async()=>assert.fail(),{readVideos:false}); assert.equal(listing.items.length,3);
  let count=0; const read=async()=>{count++;return 'read';};
  assert.equal((await m.check(a,read,{maxVideos:1})).pending,2);
  assert.equal((await m.check(a,read,{maxVideos:3})).pending,0); assert.equal(count,3);
});
test('accounts have separate mention dedupe state', async t => {
  const m=await fixture(t), item={id:'1',time:now(),video:'av1'}; let count=0;
  await m.check(api([item],'1'),async()=>{count++;return 'a';}); await m.check(api([item],'2'),async()=>{count++;return 'b';}); assert.equal(count,2);
});
test('concurrent monitor checks serialize and read each message once', async t => {
  const m=await fixture(t), a=api([{id:'1',time:now(),video:'av1'}]); let count=0;
  await Promise.all([m.check(a,async()=>{count++;return 'x';}),m.check(a,async()=>{count++;return 'x';})]); assert.equal(count,1);
});
test('monitor follows pagination and preserves untouched page cursor', async t => {
  const m=await fixture(t), cursors=[];
  const a=api([]); a.mentions=async cursor=>{cursors.push(cursor); return cursor.id ? {items:[{id:'1',time:now(),video:'av1'}],cursor:{is_end:true}} : {items:[{id:'2',time:now(),video:'av2'}],cursor:{id:'1',time:now(),is_end:false}};};
  const result=await m.check(a,async()=> 'x'); assert.equal(result.results.length,2); assert.equal(cursors[1].id,'1'); assert.equal(result.incomplete,false);
});
test('schedule starts once and keeps no-auto-send instructions', async () => {
  const records=[], schedule={list:async()=>records,create:async(sessionId,args)=>{const record={id:'task-1',title:args.title,everySeconds:args.every_seconds,prompt:args.prompt};records.push(record);return record;}};
  const first=await ensureMonitor(schedule,'session'); const second=await ensureMonitor(schedule,'session');
  assert.equal(first.active,true); assert.equal(second.reused,true); assert.equal(records.length,1); assert.match(records[0].prompt,/不发送评论或私信/);
});
test('changing monitor interval updates the same persisted task through schedule API',async()=>{
 const existing={id:'task-1',title:'B站 @视频阅读',everySeconds:600};let request;
 const schedule={list:async()=>[existing],update:async value=>{request=value;return{record:{...existing,everySeconds:value.change.every_seconds}};}};
 const result=await ensureMonitor(schedule,'session',900);assert.equal(result.id,'task-1');assert.equal(result.everySeconds,900);assert.equal(request.change.every_seconds,900);
});
test('empty mentions and private inbox are quiet and conclude only silent checks',async t=>{
 const m=await fixture(t),result=await m.check(api([]),()=>assert.fail('nothing to read'));
 assert.equal(result.quiet,true);assert.deepEqual(result.privateMessages,[]);
 let closed=0;const execution={concludeTurn:()=>closed++};
 concludeIfQuiet(result,false,execution);assert.equal(closed,0);
 concludeIfQuiet(result,true,execution);assert.equal(closed,1);
 concludeIfQuiet({quiet:false},true,execution);assert.equal(closed,1);
});
test('new incoming private messages notify once; outgoing and old messages stay quiet across restart',async t=>{
 const m=await fixture(t),a=api([]),time=now();
 a.privateSessions=async()=>({hasMore:false,sessions:[{uid:'99',type:1,system:false,lastTime:time,lastKey:'in-1',name:'来信人'}]});
 a.messages=async()=>({hasMore:false,messages:[
  {key:'out-1',sender:'42',time,content:'{"content":"自己发的"}'},
  {key:'in-1',sender:'99',time,content:'{"content":"请看看这个视频"}',type:1},
  {key:'old',sender:'99',time:time-1000,content:'旧私信'},
 ]});
 await m.initialize(a);const first=await m.check(a,()=>assert.fail());
 assert.equal(first.quiet,false);assert.equal(first.privateMessages.length,1);assert.equal(first.privateMessages[0].content,'请看看这个视频');
 const next=await new MentionMonitor(m.file).check(a,()=>assert.fail());assert.equal(next.quiet,true);assert.deepEqual(next.privateMessages,[]);
});
test('new non-video mentions also notify once rather than being silently discarded',async t=>{
 const m=await fixture(t),a=api([{id:'plain-at',time:now(),video:null,text:'@账号 你好'}]);
 const first=await m.check(a,()=>assert.fail());assert.equal(first.quiet,false);assert.equal(first.results[0].status,'mention');
 assert.equal((await m.check(a,()=>assert.fail())).quiet,true);
});
test('existing persisted monitor gets the new silence prompt without changing interval or creating tasks',async()=>{
 const record={id:'existing',title:'B站 @视频阅读',everySeconds:900,prompt:'旧规则'},updates=[];
 const schedule={catalog:async()=>[{...record,status:'active',sessionId:'chat'}],list:async()=>[record],update:async request=>{updates.push(request);record.prompt=request.prompt;return{record};}};
 assert.equal(await refreshMonitorPrompts(schedule),1);assert.equal(updates[0].change,undefined);assert.equal(record.everySeconds,900);
 assert.match(record.prompt,/silentIfEmpty=true/);assert.match(record.prompt,/不输出任何回复/);
 assert.equal(await refreshMonitorPrompts(schedule),0);
});
