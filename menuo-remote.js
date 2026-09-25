/* MENUO remote-first cache bridge. Supabase is the source of truth. */
(function(){
  'use strict';
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  const money=c=> (Number(c||0)/100).toFixed(2).replace('.',',')+' €';

  async function hydrate(){
    const sb=window.MENUO_SUPABASE;
    if(!sb||typeof state==='undefined')return false;
    const auth=await sb.auth.getUser();
    const u=auth?.data?.user;
    if(!u)return false;

    const [rq,cq,dq,qq,pq]=await Promise.all([
      sb.from('restaurants').select('*').eq('owner_id',u.id).order('created_at',{ascending:true}),
      sb.from('categories').select('*').order('sort_order',{ascending:true}),
      sb.from('dishes').select('*').order('sort_order',{ascending:true}),
      sb.from('qr_codes').select('id,restaurant_id,token,is_active').eq('is_active',true),
      sb.rpc('get_my_plan')
    ]);
    const qs=[rq,cq,dq,qq,pq];
    const bad=qs.find(q=>q.error);
    if(bad)throw bad.error;

    const cats=cq.data||[], dishes=dq.data||[], qrs=qq.data||[];
    const planRow=Array.isArray(pq.data)?pq.data[0]:pq.data;
    const restaurants=(rq.data||[]).map(r=>{
      const rcats=cats.filter(c=>c.restaurant_id===r.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
      const qr=qrs.find(x=>x.restaurant_id===r.id);
      return {
        id:r.id,remoteId:r.id,ownerId:u.id,name:r.name||'Мой ресторан',slug:r.slug||'',
        logoUrl:r.logo_url||'',address:r.address||'',phone:r.phone||'',description:r.description||'',
        website:r.website||'',instagram:r.instagram||'',facebook:r.facebook||'',hours:r.hours||'',
        defaultLocale:r.default_locale||'ru',published:r.published!==false,
        categories:rcats.map(c=>c.name),qrToken:qr?.token||'',qrCreated:!!qr,
        publicUrl:qr?new URL('?menu='+encodeURIComponent(qr.token),location.href).toString():''
      };
    });
    const ids=new Set(restaurants.map(r=>r.id));
    const mappedDishes=dishes.filter(d=>ids.has(d.restaurant_id)).map(d=>({
      id:d.id,remoteId:d.id,restaurantId:d.restaurant_id,name:d.name||'Блюдо',
      description:d.description||'',price:money(d.price_cents),priceCents:Number(d.price_cents||0),
      category:(cats.find(c=>c.id===d.category_id)?.name)||'Основные',
      available:d.is_available!==false,photo:d.image_url||'',imageUrl:d.image_url||'',
      currency:d.currency||'EUR',allergens:Array.isArray(d.allergens)?d.allergens:[]
    }));

    const oldActive=state.activeRestaurantId;
    const oldUser=(state.users||[]).find(x=>x.id===u.id)||{};
    state.users=[{
      ...oldUser,id:u.id,email:u.email||'',phone:u.phone||'',
      firstName:u.user_metadata?.first_name||oldUser.firstName||'',
      lastName:u.user_metadata?.last_name||oldUser.lastName||'',
      plan:String(planRow?.code||planRow?.plan_code||oldUser.plan||'FREE').toUpperCase()
    }];
    state.restaurants=restaurants;
    state.dishes=mappedDishes;
    state.session=u.id;
    state.activeRestaurantId=ids.has(oldActive)?oldActive:(restaurants[0]?.id||null);
    save();

    try{
      if(document.getElementById('owner')&&!document.getElementById('owner').classList.contains('hidden'))renderOwner();
      if(document.getElementById('editor')&&!document.getElementById('editor').classList.contains('hidden'))renderEditor();
    }catch(_){}
    return true;
  }

  async function boot(){
    for(let i=0;i<80&&!window.MENUO_SUPABASE;i++)await wait(250);
    if(!window.MENUO_SUPABASE)return;
    try{await hydrate()}catch(e){console.warn('MENUO remote hydrate failed',e)}
    window.MENUO_HYDRATE=hydrate;
    window.MENUO_SUPABASE.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_IN'&&session?.user)setTimeout(()=>hydrate().catch(e=>console.warn('MENUO rehydrate failed',e)),0);
      if(event==='SIGNED_OUT'){
        state.users=[];state.restaurants=[];state.dishes=[];state.session=null;state.activeRestaurantId=null;save();
      }
    });
  }
  boot();
})();