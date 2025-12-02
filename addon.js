const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 7000;
const BASE_URL = 'https://whereyouwatch.com/latest-reports/';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/catalog/movie/top';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 60 days in milliseconds
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000; 

const manifest = {
    id: 'org.whereyouwatch.reports',
    version: '1.0.0',
    name: 'WhereYouWatch Reports',
    description: 'Latest releases from WhereYouWatch.com (Last 2 Months)',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
        {
            type: 'movie',
            id: 'wyw_reports',
            name: 'WhereYouWatch',
            extra: [{ name: 'skip' }]
        }
    ]
};

const builder = new addonBuilder(manifest);
let movieCatalog = [];
let lastStatus = "Initializing...";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseReleaseTitle(rawString) {
    const yearMatch = rawString.match(/(19|20)\d{2}/);
    if (yearMatch) {
        const yearIndex = yearMatch.index;
        let title = rawString.substring(0, yearIndex).trim();
        title = title.replace(/\./g, ' ').replace(/_/g, ' ');
        return { title: title, year: yearMatch[0] };
    }
    return { title: rawString, year: null };
}

function parseDate(dateString) {
    if (!dateString) return Date.now();
    const cleanDate = dateString.replace('Submitted on:', '').trim();
    return new Date(cleanDate).getTime();
}

async function resolveToImdb(title, year) {
    if (!year) return null;
    try {
        const query = `${title} ${year}`;
        const url = `${CINEMETA_URL}/search=${encodeURIComponent(query)}.json`;
        const { data } = await axios.get(url);
        if (data && data.metas && data.metas.length > 0) {
            return data.metas[0];
        }
    } catch (e) { return null; }
    return null;
}

async function scrapePages() {
    console.log('--- STARTING SCRAPE (WhereYouWatch) ---');
    lastStatus = "Scraping Page 1...";
    let allItems = [];
    let keepFetching = true;
    let page = 1;
    const cutoffDate = Date.now() - MAX_AGE_MS;

    try {
        while (keepFetching) {
            console.log(`> Fetching Page ${page}...`);
            const url = page === 1 ? BASE_URL : `${BASE_URL}page/${page}/`;
            try {
                const response = await axios.get(url, { headers: { 'User-Agent': USER_AGENT } });
                const $ = cheerio.load(response.data);
                let itemsFoundOnPage = 0;

                $('h2, h3, h4').each((i, el) => {
                    const rawTitle = $(el).text().trim();
                    const hasYear = rawTitle.match(/\d{4}/);
                    const hasQuality = rawTitle.includes('WEB') || rawTitle.includes('1080p') || rawTitle.includes('2160p') || rawTitle.includes('DVDRip');

                    if (hasYear && hasQuality) {
                        let container = $(el).parent();
                        let dateText = container.text().match(/Submitted on:\s*([A-Za-z]+\s\d{1,2},\s\d{4})/);
                        if (!dateText) dateText = container.parent().text().match(/Submitted on:\s*([A-Za-z]+\s\d{1,2},\s\d{4})/);

                        if (dateText) {
                            const dateStr = dateText[1];
                            const dateTs = parseDate(dateStr);
                            if (dateTs < cutoffDate) {
                                console.log(`> Reached limit: ${dateStr}`);
                                keepFetching = false;
                                return false; 
                            }
                            itemsFoundOnPage++;
                            allItems.push({ rawTitle: rawTitle, date: dateTs });
                        }
                    }
                });

                if (itemsFoundOnPage === 0 && page > 1) keepFetching = false;
                page++;
                if (keepFetching) await delay(2000);
                if (page > 15) keepFetching = false;

            } catch (err) {
                console.error(`Error fetching page ${page}: ${err.message}`);
                keepFetching = false;
            }
        }

        console.log(`> Found ${allItems.length} reports. Matching IMDb...`);
        lastStatus = `Processing ${allItems.length} items...`;
        const newCatalog = [];

        for (const item of allItems) {
            const parsed = parseReleaseTitle(item.rawTitle);
            const imdbItem = await resolveToImdb(parsed.title, parsed.year);

            if (imdbItem) {
                newCatalog.push({
                    id: imdbItem.id,
                    type: 'movie',
                    name: imdbItem.name,
                    poster: `https://images.metahub.space/poster/medium/${imdbItem.id}/img`,
                    description: `Release: ${item.rawTitle}\nMatched: ${imdbItem.name}`,
                    releaseInfo: imdbItem.releaseInfo
                });
            } else {
                newCatalog.push({
                    id: `wyw_${parsed.title.replace(/\s/g, '')}_${parsed.year || '0000'}`,
                    type: 'movie',
                    name: parsed.title,
                    poster: null,
                    description: `Unmatched Release: ${item.rawTitle}`,
                    releaseInfo: parsed.year || '????'
                });
            }
        }

        const uniqueCatalog = [];
        const seenIds = new Set();
        for (const item of newCatalog) {
            if (!seenIds.has(item.id)) {
                seenIds.add(item.id);
                uniqueCatalog.push(item);
            }
        }

        movieCatalog = uniqueCatalog;
        lastStatus = "Ready";
        console.log(`> Update Complete. Catalog size: ${movieCatalog.length}`);

    } catch (error) {
        console.error('! Critical Error:', error.message);
        lastStatus = `Error: ${error.message}`;
    }
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (movieCatalog.length === 0) {
        return {
            metas: [{
                id: 'tt_status',
                type: 'movie',
                name: `Status: ${lastStatus}`,
                description: "Please wait for the server to fetch data.",
                poster: 'https://via.placeholder.com/300x450.png?text=Loading...',
            }]
        };
    }
    if (type === 'movie' && id === 'wyw_reports') {
        const skip = extra.skip ? parseInt(extra.skip) : 0;
        return { metas: movieCatalog.slice(skip, skip + 100) };
    }
    return { metas: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
scrapePages();
setInterval(scrapePages, 120 * 60 * 1000); 
console.log(`Addon running on http://localhost:${PORT}`);
