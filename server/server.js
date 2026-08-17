const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = process.env.PORT || 3000;

const API_FOOTBALL_KEY =
    process.env.API_FOOTBALL_KEY ||
    process.env.LIVE_FOOTBALL_API_KEY ||
    "";

const FOOTBALL_DATA_TOKEN =
    process.env.FOOTBALL_DATA_TOKEN ||
    process.env.FOOTBALL_DATA_API_KEY ||
    "";

const BD_TIMEZONE = "Asia/Dhaka";

const API_FOOTBALL_BASE =
    "https://v3.football.api-sports.io";

const FOOTBALL_DATA_BASE =
    "https://api.football-data.org/v4";

/* Cache durations */
const LIVE_CACHE_MS = 30 * 1000;          // 30 sec
const TODAY_CACHE_MS = 60 * 1000;         // 1 min
const UPCOMING_CACHE_MS = 15 * 60 * 1000; // 15 min

/* Upload limit */
const MAX_UPLOAD_BYTES =
    500 * 1024 * 1024;

/* =========================================================
   PATHS
========================================================= */

const serverDir = __dirname;

const wwwDir =
    path.join(
        __dirname,
        "..",
        "www"
    );

const uploadsDir =
    path.join(
        __dirname,
        "uploads"
    );

const cacheDir =
    path.join(
        __dirname,
        "cache"
    );

const cacheFile =
    path.join(
        cacheDir,
        "fixtures-cache.json"
    );

/* Create required folders */

for (
    const dir of [
        uploadsDir,
        cacheDir
    ]
) {

    if (!fs.existsSync(dir)) {

        fs.mkdirSync(
            dir,
            {
                recursive: true
            }
        );
    }
}

/* =========================================================
   APP
========================================================= */

app.disable("x-powered-by");

app.use(
    express.json({
        limit: "1mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "1mb"
    })
);

/* Static files */

app.use(
    "/uploads",
    express.static(uploadsDir)
);

app.use(
    express.static(wwwDir)
);

/* =========================================================
   SIMPLE RATE LIMITER
   No extra dependency required.
========================================================= */

const rateMap =
    new Map();

const RATE_WINDOW_MS =
    60 * 1000;

const RATE_LIMIT =
    60;

function rateLimit(
    req,
    res,
    next
) {

    const ip =
        (
            req.headers["x-forwarded-for"] ||
            req.socket.remoteAddress ||
            "unknown"
        )
        .toString()
        .split(",")[0]
        .trim();

    const now =
        Date.now();

    let record =
        rateMap.get(ip);

    if (
        !record ||
        now - record.start >= RATE_WINDOW_MS
    ) {

        record = {
            start: now,
            count: 0
        };

        rateMap.set(
            ip,
            record
        );
    }

    record.count++;

    if (
        record.count > RATE_LIMIT
    ) {

        return res
            .status(429)
            .json({
                success: false,
                error:
                    "Too many requests. Please try again shortly."
            });
    }

    next();
}

app.use(
    "/api",
    rateLimit
);

/* Cleanup old rate entries */

setInterval(
    () => {

        const now =
            Date.now();

        for (
            const [
                ip,
                record
            ]
            of rateMap.entries()
        ) {

            if (
                now - record.start >
                RATE_WINDOW_MS * 2
            ) {

                rateMap.delete(ip);

            }
        }

    },
    5 * 60 * 1000
);

/* =========================================================
   MEMORY CACHE
========================================================= */

const memoryCache = {

    dates: new Map(),

    upcoming: {
        key: null,
        data: null,
        expires: 0
    }

};

/* =========================================================
   DISK CACHE
   Useful as stale fallback.

   NOTE:
   On Render Free, local disk can be lost after restart.
========================================================= */

function loadDiskCache() {

    try {

        if (
            !fs.existsSync(cacheFile)
        ) {

            return {
                dates: {},
                upcoming: null
            };
        }

        const raw =
            fs.readFileSync(
                cacheFile,
                "utf8"
            );

        const data =
            JSON.parse(raw);

        return {
            dates:
                data.dates || {},

            upcoming:
                data.upcoming || null
        };

    } catch (error) {

        console.error(
            "CACHE LOAD ERROR:",
            error.message
        );

        return {
            dates: {},
            upcoming: null
        };
    }
}

