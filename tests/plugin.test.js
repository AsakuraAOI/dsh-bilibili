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
test('plugin registers all capabilities and routes reading through DSH guarded execution',async()=>{
  let execution;const {tools,sections}=setup(async exec=>{execution=exec;return{isError:false,value:'videoContentRead: true\nvideoId: demo'};});
  tools.set('video_process',{execute:()=>assert.fail('must not bypass DSH tool pipeline')});
  const agent={session:{id:'session'}};const result=await tools.get('bilibili_read').execute({input:'BV1xx411c7mD'},{agent,token:'parent',signal:new AbortController().signal});
  assert.equal(tools.size,11);assert.equal(execution.name,'video_process');assert.equal(execution.agent,agent);assert.equal(execution.parent,'parent');assert.match(result.reading,/videoId/);
  assert.match(sections.find(section=>section.name==='bilibili:workflow').text({}),/自动回复原 @评论/);
  assert.equal(Config({}).notifySession,false);
});
test('guard refusal and metadata-only results cannot be marked as read',async()=>{
  for(const outcome of [{isError:true,error:{message:'refused'}},{isError:false,value:'videoContentRead: false'}]){
    const {tools}=setup(async()=>outcome);tools.set('video_process',{});
    await assert.rejects(()=>tools.get('bilibili_read').execute({input:'BV1xx411c7mD'},{}));
  }
});
test('silent empty monitor renders no content while manual checks retain their result',()=>{
 const{tools}=setup();const output=tools.get('bilibili_mentions_check').output;
 assert.deepEqual(output.render({silentIfEmpty:true},{quiet:true}),[]);
 assert.equal(output.render({}, {quiet:true})[0].type,'text');
 assert.equal(output.render({silentIfEmpty:true},{quiet:false,privateMessages:[{content:'新消息'}]})[0].type,'text');
});

test('scheduled checks deliver with notifications off and honor both live config and per-call choice',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'bili-plugin-')),accountFile=join(directory,'account.json');
 t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:3}));
 await writeJson(accountFile,{cookies:{SESSDATA:'fake',bili_jct:'fake',DedeUserID:'42'}});
 let mentionId=0,posts=0,closed=0;
 const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
 globalThis.fetch=async(url,init)=>{
  let data;
  if(url.includes('/x/msgfeed/at')) data={items:[{id:String(++mentionId),at_time:Math.floor(Date.now()/1000),user:{mid:99},item:{business_id:1,subject_id:1,root_id:77,source_id:88}}],cursor:{is_end:true}};
  else if(url.includes('/get_sessions')) data={session_list:[],has_more:false};
  else if(url.includes('/x/web-interface/view')) data={bvid:'BV1xx411c7mD',aid:1,title:'演示',owner:{},pages:[{page:1,cid:1}]};
  else if(url.includes('/x/v2/reply/add')) {posts++;assert.equal(init.body.get('parent'),'88');data={rpid_str:String(posts)};}
  else assert.fail('Unexpected URL '+url);
  return Response.json({code:0,data});
 };
 const config=Config({accountFile}),{tools}=setup(async()=>({value:'videoContentRead: true\n\noverview:\n测试内容'}),{get:()=>config});tools.set('video_process',{});
 const tool=tools.get('bilibili_mentions_check'),exec={concludeTurn:()=>closed++};
 const first=await tool.execute({silentIfEmpty:true},exec);assert.equal(posts,1);assert.equal(closed,1);assert.equal(first.quiet,true);assert.deepEqual(tool.output.render({silentIfEmpty:true},first),[]);
 config.notifySession=true;
 const second=await tool.execute({silentIfEmpty:true},exec);assert.equal(posts,2);assert.equal(closed,1);assert.equal(second.quiet,false);
 const third=await tool.execute({silentIfEmpty:true,notifySession:false},exec);assert.equal(posts,3);assert.equal(closed,2);assert.equal(third.quiet,true);
 config.notifySession=false;
 const fourth=await tool.execute({silentIfEmpty:true,notifySession:true},exec);assert.equal(posts,4);assert.equal(closed,2);assert.equal(fourth.quiet,false);
});

