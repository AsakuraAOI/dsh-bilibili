import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config } from '../src/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from '../src/client.js';
function setup(execute, config = Config({})) {
  const tools=new Map(),sections=[];
  const ctx={effect:fn=>fn(),get:()=>undefined,tools:{register:d=>{tools.set(d.name,d);return()=>tools.delete(d.name);},get:name=>tools.get(name),execute},systemPrompt:{section:s=>{sections.push(s);return()=>{};}}};
  apply(ctx,config);return{tools,sections};
}
test('plugin prepares media through guarded DSH execution without hidden ASR or vision',async t=>{
  let execution;
  const f=await mentionFixture(t,[],async exec=>{execution=exec;return{isError:false,value:'videoContentRead: true\nvideoId: demo\nrepresentation: evidence_text\nmaterials:\n原话'};});
  const result=await f.tools.get('bilibili_read').execute({input:'BV1xx411c7mD'},f.exec);
  assert.equal(execution.name,'media_open');assert.equal(execution.agent,f.exec.agent);assert.equal(execution.parent,'parent');assert.match(result.reading,/videoId/);
  assert.match(execution.arguments.path,/media\.mp4$/);assert.equal(execution.arguments.instruction,undefined);
  assert.equal(Config({}).notifySession,false);assert.equal(Config({}).checkIntervalSeconds,60);
  assert.throws(()=>Config({checkIntervalSeconds:59}));
});

test('guard refusal and invalid material states cannot be marked as read',async t=>{
  for(const outcome of [{isError:true,error:{message:'refused'}},{isError:false,value:'videoContentRead: false'}]){
    const f=await mentionFixture(t,[],async()=>outcome);
    await assert.rejects(()=>f.tools.get('bilibili_read').execute({input:'BV1xx411c7mD'},f.exec));
  }
});

test('silent empty monitor renders no content while manual checks retain their result',()=>{
 const{tools}=setup();const output=tools.get('bilibili_mentions_check').output;
 assert.deepEqual(output.render({silentIfEmpty:true},{quiet:true}),[]);
 assert.equal(output.render({}, {quiet:true})[0].type,'text');
 assert.equal(output.render({silentIfEmpty:true},{quiet:false,privateMessages:[{content:'新消息'}]})[0].type,'text');
});

const material = (text, id='demo') => `videoId: ${id}\nvideoContentRead: true\nrepresentation: evidence_text\n\nmaterials:\n${text}`;

test('disabled notifications still allow the main Agent to process materials before finishing quietly',async t=>{
 let closed=0;
 const f=await mentionFixture(t,['@账号 看看这个视频'],async()=>({value:material('[00:01] [视频字幕原文] 第一条原句。')}),false,()=>closed++);
 const check=await f.check();assert.equal(check.requiresAgent,true);assert.equal(check.quiet,false);assert.equal(f.posts.length,0);assert.equal(closed,0);
 await assert.rejects(()=>f.finish(check.requestIds),/还有请求未/);assert.equal(closed,0);
 await f.reply(check.requestIds[0],{content:'主 Agent 根据原句处理后的回复。'});assert.equal(f.posts.length,1);assert.equal(closed,0);
 const done=await f.finish(check.requestIds);assert.equal(done.quiet,true);assert.equal(closed,1);
 assert.deepEqual(f.tools.get('bilibili_mentions_finish').output.render({},done),[]);
});

async function mentionFixture(t, comments, invoke, notifySession=true, concludeTurn=()=>{}) {
 const directory=await mkdtemp(join(tmpdir(),'bili-focus-')),accountFile=join(directory,'account.json');
 t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:3}));
 await writeJson(accountFile,{cookies:{SESSDATA:'fake',bili_jct:'fake',DedeUserID:'42'},deviceId:'fake'});
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 const posts=[];
 globalThis.fetch=async(url,init)=>{
  let data;
  if(url.includes('/x/msgfeed/at')) data={items:comments.map((text,index)=>({id:String(index+1),at_time:Math.floor(Date.now()/1000),user:{mid:99},item:{business_id:1,subject_id:1,root_id:77,source_id:88+index,source_content:text}})),cursor:{is_end:true}};
  else if(url.includes('/get_sessions')) data={session_list:[],has_more:false};
  else if(url.includes('/x/web-interface/view')) data={bvid:'BV1xx411c7mD',aid:1,title:'演示',owner:{},pages:[{page:1,cid:1}]};
  else if(url.includes('/x/player/playurl')) data={durl:[{url:'https://cdn.bilivideo.com/test.mp4'}]};
  else if(url.includes('/x/player/')) data={subtitle:{subtitles:[]}};
  else if(url.includes('cdn.bilivideo.com/')) return new Response('fake-mp4');
  else if(init.method==='POST') {posts.push({url,body:init.body});data={rpid_str:String(posts.length),msg_key:String(posts.length)};}
  else if(url.includes('/nav')) data={wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png'}};
  else assert.fail('Unexpected URL '+url);
  return Response.json({code:0,data});
 };
 const {tools}=setup(invoke,Config({accountFile}));tools.set('media_open',{});tools.set('media_materials',{});
 const exec={agent:{session:{id:'chat'}},token:'parent',rootCallId:'root',concludeTurn};
 return {tools,posts,exec,check:()=>tools.get('bilibili_mentions_check').execute({notifySession,silentIfEmpty:true},exec),reply:(requestId,args)=>tools.get('bilibili_mention_reply').execute({requestId,...args},exec),finish:requestIds=>tools.get('bilibili_mentions_finish').execute({requestIds},exec)};
}