function saveDiskCache(
    data
) {

    try {

        fs.writeFileSync(
            cacheFile,
            JSON.stringify(
                data,
                null,
                2
            ),
            "utf8"
        );

    } catch (error) {

        console.error(
            "CACHE SAVE ERROR:",
            error.message
        );
    }
}

let diskCache =
    loadDiskCache();

/* =========================================================
   DATE HELPERS
========================================================= */

function getBDDate(
    offset = 0
) {

    const now =
        new Date();

    const parts =
        new Intl.DateTimeFormat(
            "en-CA",
            {
                timeZone:
                    BD_TIMEZONE,

                year:
                    "numeric",

                month:
                    "2-digit",

                day:
                    "2-digit"
            }
        )
        .formatToParts(now);

    let year;
    let month;
    let day;

    for (
        const part of parts
    ) {

        if (
            part.type === "year"
        ) {
            year =
                Number(part.value);
        }

        if (
            part.type === "month"
        ) {
            month =
                Number(part.value);
        }

        if (
            part.type === "day"
        ) {
            day =
                Number(part.value);
        }
    }

    const date =
        new Date(
            Date.UTC(
                year,
                month - 1,
                day
            )
        );

    date.setUTCDate(
        date.getUTCDate() +
        offset
    );

    return date
        .toISOString()
        .slice(0, 10);
}

function getBDDateTime(
    dateString
) {

    if (!dateString) {
        return null;
    }

    return new Intl.DateTimeFormat(
        "en-BD",
        {
            timeZone:
                BD_TIMEZONE,

            year:
                "numeric",

            month:
                "short",

            day:
                "2-digit",

            hour:
                "2-digit",

            minute:
                "2-digit",

            hour12:
                true
        }
    ).format(
        new Date(dateString)
    );
}

/* =========================================================
   MATCH STATUS HELPERS
========================================================= */

function getStatus(
    match
) {

    return (
        match?.fixture?.status?.short ||
        match?.status?.short ||
        ""
    );
}

function isLive(
    match
) {

    return [
        "1H",
        "HT",
        "2H",
        "ET",
        "BT",
        "P",
        "LIVE"
    ].includes(
        getStatus(match)
    );
}

function isFinished(
    match
) {

    return [
        "FT",
        "AET",
        "PEN"
    ].includes(
        getStatus(match)
    );
}

function isScheduled(
    match
) {

    return [
        "NS",
        "TBD"
    ].includes(
        getStatus(match)
    );
}

function isCancelled(
    match
) {

    return [
        "CANC",
        "PST",
        "ABD",
        "AWD",
        "WO"
    ].includes(
        getStatus(match)
    );
}

/* =========================================================
   MATCH UTILS
========================================================= */

function uniqueMatches(
    matches
) {

    const map =
        new Map();

    for (
        const match of matches
    ) {

        const id =
            match?.fixture?.id;

        if (!id) {
            continue;
        }

        map.set(
            String(id),
            match
        );
    }

    return Array.from(
        map.values()
    );
}

function sortMatches(
    matches
) {

    return matches.sort(
        (
            a,
            b
        ) => {

            const aTime =
                new Date(
                    a?.fixture?.date || 0
                ).getTime();

            const bTime =
                new Date(
                    b?.fixture?.date || 0
                ).getTime();

            return (
                aTime - bTime
            );
        }
    );
}

/* =========================================================
   GENERIC HTTP JSON
========================================================= */

async function requestJSON(
    url,
    options = {}
) {

    const response =
        await fetch(
            url,
            {
                ...options,

                signal:
                    AbortSignal.timeout(
                        15000
                    )
            }
        );

    let data = {};

    try {

        data =
            await response.json();

    } catch {

        data = {};

    }

    return {
        response,
        data
    };
}

/* =========================================================
   API-FOOTBALL
========================================================= */

async function fetchApiFootball(
    date
) {

    if (!API_FOOTBALL_KEY) {

        throw new Error(
            "API-Football key is not configured."
        );
    }

    const url =
        new URL(
            API_FOOTBALL_BASE +
            "/fixtures"
        );

    url.searchParams.set(
        "date",
        date
    );

    url.searchParams.set(
        "timezone",
        BD_TIMEZONE
    );

    const {
        response,
        data
    } =
        await requestJSON(
            url.toString(),
            {
                headers: {
                    "x-apisports-key":
                        API_FOOTBALL_KEY,

                    Accept:
                        "application/json"
                }
            }
        );

    if (
        data?.errors &&
        Object.keys(
            data.errors
        ).length > 0
    ) {

        throw new Error(
            JSON.stringify(
                data.errors
            )
        );
    }

    if (
        !response.ok
    ) {

        throw new Error(
            data?.message ||
            `API-Football HTTP ${response.status}`
        );
    }

    const matches =
        Array.isArray(
            data?.response
        )
            ? data.response
            : [];

    return {
        provider:
            "API-Football",

        matches
    };
}

