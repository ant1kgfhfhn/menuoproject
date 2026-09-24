/* MENUO production QA bridge: visitor scanner, public QR routing, profile persistence. */
(function(){
  'use strict';

  function localState(){try{return typeof state!=='undefined'?state:null}catch(_){return null}}
  function saveLocal(){try{if(typeof save==='function')save()}catch(_){}}
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

  function appUrl(token){
    const u=new URL(location.href);
    u.search='';
    u.hash='';
    u.searchParams.set('menu',token);
    return u.toString();
  }

  function stop(){
    try{if(window.__MENUO_SCAN_CONTROLS?.stop)window.__MENUO_SCAN_CONTROLS.stop()}catch(_){}
    window.__MENUO_SCAN_CONTROLS=null;
    try{if(window.__MENUO_SCAN_READER?.reset)window.__MENUO_SCAN_READER.reset()}catch(_){}
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
    s.innerHTML='<div class="top"><button class="back" id="menuoScannerBack">‹</button><div class="brand">Сканировать QR</div><span style="width:40px"></span></div>'+
      '<div class="scan"><div class="camera"><video id="scannerVideo" playsinline muted></video><div class="frame"></div></div>'+
      '<div class="scan-status" id="scanStatus">Нажмите «Запустить камеру»</div>'+
      '<button class="secondary" id="menuoScannerRetry">Запустить камеру</button></div>'+
      '<div class="notice" id="scannerHelp">Наведите заднюю камеру на QR-код MENUO.</div>';
    const app=document.getElementById('app');
    if(app)app.appendChild(s);else document.body.appendChild(s);
    s.querySelector('#menuoScannerBack').onclick=()=>{stop();if(typeof show==='function')show('home')};
    s.querySelector('#menuoScannerRetry').onclick=start;
    return s;
  }

  function loadZXing(){
    if(window.ZXingBrowser?.BrowserQRCodeReader)return Promise.resolve(window.ZXingBrowser);
    return new Promise((resolve,reject)=>{
      const old=document.querySelector('script[data-menuo-zxing]');
      if(old){
        const started=Date.now();
        const timer=setInterval(()=>{
          if(window.ZXingBrowser?.BrowserQRCodeReader){clearInterval(timer);resolve(window.ZXingBrowser)}
          else if(Date.now()-started>10000){clearInterval(timer);reject(new Error('zxing-timeout'))}
        },100);
        return;
      }
      const script=document.createElement('script');
      script.src='https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js';
      script.async=true;
      script.dataset.menuoZxing='1';
      script.onload=()=>window.ZXingBrowser?.BrowserQRCodeReader?resolve(window.ZXingBrowser):reject(new Error('zxing-global-missing'));
      script.onerror=()=>reject(new Error('zxing-load-failed'));
      document.head.appendChild(script);
    });
  }

  async function start(){
    const s=ensureScanner();
    document.querySelectorAll('.screen').forEach(el=>el.classList.add('hidden'));
    s.classList.remove('hidden');
    const status=s.querySelector('#scanStatus');
    const video=s.querySelector('#scannerVideo');
    stop();
    status.textContent='Запрашиваем доступ к камере…';
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('camera-api-unavailable');
      const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      video.srcObject=stream;
      await video.play();
      stream.getTracks().forEach(t=>t.stop());
      video.srcObject=null;
      status.textContent='Загружаем сканер QR…';
      const ZX=await loadZXing();
      const reader=new ZX.BrowserQRCodeReader();
      window.__MENUO_SCAN_READER=reader;
      const devices=await ZX.BrowserCodeReader.listVideoInputDevices();
      const device=(devices||[]).find(d=>/back|rear|environment/i.test(d.label))||(devices||[])[0];
      if(!device)throw new Error('camera-not-found');
      window.__MENUO_SCAN_CONTROLS=await reader.decodeFromVideoDevice(device.deviceId,video,(result)=>{
        if(!result)return;
        const raw=result.getText();
        stop();
        try{
          const u=new URL(raw,location.href);
          const token=u.searchParams.get('menu');
          if(token){location.href=u.origin+u.pathname+'?menu='+encodeURIComponent(token);return}
          if(/^https?:\\/\\//i.test(raw)){location.href=raw;return}
        }catch(_){}
        status.textContent='Этот QR не является ссылкой MENUO.';
      });
      status.textContent='Наведите камеру на QR-код MENUO';
    }catch(e){
      console.error('MENUO scanner error',e);
      status.textContent='Не удалось открыть камеру. Разрешите доступ к камере и нажмите кнопку ещё раз.';
    }
  }

  async function renderPublicFromToken(){
    const token=new URLSearchParams(location.search).get('menu');
    if(!token)return;
    const started=Date.now();
    while(!window.MENUO_SUPABASE && Date.now()-started<15000)await new Promise(r=>setTimeout(r,100));
    const sb=window.MENUO_SUPABASE;
    if(!sb)return;
    const {data,error}=await sb.rpc('get_public_menu',{p_token:token});
    if(error||!data){
      console.error('MENUO public menu error',error);
      return;
    }
    const host=document.getElementById('public');
    if(!host)return;
    document.querySelectorAll('.screen').forEach(el=>el.classList.add('hidden'));
    host.classList.remove('hidden');
    window.scrollTo({top:0,behavior:'instant'});
    const r=data.restaurant||{},cats=data.categories||[],dishes=data.dishes||[];
    const byCat=new Map(cats.map(c=>[c.id,c.name]));
    host.innerHTML='<div class="public-hero"><div class="top" style="margin-bottom:0"><div class="rest-logo">'+
      esc((r.name||'R').slice(0,1).toUpperCase())+
      '</div><button class="lang" onclick="toggleLanguages()">RU ▾</button></div><h1>'+
      esc(r.name||'MENUO')+'</h1><p>'+esc(r.description||'Цифровое меню MENUO')+
      '</p></div><div class="category-row" id="menuoPublicCategories"></div><div id="menuoPublicItems"></div>';
    const catHost=host.querySelector('#menuoPublicCategories');
    catHost.innerHTML=cats.map(c=>'<button class="chip" data-cat="'+esc(c.id)+'">'+esc(c.name)+'</button>').join('');
    const items=host.querySelector('#menuoPublicItems');
    const render=(catId)=>{
      const filtered=catId?dishes.filter(d=>String(d.category_id)===String(catId)):dishes;
      items.innerHTML=filtered.length?filtered.map(d=>'<article class="dish '+(d.is_available?'':'unavailable')+'"><div class="food">'+
        (d.image_url?'<img src="'+esc(d.image_url)+'" alt="">':'🍽️')+
        '</div><div class="dish-info"><h3>'+esc(d.name)+'</h3><p>'+esc(d.description||'')+
        '</p><small style="color:#69756e">'+esc(byCat.get(d.category_id)||'')+
        '</small></div><div class="price">'+(Number(d.price_cents||0)/100).toFixed(2).replace('.',',')+
        ' '+esc(d.currency||'EUR')+'</div></article>').join(''):'<div class="empty">Меню пока пустое.</div>';
    };
    const all=document.createElement('button');
    all.className='chip active';
    all.textContent='Все';
    all.onclick=()=>{catHost.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));all.classList.add('active');render(null)};
    catHost.prepend(all);
    catHost.querySelectorAll('.chip[data-cat]').forEach(b=>b.onclick=()=>{catHost.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');render(b.dataset.cat)});
    render(null);
    try{await sb.from('analytics_events').insert({restaurant_id:r.id,event_type:'menu_view',metadata:{source:'public',token}})}catch(_){}
  }

  function patchPublicUrl(){
    const original=window.publicUrl;
    window.publicUrl=function(r){
      if(r?.qrToken)return appUrl(r.qrToken);
      return typeof original==='function'?original(r):appUrl(r?.slug||'');
    };
    const originalOpen=window.openPublic;
    window.openPublic=function(){
      const r=(typeof currentRestaurant==='function')?currentRestaurant():null;
      if(r?.qrToken){location.href=appUrl(r.qrToken);return}
      if(typeof originalOpen==='function')return originalOpen();
    };
  }

  function patchProfile(){
    const old=window.saveProfile;
    if(typeof old!=='function')return;
    window.saveProfile=async function(){
      const sb=window.MENUO_SUPABASE;
      const s=localState();
      const u=typeof user==='function'?user():null;
      if(!sb||!u){return old()};
      const first=document.getElementById('pfFirst')?.value.trim()||u.firstName||'Пользователь';
      const last=document.getElementById('pfLast')?.value.trim()||u.lastName||'';
      const {error}=await sb.from('profiles').update({first_name:first,last_name:last}).eq('id',u.id);
      if(error){alert('Не удалось сохранить профиль.');console.error(error);return}
      u.firstName=first;u.lastName=last;saveLocal();
      if(typeof updateNav==='function')updateNav();
      if(typeof show==='function')show('userProfile');
    };
  }

  function patch(){
    window.startScanner=start;
    window.stopScanner=stop;
    patchPublicUrl();
    patchProfile();
    document.addEventListener('click',e=>{
      const b=e.target?.closest?.('button.role');
      if(b && /Я посетитель ресторана/.test(b.textContent||'')){
        e.preventDefault();e.stopImmediatePropagation();start();
      }
    },true);
    window.addEventListener('beforeunload',stop);
    renderPublicFromToken();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',patch);else patch();
})();
