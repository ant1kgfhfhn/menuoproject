/* MENUO visitor runtime: reliable iOS/Android QR scanner + public menu. */
(function(){
  'use strict';

  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
  function stop(){
    try{window.__MENUO_SCAN_CONTROLS?.stop()}catch(_){}
    window.__MENUO_SCAN_CONTROLS=null;
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
      script.src='https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/umd/index.min.js';
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

    try{
      if(!window.isSecureContext)throw new Error('secure-context');
      const ZX=await loadZXing();
      const reader=new ZX.BrowserQRCodeReader();
      window.__MENUO_SCAN_READER=reader;

      let controls;
      try{
        controls=await reader.decodeFromConstraints(
          {video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false},
          video,
          (result)=>{
            if(!result)return;
            const raw=result.getText();
            stop();
            openScanResult(raw);
          }
        );
      }catch(firstError){
        const devices=await ZX.BrowserCodeReader.listVideoInputDevices();
        const device=(devices||[]).find(d=>/back|rear|environment/i.test(d.label))||(devices||[])[0];
        if(!device)throw firstError;
        controls=await reader.decodeFromVideoDevice(device.deviceId,video,(result)=>{
          if(!result)return;
          const raw=result.getText();
          stop();
          openScanResult(raw);
        });
      }
      window.__MENUO_SCAN_CONTROLS=controls;
      status.textContent='Наведите заднюю камеру на QR-код MENUO';
    }catch(e){
      console.error('MENUO scanner error',e);
      status.textContent=e.message==='secure-context'
        ?'Сканер работает только по HTTPS. Откройте MENUO через защищённый адрес.'
        :'Не удалось открыть камеру. Разрешите доступ к камере и нажмите «Запустить камеру» ещё раз.';
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
    const token=new URLSearchParams(location.search).get('menu');
    if(!token)return;
    const started=Date.now();
    while(!window.MENUO_SUPABASE&&Date.now()-started<15000)await new Promise(r=>setTimeout(r,100));
    const sb=window.MENUO_SUPABASE;
    if(!sb)return showPublicError('Не удалось подключиться к MENUO.');
    const {data,error}=await sb.rpc('get_public_menu',{p_token:token});
    if(error||!data){
      console.error('MENUO public menu error',error);
      return showPublicError('Меню по этой QR-ссылке не найдено или оно отключено.');
    }

    const host=document.getElementById('public');
    if(!host)return;
    document.querySelectorAll('.screen').forEach(el=>el.classList.add('hidden'));
    host.classList.remove('hidden');
    window.scrollTo({top:0,behavior:'instant'});

    const r=data.restaurant||{},cats=data.categories||[],dishes=data.dishes||[];
    const byCat=new Map(cats.map(c=>[String(c.id),c.name]));
    host.innerHTML='<div class="public-hero"><div class="top" style="margin-bottom:0"><div class="rest-logo">'+esc((r.name||'M').slice(0,1).toUpperCase())+'</div><button class="lang" onclick="toggleLanguages()">RU ▾</button></div><h1>'+esc(r.name||'MENUO')+'</h1><p>'+esc(r.description||'Цифровое меню MENUO')+'</p></div><div class="category-row" id="menuoPublicCategories"></div><div id="menuoPublicItems"></div>';

    const catHost=host.querySelector('#menuoPublicCategories');
    const items=host.querySelector('#menuoPublicItems');
    const all=document.createElement('button');
    all.className='chip active';all.textContent='Все';catHost.appendChild(all);

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