/* =========================================================
   FOOTBALL-DATA.ORG
========================================================= */

async function fetchFootballData(
    date
) {

    if (!FOOTBALL_DATA_TOKEN) {

        throw new Error(
            "football-data.org token is not configured."
        );
    }

    const url =
        new URL(
            FOOTBALL_DATA_BASE +
            "/matches"
        );

    /*
      football-data.org uses dateFrom/dateTo.
      We query the requested UTC calendar day.
    */

    url.searchParams.set(
        "dateFrom",
        date
    );

    url.searchParams.set(
        "dateTo",
        date
    );

    const {
        response,
        data
    } =
        await requestJSON(
            url.toString(),
            {
                headers: {
                    "X-Auth-Token":
                        FOOTBALL_DATA_TOKEN,

                    Accept:
                        "application/json"
                }
            }
        );

    if (
        !response.ok
    ) {

        throw new Error(
            data?.message ||
            data?.error ||
            `football-data.org HTTP ${response.status}`
        );
    }

    return {
        provider:
            "football-data.org",

        matches:
            normalizeFootballData(
                data?.matches || []
            )
    };
}

/* =========================================================
   NORMALIZE FOOTBALL-DATA.ORG
========================================================= */

function normalizeFootballData(
    matches
) {

    return matches.map(
        match => {

            const status =
                normalizeFootballDataStatus(
                    match.status
                );

            const home =
                match.homeTeam || {};

            const away =
                match.awayTeam || {};

            const fullTime =
                match.score?.fullTime || {};

            const utcDate =
                match.utcDate;

            return {

                fixture: {

                    id:
                        match.id,

                    date:
                        utcDate,

                    status: {

                        short:
                            status,

                        long:
                            match.status ||
                            status,

                        elapsed:
                            calculateElapsed(
                                utcDate,
                                status
                            )
                    }
                },

                league: {

                    id:
                        match.competition?.id ||
                        null,

                    name:
                        match.competition?.name ||
                        "Football",

                    country:
                        match.area?.name ||
                        "",

                    logo:
                        match.competition?.emblem ||
                        "",

                    season:
                        null
                },

                teams: {

                    home: {

                        id:
                            home.id ||
                            null,

                        name:
                            home.name ||
                            "Home",

                        logo:
                            home.crest ||
                            ""
                    },

                    away: {

                        id:
                            away.id ||
                            null,

                        name:
                            away.name ||
                            "Away",

                        logo:
                            away.crest ||
                            ""
                    }
                },

                goals: {

                    home:
                        fullTime.home ??
                        null,

                    away:
                        fullTime.away ??
                        null
                },

                sourceProvider:
                    "football-data.org"
            };
        }
    );
}

function normalizeFootballDataStatus(
    status
) {

    switch (
        status
    ) {

        case "FINISHED":
            return "FT";

        case "IN_PLAY":
            return "LIVE";

        case "PAUSED":
            return "HT";

        case "POSTPONED":
        case "SUSPENDED":
        case "CANCELLED":
            return "PST";

        default:
            return "NS";
    }
}

function calculateElapsed(
    dateString,
    status
) {

    if (
        ![
            "LIVE",
            "HT"
        ].includes(status)
    ) {

        return null;
    }

    const start =
        new Date(
            dateString
        ).getTime();

    if (
        !Number.isFinite(start)
    ) {

        return null;
    }

    return Math.max(
        0,
        Math.floor(
            (
                Date.now() -
                start
            ) /
            60000
        )
    );
}

/* =========================================================
   PROVIDER FALLBACK
========================================================= */

