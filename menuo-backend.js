/* MENUO production runtime: Supabase persistence + immutable QR. */
(function(){
  'use strict';

  const SUPABASE_URL='https://vizmqgmefbgcggyfzdkj.supabase.co';
  const SUPABASE_KEY='sb_publishable_G_9VANFg4Dh7vuw8qpwwGw_Ck0h0H_3';
  let sb=null;

  function loadScript(src){
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src=src;s.async=true;s.onload=resolve;s.onerror=reject;
      document.head.appendChild(s);
    });
  }

  function localState(){try{return typeof state!=='undefined'?state:null}catch(_){return null}}
  function saveLocal(){try{if(typeof save==='function')save()}catch(_){}}
  function current(){
    try{if(typeof currentRestaurant==='function')return currentRestaurant()}catch(_){}
    const s=localState();
    return s?.restaurants?.find(r=>r.id===s.activeRestaurantId&&r.ownerId===s.session)||null;
  }
  function slugify(v){
    return String(v||'restaurant').toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-')
      .replace(/^-+|-+$/g,'').slice(0,70)||'restaurant';
  }
  function esc(v){
    return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function publicUrl(token){
    const u=new URL(location.href);
    u.search='';u.hash='';
    u.searchParams.set('menu',token);
    return u.toString();
  }

  async function boot(){
    try{
      if(!window.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
      });
      window.MENUO_SUPABASE=sb;
      patchPublicLinks();
      patchSaveButton();
    }catch(e){console.error('MENUO backend boot failed',e)}
  }

  async function saveRestaurant(r,user){
    const slug=slugify(r.slug||r.name);
    const payload={
      owner_id:user.id,name:r.name||'Мой ресторан',slug,
      logo_url:r.logoUrl||r.logo_url||null,address:r.address||null,phone:r.phone||null,
      description:r.description||null,website:r.website||null,instagram:r.instagram||null,
      facebook:r.facebook||null,hours:typeof r.hours==='object'?r.hours:{},
      default_locale:r.defaultLocale||r.default_locale||'ru',published:true
    };

    let rest=null;

    if(r.remoteId){
      const q=await sb.from('restaurants').update(payload).eq('id',r.remoteId).select().maybeSingle();
      if(q.error)throw q.error;
      rest=q.data;
    }

    if(!rest){
      const q=await sb.from('restaurants').select('*').eq('owner_id',user.id).eq('slug',slug).maybeSingle();
      if(q.error)throw q.error;
      rest=q.data||null;
    }

    if(rest){
      const q=await sb.from('restaurants').update(payload).eq('id',rest.id).select().single();
      if(q.error)throw q.error;
      rest=q.data;
    }else{
      const q=await sb.from('restaurants').insert(payload).select().single();
      if(q.error){
        // A previous save may have created the restaurant before a later step failed.
        // On FREE (1 restaurant) the local copy can have a different slug, so recover
        // the owner's existing restaurant instead of hitting the plan-limit trigger.
        const retry=await sb.from('restaurants').select('*').eq('owner_id',user.id).eq('slug',slug).maybeSingle();
        if(retry.error)throw q.error;
        if(retry.data){
          rest=retry.data;
        }else if(q.error?.code==='P0001' || /restaurant_limit_reached/i.test(q.error?.message||'')){
          const owned=await sb.from('restaurants').select('*').eq('owner_id',user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
          if(owned.error||!owned.data)throw q.error;
          const recovered=await sb.from('restaurants').update(payload).eq('id',owned.data.id).select().single();
          if(recovered.error)throw recovered.error;
          rest=recovered.data;
        }else throw q.error;
      }else rest=q.data;
    }

    if(!rest)throw new Error('Не удалось сохранить ресторан в базе данных.');
    r.remoteId=rest.id;r.slug=rest.slug;
    saveLocal();
    return rest;
  }

  async function syncCategories(r,restaurantId){
    const names=[...(Array.isArray(r.categories)?r.categories:[])].map(x=>String(x||'').trim()).filter(Boolean);
    const unique=[...new Set(names.length?names:['Все'])];

    const existing=await sb.from('categories').select('id,name').eq('restaurant_id',restaurantId);
    if(existing.error)throw existing.error;
    const byName=new Map((existing.data||[]).map(x=>[x.name,x.id]));

    // Keep existing UUIDs; omit id for new rows so Postgres generates it.
    const existingRows=unique.filter(name=>byName.has(name)).map((name,i)=>({
      id:byName.get(name),restaurant_id:restaurantId,name,sort_order:i,is_active:true
    }));
    if(existingRows.length){
      const uq=await sb.from('categories').upsert(existingRows,{onConflict:'id'}).select();
      if(uq.error)throw uq.error;
    }
    const newRows=unique.filter(name=>!byName.has(name)).map((name,i)=>({
      restaurant_id:restaurantId,name,sort_order:i,is_active:true
    }));
    let inserted=[];
    if(newRows.length){
      const iq=await sb.from('categories').insert(newRows).select();
      if(iq.error)throw iq.error;
      inserted=iq.data||[];
    }
    const qData=[...existingRows.map(x=>({id:x.id,name:x.name})),...inserted.map(x=>({id:x.id,name:x.name}))];

    const keep=new Set(unique);
    const stale=(existing.data||[]).filter(x=>!keep.has(x.name));
    if(stale.length){
      const del=await sb.from('categories').delete().in('id',stale.map(x=>x.id));
      if(del.error)throw del.error;
    }

    return new Map(qData.map(x=>[x.name,x.id]));
  }

  function localDishes(r){
    const s=localState();
    return Array.isArray(s?.dishes)?s.dishes.filter(d=>d.restaurantId===r.id):[];
  }

  async function syncDishes(r,restaurantId,catMap){
    const old=await sb.from('dishes').select('id').eq('restaurant_id',restaurantId);
    if(old.error)throw old.error;
    if(old.data?.length){
      const del=await sb.from('dishes').delete().eq('restaurant_id',restaurantId);
      if(del.error)throw del.error;
    }

    const ds=localDishes(r).map((d,i)=>({
      restaurant_id:restaurantId,
      category_id:catMap.get(String(d.category||d.categoryName||'').trim())||null,
      name:String(d.name||'Блюдо').trim()||'Блюдо',
      description:String(d.description||''),
      price_cents:Math.max(0,Math.round(Number(String(d.price??d.priceCents??0).replace(',','.'))*100)),
      currency:d.currency||'EUR',
      image_url:(d.photo||d.imageUrl||d.image_url||'').startsWith('http')?(d.photo||d.imageUrl||d.image_url):null,
      is_available:d.available!==false&&d.isAvailable!==false,
      sort_order:i,
      allergens:Array.isArray(d.allergens)?d.allergens:[]
    }));

    if(ds.length){
      const q=await sb.from('dishes').insert(ds);
      if(q.error)throw q.error;
    }
  }

  async function syncQr(r,restaurantId){
    let q=await sb.from('qr_codes').select('*').eq('restaurant_id',restaurantId).maybeSingle();
    if(q.error)throw q.error;
    if(!q.data){
      q=await sb.from('qr_codes').insert({
        restaurant_id:restaurantId,name:'Основной QR',is_active:true
      }).select().single();
      if(q.error)throw q.error;
    }
    r.qrToken=q.data.token;
    r.qrCreated=true;
    saveLocal();
    return q.data;
  }

  async function syncLocalMenu(){
    if(!sb)throw new Error('MENUO ещё загружает базу данных. Подождите секунду.');
    const {data:{user},error:userError}=await sb.auth.getUser();
    if(userError)throw userError;
    if(!user)throw new Error('Сначала войдите в аккаунт MENUO.');

    const r=current();
    if(!r)throw new Error('Сначала создайте ресторан.');
    const rest=await saveRestaurant(r,user);
    const catMap=await syncCategories(r,rest.id);
    await syncDishes(r,rest.id,catMap);
    const qr=await syncQr(r,rest.id);

    const url=publicUrl(qr.token);
    r.publicUrl=url;
    saveLocal();
    return {restaurant:rest,qr,url};
  }

  function showQr(url){
    let layer=document.getElementById('menuoQrLayer');
    if(!layer){
      layer=document.createElement('div');
      layer.id='menuoQrLayer';
      layer.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(20,29,24,.72);display:grid;place-items:center;padding:18px';
      document.body.appendChild(layer);
    }
    layer.innerHTML='<div style="width:min(100%,430px);max-height:92vh;overflow:auto;background:#fffdfa;border-radius:26px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,.25);text-align:center;color:#17201c"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:20px">Постоянный QR-код</b><button id="menuoQrClose" style="border:0;background:#eef2ef;border-radius:10px;width:38px;height:38px;font-size:22px">×</button></div><p style="color:#69756e;font-size:13px;line-height:1.4">Этот QR привязан к ресторану и не меняется при редактировании меню.</p><div id="menuoQrCanvas" style="display:grid;place-items:center;margin:15px auto"></div><div style="background:#f4f5ef;border-radius:11px;padding:10px;font-size:11px;word-break:break-all;color:#69756e">'+esc(url)+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px"><button id="menuoQrOpen" style="border:0;border-radius:12px;padding:13px;background:#ddf4e9;color:#1b6b4e;font-weight:800">Открыть меню</button><button id="menuoQrDownload" style="border:0;border-radius:12px;padding:13px;background:#1b6b4e;color:#fff;font-weight:800">Скачать QR</button></div></div>';
    layer.querySelector('#menuoQrClose').onclick=()=>layer.remove();
    layer.querySelector('#menuoQrOpen').onclick=()=>location.href=url;
    layer.querySelector('#menuoQrDownload').onclick=()=>downloadQr(url);
    loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js').then(()=>{
      const box=layer.querySelector('#menuoQrCanvas');
      if(window.QRCode) new window.QRCode(box,{text:url,width:270,height:270,correctLevel:window.QRCode.CorrectLevel.H});
    }).catch(()=>{layer.querySelector('#menuoQrCanvas').innerHTML='<div class="notice error">Не удалось загрузить генератор QR. Ссылка выше всё равно рабочая.</div>'});
  }

  async function downloadQr(url){
    try{
      await loadScript('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js');
      const data=await window.QRCode.toDataURL(url,{width:1200,margin:3,errorCorrectionLevel:'H'});
      const a=document.createElement('a');a.href=data;a.download='menuo-qr.png';a.click();
    }catch(e){alert('Не удалось скачать QR. Откройте ссылку меню и попробуйте ещё раз.')}
  }

  function patchPublicLinks(){
    const originalUrl=window.publicUrl;
    window.publicUrl=function(r){
      if(r?.qrToken)return publicUrl(r.qrToken);
      return typeof originalUrl==='function'?originalUrl(r):location.href;
    };
    const originalOpen=window.openPublic;
    window.openPublic=function(){
      const r=current();
      if(r?.qrToken){location.href=publicUrl(r.qrToken);return}
      if(typeof originalOpen==='function')return originalOpen();
    };
  }

  function patchSaveButton(){
    document.addEventListener('click',async e=>{
      const b=e.target?.closest?.('button');
      if(!b)return;
      if(!/Сохранить меню и открыть QR-код|Сохранить меню и сгенерировать QR-код/i.test((b.textContent||'').trim()))return;
      e.preventDefault();e.stopImmediatePropagation();
      try{
        b.disabled=true;
        const x=await syncLocalMenu();
        showQr(x.url);
      }catch(err){
        console.error('MENUO save/QR error',err);
        const message=err?.message||'Не удалось сохранить меню.';
        alert(message);
      }finally{b.disabled=false}
    },true);
  }

  window.MENUO_SYNC_MENU=syncLocalMenu;
  window.MENUO_OPEN_QR=async()=>{
    try{const x=await syncLocalMenu();showQr(x.url)}
    catch(e){alert(e?.message||'Не удалось открыть QR-код.')}
  };

  boot();
})();