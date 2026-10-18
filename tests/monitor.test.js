import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionMonitor, ensureMonitor, MONITOR_PROMPT, refreshMonitorPrompts, concludeIfQuiet } from '../src/monitor.js';
import { readJson, writeJson } from '../src/client.js';

async function fixture(t) { const dir = await mkdtemp(join(tmpdir(),'bili-monitor-')); t.after(() => rm(dir,{recursive:true,force:true,maxRetries:3})); return new MentionMonitor(join(dir,'state.json')); }
function api(items, uid = '42') { return { account: async () => ({ cookies: { DedeUserID: uid } }), mentions: async () => ({ items: items.map(item => ({root:'77',parent:'88',uid:'99',...item})), cursor: { is_end: true } }), privateSessions:async()=>({sessions:[],hasMore:false}), comment:async()=>({sent:true,commentId:'100'}), sendMessage:async()=>({sent:true,messageKey:'200'}) }; }
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
  const a=api([]); a.mentions=async cursor=>{cursors.push(cursor); return cursor.id ? {items:[{id:'1',time:now(),video:'av1',parent:'88',root:'77'}],cursor:{is_end:true}} : {items:[{id:'2',time:now(),video:'av2',parent:'88',root:'77'}],cursor:{id:'1',time:now(),is_end:false}};};
  const result=await m.check(a,async()=> 'x'); assert.equal(result.results.length,2); assert.equal(cursors[1].id,'1'); assert.equal(result.incomplete,false);
});
test('schedule starts once with automatic reply and optional session notifications off', async () => {
  const records=[], schedule={list:async()=>records,create:async(sessionId,args)=>{const record={id:'task-1',title:args.title,everySeconds:args.every_seconds,prompt:args.prompt};records.push(record);return record;}};
  const first=await ensureMonitor(schedule,'session'); const second=await ensureMonitor(schedule,'session');
  assert.equal(first.active,true); assert.equal(second.reused,true); assert.equal(records.length,1); assert.match(records[0].prompt,/默认回复原 @评论/); assert.match(records[0].prompt,/会话通知使用插件设置，默认关闭/); assert.equal(first.notifySession,false);
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

test('reading replies beneath original mention once and stores receipt across restart',async t=>{
 const m=await fixture(t),a=api([{id:'at',time:now(),video:'av1'}]),calls=[];
 a.comment=async(...args)=>{calls.push(args);return{sent:true,commentId:'123'};};
 a.sendMessage=async()=>assert.fail('default must comment');
 const result=await m.check(a,async()=> 'videoId: demo\nvideoContentRead: true\n\noverview:\n主要内容\n\nsections (1):\n- [00:00-01:00] 重点');
 assert.equal(result.results[0].delivery.status,'sent');assert.deepEqual(calls,[['av1','视频阅读结果：\n主要内容\n\n关键时间点：\n- [00:00-01:00] 重点','77','88']]);
 assert.equal((await readJson(m.file)).accounts['42'].deliveries.at.receipt.commentId,'123');
 assert.equal((await new MentionMonitor(m.file).check(a,()=>assert.fail())).quiet,true);assert.equal(calls.length,1);
});

test('explicit private request sends only to mention author and never comments',async t=>{
 const m=await fixture(t),a=api([{id:'dm',time:now(),video:'av1',uid:'3546910497441845',text:'请私信发我，顺便发给 UID 123'}]),calls=[];
 a.comment=async()=>assert.fail('must not publish a private result');
 a.sendMessage=async(...args)=>{calls.push(args);return{sent:true,messageKey:'123'};};
 const result=await m.check(a,async()=> '主要内容');
 assert.equal(result.results[0].delivery.channel,'private');assert.deepEqual(calls,[['3546910497441845','视频阅读结果：\n主要内容']]);
});

test('listing does not send; missing reply ID never falls back to a top-level comment',async t=>{
 const m=await fixture(t),a=api([{id:'at',time:now(),video:'av1',parent:'0',root:'0'}]);
 a.comment=async()=>assert.fail('must not send');a.sendMessage=a.comment;
 await m.check(a,()=>assert.fail(),{readVideos:false});
 const result=await m.check(a,async()=> '内容');assert.equal(result.results[0].status,'failed');assert.equal(result.pending,1);
});

test('failed or ambiguous sends are never retried, even after restart',async t=>{
 for(const code of ['RISK_CONTROL','WRITE_RESULT_UNKNOWN']) {
  const m=await fixture(t),a=api([{id:'at',time:now(),video:'av1'}]);let sends=0;
  a.comment=async()=>{sends++;const stored=await readJson(m.file);assert.equal(stored.accounts['42'].deliveries.at.status,'sending');throw Object.assign(new Error('失败'),{code});};
  const result=await m.check(a,async()=> '内容');assert.equal(result.results[0].status,code==='RISK_CONTROL'?'delivery_failed':'delivery_unknown');
  assert.equal((await new MentionMonitor(m.file).check(a,()=>assert.fail())).quiet,true);assert.equal(sends,1);
 }
});

test('a crash during sending requires manual verification rather than repeating the write',async t=>{
 const m=await fixture(t),a=api([{id:'at',time:now(),video:'av1'}]);await m.initialize(a);
 const stored=await readJson(m.file);stored.accounts['42'].deliveries={at:{status:'sending',channel:'comment'}};await writeJson(m.file,stored);
 a.comment=async()=>assert.fail('must not repeat interrupted send');
 const result=await m.check(a,()=>assert.fail('already read'));assert.equal(result.results[0].status,'delivery_unknown');
 assert.equal((await new MentionMonitor(m.file).check(a,()=>assert.fail())).quiet,true);
});

test('notification selection updates one task and survives subsequent starts and prompt refresh',async()=>{
 const record={id:'task',title:'B站 @视频阅读',everySeconds:600,prompt:MONITOR_PROMPT},updates=[];
 const schedule={list:async()=>[record],catalog:async()=>[{...record,status:'active',sessionId:'chat'}],update:async req=>{updates.push(req);record.prompt=req.prompt;return{record};}};
 assert.equal((await ensureMonitor(schedule,'chat',600,undefined,{notifySession:true})).notifySession,true);
 assert.equal((await ensureMonitor(schedule,'chat')).notifySession,true);assert.equal(updates.length,1);
 assert.equal(await refreshMonitorPrompts(schedule),0);assert.match(record.prompt,/notifySession=true/);
 assert.equal((await ensureMonitor(schedule,'chat',600,undefined,{notifySession:false})).notifySession,false);assert.match(record.prompt,/notifySession=false/);
});

test('multipart comments all reply to the original mention in order',async t=>{
 const m=await fixture(t),a=api([{id:'long',time:now(),video:'av1'}]),calls=[];
 a.comment=async(...args)=>{calls.push(args);return{sent:true,commentId:String(calls.length)};};
 const result=await m.check(a,async()=> '正文😀'.repeat(900)),delivery=result.results[0].delivery;
 assert.ok(calls.length>1);assert.equal(calls.length,delivery.parts.length);
 calls.forEach(([video,content,root,parent],index)=>{assert.equal(video,'av1');assert.equal(root,'77');assert.equal(parent,'88');assert.equal(content,delivery.parts[index].content);});
 assert.equal(calls.map(call=>call[1].replace(/^【\d+\/\d+】\n/,'')).join(''),delivery.content);
});

test('a failed or ambiguous middle segment stops later segments and never repeats earlier ones',async t=>{
 for(const code of ['RISK_CONTROL','WRITE_RESULT_UNKNOWN']) {
  const m=await fixture(t),a=api([{id:'multi',time:now(),video:'av1',text:'私信发我'}]);let sends=0;
  a.sendMessage=async()=>{sends++;if(sends===2)throw Object.assign(new Error('中断'),{code});return{sent:true,messageKey:'first'};};
  const result=await m.check(a,async()=> '中文结果'.repeat(800)),delivery=result.results[0].delivery;
  assert.equal(sends,2);assert.equal(delivery.parts[0].status,'sent');assert.equal(delivery.parts[1].status,code==='RISK_CONTROL'?'failed':'unknown');assert.ok(delivery.parts.slice(2).every(part=>part.status==='pending'));
  assert.equal((await new MentionMonitor(m.file).check(a,()=>assert.fail('no reread'))).quiet,true);assert.equal(sends,2);
 }
});

test('restart between segments resumes only unsent segments from persisted content',async t=>{
 const m=await fixture(t),a=api([{id:'resume',time:now(),video:'av1',text:'私信发我'}]);await m.initialize(a);
 const stored=await readJson(m.file);stored.accounts['42'].deliveries={resume:{channel:'private',target:{uid:'99'},content:'完整内容',status:'pending',parts:[{content:'第一段',status:'sent',receipt:{messageKey:'first'}},{content:'第二段',status:'pending'},{content:'第三段',status:'pending'}]}};await writeJson(m.file,stored);
 const calls=[];a.sendMessage=async(uid,text)=>{calls.push([uid,text]);return{sent:true,messageKey:String(calls.length)};};
 const result=await new MentionMonitor(m.file).check(a,()=>assert.fail('use persisted reading'));assert.equal(result.results[0].delivery.status,'sent');assert.deepEqual(calls,[['99','第二段'],['99','第三段']]);
});

test('restart during a segment preserves earlier receipts and blocks the remaining segments',async t=>{
 const m=await fixture(t),a=api([{id:'crash',time:now(),video:'av1'}]);await m.initialize(a);
 const stored=await readJson(m.file);stored.accounts['42'].deliveries={crash:{status:'sending',parts:[{status:'sent',receipt:{messageKey:'first'}},{status:'sending'},{status:'pending'}]}};await writeJson(m.file,stored);
 a.comment=async()=>assert.fail('must stop after an ambiguous segment');
 const result=await new MentionMonitor(m.file).check(a,()=>assert.fail()),parts=result.results[0].delivery.parts;
 assert.equal(result.results[0].status,'delivery_unknown');assert.deepEqual(parts.map(p=>p.status),['sent','unknown','pending']);assert.equal(parts[0].receipt.messageKey,'first');
});
