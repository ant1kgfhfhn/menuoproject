import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@22";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const ALLOWED_ORIGINS = new Set([
  "https://menuo-qr.com",
  "https://www.menuo-qr.com",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost"
]);

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "";
  const localDevOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) || localDevOrigin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin ? origin : "https://menuo-qr.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

async function purgeStoragePrefix(bucket: string, prefix: string) {
  async function walk(path: string): Promise<void> {
    let offset = 0;
    while (true) {
      const { data, error } = await admin.storage.from(bucket).list(path, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" }
      });
      if (error) throw error;
      const rows = data || [];
      const files: string[] = [];
      for (const item of rows) {
        const fullPath = path ? `${path}/${item.name}` : item.name;
        if (item.id === null) await walk(fullPath);
        else files.push(fullPath);
      }
      if (files.length) {
        const removed = await admin.storage.from(bucket).remove(files);
        if (removed.error) throw removed.error;
      }
      if (rows.length < 100) break;
      offset += rows.length;
    }
  }
  await walk(prefix);
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Для удаления войдите в аккаунт повторно." }, 401, cors);

    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: "Сессия недействительна. Войдите снова." }, 401, cors);

    const body = await req.json().catch(() => ({}));
    if (body.confirmation !== "DELETE") {
      return json({ error: "Подтверждение удаления не получено." }, 400, cors);
    }

    const { data: profileSub, error: subError } = await admin
      .from("subscriptions")
      .select("status,stripe_subscription_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (subError) throw subError;

    if (
      profileSub?.stripe_subscription_id &&
      ["active", "trialing", "past_due", "unpaid"].includes(String(profileSub.status))
    ) {
      if (!STRIPE_SECRET_KEY) {
        return json({
          error: "Найдена платная подписка. Отмените её в разделе «Тарифы» перед удалением аккаунта."
        }, 409, cors);
      }
      const stripe = new Stripe(STRIPE_SECRET_KEY);
      const current = await stripe.subscriptions.retrieve(profileSub.stripe_subscription_id);
      if (["active", "trialing", "past_due", "unpaid"].includes(current.status)) {
        await stripe.subscriptions.cancel(current.id);
      }
    }

    await purgeStoragePrefix("profile-avatars", user.id);
    await purgeStoragePrefix("restaurant-photos", user.id);

    // Profile-owned records cascade from profiles; payment history keeps its audit row.
    const deletedProfile = await admin.from("profiles").delete().eq("id", user.id);
    if (deletedProfile.error) throw deletedProfile.error;

    const deletedAuth = await admin.auth.admin.deleteUser(user.id, true);
    if (deletedAuth.error) throw deletedAuth.error;

    return json({ success: true }, 200, cors);
  } catch (error) {
    console.error("delete-account failed", error);
    return json({
      error: error instanceof Error ? error.message : "Не удалось удалить аккаунт."
    }, 500, cors);
  }
});