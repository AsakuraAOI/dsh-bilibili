import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config } from '../src/index.js';
function setup(execute) {
  const tools=new Map(),sections=[];
  const ctx={effect:fn=>fn(),get:()=>undefined,tools:{register:d=>{tools.set(d.name,d);return()=>tools.delete(d.name);},get:name=>tools.get(name),execute},systemPrompt:{section:s=>{sections.push(s);return()=>{};}}};
  apply(ctx,Config({}));return{tools,sections};
}
test('plugin registers all capabilities and routes reading through DSH guarded execution',async()=>{
  let execution;const {tools,sections}=setup(async exec=>{execution=exec;return{isError:false,value:'videoContentRead: true\nvideoId: demo'};});
  tools.set('video_process',{execute:()=>assert.fail('must not bypass DSH tool pipeline')});
  const agent={session:{id:'session'}};const result=await tools.get('bilibili_read').execute({input:'BV1xx411c7mD'},{agent,token:'parent',signal:new AbortController().signal});
  assert.equal(tools.size,11);assert.equal(execution.name,'video_process');assert.equal(execution.agent,agent);assert.equal(execution.parent,'parent');assert.match(result.reading,/videoId/);
  assert.match(sections.find(section=>section.name==='bilibili:workflow').text({}),/不自动评论或私信/);
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
