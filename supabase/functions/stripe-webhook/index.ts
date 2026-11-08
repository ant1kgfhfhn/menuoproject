import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@22";
import { createClient } from "jsr:@supabase/supabase-js@2";

const stripe=new Stripe(Deno.env.get("STRIPE_SECRET_KEY")||"");
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cryptoProvider=Stripe.createSubtleCryptoProvider();

function stripePeriodTimestamp(sub: any, field: "current_period_start" | "current_period_end"): number | null {
  const direct = Number(sub?.[field]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const items = sub?.items?.data || [];
  const candidates = items
    .map((item: any) => Number(item?.[field]))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return null;
  return Math.min(...candidates);
}
function stripePeriodIso(sub: any, field: "current_period_start" | "current_period_end"): string | null {
  const value = stripePeriodTimestamp(sub, field);
  if (!value) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}


async function upsertSubscriptionContract(userId: string, sub: any, planId: string, statusOverride?: string) {
  const patch: Record<string, unknown> = {
    user_id: userId,
    plan_id: planId,
    status: statusOverride || sub.status,
    stripe_customer_id: String(typeof sub.customer === "string" ? sub.customer : sub.customer?.id || ""),
    stripe_subscription_id: sub.id,
    cancel_at_period_end: !!sub.cancel_at_period_end
  };
  const start = stripePeriodIso(sub, "current_period_start");
  const end = stripePeriodIso(sub, "current_period_end");
  if (start) patch.current_period_start = start;
  if (end) patch.current_period_end = end;
  const { error } = await admin.from("subscription_contracts")
    .upsert(patch, { onConflict: "stripe_subscription_id" });
  if (error) throw error;
}

Deno.serve(async req=>{
  const body=await req.text();
  const sig=req.headers.get("stripe-signature")||"";
  let event;
  try{event=await stripe.webhooks.constructEventAsync(body,sig,Deno.env.get("STRIPE_WEBHOOK_SECRET")!,undefined,cryptoProvider)}
  catch(e){return new Response("bad signature",{status:400})}
  try{
    const obj:any=event.data.object;
    const meta=obj.metadata||{};
    const userId=meta.supabase_user_id||null;
    await admin.from("payment_events").upsert({
      stripe_event_id:event.id,event_type:event.type,user_id:userId,
      stripe_customer_id:obj.customer||null,stripe_subscription_id:obj.subscription||obj.id||null,payload:obj
    },{onConflict:"stripe_event_id"});

    if(event.type==="checkout.session.completed"){
      const session:any=obj;

      if(session.mode==="subscription" && session.metadata?.purchase_mode==="separate_paid_subscription"){
        const meta:any=session.metadata||{};
        if(!["paid","no_payment_required"].includes(String(session.payment_status||""))){
          console.warn("MENUO separate subscription Checkout is not paid yet; existing subscription is unchanged",session.id);
        }else{
          const uid=String(meta.supabase_user_id||"");
          const targetPlan=String(meta.plan_id||"").toLowerCase();
          const previousId=String(meta.previous_subscription_id||"");
          const newId=typeof session.subscription==="string"?session.subscription:session.subscription?.id;
          if(!uid||session.client_reference_id!==uid||!newId||!["pro","business"].includes(targetPlan)){
            throw new Error("Invalid MENUO separate subscription Checkout metadata.");
          }
          const [{data:primary,error:primaryError},newSub]=await Promise.all([
            admin.from("subscriptions").select("user_id,plan_id,status,stripe_customer_id,stripe_subscription_id")
              .eq("user_id",uid).maybeSingle(),
            stripe.subscriptions.retrieve(newId)
          ]);
          if(primaryError)throw primaryError;
          if(String(newSub.customer||"")!==String(session.customer||"")||
             String(newSub.metadata?.supabase_user_id||"")!==uid||
             String(newSub.metadata?.plan_id||"").toLowerCase()!==targetPlan){
            throw new Error("MENUO new subscription does not match the paid Checkout metadata.");
          }

          const alreadyApplied=primary?.stripe_subscription_id===newSub.id;
          if(!alreadyApplied){
            if(previousId){
              if(!primary || primary.stripe_subscription_id!==previousId){
                throw new Error("MENUO subscription changed while the new Checkout was open. The old subscription was not modified.");
              }
              const previousSub=await stripe.subscriptions.retrieve(previousId);
              const previousPlan=String(meta.previous_plan_id||primary.plan_id||previousSub.metadata?.plan_id||"free").toLowerCase();
              if(String(previousSub.customer||"")!==String(session.customer||"")||
                 String(previousSub.metadata?.supabase_user_id||uid)!==uid){
                throw new Error("MENUO previous subscription could not be verified. It was not modified.");
              }
              let oldSub:any=previousSub;
              const oldSchedule=typeof oldSub.schedule==="string"?oldSub.schedule:oldSub.schedule?.id;
              if(oldSchedule){
                await stripe.subscriptionSchedules.release(oldSchedule);
                oldSub=await stripe.subscriptions.retrieve(oldSub.id);
              }
              if(previousPlan==="free"){
                if(!["canceled","incomplete_expired"].includes(String(oldSub.status))){
                  oldSub=await stripe.subscriptions.cancel(oldSub.id,{invoice_now:false,prorate:false});
                }
              }else if(["active","trialing","past_due","unpaid"].includes(String(oldSub.status))&&!oldSub.cancel_at_period_end){
                oldSub=await stripe.subscriptions.update(oldSub.id,{cancel_at_period_end:true});
              }
              // No refund is issued. The previously paid plan remains in force until its
              // period end, then cancellation stops the next recurring renewal.
              await upsertSubscriptionContract(uid,oldSub,previousPlan);
            }
            await upsertSubscriptionContract(uid,newSub,targetPlan);
          }
        }
      }

      // Upgrade payments are a one-time Checkout for only the prorated difference.
      // Keep the old paid subscription untouched until this checkout is confirmed paid.
      if(session.mode==="payment" && session.metadata?.action==="subscription_upgrade"){
        const meta:any=session.metadata||{};
        const uid=String(meta.supabase_user_id||"");
        const subscriptionId=String(meta.subscription_id||"");
        const targetPlan=String(meta.target_plan||"").toLowerCase();
        const expectedCurrent=String(meta.current_plan||"").toLowerCase();
        const targetPriceId=String(meta.target_price_id||"");
        const paymentIntentId=typeof session.payment_intent==="string"
          ? session.payment_intent
          : session.payment_intent?.id;
        if(session.payment_status!=="paid"){
          console.warn("MENUO upgrade checkout completed without paid status; subscription was not changed",session.id);
        }else if(!uid||session.client_reference_id!==uid||!subscriptionId||!targetPriceId||
          !["pro","business"].includes(targetPlan)||!["pro","business"].includes(expectedCurrent)){
          throw new Error("Invalid MENUO upgrade checkout metadata.");
        }else{
          const [{data:row,error:rowError},targetPrice,liveSub]=await Promise.all([
            admin.from("subscriptions").select("plan_id,status,stripe_customer_id,stripe_subscription_id")
              .eq("user_id",uid).maybeSingle(),
            stripe.prices.retrieve(targetPriceId),
            stripe.subscriptions.retrieve(subscriptionId)
          ]);
          if(rowError)throw rowError;
          if(!row||row.stripe_subscription_id!==subscriptionId||
            String(row.stripe_customer_id||"")!==String(session.customer||"")||
            String(liveSub.customer||"")!==String(session.customer||"")||
            targetPrice.metadata?.menuo_plan_id!==targetPlan||
            !targetPrice.recurring||targetPrice.currency!==String((liveSub.items?.data||[]).find((item:any)=>!item.deleted)?.price?.currency||"").toLowerCase()){
            throw new Error("MENUO upgrade checkout could not be matched to the account and subscription.");
          }
          const liveItems=(liveSub.items?.data||[]).filter((item:any)=>!item.deleted);
          if(liveItems.length!==1)throw new Error("MENUO upgrade subscription has unexpected item count.");
          const currentItem=liveItems[0];
          const actualPlan=String(currentItem.price?.metadata?.menuo_plan_id||liveSub.metadata?.plan_id||"").toLowerCase();
          if(actualPlan!==targetPlan && actualPlan!==expectedCurrent){
            // Another change happened while Checkout was open. Refund the one-time
            // upgrade payment rather than charging the customer without applying it.
            if(paymentIntentId){
              const refundList=await stripe.refunds.list({payment_intent:paymentIntentId,limit:10});
              const prior=refundList.data.some((refund:any)=>refund.metadata?.menuo_upgrade_session===session.id);
              if(!prior){
                await stripe.refunds.create({
                  payment_intent:paymentIntentId,
                  reason:"requested_by_customer",
                  metadata:{menuo_upgrade_session:session.id,reason:"subscription_changed_during_checkout"}
                },{idempotencyKey:"menuo-upgrade-stale-"+session.id});
              }
            }
            console.warn("MENUO upgrade checkout refunded because subscription changed during Checkout",session.id);
          }else{
            let updatedSub:any=liveSub;
            if(actualPlan!==targetPlan||currentItem.price?.id!==targetPriceId){
              const scheduled=typeof updatedSub.schedule==="string"
                ? updatedSub.schedule : updatedSub.schedule?.id;
              if(scheduled){
                await stripe.subscriptionSchedules.release(scheduled);
                updatedSub=await stripe.subscriptions.retrieve(updatedSub.id);
              }
              if(updatedSub.cancel_at_period_end){
                updatedSub=await stripe.subscriptions.update(updatedSub.id,{cancel_at_period_end:false});
              }
              const activeItem=(updatedSub.items?.data||[]).find((item:any)=>!item.deleted);
              if(!activeItem)throw new Error("MENUO upgrade lost its subscription item.");
              updatedSub=await stripe.subscriptions.update(updatedSub.id,{
                items:[{id:activeItem.id,price:targetPriceId,quantity:activeItem.quantity||1}],
                proration_behavior:"none",
                metadata:{
                  ...(updatedSub.metadata||{}),
                  supabase_user_id:uid,
                  plan_id:targetPlan,
                  pending_plan_id:"",
                  promo_code:""
                }
              });
            }
            const subscriptionPatch:any={
              user_id:uid,
              plan_id:targetPlan,
              status:updatedSub.status,
              stripe_customer_id:String(updatedSub.customer),
              stripe_subscription_id:updatedSub.id
            };
            const periodStart=stripePeriodIso(updatedSub,"current_period_start");
            const periodEnd=stripePeriodIso(updatedSub,"current_period_end");
            if(periodStart)subscriptionPatch.current_period_start=periodStart;
            if(periodEnd)subscriptionPatch.current_period_end=periodEnd;
            const subscriptionWrite=await admin.from("subscriptions").upsert(subscriptionPatch,{onConflict:"user_id"});
            if(subscriptionWrite.error)throw subscriptionWrite.error;
          }
        }
      }
      const subscriptionId=typeof session.subscription==="string"?session.subscription:session.subscription?.id;
      const shouldProcessSubscription=!(
        session.mode==="subscription" &&
        session.metadata?.purchase_mode==="separate_paid_subscription" &&
        !["paid","no_payment_required"].includes(String(session.payment_status||""))
      );
      if(subscriptionId && shouldProcessSubscription){
        const sub:any=await stripe.subscriptions.retrieve(subscriptionId);
        const m=sub.metadata||meta;
        const uid=m.supabase_user_id||userId;
        const pricePlan=(sub.items?.data||[])
          .map((item:any)=>item?.price?.metadata?.menuo_plan_id)
          .find((value:any)=>typeof value==="string"&&value.trim());
        const planId=pricePlan||m.plan_id||meta.plan_id||"free";
        const subscriptionPatch:any={
          user_id:uid,plan_id:planId,status:sub.status,stripe_customer_id:String(sub.customer),
          stripe_subscription_id:sub.id
        };
        const periodStart=stripePeriodIso(sub,"current_period_start");
        const periodEnd=stripePeriodIso(sub,"current_period_end");
        if(periodStart)subscriptionPatch.current_period_start=periodStart;
        if(periodEnd)subscriptionPatch.current_period_end=periodEnd;
        const subscriptionWrite=await admin.from("subscriptions").upsert(subscriptionPatch,{onConflict:"user_id"});
        if(subscriptionWrite.error)throw subscriptionWrite.error;
        await upsertSubscriptionContract(uid,sub,planId);
        if(meta.promo_code){
          const {data:promo}=await admin.from("promo_codes").select("id").eq("code",meta.promo_code).maybeSingle();
          if(promo){
            await admin.from("promo_redemptions").upsert({
              promo_code_id:promo.id,user_id:uid,stripe_checkout_session_id:session.id,
              stripe_subscription_id:sub.id
            },{onConflict:"promo_code_id,user_id"});
            await admin.rpc("increment_promo_redemption",{p_id:promo.id});
          }
        }
      }
    }

    if(["customer.subscription.updated","customer.subscription.deleted"].includes(event.type)){
      let sub:any=obj;
      let m=sub.metadata||{};
      const itemPlan=(sub.items?.data||[])
        .map((item:any)=>item?.price?.metadata?.menuo_plan_id)
        .find((value:any)=>typeof value==="string"&&value.trim());
      if(event.type==="customer.subscription.updated" && !sub.pending_update){
        const requested=String(m.pending_plan_id||"").toLowerCase();
        const pricePlan=String(itemPlan||"").toLowerCase();
        const target=["pro","business"].includes(requested)?requested:
          (["pro","business"].includes(pricePlan)?pricePlan:"");
        if(target && (target!==String(m.plan_id||"").toLowerCase() || m.pending_plan_id)){
          sub=await stripe.subscriptions.update(sub.id,{
            metadata:{...m,plan_id:target,pending_plan_id:""}
          });
          m=sub.metadata||{};
        }
      }
      const uid=m.supabase_user_id;
      if(uid){
        const effectivePlan=event.type.endsWith("deleted")
          ? (m.plan_id||"free")
          : (itemPlan||m.plan_id||"free");
        await upsertSubscriptionContract(uid,sub,effectivePlan,event.type.endsWith("deleted")?"canceled":undefined);
        const {data:primary,error:primaryError}=await admin.from("subscriptions")
          .select("stripe_subscription_id,plan_id,status").eq("user_id",uid).maybeSingle();
        if(primaryError)throw primaryError;
        // Delayed events from an older paid contract may update the contract history,
        // but must never overwrite the user's newer current plan.
        if(!primary || !primary.stripe_subscription_id || primary.stripe_subscription_id===sub.id){
          const subscriptionPatch:any={
            plan_id:event.type.endsWith("deleted")?"free":effectivePlan,
            status:event.type.endsWith("deleted")?"canceled":sub.status,
            stripe_customer_id:String(sub.customer||""),
            stripe_subscription_id:sub.id
          };
          const periodStart=stripePeriodIso(sub,"current_period_start");
          const periodEnd=stripePeriodIso(sub,"current_period_end");
          if(periodStart)subscriptionPatch.current_period_start=periodStart;
          if(periodEnd)subscriptionPatch.current_period_end=periodEnd;
          const subscriptionWrite=await admin.from("subscriptions").upsert(subscriptionPatch,{onConflict:"user_id"});
          if(subscriptionWrite.error)throw subscriptionWrite.error;
        }
      }
    }

    if(event.type==="invoice.paid"){
      const invoice:any=obj;
      const subscriptionId=typeof invoice.subscription==="string"
        ? invoice.subscription
        : invoice.subscription?.id;
      if(subscriptionId){
        let sub:any=await stripe.subscriptions.retrieve(subscriptionId);
        let m=sub.metadata||{};
        const itemPlan=(sub.items?.data||[])
          .map((item:any)=>item?.price?.metadata?.menuo_plan_id)
          .find((value:any)=>typeof value==="string"&&value.trim());
        const pending=String(m.pending_plan_id||"").toLowerCase();
        const target=!sub.pending_update&&["pro","business"].includes(pending)?pending:
          (!sub.pending_update&&["pro","business"].includes(String(itemPlan||"").toLowerCase())?String(itemPlan).toLowerCase():"");
        if(target && (target!==String(m.plan_id||"").toLowerCase() || m.pending_plan_id)){
          sub=await stripe.subscriptions.update(sub.id,{
            metadata:{...m,plan_id:target,pending_plan_id:""}
          });
          m=sub.metadata||{};
        }
        const uid=m.supabase_user_id||invoice.metadata?.supabase_user_id;
        if(uid){
          const effectivePlan=itemPlan||m.plan_id||"free";
          await upsertSubscriptionContract(uid,sub,effectivePlan);
          const {data:primary,error:primaryError}=await admin.from("subscriptions")
            .select("stripe_subscription_id").eq("user_id",uid).maybeSingle();
          if(primaryError)throw primaryError;
          // Invoice events from a previous, already-paid contract must not replace a
          // newer subscription currently used by the app.
          if(!primary || !primary.stripe_subscription_id || primary.stripe_subscription_id===sub.id){
            const subscriptionPatch:any={
              user_id:uid,plan_id:effectivePlan,status:sub.status,
              stripe_customer_id:String(sub.customer||""),
              stripe_subscription_id:sub.id
            };
            const periodStart=stripePeriodIso(sub,"current_period_start");
            const periodEnd=stripePeriodIso(sub,"current_period_end");
            if(periodStart)subscriptionPatch.current_period_start=periodStart;
            if(periodEnd)subscriptionPatch.current_period_end=periodEnd;
            const subscriptionWrite=await admin.from("subscriptions").upsert(subscriptionPatch,{onConflict:"user_id"});
            if(subscriptionWrite.error)throw subscriptionWrite.error;
          }
        }
      }
    }
    return Response.json({received:true});
  }catch(e){console.error(e);return new Response("webhook processing error",{status:500})}
});