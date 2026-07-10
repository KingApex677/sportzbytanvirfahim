const HEALTH_CACHE_TTL_MS = 15 * 60 * 1000;
const STREAM_TIMEOUT_MS = 5000;
const HEALTH_RETRIES = 2;
const MAX_HEALTH_CHECKS_PER_REQUEST = 24;
const HEALTH_RESPONSE_BUDGET_MS = 8500;
const CHECKING_RETRY_MS = 30 * 1000;

const healthCache = new Map();

// Builds the configured upstream playlist source list from Netlify environment variables.
function getPlaylistUrls() {
    return [
        process.env.STREAM_SOURCE_URL,
        process.env.M3U_SOURCE_TWO,
        process.env.M3U_SOURCE_THREE
    ].filter(Boolean);
}

// Fetches all configured playlists without allowing one failed source to break aggregation.
async function fetchPlaylistContents(playlistUrls) {
    const requests = playlistUrls.map(url =>
        fetch(url)
            .then(res => res.ok ? res.text() : '')
            .catch(() => '')
    );

    return Promise.all(requests);
}

// Combines multiple M3U playlists into the single master playlist used by existing clients.
function buildMasterM3U(playlistsContent) {
    let masterM3U = "#EXTM3U\n";

    playlistsContent.forEach(content => {
        const lines = content.split('\n');
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#EXTM3U')) {
                masterM3U += trimmed + "\n";
            }
        });
    });

    return masterM3U;
}

// Parses channel metadata from M3U content so health data can be returned beside playlist data.
function parseM3U(masterM3U) {
    const lines = masterM3U.split(/\r?\n/);
    const parsed = [];
    let currentChannel = {};

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const nameIndex = line.lastIndexOf(',');
            if (nameIndex !== -1) currentChannel.name = line.substring(nameIndex + 1).trim();

            const groupMatch = line.match(/group-title="([^"]+)"/);
            currentChannel.category = groupMatch ? groupMatch[1] : "Uncategorized";

            const logoMatch = line.match(/tvg-logo="([^"]+)"/);
            if (logoMatch) currentChannel.logo = logoMatch[1];
        } else if (line.startsWith('http') || line.includes('://')) {
            currentChannel.url = line;
            if (!currentChannel.name) currentChannel.name = `Channel ${parsed.length + 1}`;
            parsed.push(currentChannel);
            currentChannel = {};
        }
    }

    return parsed;
}

// Creates the default health shape used before a stream has been checked.
function createCheckingHealth() {
    return {
        online: false,
        offline: false,
        checking: true,
        responseTime: null,
        lastChecked: null
    };
}

// Normalizes cached health records into the required public channel health fields.
function publicHealthFromCache(url) {
    const cached = healthCache.get(url);
    if (!cached) return createCheckingHealth();

    return {
        online: cached.status === 'online',
        offline: cached.status === 'offline',
        checking: cached.status === 'checking',
        responseTime: cached.responseTime,
        lastChecked: cached.lastChecked
    };
}

// Runs one timed HTTP request for a stream and falls back to GET when HEAD is not supported.
async function timedStreamProbe(url, method = 'HEAD') {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method,
            signal: controller.signal,
            headers: method === 'GET' ? { Range: 'bytes=0-1023' } : {}
        });

        const responseTime = Date.now() - startedAt;
        const headUnsupported = method === 'HEAD' && [405, 403, 501].includes(response.status);

        if (headUnsupported) {
            return timedStreamProbe(url, 'GET');
        }

        return {
            ok: response.ok || response.status === 206,
            responseTime
        };
    } finally {
        clearTimeout(timeout);
    }
}

// Checks one stream with two retries before marking the cached status offline.
async function checkStreamHealth(url) {
    healthCache.set(url, {
        status: 'checking',
        responseTime: null,
        lastChecked: new Date().toISOString()
    });

    for (let attempt = 0; attempt <= HEALTH_RETRIES; attempt++) {
        try {
            const result = await timedStreamProbe(url);
            if (result.ok) {
                healthCache.set(url, {
                    status: 'online',
                    responseTime: result.responseTime,
                    lastChecked: new Date().toISOString()
                });
                return;
            }
        } catch (error) {
            // Failed attempts are retried below and converted to offline after the final try.
        }
    }

    healthCache.set(url, {
        status: 'offline',
        responseTime: null,
        lastChecked: new Date().toISOString()
    });
}

