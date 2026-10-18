import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDelivery, wantsPrivateReply, splitReply, sendDelivery } from '../src/delivery.js';

test('private routing requires an explicit request and respects common negations',()=>{
 for(const text of ['请私信发我','麻烦把结果通过私信回复','不要公开评论，请私信','私信','DM me','send me a private message']) assert.equal(wantsPrivateReply(text),true,text);
 for(const text of ['看看视频','不要私信我','不用发私信，直接评论','无需私聊','别发私信','视频介绍了私信功能','私信不要发']) assert.equal(wantsPrivateReply(text),false,text);
});

test('reply content strips internal headers and splits without losing any content',()=>{
 const item={video:'av1',parent:'88',root:'0',uid:'99'},reading='videoId: private-cache-id\nvideoContentRead: true\n\noverview:\n'+ '😀中文'.repeat(1200);
 const comment=prepareDelivery(item,reading);assert.equal(comment.target.root,'88');assert.ok(comment.parts.length>1);assert.doesNotMatch(comment.content,/private-cache-id|videoContentRead/);
 const dm=prepareDelivery({...item,text:'私信发我'},reading);assert.ok(dm.parts.length>1);
 for(const delivery of [comment,dm]) {
  assert.equal(delivery.parts.map(part=>part.content.replace(/^【\d+\/\d+】\n/,'')).join(''),delivery.content);
  delivery.parts.forEach((part,index)=>{
   assert.ok([...part.content].length<=(delivery.channel==='private'?500:1000));
   if(delivery.channel==='private') assert.ok(Buffer.byteLength(JSON.stringify({content:part.content}))<=2000);
   assert.ok(part.content.startsWith(`【${index+1}/${delivery.parts.length}】\n`));
  });
 }
 assert.throws(()=>prepareDelivery(item,'videoId: demo\nvideoContentRead: true'),{code:'REPLY_CONTENT_MISSING'});
 assert.throws(()=>prepareDelivery({...item,text:'私信我',uid:''},'内容'),{code:'INVALID_ARGUMENT'});
});

test('single parts stay unchanged, and numbered Unicode and escaped JSON remain within limits',()=>{
 assert.deepEqual(splitReply('内容','private'),['内容']);
 for(const channel of ['private','comment']) for(const text of ['😀中文'.repeat(5000), '\u0000"\\\n'.repeat(3000), '段落一\n\n段落二 word '.repeat(1000)]) {
  const parts=splitReply(text,channel);assert.equal(parts.map(p=>p.replace(/^【\d+\/\d+】\n/,'')).join(''),text);
  assert.ok(parts.length>=10);
  parts.forEach((part,index)=>{assert.ok([...part].length<=(channel==='private'?500:1000));if(channel==='private') assert.ok(Buffer.byteLength(JSON.stringify({content:part}))<=2000);assert.ok(part.startsWith(`【${index+1}/${parts.length}】\n`));});
 }
});

test('segments are awaited in order and each receipt is persisted before the next send',async()=>{
 const delivery=prepareDelivery({uid:'99',text:'私信发我'},'中文内容'.repeat(400));delivery.status='pending';
 let calls=0,inFlight=false;const persisted=[];
 await sendDelivery({sendMessage:async(uid,content)=>{
  assert.equal(uid,'99');assert.equal(inFlight,false);inFlight=true;
  const saved=persisted.at(-1);assert.equal(saved.parts[calls].status,'sending');
  assert.ok(saved.parts.slice(0,calls).every(part=>part.status==='sent'&&part.receipt));
  assert.equal(content,delivery.parts[calls].content);calls++;
  await Promise.resolve();inFlight=false;return{sent:true,messageKey:String(calls)};
 }},delivery,async()=>persisted.push(structuredClone(delivery)));
 assert.equal(calls,delivery.parts.length);assert.equal(delivery.status,'sent');assert.ok(delivery.parts.every(part=>part.status==='sent'));assert.equal(persisted.length,calls*2);
});

test('multipart resume passes the previous persisted acknowledgement as a pacing deadline',async()=>{
 const delivery={channel:'private',target:{uid:'99'},status:'pending',parts:[{content:'【1/2】第一段',status:'sent',receipt:{acknowledgedAt:1700000000000}},{content:'【2/2】第二段',status:'pending'}]};
 const calls=[];
 await sendDelivery({sendMessage:async(...args)=>{calls.push(args);return{sent:true,messageKey:'2',acknowledgedAt:1700000001500};}},delivery,async()=>{});
 assert.deepEqual(calls,[['99','【2/2】第二段',{notBefore:1700000001500}]]);assert.equal(delivery.status,'sent');
});
