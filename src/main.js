import { Actor } from 'apify';
import { PuppeteerCrawler } from 'crawlee';
import sanitizeHtml from 'sanitize-html';
import crypto from 'crypto';

await Actor.init();

// Getting user input
const input = await Actor.getInput() || {};
const {
     platforms = ['x'],
    keywords = ['artificial intelligence'],
    maxRecords = 1000,
    includeImages = true,
    minTextLength = 50,
} = input;



// Build starting URLs
const startUrls = [];
for (const platform of platforms) {
    for (const keyword of keywords) {
        if (platform === 'reddit') {
            startUrls.push({
                url: `https://www.reddit.com/search/?q=${encodeURIComponent(keyword)}&sort=top`,
                userData: { platform: 'reddit', keyword },
            });
        } else if (platform === 'x') {
            startUrls.push({
                url: `https://twitter.com/search?q=${encodeURIComponent(keyword)}&src=typed_query`,
                userData: { platform: 'twitter', keyword },
            });
        } else if (platform === 'news') {
            startUrls.push({
                url: `https://news.google.com/search?q=${encodeURIComponent(keyword)}`,
                userData: { platform: 'news', keyword },
            });
        } else if (platform === 'hackernews') {
                startUrls.push({
        url: `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=50`,
        userData: { platform: 'hackernews', keyword },
    });

        }
    }
}

let recordCount = 0;
const seenHashes = new Set();

const crawler = new PuppeteerCrawler({
    async requestHandler({ request, page, log }) {
        // Set proper headers to look like a real browser
        await page.setExtraHTTPHeaders({
            'Accept': 'application/json, text/html',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        if (recordCount >= maxRecords) {
            log.info('Max records reached, stopping...');
            return;
        }

        const { platform, keyword } = request.userData;
        log.info(`Scraping ${platform} for "${keyword}"`);

        let results = [];

        try {
            if (platform === 'reddit') {
                results = await scrapeReddit(page, includeImages);
            } else if (platform === 'twitter') {
                results = await scrapeTwitter(page, includeImages);
            } else if (platform === 'news') {
                results = await scrapeNews(page);
            }else if (platform === 'hackernews') {
                results = await scrapeHackerNews(page);
            } else {
                log.warning(`Unsupported platform: ${platform}`);
                return;
            }

            log.info(`Scraped ${results.length} items from ${platform}`);   

            // Filter and deduplicate
            results = results
                .filter(item => item.text?.content && item.text.content.length >= minTextLength)
                .filter(item => {
                    const hash = hashContent(item.text.content);
                    if (seenHashes.has(hash)) return false;
                    seenHashes.add(hash);
                    return true;
                });

            // Save to dataset
            for (const item of results) {
                if (recordCount >= maxRecords) break;
                
                await Actor.pushData({
                    ...item,
                    keyword,
                    scraped_at: new Date().toISOString(),
                });
                
                recordCount++;
            }

            log.info(`Collected ${results.length} records. Total: ${recordCount}/${maxRecords}`);

        } catch (error) {
            log.error(`Error scraping ${platform}:`, error);
        }
    },
    maxRequestsPerCrawl: startUrls.length * 5,
    maxConcurrency: 1, // Changed to 1 for reliability
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled' // Hide automation
            ],
        },
    },
});

await crawler.run(startUrls);

console.log(`\n✅ Scraping completed! Total records collected: ${recordCount}`);

await Actor.exit();

// ==================== SCRAPING FUNCTIONS ====================