async function fetchMatches(
    date
) {

    let firstError =
        null;

    /*
      Priority 1:
      API-Football
    */

    if (
        API_FOOTBALL_KEY
    ) {

        try {

            return await fetchApiFootball(
                date
            );

        } catch (error) {

            firstError =
                error;

            console.error(
                "API-Football failed:",
                error.message
            );
        }
    }

    /*
      Priority 2:
      football-data.org
    */

    if (
        FOOTBALL_DATA_TOKEN
    ) {

        try {

            return await fetchFootballData(
                date
            );

        } catch (error) {

            console.error(
                "football-data.org failed:",
                error.message
            );
        }
    }

    throw new Error(
        firstError
            ? firstError.message
            : "No football API is configured."
    );
}

/* =========================================================
   CACHE SAVE
========================================================= */

function persistCache() {

    const dates = {};

    for (
        const [
            key,
            value
        ]
        of memoryCache.dates.entries()
    ) {

        dates[key] =
            value;
    }

    diskCache = {

        dates,

        upcoming:
            memoryCache.upcoming

    };

    saveDiskCache(
        diskCache
    );
}

/* =========================================================
   DATE FETCH WITH STALE FALLBACK
========================================================= */

async function getMatchesForDate(
    date,
    force = false
) {

    const now =
        Date.now();

    const memory =
        memoryCache.dates.get(
            date
        );

    /*
      Fresh memory cache
    */

    if (
        !force &&
        memory &&
        memory.data &&
        memory.expires > now
    ) {

        return {

            matches:
                memory.data,

            provider:
                memory.provider,

            cached:
                true,

            stale:
                false

        };
    }

    /*
      Try API providers
    */

    try {

        const result =
            await fetchMatches(
                date
            );

        memoryCache.dates.set(
            date,
            {

                data:
                    result.matches,

                provider:
                    result.provider,

                expires:
                    now +
                    DATE_CACHE_MS

            }
        );

        persistCache();

        return {

            matches:
                result.matches,

            provider:
                result.provider,

            cached:
                false,

            stale:
                false

        };

    } catch (error) {

        /*
          Try memory stale cache first.
        */

        if (
            memory &&
            Array.isArray(
                memory.data
            )
        ) {

            return {

                matches:
                    memory.data,

                provider:
                    memory.provider,

                cached:
                    true,

                stale:
                    true

            };
        }

        /*
          Try disk stale cache.
        */

        const disk =
            diskCache
                ?.dates
                ?.
                [date];

        if (
            disk &&
            Array.isArray(
                disk.data
            )
        ) {

            return {

                matches:
                    disk.data,

                provider:
                    disk.provider,

                cached:
                    true,

                stale:
                    true

            };
        }

        throw error;
    }
}

/* =========================================================
   STATUS ENDPOINT
========================================================= */

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            success:
                true,

            server:
                "DreamLive",

            timezone:
                BD_TIMEZONE,

            today:
                getBDDate(),

            providers: {

                apiFootball:
                    Boolean(
                        API_FOOTBALL_KEY
                    ),

                footballData:
                    Boolean(
                        FOOTBALL_DATA_TOKEN
                    )

            },

            cacheDates:
                memoryCache
                    .dates
                    .size,

            time:
                new Date().toISOString()

        });
    }
);

/* =========================================================
   LIVE
========================================================= */

app.get(
    "/api/live",
    async (req, res) => {

        try {

            const today =
                getBDDate();

            const result =
                await getMatchesForDate(
                    today,
                    req.query.refresh === "1"
                );

            const matches =
                result.matches.filter(
                    isLive
                );

            res.json({

                success:
                    true,

                source:
                    result.provider,

                date:
                    today,

                timezone:
                    BD_TIMEZONE,

                results:
                    matches.length,

                response:
                    matches,

                cached:
                    result.cached,

                stale:
                    result.stale

            });

        } catch (error) {

            console.error(
                "LIVE ERROR:",
                error.message
            );

            res.status(503).json({

                success:
                    false,

                error:
                    error.message

            });
        }
    }
);

/* =========================================================
   TODAY
========================================================= */

app.get(
    "/api/today",
    async (req, res) => {

        try {

            const today =
                getBDDate();

            const result =
                await getMatchesForDate(
                    today,
                    req.query.refresh === "1"
                );

            const matches =
                result.matches.filter(
                    match => {

                        if (
                            isCancelled(match)
                        ) {

                            return false;
                        }

                        /*
                          Live is displayed
                          in Live section,
                          not Today.
                        */

                        if (
                            isLive(match)
                        ) {

                            return false;
                        }

                        return (
                            isFinished(match) ||
                            isScheduled(match)
                        );
                    }
                );

            sortMatches(
                matches
            );

            res.json({

                success:
                    true,

                source:
                    result.provider,

                date:
                    today,

                timezone:
                    BD_TIMEZONE,

                results:
                    matches.length,

                response:
                    matches,

                cached:
                    result.cached,

                stale:
                    result.stale

            });

        } catch (error) {

            console.error(
                "TODAY ERROR:",
                error.message
            );

            res.status(503).json({

                success:
                    false,

                error:
                    error.message

            });
        }
    }
);

