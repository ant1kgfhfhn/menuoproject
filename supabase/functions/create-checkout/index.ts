import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@22";
import { createClient } from "jsr:@supabase/supabase-js@2";

const stripe=new Stripe(Deno.env.get("STRIPE_SECRET_KEY")||"");
const supabase=createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};

function isoTime(value:any){
  const n=typeof value==="number"?value:Number(value);
  if(!Number.isFinite(n)||n<=0)return null;
  const d=new Date(n*1000);
  return Number.isNaN(d.getTime())?null:d.toISOString();
}

function periodTimestamp(sub: any, field: "current_period_start" | "current_period_end"): number | null {
  const direct = Number(sub?.[field]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const candidates = (sub?.items?.data || [])
    .map((item: any) => Number(item?.[field]))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.min(...candidates) : null;
}
function periodIso(sub: any, field: "current_period_start" | "current_period_end"): string | null {
  const value = periodTimestamp(sub, field);
  return value ? isoTime(value) : null;
}

Deno.serve(async req=>{
  let stage="start";
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  try{
    stage="auth";
    const auth=req.headers.get("Authorization")||"";
    const token=auth.replace(/^Bearer\s+/i,"");
    const {data:{user},error}=await supabase.auth.getUser(token);
    if(error||!user)return new Response(JSON.stringify({error:"Unauthorized"}),{status:401,headers:{...cors,"Content-Type":"application/json"}});
    stage="input";
    const {planId,promoCode,confirmSeparatePurchase=false}=await req.json();
    if(!["pro","business"].includes(String(planId)))throw new Error("Invalid plan");

    stage="load_plan";
    const {data:plan,error:planError}=await supabase.from("plans").select("*").eq("id",planId).single();
    if(planError)throw planError;
    if(!plan)throw new Error("Plan not found");

    stage="load_subscription";
    const existing=await supabase.from("subscriptions").select("stripe_customer_id,status,plan_id,stripe_subscription_id,current_period_end").eq("user_id",user.id).maybeSingle();
    if(existing.error)throw existing.error;
    let customerId=existing.data?.stripe_customer_id||undefined;

    let previousSubscriptionForPurchase:any=null;
    let previousPlanForPurchase:string|null=null;

    if(customerId){
      stage="find_active_subscription";
      const allCustomerSubs=await stripe.subscriptions.list({customer:customerId,status:"all",limit:50});
      const currentEligibleStatuses=["active","trialing","past_due","unpaid"];
      const eligibleSubs=allCustomerSubs.data.filter((sub:any)=>currentEligibleStatuses.includes(String(sub.status||"")));
      // The subscriptions row defines the plan currently granted in MENUO. Other
      // subscriptions may be older contracts canceled at their period end.
      let current:any=eligibleSubs.find((sub:any)=>sub.id===existing.data?.stripe_subscription_id)
        || eligibleSubs[0]
        || null;
      if(current){
        const pricePlan=current.items?.data
          ?.map((entry:any)=>entry.price?.metadata?.menuo_plan_id)
          .find((value:any)=>typeof value==="string"&&value.trim());
        const currentPlan=String(pricePlan||current.metadata?.plan_id||existing.data?.plan_id||"free").toLowerCase();
        const endDate=periodIso(current,"current_period_end");
        const scheduleId=typeof current.schedule==="string"?current.schedule:current.schedule?.id;

        if(currentPlan===String(planId).toLowerCase()){
          // Choosing the already-paid plan only resumes it if it had been scheduled
          // to end; it never creates a duplicate subscription.
          if(scheduleId){
            await stripe.subscriptionSchedules.release(scheduleId);
            current=await stripe.subscriptions.retrieve(current.id);
          }
          if(current.cancel_at_period_end){
            current=await stripe.subscriptions.update(current.id,{cancel_at_period_end:false});
          }
          const patch:any={
            user_id:user.id,plan_id:currentPlan,status:current.status,
            stripe_customer_id:String(current.customer),
            stripe_subscription_id:current.id
          };
          const startTime=periodIso(current,"current_period_start");
          const endTime=periodIso(current,"current_period_end");
          if(startTime)patch.current_period_start=startTime;
          if(endTime)patch.current_period_end=endTime;
          const {error:syncError}=await supabase.from("subscriptions").upsert(patch,{onConflict:"user_id"});
          if(syncError)throw syncError;
          const contractPatch:any={
            user_id:user.id,plan_id:currentPlan,status:current.status,
            stripe_customer_id:String(current.customer),stripe_subscription_id:current.id,
            current_period_start:startTime,current_period_end:endTime,
            cancel_at_period_end:!!current.cancel_at_period_end
          };
          const {error:contractError}=await supabase.from("subscription_contracts").upsert(contractPatch,{onConflict:"stripe_subscription_id"});
          if(contractError)throw contractError;
          return new Response(JSON.stringify({
            unchanged:true,
            restoredAutoRenewal:!!current.cancel_at_period_end,
            restoredScheduledPlan:!!scheduleId,
            planId:currentPlan,
            status:current.status,
            currentPeriodEnd:endTime
          }),{headers:{...cors,"Content-Type":"application/json"}});
        }

        if(currentPlan!=="free"){
          if(!confirmSeparatePurchase){
            return new Response(JSON.stringify({
              confirmationRequired:true,
              currentPlan,
              requestedPlan:String(planId).toLowerCase(),
              currentPeriodEnd:endDate,
              cancelAtPeriodEnd:!!current.cancel_at_period_end
            }),{headers:{...cors,"Content-Type":"application/json"}});
          }
        }

        // Crucially, selecting a different plan never changes the existing
        // subscription here. The old contract will only be scheduled to stop
        // after the separately purchased subscription has actually been paid.
        previousSubscriptionForPurchase=current;
        previousPlanForPurchase=currentPlan;
      }
    }

    if(!customerId){
      const customer=await stripe.customers.create({email:user.email||undefined,metadata:{supabase_user_id:user.id}});
      customerId=customer.id;
      const {error:updateError}=await supabase.from("subscriptions").update({stripe_customer_id:customerId}).eq("user_id",user.id);
      if(updateError)throw updateError;
    }

    stage="promo";
    let discounts:any[]|undefined;
    if(promoCode?.trim()){
      const {data:promo,error:promoError}=await supabase.rpc("validate_promo",{p_code:String(promoCode),p_user:user.id});
      if(promoError)throw promoError;
      const p=Array.isArray(promo)?promo[0]:promo;
      if(!p)throw new Error("Промокод недействителен, истёк или уже использован.");
      const full=await supabase.from("promo_codes").select("*").eq("id",p.id).single();
      if(full.error)throw full.error;
      const fixedDiscount=Number(full.data.discount_cents||0)>0;
      let couponId=fixedDiscount?full.data.stripe_coupon_eur_id:full.data.stripe_coupon_id;
      if(!couponId){
        const coupon=await stripe.coupons.create({
          name:"MENUO "+full.data.code,
          percent_off:full.data.discount_percent||undefined,
          amount_off:full.data.discount_cents||undefined,
          currency:fixedDiscount?"eur":undefined,
          duration:full.data.duration_months?"repeating":"once",
          duration_in_months:full.data.duration_months||undefined,
          metadata:{menuo_promo_id:full.data.id,code:full.data.code}
        });
        couponId=coupon.id;
        const couponField=fixedDiscount?"stripe_coupon_eur_id":"stripe_coupon_id";
        const {error:updatePromoError}=await supabase.from("promo_codes").update({[couponField]:couponId}).eq("id",full.data.id);
        if(updatePromoError)throw updatePromoError;
      }
      discounts=[{coupon:couponId}];
    }

    stage="stripe_checkout";
    const site="https://menuo-qr.com";
    const session=await stripe.checkout.sessions.create({
      mode:"subscription",
      customer:customerId,
      line_items:[{
        price_data:{
          currency:"eur",
          product_data:{name:"MENUO "+plan.name,metadata:{menuo_plan_id:plan.id}},
          unit_amount:Number(plan.price_monthly_cents),
          recurring:{interval:"month"}
        },
        quantity:1
      }],
      discounts,
      success_url:site+"/?payment=success&plan_change="+encodeURIComponent(plan.id),
      cancel_url:site+"/?payment=cancel&plan_change="+encodeURIComponent(plan.id),
      client_reference_id:user.id,
      metadata:{
        supabase_user_id:user.id,
        plan_id:plan.id,
        promo_code:String(promoCode||"").trim().toUpperCase(),
        ...(previousSubscriptionForPurchase?{
          purchase_mode:"separate_paid_subscription",
          previous_subscription_id:String(previousSubscriptionForPurchase.id),
          previous_plan_id:String(previousPlanForPurchase||"free")
        }:{})
      },
      subscription_data:{metadata:{
        supabase_user_id:user.id,
        plan_id:plan.id,
        promo_code:String(promoCode||"").trim().toUpperCase(),
        ...(previousSubscriptionForPurchase?{
          purchase_mode:"separate_paid_subscription",
          previous_subscription_id:String(previousSubscriptionForPurchase.id),
          previous_plan_id:String(previousPlanForPurchase||"free")
        }:{})
      }}
    });
    return new Response(JSON.stringify({url:session.url}),{headers:{...cors,"Content-Type":"application/json"}});
  }catch(e){
    console.error("create-checkout failed",stage,e);
    return new Response(JSON.stringify({error:e?.message||"Checkout error",stage,type:e?.type||null,code:e?.code||null}),{status:200,headers:{...cors,"Content-Type":"application/json"}});
  }
});