// Chooses a small stale batch so large playlists are checked incrementally instead of per request.
function selectHealthBatch(channels, startOffset = 0) {
    const now = Date.now();
    const seenUrls = new Set();
    const due = [];
    const orderedChannels = channels.length
        ? [...channels.slice(startOffset % channels.length), ...channels.slice(0, startOffset % channels.length)]
        : [];

    for (const channel of orderedChannels) {
        if (!channel.url || seenUrls.has(channel.url)) continue;
        seenUrls.add(channel.url);

        const cached = healthCache.get(channel.url);
        const checkedAt = cached?.lastChecked ? Date.parse(cached.lastChecked) : 0;
        const checkingExpired = cached?.status === 'checking' && now - checkedAt >= CHECKING_RETRY_MS;
        const stale = !cached || !checkedAt || checkingExpired || now - checkedAt >= HEALTH_CACHE_TTL_MS;
        if (stale && due.length < MAX_HEALTH_CHECKS_PER_REQUEST) {
            due.push(channel.url);
        }
    }

    return due;
}

// Performs bounded concurrent health checks for the selected stale stream batch.
async function refreshHealthBatch(channels, startOffset = 0) {
    const batch = selectHealthBatch(channels, startOffset);
    if (!batch.length) return;

    const checks = Promise.allSettled(batch.map(url => checkStreamHealth(url)));
    const budget = new Promise(resolve => setTimeout(resolve, HEALTH_RESPONSE_BUDGET_MS));
    await Promise.race([checks, budget]);
}

// Counts health states for the frontend dashboard metadata.
function buildHealthSummary(channels) {
    return channels.reduce((summary, channel) => {
        const health = publicHealthFromCache(channel.url);
        if (health.online) summary.online++;
        else if (health.offline) summary.offline++;
        else summary.checking++;
        return summary;
    }, { online: 0, offline: 0, checking: 0 });
}

// Attaches health information to every parsed channel without changing core playlist metadata.
function attachHealthToChannels(channels) {
    return channels.map(channel => ({
        ...channel,
        health: publicHealthFromCache(channel.url),
        ...publicHealthFromCache(channel.url)
    }));
}

// Decides whether the caller wants the enriched JSON response or legacy M3U text.
function wantsJson(event) {
    const accept = event.headers && (event.headers.accept || event.headers.Accept || '');
    return event.queryStringParameters?.format === 'json' || accept.includes('application/json');
}

exports.handler = async (event) => {
    const playlistUrls = getPlaylistUrls();
    const healthOffset = Number.parseInt(event.queryStringParameters?.healthOffset || '0', 10) || 0;

    try {
        const playlistsContent = await fetchPlaylistContents(playlistUrls);
        const masterM3U = buildMasterM3U(playlistsContent);
        const channels = parseM3U(masterM3U);

        await refreshHealthBatch(channels, healthOffset);

        if (!wantsJson(event)) {
            return {
                statusCode: 200,
                headers: {
                    "Content-Type": "text/plain",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=60"
                },
                body: masterM3U
            };
        }

        const enrichedChannels = attachHealthToChannels(channels);
        const healthSummary = buildHealthSummary(channels);

        return {
            statusCode: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store, max-age=0"
            },
            body: JSON.stringify({
                playlist: {
                    channelCount: channels.length,
                    sourceCount: playlistUrls.length,
                    generatedAt: new Date().toISOString(),
                    m3u: masterM3U
                },
                health: {
                    ...healthSummary,
                    cacheTtlSeconds: HEALTH_CACHE_TTL_MS / 1000,
                    lastUpdated: new Date().toISOString()
                },
                channels: enrichedChannels
            })
        };
    } catch (error) {
        return {
            statusCode: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({ error: "Failed compiling aggregated stream pool profiles." })
        };
    }
};