/* =========================================================
   UPCOMING
   TODAY + NEXT 2 DAYS
========================================================= */

app.get(
    "/api/upcoming",
    async (req, res) => {

        const today =
            getBDDate();

        const force =
            req.query.refresh === "1";

        const now =
            Date.now();

        /*
          Fresh upcoming cache
        */

        if (
            !force &&
            memoryCache.upcoming.key === today &&
            memoryCache.upcoming.data &&
            memoryCache.upcoming.expires > now
        ) {

            return res.json({

                ...memoryCache.upcoming.data,

                cached:
                    true,

                stale:
                    false

            });
        }

        try {

            const all = [];

            let provider =
                null;

            let stale =
                false;

            /*
              0 = today
              1 = tomorrow
              2 = day after tomorrow
            */

            for (
                let i = 0;
                i <= 2;
                i++
            ) {

                const date =
                    getBDDate(i);

                try {

                    const result =
                        await getMatchesForDate(
                            date,
                            force
                        );

                    provider =
                        provider ||
                        result.provider;

                    if (
                        result.stale
                    ) {

                        stale =
                            true;
                    }

                    const scheduled =
                        result.matches.filter(
                            match => {

                                return (
                                    isScheduled(match) &&
                                    !isLive(match) &&
                                    !isFinished(match) &&
                                    !isCancelled(match)
                                );
                            }
                        );

                    all.push(
                        ...scheduled
                    );

                } catch (error) {

                    console.error(
                        `UPCOMING ${date}:`,
                        error.message
                    );
                }
            }

            const upcoming =
                sortMatches(
                    uniqueMatches(
                        all
                    )
                );

            const data = {

                success:
                    true,

                source:
                    provider ||
                    "multiple",

                message:
                    "Upcoming matches loaded",

                from:
                    today,

                to:
                    getBDDate(2),

                timezone:
                    BD_TIMEZONE,

                results:
                    upcoming.length,

                response:
                    upcoming,

                stale

            };

            memoryCache.upcoming = {

                key:
                    today,

                data,

                expires:
                    now +
                    UPCOMING_CACHE_MS

            };

            persistCache();

            res.json({

                ...data,

                cached:
                    false

            });

        } catch (error) {

            /*
              Stale upcoming fallback.
            */

            const diskUpcoming =
                diskCache?.upcoming;

            if (
                diskUpcoming?.data
            ) {

                return res.json({

                    ...diskUpcoming.data,

                    cached:
                        true,

                    stale:
                        true

                });
            }

            res.status(503).json({

                success:
                    false,

                error:
                    error.message

            });
        }
    }
);

/* =========================================================
   MATCH DETAILS - API FOOTBALL
========================================================= */

app.get(
    "/api/match/:id",
    async (req, res) => {

        const id =
            req.params.id;

        if (
            !API_FOOTBALL_KEY
        ) {

            return res.status(503).json({

                success:
                    false,

                error:
                    "Match details require API-Football."

            });
        }

        try {

            const url =
                new URL(
                    API_FOOTBALL_BASE +
                    "/fixtures"
                );

            url.searchParams.set(
                "id",
                id
            );

            url.searchParams.set(
                "timezone",
                BD_TIMEZONE
            );

            const {
                response,
                data
            } =
                await requestJSON(
                    url.toString(),
                    {
                        headers: {
                            "x-apisports-key":
                                API_FOOTBALL_KEY
                        }
                    }
                );

            res
                .status(
                    response.status
                )
                .json(
                    data
                );

        } catch (error) {

            res.status(503).json({

                success:
                    false,

                error:
                    error.message

            });

        }
    }
);

/* =========================================================
   LINEUPS
========================================================= */

