const JRA_CHANNEL_ID = "UCj6AKkCWS6FJqf0o5wP45eQ";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
};

type YoutubeError = {
  error?: { message?: string; errors?: { reason?: string }[] };
};

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { ...cors, "cache-control": "no-store" },
  });

async function youtube(path: string, params: Record<string, string>) {
  const key = Deno.env.get("YOUTUBE_API_KEY");
  if (!key) throw new Error("YOUTUBE_API_KEY_NOT_CONFIGURED");
  const query = new URLSearchParams(params);
  const response = await fetch(`${YOUTUBE_API}/${path}?${query}`, {
    headers: { "x-goog-api-key": key, "accept": "application/json" },
  });
  const body = await response.json() as YoutubeError & Record<string, unknown>;
  if (!response.ok) {
    const reason = body.error?.errors?.[0]?.reason ?? "YOUTUBE_API_ERROR";
    throw new Error(`${reason}:${body.error?.message ?? response.status}`);
  }
  return body;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "GET") return json({ error: "METHOD" }, 405);
  try {
    const requestUrl = new URL(req.url);
    let videoId = requestUrl.searchParams.get("videoId")?.trim() ?? "";
    if (videoId && !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return json({ error: "INVALID_VIDEO_ID" }, 400);
    }
    if (!videoId) {
      const search = await youtube("search", {
        part: "id",
        channelId: JRA_CHANNEL_ID,
        eventType: "live",
        type: "video",
        maxResults: "1",
        fields: "items(id/videoId)",
      });
      const items = search.items as { id?: { videoId?: string } }[] | undefined;
      videoId = items?.[0]?.id?.videoId ?? "";
      if (!videoId) return json({ status: "offline", messages: [] }, 404);
    }

    const video = await youtube("videos", {
      part: "snippet,liveStreamingDetails",
      id: videoId,
      fields:
        "items(id,snippet(channelId,title),liveStreamingDetails(actualStartTime,activeLiveChatId))",
    });
    const item = (video.items as {
      id: string;
      snippet?: { channelId?: string; title?: string };
      liveStreamingDetails?: {
        actualStartTime?: string;
        activeLiveChatId?: string;
      };
    }[] | undefined)?.[0];
    if (!item || item.snippet?.channelId !== JRA_CHANNEL_ID) {
      return json({ error: "NOT_JRA_LIVE" }, 404);
    }
    const liveChatId = item.liveStreamingDetails?.activeLiveChatId;
    if (!liveChatId) {
      return json({
        status: "chat_unavailable",
        videoId,
        title: item.snippet?.title,
        actualStartTime: item.liveStreamingDetails?.actualStartTime,
        messages: [],
      }, 404);
    }

    const params: Record<string, string> = {
      part: "snippet,authorDetails",
      liveChatId,
      maxResults: "200",
      profileImageSize: "32",
      hl: "ja",
      fields:
        "nextPageToken,pollingIntervalMillis,offlineAt,items(id,snippet(type,publishedAt,displayMessage,superChatDetails/amountDisplayString),authorDetails(displayName,profileImageUrl,isChatOwner,isChatModerator,isChatSponsor))",
    };
    const pageToken = requestUrl.searchParams.get("pageToken")?.trim();
    if (pageToken) params.pageToken = pageToken;
    const chat = await youtube("liveChat/messages", params);
    const messages = ((chat.items ?? []) as {
      id: string;
      snippet?: {
        type?: string;
        publishedAt?: string;
        displayMessage?: string;
        superChatDetails?: { amountDisplayString?: string };
      };
      authorDetails?: {
        displayName?: string;
        profileImageUrl?: string;
        isChatOwner?: boolean;
        isChatModerator?: boolean;
        isChatSponsor?: boolean;
      };
    }[]).filter((message) => message.snippet?.displayMessage).map((
      message,
    ) => ({
      id: message.id,
      text: message.snippet?.displayMessage,
      publishedAt: message.snippet?.publishedAt,
      type: message.snippet?.type,
      amount: message.snippet?.superChatDetails?.amountDisplayString,
      author: message.authorDetails?.displayName,
      avatar: message.authorDetails?.profileImageUrl,
      owner: Boolean(message.authorDetails?.isChatOwner),
      moderator: Boolean(message.authorDetails?.isChatModerator),
      sponsor: Boolean(message.authorDetails?.isChatSponsor),
    }));
    return json({
      status: chat.offlineAt ? "offline" : "live",
      videoId,
      title: item.snippet?.title,
      actualStartTime: item.liveStreamingDetails?.actualStartTime,
      nextPageToken: chat.nextPageToken,
      pollingIntervalMillis: Math.max(
        2000,
        Number(chat.pollingIntervalMillis) || 5000,
      ),
      messages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.error("JRA YouTube chat request failed", message.split(":")[0]);
    const status = message.startsWith("YOUTUBE_API_KEY_NOT_CONFIGURED")
      ? 503
      : message.startsWith("quotaExceeded")
      ? 429
      : 502;
    return json({ error: message.split(":")[0] }, status);
  }
});
