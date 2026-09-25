/* MENUO visitor runtime: reliable iOS/Android QR scanner + public menu. */
(function(){
  'use strict';

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function stop(){
    try{window.__MENUO_SCAN_CONTROLS?.stop()}catch(_){}
    window.__MENUO_SCAN_CONTROLS=null;
    try{window.__MENUO_SCAN_STREAM?.getTracks().forEach(t=>t.stop())}catch(_){}
    window.__MENUO_SCAN_STREAM=null;
    try{window.__MENUO_SCAN_READER?.reset()}catch(_){}
    window.__MENUO_SCAN_READER=null;
    const v=document.getElementById('scannerVideo');
    if(v?.srcObject){
      try{v.srcObject.getTracks().forEach(t=>t.stop())}catch(_){}
      v.srcObject=null;
    }
  }

  function ensureScanner(){
    let s=document.getElementById('scanner');
    if(s)return s;
    s=document.createElement('section');
    s.id='scanner';
    s.className='screen hidden';
    s.innerHTML='<div class="top"><button class="back" id="menuoScannerBack">‹</button><div class="brand">Сканировать QR</div><span style="width:40px"></span></div><div class="scan"><div class="camera"><video id="scannerVideo" playsinline muted autoplay></video><div class="frame"></div></div><div class="scan-status" id="scanStatus">Нажмите «Запустить камеру»</div><button class="secondary" id="menuoScannerRetry">Запустить камеру</button></div><div class="notice" id="scannerHelp">Разрешите доступ к камере. Для MENUO можно сканировать QR прямо камерой телефона.</div>';
    document.getElementById('app')?.appendChild(s);
    s.querySelector('#menuoScannerBack').onclick=()=>{stop();show('home')};
    s.querySelector('#menuoScannerRetry').onclick=start;
    return s;
  }

  function loadZXing(){
    if(window.ZXingBrowser?.BrowserQRCodeReader)return Promise.resolve(window.ZXingBrowser);
    return new Promise((resolve,reject)=>{
      const script=document.createElement('script');
      script.src='https://unpkg.com/@zxing/browser@0.2.1';
      script.async=true;script.dataset.menuoZxing='1';
      script.onload=()=>window.ZXingBrowser?.BrowserQRCodeReader?resolve(window.ZXingBrowser):reject(new Error('zxing-global-missing'));
      script.onerror=()=>reject(new Error('zxing-load-failed'));
      document.head.appendChild(script);
    });
  }

  async function start(){
    const s=ensureScanner();
    document.querySelectorAll('.screen').forEach(el=>el.classList.add('hidden'));
    s.classList.remove('hidden');
    window.scrollTo({top:0,behavior:'instant'});
    stop();

    const status=s.querySelector('#scanStatus');
    const video=s.querySelector('#scannerVideo');
    status.textContent='Запрашиваем доступ к камере…';

    let stream;
    try{
      if(!window.isSecureContext)throw new Error('secure-context');
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('camera-unsupported');
      stream=await navigator.mediaDevices.getUserMedia({
        video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},
        audio:false
      });
      video.srcObject=stream;
      await video.play();
      window.__MENUO_SCAN_STREAM=stream;
      status.textContent='Камера включена. Загружаем сканер…';
    }catch(e){
      console.error('MENUO camera error',e);
      status.textContent=e.message==='secure-context'
        ?'Сканер работает только по HTTPS. Откройте MENUO через защищённый адрес.'
        :e.message==='camera-unsupported'
          ?'Этот браузер не поддерживает доступ к камере.'
          :'Камера не доступна. Проверьте разрешение камеры для menuo-qr.com в настройках Safari.';
      return;
    }

    try{
      const ZX=await loadZXing();
      const reader=new ZX.BrowserQRCodeReader();
      window.__MENUO_SCAN_READER=reader;
      const controls=await reader.decodeFromStream(stream,video,(result)=>{
        if(!result)return;
        const raw=result.getText();
        stop();
        openScanResult(raw);
      });
      window.__MENUO_SCAN_CONTROLS=controls;
      status.textContent='Наведите заднюю камеру на QR-код MENUO';
    }catch(e){
      console.error('MENUO decoder error',e);
      status.textContent='Камера работает, но не удалось загрузить QR-сканер. Нажмите «Запустить камеру» ещё раз.';
      try{stream?.getTracks().forEach(t=>t.stop())}catch(_){}
      window.__MENUO_SCAN_STREAM=null;
      return;
    }
  }

  function openScanResult(raw){
    try{
      const u=new URL(raw,location.href);
      const token=u.searchParams.get('menu');
      if(token){
        const target=new URL(location.href);
        target.search='';target.hash='';
        target.searchParams.set('menu',token);
        location.href=target.toString();
        return;
      }
      if(/^https?:\/\//i.test(raw)){location.href=raw;return}
      alert('Это не ссылка MENUO.');
    }catch(_){alert('QR-код не распознан как ссылка.')}
  }

  async function renderPublic(){
    const token=String(new URLSearchParams(location.search).get('menu')||'').trim();
    if(!token)return;
    const started=Date.now();
    while(!window.MENUO_SUPABASE&&Date.now()-started<15000)await new Promise(r=>setTimeout(r,100));
    const sb=window.MENUO_SUPABASE;
    if(!sb)return showPublicError('Не удалось подключиться к MENUO.');
    let data=null,error=null;
    for(let attempt=0;attempt<2&&!data;attempt++){
      const q=await sb.rpc('get_public_menu',{p_token:token});
      data=q.data;error=q.error;
      if(!data&&attempt===0)await new Promise(r=>setTimeout(r,400));
    }
    // Direct REST fallback for Safari/WebKit when the client RPC layer is interrupted.
    if(!data){
      try{
        const res=await fetch('https://vizmqgmefbgcggyfzdkj.supabase.co/rest/v1/rpc/get_public_menu',{
          method:'POST',headers:{'Content-Type':'application/json','apikey':'sb_publishable_G_9VANFg4Dh7vuw8qpwwGw_Ck0h0H_3','Authorization':'Bearer sb_publishable_G_9VANFg4Dh7vuw8qpwwGw_Ck0h0H_3'},
          body:JSON.stringify({p_token:token})
        });
        if(res.ok)data=await res.json(); else error=await res.text();
      }catch(e){error=e}
    }
    if(error||!data){
      console.error('MENUO public menu error',error,token);
      return showPublicError('Меню по этой QR-ссылке не найдено или оно отключено.');
    }

    const host=document.getElementById('public');
    if(!host)return;
    document.querySelectorAll('.screen').forEach(el=>el.classList.add('hidden'));
    host.classList.remove('hidden');
    window.scrollTo({top:0,behavior:'instant'});

    const r=data.restaurant||{},cats=data.categories||[],dishes=data.dishes||[];
    const byCat=new Map(cats.map(c=>[String(c.id),c.name]));
    const lang=(typeof state!=='undefined'&&state?.language)||'ru';
    const labels={ru:['Все','Цифровое меню MENUO'],de:['Alle','Digitales MENUO-Menü'],en:['All','MENUO digital menu'],uk:['Усі','Цифрове меню MENUO'],tr:['Tümü','MENUO dijital menü'],pl:['Wszystkie','Cyfrowe menu MENUO'],es:['Todos','Menú digital de MENUO'],fr:['Tous','Menu numérique MENUO'],it:['Tutti','Menu digitale MENUO'],pt:['Todos','Menu digital MENUO'],ro:['Toate','Meniu digital MENUO'],ar:['الكل','قائمة MENUO الرقمية']}[lang]||['Все','Цифровое меню MENUO'];
    host.innerHTML='<div class="public-hero"><div class="top" style="margin-bottom:0"><div class="rest-logo">'+esc((r.name||'M').slice(0,1).toUpperCase())+'</div><button class="lang" onclick="toggleLanguages()">RU ▾</button></div><h1>'+esc(r.name||'MENUO')+'</h1><p>'+esc(r.description||'Цифровое меню MENUO')+'</p></div><div class="category-row" id="menuoPublicCategories"></div><div id="menuoPublicItems"></div>';

    const catHost=host.querySelector('#menuoPublicCategories');
    const items=host.querySelector('#menuoPublicItems');
    const all=document.createElement('button');
    all.className='chip active';all.textContent=labels[0];catHost.appendChild(all);

    function render(catId){
      const list=catId?dishes.filter(d=>String(d.category_id)===String(catId)):dishes;
      items.innerHTML=list.length?list.map(d=>'<article class="dish '+(d.is_available?'':'unavailable')+'"><div class="food">'+(d.image_url?'<img src="'+esc(d.image_url)+'" alt="">':'🍽️')+'</div><div class="dish-info"><h3>'+esc(d.name)+'</h3><p>'+esc(d.description||'')+'</p><small style="color:#69756e">'+esc(byCat.get(String(d.category_id))||'')+'</small></div><div class="price">'+(Number(d.price_cents||0)/100).toFixed(2).replace('.',',')+' '+esc(d.currency||'EUR')+'</div></article>').join(''):'<div class="empty">Меню пока пустое.</div>';
    }

    cats.forEach(c=>{
      const b=document.createElement('button');b.className='chip';b.textContent=c.name;
      b.onclick=()=>{catHost.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');render(c.id)};
      catHost.appendChild(b);
    });
    all.onclick=()=>{catHost.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));all.classList.add('active');render(null)};
    render(null);
    const langBtn=host.querySelector('.lang'); if(langBtn)langBtn.textContent=(lang||'ru').toUpperCase()+' ▾';
    try{await sb.from('analytics_events').insert({restaurant_id:r.id,event_type:'menu_view',metadata:{source:'public',token}})}catch(_){}
  }

  function showPublicError(message){
    const host=document.getElementById('public');
    if(!host)return;
    document.querySelectorAll('.screen').forEach(el=>el.classList.add('hidden'));
    host.classList.remove('hidden');
    host.innerHTML='<div class="hero"><div class="eyebrow">MENUO</div><h1 class="section-title">Не удалось открыть меню</h1><p class="lead">'+esc(message)+'</p><button class="primary" onclick="location.href=location.pathname">На главную</button></div>';
  }

  function patch(){
    window.startScanner=start;
    window.stopScanner=stop;
    window.__MENUO_RENDER_PUBLIC=renderPublic;
    renderPublic();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',patch);else patch();
})();