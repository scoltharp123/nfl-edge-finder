import type { Config } from "@netlify/functions"

// Pulls NFL odds from The Odds API. The key lives in the ODDS_API_KEY
// environment variable (set in Netlify UI), never in code.
// "us" region = DraftKings + other US books; "eu" region = Pinnacle (sharp reference).
// Cost: 3 markets x 2 regions = 6 API credits per uncached call.
// The CDN caches the response for 10 minutes so page refreshes don't burn credits.

export default async (req: Request) => {
  const key = Netlify.env.get("ODDS_API_KEY")
  if (!key) {
    return Response.json(
      { error: "ODDS_API_KEY is not set. Add it in Netlify: Project configuration → Environment variables, then redeploy." },
      { status: 500 }
    )
  }

  const url = new URL("https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds")
  url.searchParams.set("apiKey", key)
  url.searchParams.set("regions", "us,eu")
  url.searchParams.set("markets", "h2h,spreads,totals")
  url.searchParams.set("oddsFormat", "american")

  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    return Response.json(
      { error: `Odds API returned ${res.status}`, detail: text.slice(0, 500) },
      { status: 502 }
    )
  }

  const body = JSON.stringify({
    fetchedAt: new Date().toISOString(),
    remaining: res.headers.get("x-requests-remaining"),
    used: res.headers.get("x-requests-used"),
    games: JSON.parse(text),
  })

  return new Response(body, {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "public, durable, s-maxage=600, stale-while-revalidate=120",
    },
  })
}

export const config: Config = { path: "/api/odds" }
