const accountApi=(suffix,body,signal)=>api(options.accountRoute+suffix,body,signal);
    function BilibiliAccount({autoMonitor}){
      const [status,setStatus]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[qr,setQr]=React.useState(null),[session,setSession]=React.useState(''),[message,setMessage]=React.useState('');
      const generation=React.useRef(0),selection=React.useRef(session);selection.current=session;
      const refresh=React.useCallback(async signal=>{const data=await accountApi('/bilibili/status',undefined,signal);setStatus(data);setSession(previous=>previous||data.monitors[0]?.sessionId||'');return data;},[]);
      React.useEffect(()=>{const abort=new AbortController();refresh(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[refresh]);
      async function action(path,body={}){setBusy(true);setError('');setMessage('');try{await accountApi(path,body);await refresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
      async function startLogin(){generation.current++;setBusy(true);setError('');setMessage('');setQr(null);try{setQr(await accountApi('/bilibili/login/start',{}));}catch(e){setError(e.message);}finally{setBusy(false);}}
      React.useEffect(()=>{
        if(!qr?.token)return;const abort=new AbortController(),stamp=generation.current;let timer;
        const poll=async()=>{try{
          const result=await accountApi('/bilibili/login/poll',{token:qr.token},abort.signal);if(abort.signal.aborted||stamp!==generation.current)return;
          if(result.status==='success'){
            setQr(null);setMessage(`已登录：${result.name||result.uid}`);await refresh(abort.signal);
            if(autoMonitor&&selection.current){await accountApi('/bilibili/monitor/start',{sessionId:selection.current},abort.signal);await refresh(abort.signal);setMessage('已登录，并已开启 @视频定时阅读。');}
            else if(autoMonitor)setMessage('已登录。请选择通知会话，然后点击“开启监测”。');
            return;
          }
          if(['expired','failed'].includes(result.status)){setQr(null);setMessage('二维码已失效，请重新生成。');return;}
          setMessage(result.status==='scanned'?'已扫码，请在 B站手机端确认登录。':'等待扫码…');timer=setTimeout(poll,3000);
        }catch(e){if(!abort.signal.aborted){setError(e.message);setQr(null);}}};
        timer=setTimeout(poll,2500);return()=>{abort.abort();clearTimeout(timer);};
      },[qr?.token,refresh,autoMonitor]);
      return h('section',{className:'dpp-card','data-bilibili-login':true},
        h('h3',null,'B站账号'),h('p',null,status?.loggedIn?`已登录：${status.name} · UID ${status.uid}`:status?'尚未登录':'正在读取账号状态…'),
        h('p',{className:'dpp-muted'},'使用专门给 DSH 准备的 B站账号扫码。登录信息单独保存在本机，页面不会显示 Cookie。'),
        h('div',{className:'dpp-actions'},h('button',{className:'dpp-button dpp-primary',disabled:busy,onClick:startLogin},busy?'处理中…':status?.loggedIn?'更换账号':'扫码登录'),h('button',{className:'dpp-button',disabled:busy,onClick:()=>refresh().catch(e=>setError(e.message))},'刷新状态'),status?.loggedIn?h('button',{className:'dpp-button',disabled:busy,onClick:()=>{generation.current++;setQr(null);action('/bilibili/logout');}},'退出账号'):null),
        qr?h('div',null,h('img',{className:'dpp-qr',src:qr.image,alt:'B站登录二维码'}),h('p',{className:'dpp-muted'},'用 B站 App 扫码并确认，页面将自动完成登录。')):null,
        h('div',{className:'dpp-hint'},
          h('label',{htmlFor:'dpp-notification-session'},'视频阅读结果通知到'),
          h('select',{id:'dpp-notification-session',className:'dpp-input',value:session,onChange:e=>setSession(e.target.value),disabled:busy,style:{marginTop:8}},h('option',{value:''},'请选择一个 DSH 会话'),(status?.sessions||[]).map(s=>h('option',{key:s.id,value:s.id},s.title))),
          h('p',{className:'dpp-muted'},status?.monitors?.length?`监测已开启，共 ${status.monitors.length} 个任务；当前间隔 ${Math.round(status.monitors[0].everySeconds/60)} 分钟。`:'监测尚未开启；没有新消息时保持安静，读完只在 DSH 通知。'),
          status&&!status.scheduleAvailable?h('p',{className:'dpp-error'},'请先在插件页启用官方“自动化任务”。'):null,
          h('div',{className:'dpp-actions'},h('button',{className:'dpp-button',disabled:busy||!status?.loggedIn||!session||!status?.scheduleAvailable,onClick:()=>action('/bilibili/monitor/start',{sessionId:session})},status?.monitors?.length?'应用监测间隔':'开启监测'),h('button',{className:'dpp-button',disabled:busy||!status?.monitors?.length,onClick:()=>action('/bilibili/monitor/stop')},'停止监测'))),
        message?h('p',{className:'dpp-status',role:'status'},message):null,error?h('p',{className:'dpp-error',role:'alert'},error):null);
    }