async function mentionFixture(t, comments, invoke) {
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
  else if(init.method==='POST') {posts.push({url,body:init.body});data={rpid_str:String(posts.length),msg_key:String(posts.length)};}
  else if(url.includes('/nav')) data={wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/abcdefghijklmnopqrstuvwxyz012345.png',sub_url:'https://i0.hdslb.com/bfs/wbi/012345abcdefghijklmnopqrstuvwxyz.png'}};
  else assert.fail('Unexpected URL '+url);
  return Response.json({code:0,data});
 };
 const {tools}=setup(invoke,Config({accountFile}));tools.set('video_process',{});tools.set('video_ask',{});
 return {tools,posts,check:()=>tools.get('bilibili_mentions_check').execute({notifySession:true},{agent:{session:{id:'chat'}},token:'parent',rootCallId:'root'})};
}

test('each comment gets its own focused Seeit question and sends that answer through its chosen channel',async t=>{
 const calls=[];
 const fixture=await mentionFixture(t,['@账号 看 3:20 图表数字，私信发我','@账号 找一下安装步骤在哪'],async call=>{
  calls.push(call);assert.equal(call.parent,'parent');assert.equal(call.rootCallId,'root');
  if(call.name==='video_process') return{value:'videoId: shared-video\nvideoContentRead: true\n\noverview:\n通用概括'};
  assert.equal(call.name,'video_ask');assert.equal(call.arguments.videoId,'shared-video');
  return{value:call.arguments.question.includes('3:20')?'reliable: false\nusedPerception: true\n\n图表数字看不清。\n\n缺失信息：画面模糊\n证据 (1):\n- frame @03:20.0':'reliable: true\nusedPerception: false\n\n安装步骤在 2:00，先下载再打开安装器。\n证据 (1):\n- subtitle @02:00.0'};
 });
 const result=await fixture.check();
 assert.deepEqual(calls.map(c=>c.name),['video_process','video_ask','video_process','video_ask']);
 assert.match(calls[0].arguments.instruction,/3:20/);assert.match(calls[2].arguments.instruction,/安装步骤/);assert.equal(calls[2].arguments.force,undefined);
 assert.equal(fixture.posts.length,2);assert.ok(fixture.posts[0].url.includes('/send_msg'));
 const dm=JSON.parse(fixture.posts[0].body.get('msg[content]')).content;assert.match(dm,/尚不能可靠确认/);assert.match(dm,/03:20/);assert.match(dm,/画面模糊/);assert.doesNotMatch(dm,/通用概括/);
 assert.equal(fixture.posts[0].body.get('msg[receiver_id]'),'99');
 assert.equal(fixture.posts[1].body.get('parent'),'89');assert.match(fixture.posts[1].body.get('message'),/安装步骤在 2:00/);
 assert.equal(result.results.length,2);await fixture.check();assert.equal(calls.length,4);assert.equal(fixture.posts.length,2);
});

test('failed focused QA stays retryable and does not send a generic summary',async t=>{
 let asking=0;
 const fixture=await mentionFixture(t,['@账号 3:20 写了什么'],async call=>{
  if(call.name==='video_process') return{value:'videoId: demo\nvideoContentRead: true\n\noverview:\n不能代替答案的概括'};
  asking++;return asking===1?{isError:true,error:{message:'QA unavailable'}}:{value:'reliable: true\nusedPerception: true\n\n3:20 写着开始安装。'};
 });
 const first=await fixture.check();assert.equal(first.results[0].status,'failed');assert.equal(first.pending,1);assert.equal(fixture.posts.length,0);
 const next=await fixture.check();assert.equal(next.pending,0);assert.equal(fixture.posts.length,1);assert.match(fixture.posts[0].body.get('message'),/开始安装/);
});

test('missing QA capability, videoId or answer metadata prevents automatic sending',async t=>{
 let mode='missing-id';
 const fixture=await mentionFixture(t,['@账号 找出图表结论'],async call=>{
  if(call.name==='video_process') return{value:`${mode==='missing-id'?'':'videoId: demo\n'}videoContentRead: true\n\noverview:\n通用概括`};
  return{value:'没有可靠性标记的文本'};
 });
 assert.equal((await fixture.check()).results[0].status,'failed');assert.equal(fixture.posts.length,0);
 mode='missing-tool';fixture.tools.delete('video_ask');assert.equal((await fixture.check()).results[0].status,'failed');assert.equal(fixture.posts.length,0);
 mode='missing-answer';fixture.tools.set('video_ask',{});assert.equal((await fixture.check()).results[0].status,'failed');assert.equal(fixture.posts.length,0);
});