app.get(
    "/api/match/:id/lineups",
    async (req, res) => {

        if (
            !API_FOOTBALL_KEY
        ) {

            return res.status(503).json({

                success:
                    false,

                error:
                    "Lineups require API-Football."

            });
        }

        try {

            const url =
                new URL(
                    API_FOOTBALL_BASE +
                    "/fixtures/lineups"
                );

            url.searchParams.set(
                "fixture",
                req.params.id
            );

            const {
                response,
                data
            } =
                await requestJSON(
                    url.toString(),
                    {
                        headers: {
                            "x-apisports-key":
                                API_FOOTBALL_KEY
                        }
                    }
                );

            res
                .status(
                    response.status
                )
                .json(
                    data
                );

        } catch (error) {

            res.status(503).json({

                success:
                    false,

                error:
                    error.message

            });

        }
    }
);

/* =========================================================
   H2H
   Query usage:
   /api/h2h?team1=ID&team2=ID
========================================================= */

app.get(
    "/api/h2h",
    async (req, res) => {

        if (
            !API_FOOTBALL_KEY
        ) {

            return res.status(503).json({

                success:
                    false,

                error:
                    "H2H requires API-Football."

            });
        }

        const team1 =
            req.query.team1;

        const team2 =
            req.query.team2;

        if (
            !team1 ||
            !team2
        ) {

            return res.status(400).json({

                success:
                    false,

                error:
                    "team1 and team2 are required."

            });
        }

        try {

            const url =
                new URL(
                    API_FOOTBALL_BASE +
                    "/fixtures/headtohead"
                );

            url.searchParams.set(
                "h2h",
                `${team1}-${team2}`
            );

            const {
                response,
                data
            } =
                await requestJSON(
                    url.toString(),
                    {
                        headers: {
                            "x-apisports-key":
                                API_FOOTBALL_KEY
                        }
                    }
                );

            res
                .status(
                    response.status
                )
                .json(
                    data
                );

        } catch (error) {

            res.status(503).json({

                success:
                    false,

                error:
                    error.message

            });

        }
    }
);

/* =========================================================
   VIDEO UPLOAD
========================================================= */

const storage =
    multer.diskStorage({

        destination:
            (req, file, cb) => {

                cb(
                    null,
                    uploadsDir
                );
            },

        filename:
            (req, file, cb) => {

                const ext =
                    path.extname(
                        file.originalname
                    );

                const base =
                    path.basename(
                        file.originalname,
                        ext
                    )
                    .replace(
                        /[^a-zA-Z0-9-_]/g,
                        "_"
                    )
                    .slice(
                        0,
                        80
                    );

                cb(
                    null,
                    `${Date.now()}-${base}${ext}`
                );
            }
    });

const upload =
    multer({

        storage,

        limits: {

            fileSize:
                MAX_UPLOAD_BYTES

        },

        fileFilter:
            (req, file, cb) => {

                const allowed =
                    [
                        "video/mp4",
                        "video/webm",
                        "video/ogg",
                        "video/quicktime"
                    ];

                if (
                    allowed.includes(
                        file.mimetype
                    )
                ) {

                    cb(
                        null,
                        true
                    );

                } else {

                    cb(
                        new Error(
                            "Only MP4, WebM, OGG and MOV video files are allowed."
                        )
                    );
                }
            }
    });

/* Upload endpoint */

app.post(
    "/api/upload",
    upload.single("video"),
    (req, res) => {

        try {

            if (
                !req.file
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Please select a video."

                });
            }

            const video =
                "/uploads/" +
                encodeURIComponent(
                    req.file.filename
                );

            res.json({

                success:
                    true,

                video,

                filename:
                    req.file.originalname

            });

        } catch (error) {

            res.status(500).json({

                success:
                    false,

                error:
                    error.message

            });
        }
    }
);

/* =========================================================
   API 404
========================================================= */

app.use(
    "/api",
    (req, res) => {

        res.status(404).json({

            success:
                false,

            error:
                "API endpoint not found."

        });
    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (error, req, res, next) => {

        console.error(
            "SERVER ERROR:",
            error.message
        );

        res.status(400).json({

            success:
                false,

            error:
                error.message ||
                "Something went wrong."

        });
    }
);

/* =========================================================
   HOME PAGE
========================================================= */

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                wwwDir,
                "index.html"
            ),
            error => {

                if (
                    error &&
                    !res.headersSent
                ) {

                    res.status(500).send(
                        "DreamLive frontend could not be loaded."
                    );
                }

            }
        );
    }
);

/* =========================================================
   START
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `DreamLive running on port ${PORT}`
        );

    }
);