import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MentionMonitor } from '../src/monitor.js';
import { readJson } from '../src/client.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'bili-handoff-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:3}));
 const items=[{id:'at',time:Math.floor(Date.now()/1000),video:'av1',root:'77',parent:'88',uid:'99',text:'@账号 3:20 图表是什么？私信我'}],posts=[];
 const api={account:async()=>({cookies:{DedeUserID:'42'}}),mentions:async()=>({items,cursor:{is_end:true}}),privateSessions:async()=>({sessions:[],hasMore:false}),sendMessage:async(uid,text)=>{posts.push([uid,text]);return{sent:true,messageKey:String(posts.length)};},comment:async()=>assert.fail('route must stay private')};
 return{monitor:new MentionMonitor(join(dir,'state.json')),api,items,posts};
}

test('handoff survives restart and feed disappearance without marking read-and-reply complete',async t=>{
 const f=await fixture(t);let reads=0;const read=async()=>{reads++;return'videoId: demo\nrepresentation: evidence_text\nmaterials:\n[03:20] [VLM 观察] 数字模糊。';};
 const first=await f.monitor.prepareForAgent(f.api,read,{ownerSessionId:'agent',notifySession:false});assert.equal(first.results[0].status,'awaiting_agent');assert.equal(f.posts.length,0);assert.equal(first.pending,1);
 const requestId=first.results[0].requestId;f.items.splice(0);
 const restarted=new MentionMonitor(f.monitor.file);const next=await restarted.prepareForAgent(f.api,()=>assert.fail('reuse materials'),{ownerSessionId:'agent'});assert.equal(next.results[0].requestId,requestId);assert.equal(reads,1);
 await assert.rejects(()=>restarted.finish(f.api,[requestId],'agent'),/还有请求未/);
 const response=await restarted.reply(f.api,requestId,{ownerSessionId:'agent',content:'主 Agent 经回看后确认数字为 42。'});assert.equal(response.status,'sent');assert.equal(f.posts[0][0],'99');
 assert.equal((await restarted.finish(f.api,[requestId],'agent')).quiet,true);
 await restarted.reply(f.api,requestId,{ownerSessionId:'agent',content:'不应重复发送'});assert.equal(f.posts.length,1);
 const state=await readJson(f.monitor.file);assert.ok(state.accounts['42'].completed.includes('at'));assert.equal(state.accounts['42'].deliveries.at.reading,undefined);
});

test('another session cannot receive prepared work or change its destination',async t=>{
 const f=await fixture(t);const first=await f.monitor.prepareForAgent(f.api,async()=> 'materials:\n原材料',{ownerSessionId:'first'});
 const other=await f.monitor.prepareForAgent(f.api,()=>assert.fail(),{ownerSessionId:'other'});assert.equal(other.results.length,0);
 await assert.rejects(()=>f.monitor.reply(f.api,first.results[0].requestId,{ownerSessionId:'other',content:'改发'}),/另一个 DSH 会话/);assert.equal(f.posts.length,0);
});

test('unknown partial send cannot be replayed when the main Agent retries a reply',async t=>{
 const f=await fixture(t);const first=await f.monitor.prepareForAgent(f.api,async()=> 'materials:\n原材料',{ownerSessionId:'agent'});let sends=0;
 f.api.sendMessage=async()=>{sends++;if(sends===2)throw Object.assign(new Error('网络中断'),{code:'WRITE_RESULT_UNKNOWN'});return{sent:true,messageKey:'first'};};
 const id=first.results[0].requestId;const result=await f.monitor.reply(f.api,id,{ownerSessionId:'agent',content:'长回复内容'.repeat(500)});assert.equal(result.status,'unknown');assert.equal(sends,2);
 await f.monitor.reply(f.api,id,{ownerSessionId:'agent',content:'不允许重发'});assert.equal(sends,2);
});

test('verbatim materials preserve inner markers, blank lines and source wording',async t=>{
 const f=await fixture(t),body='[00:00] [视频字幕原文] 原句\nmaterials:\n  \n正文中的标记与空行不能丢失。';
 const prepared=await f.monitor.prepareForAgent(f.api,async()=>`videoId: demo\nvideoContentRead: true\nrepresentation: evidence_text\nmaterials:\n${body}`,{ownerSessionId:'agent'});
 await f.monitor.reply(f.api,prepared.results[0].requestId,{ownerSessionId:'agent',useMaterials:true});assert.equal(f.posts[0][1],body);
});
