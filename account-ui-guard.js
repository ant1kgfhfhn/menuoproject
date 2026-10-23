/* UI guards for MENUO persistence, pricing limits, and safe QR publishing. */
(function(){
  'use strict';
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const buttonText='Опубликовать меню и QR-код';
  function current(){try{return typeof currentRestaurant==='function'?currentRestaurant():null}catch(_){return null}}
  function ownRestaurants(){try{return typeof restaurants==='function'?restaurants():[]}catch(_){return []}}
  function currentPlan(){try{return typeof plan==='function'?plan():{restaurants:1}}catch(_){return {restaurants:1}}}
  function allowed(id){
    const list=ownRestaurants(),index=list.findIndex(r=>r.id===id);
    const limit=Number(currentPlan()?.restaurants??1);
    return index>=0&&(limit===Infinity||index<limit);
  }
  function setQrButtonLabel(){
    const b=document.querySelector('button[onclick="saveMenuAndQr()"]');
    if(b)b.textContent=buttonText;
  }
  // The old runtime bridge listens for the old label in the capture phase. Use the new label
  // so the current, safe save handler runs instead of the old delete-and-recreate handler.
  setQrButtonLabel();
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setQrButtonLabel);

  let autosaveTimer=null;
  function installWhenReady(){
    if(typeof window.MENUO_SAVE_MENU_DATA==='function'&&typeof window.MENUO_SYNC_MENU==='function'){
      window.queueMenuAutosave=function(immediate=false){
        const targetId=current()?.id||null;
        if(autosaveTimer)clearTimeout(autosaveTimer);
        return new Promise(resolve=>{
          autosaveTimer=setTimeout(async()=>{
            try{
              await window.MENUO_SAVE_MENU_DATA(targetId);
              const status=document.getElementById('saveStatus');
              if(status)status.textContent='Все изменения сохранены';
              resolve(true);
            }catch(e){
              console.warn('MENUO autosave failed',e);
              const status=document.getElementById('saveStatus');
              if(status)status.textContent='Не удалось синхронизировать изменения';
              resolve(false);
            }
          },immediate?0:900);
        });
      };
      window.saveMenuAndQr=async function(){
        const b=document.querySelector('button[onclick="saveMenuAndQr()"]');
        if(b)b.disabled=true;
        try{
          await window.MENUO_SYNC_MENU();
          if(typeof renderQr==='function')renderQr();
          else if(typeof show==='function')show('qr');
        }catch(e){alert(e?.message||'Не удалось сохранить меню и QR-код.')}
        finally{if(b)b.disabled=false}
      };

      const oldSelect=window.selectRestaurant;
      if(typeof oldSelect==='function'&&!oldSelect.__menuoPlanGate){
        const wrapped=function(id){
          if(!allowed(id)){
            alert('Этот ресторан и все его данные сохранены, но для работы с ним нужен более высокий тариф.');
            if(typeof show==='function')show('subscription');
            return;
          }
          return oldSelect(id);
        };
        wrapped.__menuoPlanGate=true;
        window.selectRestaurant=wrapped;
      }

      const oldRender=window.renderOwner;
      if(typeof oldRender==='function'&&!oldRender.__menuoPlanGate){
        const wrapped=function(){
          const result=oldRender();
          const box=document.getElementById('restaurantsList');
          const list=ownRestaurants(),limit=Number(currentPlan()?.restaurants??1);
          if(box){
            [...box.children].forEach((card,index)=>{
              if(index<limit)return;
              const small=card.querySelector('small');
              if(small&&!small.dataset.menuoLocked){small.textContent+=' · сохранено, доступ ограничен тарифом';small.dataset.menuoLocked='1'}
              const button=card.querySelector('button.mini');
              if(button){button.textContent='Выбрать тариф';button.onclick=()=>{if(typeof show==='function')show('subscription')}}
            });
          }
          return result;
        };
        wrapped.__menuoPlanGate=true;
        window.renderOwner=wrapped;
      }
      const oldShow=window.show;
      if(typeof oldShow==='function'&&!oldShow.__menuoPlanGate){
        const wrapped=function(id,opts){
          if(['editor','restaurantProfile','qr'].includes(id)){
            const r=current();
            if(r&&!allowed(r.id))return oldShow('subscription',opts);
          }
          return oldShow(id,opts);
        };
        wrapped.__menuoPlanGate=true;
        window.show=wrapped;
      }
      return true;
    }
    return false;
  }
  let tries=0;
  const poll=async()=>{
    while(tries++<300){
      if(installWhenReady())return;
      await sleep(100);
    }
    console.warn('MENUO UI guard: persistence API not ready.');
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',poll,{once:true});
  else poll();
})();