async function scrapeReddit(page, includeImages) {
    console.log('📥 Fetching Reddit JSON data...');
    
    // Get the JSON content from the page
    const content = await page.content();
    
    // The browser shows JSON in a <pre> tag, so let's extract it
    const jsonData = await page.evaluate(() => {
        const preTag = document.querySelector('pre');
        if (preTag) {
            return preTag.textContent;
        }
        return document.body.textContent;
    });
    
    console.log(`📄 Received ${jsonData.length} characters of JSON`);
    
    try {
        const data = JSON.parse(jsonData);
        const results = [];
        
        // Reddit's JSON structure: data.data.children contains the posts
        if (data.data && data.data.children) {
            const posts = data.data.children;
            console.log(`✅ Found ${posts.length} posts in JSON`);
            
            posts.forEach((item, index) => {
                const post = item.data;
                
                // Skip if no title
                if (!post.title) return;
                
                // Build full text
                const fullText = post.selftext ? 
                    `${post.title}\n\n${post.selftext}` : 
                    post.title;
                
                // Get images
                const images = [];
                if (includeImages) {
                    if (post.preview && post.preview.images) {
                        post.preview.images.forEach(img => {
                            if (img.source && img.source.url) {
                                // Decode HTML entities in URL
                                const imageUrl = img.source.url.replace(/&amp;/g, '&');
                                images.push(imageUrl);
                            }
                        });
                    }
                    // Also check for direct image URLs
                    if (post.url && (post.url.includes('.jpg') || post.url.includes('.png'))) {
                        images.push(post.url);
                    }
                }
                
                results.push({
                    id: `reddit_${post.id}`,
                    source: 'reddit',
                    url: `https://reddit.com${post.permalink}`,
                    content_type: images.length > 0 ? 'text_image' : 'text',
                    text: {
                        title: post.title,
                        content: fullText,
                    },
                    media: {
                        images: images.slice(0, 5),
                    },
                    metadata: {
                        subreddit: post.subreddit_name_prefixed || `r/${post.subreddit}`,
                        score: post.score,
                        author: post.author,
                        comments: post.num_comments,
                        created: new Date(post.created_utc * 1000).toISOString(),
                        has_images: images.length > 0,
                    },
                });
            });
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Error parsing Reddit JSON:', error.message);
        console.log('First 500 chars:', jsonData.substring(0, 500));
        return [];
    }
}

async function scrapeHackerNews(page) {
    console.log('📥 Fetching HackerNews data...');
    
    const jsonData = await page.evaluate(() => {
        const preTag = document.querySelector('pre');
        if (preTag) return preTag.textContent;
        return document.body.textContent;
    });
    
    console.log(`📄 Received ${jsonData.length} characters`);
    
    try {
        const data = JSON.parse(jsonData);
        const results = [];
        
        if (data.hits && Array.isArray(data.hits)) {
            console.log(`✅ Found ${data.hits.length} HackerNews stories`);
            
            data.hits.forEach((hit) => {
                if (!hit.title) return;
                
                const text = hit.story_text || hit.title;
                
                results.push({
                    id: `hn_${hit.objectID}`,
                    source: 'hackernews',
                    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
                    content_type: 'text',
                    text: {
                        title: hit.title,
                        content: text,
                    },
                    media: {
                        images: [],
                    },
                    metadata: {
                        author: hit.author,
                        points: hit.points || 0,
                        comments: hit.num_comments || 0,
                        created: hit.created_at,
                    },
                });
            });
        }
        
        return results;
        
    } catch (error) {
        console.error('❌ Error parsing HackerNews JSON:', error.message);
        return [];
    }
}
async function scrapeTwitter(page, includeImages) {
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 10000 });
    
    return await page.evaluate((includeImages) => {
        const results = [];
        const tweets = document.querySelectorAll('article[data-testid="tweet"]');
        
        tweets.forEach((tweet, index) => {
            if (index >= 20) return;
            
            try {
                const textEl = tweet.querySelector('[data-testid="tweetText"]');
                const authorEl = tweet.querySelector('[data-testid="User-Name"]');
                const timeEl = tweet.querySelector('time');
                
                const text = textEl?.textContent?.trim() || '';
                if (!text) return;
                
                const images = includeImages ?
                    Array.from(tweet.querySelectorAll('img[src*="pbs.twimg.com/media"]'))
                        .map(img => img.src)
                        .slice(0, 4) : [];
                
                results.push({
                    id: `twitter_${Date.now()}_${index}`,
                    source: 'twitter',
                    url: window.location.href,
                    content_type: images.length > 0 ? 'text_image' : 'text',
                    text: {
                        content: text,
                    },
                    media: {
                        images: images,
                    },
                    metadata: {
                        author: authorEl?.textContent?.trim() || '',
                        timestamp: timeEl?.getAttribute('datetime') || '',
                        has_images: images.length > 0,
                    },
                });
            } catch (err) {
                console.error('Error parsing tweet:', err);
            }
        });
        
        return results;
    }, includeImages);
}

async function scrapeNews(page) {
    await page.waitForSelector('article, .article', { timeout: 10000 });
    
    return await page.evaluate(() => {
        const results = [];
        const articles = document.querySelectorAll('article, .article');
        
        articles.forEach((article, index) => {
            if (index >= 15) return;
            
            try {
                const titleEl = article.querySelector('h2, h3, .title');
                const snippetEl = article.querySelector('p, .snippet, .description');
                const linkEl = article.querySelector('a');
                
                const title = titleEl?.textContent?.trim() || '';
                const snippet = snippetEl?.textContent?.trim() || '';
                const text = `${title}\n\n${snippet}`.trim();
                
                if (!text) return;
                
                results.push({
                    id: `news_${Date.now()}_${index}`,
                    source: 'news',
                    url: linkEl?.href || window.location.href,
                    content_type: 'text',
                    text: {
                        title: title,
                        content: snippet,
                    },
                    media: {
                        images: [],
                    },
                    metadata: {
                        source_site: new URL(linkEl?.href || window.location.href).hostname,
                    },
                });
            } catch (err) {
                console.error('Error parsing article:', err);
            }
        });
        
        return results;
    });
}

// ==================== UTILITY FUNCTIONS ====================

function hashContent(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}