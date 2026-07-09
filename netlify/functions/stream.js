// netlify/functions/stream.js

export default async (req, context) => {
    const PRIVATE_M3U_URL = process.env.MY_SECRET_M3U;

    if (!PRIVATE_M3U_URL) {
        return new Response(
            JSON.stringify({ error: "Missing configuration variable: MY_SECRET_M3U" }), 
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }

    try {
        // Securely pull playlist content while pretending to be a normal desktop browser
        const providerResponse = await fetch(PRIVATE_M3U_URL, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        
        if (!providerResponse.ok) {
            return new Response(`IPTV Provider error status: ${providerResponse.status}`, { status: 400 });
        }

        const rawM3uData = await providerResponse.text();

        return new Response(rawM3uData, {
            status: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type",
                "Content-Type": "text/plain; charset=utf-8"
            }
        });

    } catch (err) {
        return new Response(
            JSON.stringify({ error: "Failed to connect to streaming provider." }), 
            { status: 500, headers: { "Content-Type": "application/json" } }
        );
    }
};

export const config = {
    path: "/.netlify/functions/stream"
};