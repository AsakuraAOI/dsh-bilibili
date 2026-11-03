import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { BilibiliClient, DEFAULT_ACCOUNT_FILE, boundedBody } from './client.js';
import { MentionMonitor, ensureMonitor, MONITOR_TITLE, DEFAULT_CHECK_INTERVAL_SECONDS } from './monitor.js';
import { configurableRows, plain } from '../plugin-settings.js';

export const name='bilibili-account-settings';
export const inject=['connection','configEditor'];
export const ROUTE='/api/plugins/dsh-bilibili/account';
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const service=(ctx,name)=>ctx.get?.(name)||ctx[name];
async function sessions(ctx,signal){
  const query=service(ctx,'sessionQuery'); if(!query)return [];
  const rows=(await query.listSessions(signal)).filter(row=>!row.header.parentId).slice(0,50);
  let titles=[];
  try{titles=await query.readTitleSnapshots(rows.slice(0,30).map(row=>row.header.id),signal);}
  catch{signal?.throwIfAborted();}
  // SessionQuery returns settled results; the title is itself a title snapshot.
  const byId=new Map(titles.flatMap(result=>{
    if(result.status!=='fulfilled')return [];
    const snapshot=result.value,id=snapshot?.session?.id,title=snapshot?.title?.title;
    return typeof id==='string'&&typeof title==='string'&&title.trim()?[[id,title]]:[];
  }));
  return rows.map(row=>({id:row.header.id,title:byId.get(row.header.id)||row.header.id}));
}
function accountConfig(ctx){
  const row=configurableRows(ctx.configEditor).find(row=>row.entry.options.id==='bilibili-account');
  if(!row?.active)throw Object.assign(new Error('B站插件当前未运行，请先在插件页启用。'),{status:409});
  return plain(row.entry.fiber.config);
}
export function createHandler(ctx,{Client=BilibiliClient,qr=QRCode}={}){
  const pending=new Map();
  const account=signal=>new Client({accountFile:accountConfig(ctx).accountFile||DEFAULT_ACCOUNT_FILE,signal});
  async function catalog(){return await service(ctx,'schedule')?.catalog?.()||[];}
  return async request=>{
    const url=new URL(request.url),path=url.pathname.slice(ROUTE.length);
    try{
      if(request.method==='POST'){
        const origin=request.headers.get('origin');
        if(origin&&origin!==url.origin)return json({error:'拒绝跨站设置请求。'},403);
        if(!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'需要 JSON 请求。'},415);
      }
      const body=request.method==='POST'?JSON.parse((await boundedBody(request,128*1024)).toString('utf8')):{};
      if(request.method==='GET'&&path==='/bilibili/status'){
        const api=account(request.signal);
        const [status,chats,tasks]=await Promise.all([api.status(),sessions(ctx,request.signal),catalog()]);
        return json({...status,sessions:chats,monitors:tasks.filter(task=>task.title===MONITOR_TITLE&&task.status==='active').map(task=>({id:task.id,sessionId:task.sessionId,everySeconds:task.everySeconds})),scheduleAvailable:Boolean(service(ctx,'schedule'))});
      }
      if(request.method==='POST'&&path==='/bilibili/login/start'){
        const api=account(request.signal),data=await api.startLogin();
        for(const [id,item]of pending)if(Date.now()-item.at>180000)pending.delete(id);
        if(pending.size>=5)pending.delete(pending.keys().next().value);
        const token=randomUUID();pending.set(token,{key:data.key,at:Date.now(),file:api.accountFile});
        return json({status:'waiting',token,image:await qr.toDataURL(data.url,{width:300,margin:2})});
      }
      if(request.method==='POST'&&path==='/bilibili/login/poll'){
        const item=pending.get(body.token),api=account(request.signal);
        if(!item||Date.now()-item.at>180000||item.file!==api.accountFile)return json({status:'expired'});
        const result=await api.pollLogin(item.key);
        if(result.status==='success'){
          pending.delete(body.token);
          await new MentionMonitor(`${api.accountFile}.mentions.json`).initialize(api);
        }
        return json(result);
      }
      if(request.method==='POST'&&path==='/bilibili/logout'){
        const schedule=service(ctx,'schedule');
        for(const task of await catalog())if(task.title===MONITOR_TITLE&&task.status==='active')await schedule.delete({sessionId:task.sessionId,id:task.id},request.signal);
        pending.clear();return json(await account(request.signal).logout());
      }
      if(request.method==='POST'&&path==='/bilibili/monitor/start'){
        const chats=await sessions(ctx,request.signal);
        if(!chats.some(chat=>chat.id===body.sessionId))return json({error:'请选择一个现有 DSH 会话接收通知。'},400);
        const api=account(request.signal);await api.account(true);
        await new MentionMonitor(`${api.accountFile}.mentions.json`).initialize(api);
        return json(await ensureMonitor(service(ctx,'schedule'),body.sessionId,accountConfig(ctx).checkIntervalSeconds??DEFAULT_CHECK_INTERVAL_SECONDS,request.signal));
      }
      if(request.method==='POST'&&path==='/bilibili/monitor/stop'){
        const schedule=service(ctx,'schedule');
        for(const task of await catalog())if(task.title===MONITOR_TITLE&&task.status==='active')await schedule.delete({sessionId:task.sessionId,id:task.id},request.signal);
        return json({active:false});
      }
      return json({error:'没有此设置操作。'},404);
    }catch(error){return json({error:error.message||'操作失败',code:error.code},error.status||400);}
  };
}
export function apply(ctx){
  const handle=createHandler(ctx);
  for(const [path,methods]of [['/bilibili/status',['GET']],['/bilibili/login/start',['POST']],['/bilibili/login/poll',['POST']],['/bilibili/logout',['POST']],['/bilibili/monitor/start',['POST']],['/bilibili/monitor/stop',['POST']]]){
    ctx.effect(()=>ctx.connection.fetch.register({path:ROUTE+path,methods,requestBody:'buffered',fetch:handle}));
  }
}
