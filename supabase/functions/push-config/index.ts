const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return Response.json({ error: "METHOD" }, { status: 405, headers: cors });
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  if (!publicKey) return Response.json({ error: "PUSH_NOT_CONFIGURED" }, { status: 503, headers: cors });
  return Response.json({ publicKey }, { headers: { ...cors, "cache-control": "public, max-age=3600" } });
});