test('each comment returns materials for the main Agent without hidden QA or automatic sending',async t=>{
 const calls=[];
 const f=await mentionFixture(t,['@账号 看 3:20 图表数字，私信发我','@账号 找一下安装步骤在哪'],async call=>{
  calls.push(call);assert.equal(call.parent,'parent');assert.equal(call.rootCallId,'root');assert.equal(call.name,'media_open');
  return{value:material('[03:20] [VLM 画面观察，可能有误] 图表数字模糊。\n[02:00] [视频字幕原文] 先下载，再打开安装器。','shared-video')};
 });
 const check=await f.check();assert.equal(f.posts.length,0);assert.equal(check.requestIds.length,2);assert.equal(check.requiresAgent,true);
 assert.deepEqual(calls.map(c=>c.name),['media_open','media_open']);assert.equal(calls[0].arguments.instruction,undefined);assert.equal(calls[1].arguments.instruction,undefined);
 assert.match(check.results[0].materials,/图表数字模糊/);
 // This content is authored by the main Agent after evaluating the materials.
 await f.reply(check.requestIds[0],{content:'图表数字暂时无法确认，需要更清晰证据。'});
 await f.reply(check.requestIds[1],{content:'安装步骤在 2:00：先下载，再打开安装器。'});
 assert.equal(f.posts.length,2);assert.ok(f.posts[0].url.includes('/send_msg'));assert.equal(f.posts[0].body.get('msg[receiver_id]'),'99');
 assert.equal(f.posts[1].body.get('parent'),'89');assert.match(f.posts[1].body.get('message'),/安装步骤在 2:00/);
 assert.equal((await f.finish(check.requestIds)).quiet,false);await f.check();assert.equal(calls.length,2);assert.equal(f.posts.length,2);
});

test('original-material requests are also reviewed by the main Agent before verbatim sending',async t=>{
 const calls=[];
 const f=await mentionFixture(t,['@4rct1c 把原文私信我'],async call=>{calls.push(call.name);return{value:material('[00:00.300-00:03.200] [视频字幕原文] 第一句实际字幕。\n[41:25.900-41:29.000] [视频字幕原文] 末段实际字幕。'+(call.name==='media_materials'?'\n[02:00] [VLM 观察] 主 Agent 后续补看的新证据。':''))};});
 const check=await f.check();assert.equal(f.posts.length,0);assert.deepEqual(calls,['media_open']);
 await f.reply(check.requestIds[0],{useMaterials:true});assert.equal(f.posts.length,1);
 const content=JSON.parse(f.posts[0].body.get('msg[content]')).content;
 assert.match(content,/第一句实际字幕/);assert.match(content,/末段实际字幕/);assert.match(content,/主 Agent 后续补看的新证据/);assert.doesNotMatch(content,/主要内容是|representation:|videoId:/);
 // Retrying an already-acknowledged reply never sends twice.
 await f.reply(check.requestIds[0],{useMaterials:true});assert.equal(f.posts.length,1);
});

test('old summary output and failed material acquisition stay pending instead of being sent',async t=>{
 let mode='summary';
 const f=await mentionFixture(t,['@账号 看看视频'],async()=>mode==='summary'?{value:'videoId: demo\nvideoContentRead: true\n\noverview:\n只有摘要'}:{isError:true,error:{message:'material unavailable'}});
 let result=await f.check();assert.equal(result.pending,1);assert.equal(result.results[0].status,'failed');assert.equal(f.posts.length,0);
 mode='error';result=await f.check();assert.equal(result.pending,1);assert.equal(f.posts.length,0);
});

test('missing content evidence is handed to the main Agent for look-back rather than hidden by an error',async t=>{
 let supplemented=false;
 const f=await mentionFixture(t,['@账号 视频内容私信我'],async()=>({value:supplemented?material('[00:05] [VLM 观察] 新增可见证据'): 'videoId: demo\nvideoContentRead: false\nrepresentation: evidence_text\nmaterials:\n没有语音或画面证据，请回看补材料。'}));
 const check=await f.check();assert.equal(check.requiresAgent,true);assert.equal(check.results[0].status,'awaiting_agent');assert.match(check.results[0].materials,/videoContentRead: false/);assert.match(check.results[0].materials,/videoId: demo/);assert.equal(f.posts.length,0);
 await assert.rejects(()=>f.reply(check.requestIds[0],{useMaterials:true}),/尚未取得内容证据/);assert.equal(f.posts.length,0);
 // Main Agent has performed look-back; only then can refreshed evidence be sent.
 supplemented=true;await f.reply(check.requestIds[0],{useMaterials:true});assert.equal(f.posts.length,1);assert.match(JSON.parse(f.posts[0].body.get('msg[content]')).content,/新增可见证据/);
});

test('only the owning main Agent session may submit a prepared reply',async t=>{
 const f=await mentionFixture(t,['@账号 看看视频'],async()=>({value:material('[00:00] [视频字幕原文] 原句')}));const check=await f.check();
 await assert.rejects(()=>f.tools.get('bilibili_mention_reply').execute({requestId:check.requestIds[0],content:'不要发送'},{agent:{session:{id:'other'}}}),/另一个 DSH 会话/);
 assert.equal(f.posts.length,0);await f.reply(check.requestIds[0],{content:'当前主 Agent 的回复'});assert.equal(f.posts.length,1);
});
