const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

// In-memory store for session cookies (since we aren't using a DB)
const sessionStore = {};

// Target Portal URL
const TARGET_URL = '';

/**
 * STEP 1: Fetch CAPTCHA and initialize a tracking session
 */
app.get('/api/captcha', async (req, res) => {
    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });

        const captchaSelector = '#captchaImage'; 
        await page.waitForSelector(captchaSelector);
        const captchaElement = await page.$(captchaSelector);
        
        const captchaBuffer = await captchaElement.screenshot();
        const captchaBase64 = captchaBuffer.toString('base64');

        const cookies = await page.cookies();
        const sessionId = crypto.randomUUID();
        sessionStore[sessionId] = cookies; 

        await browser.close();

        res.json({
            sessionId: sessionId,
            captchaImage: `data:image/png;base64,${captchaBase64}`
        });

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: 'Failed to fetch Captcha', details: error.message });
    }
});

/**
 * STEP 2: Re-attach session, submit credentials, and scrape results
 */
app.post('/api/login-and-scrape', async (req, res) => {
    const { enrollmentNumber, password, captchaText, sessionId } = req.body;

    // 1. Basic payload validation
    if (!enrollmentNumber || !password || !captchaText || !sessionId) {
        return res.status(400).json({ error: 'Missing required parameters in request body.' });
    }

    // 2. Retrieve saved cookies from your in-memory store
    const cookies = sessionStore[sessionId];
    if (!cookies) {
        return res.status(400).json({ error: 'Invalid or expired session ID.' });
    }

    let browser;
    try {
        // 3. Launch browser instance
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        // 4. Inject the cookies from the previous CAPTCHA session
        await page.setCookie(...cookies);

        // 5. Navigate to the login portal page
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });

        // === DIAGNOSTIC LOG START ===
        // This will spy on the page and dump all input attributes to your terminal
        const pageElements = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input, select, button')).map(el => ({
                tagName: el.tagName,
                id: el.id ? `#${el.id}` : 'No ID',
                name: el.name ? `input[name="${el.name}"]` : 'No Name',
                type: el.type || ''
            }));
        });
        console.log("🔍 [DIAGNOSTIC] All active elements discovered on GGSIPU page:");
        console.table(pageElements);
        // === DIAGNOSTIC LOG END ===

        // 6. ACTUAL TARGET SELECTORS (Updated from image_a0d1fe.png)
const usernameSelector = '#username';       // Changed from '#txtUser'
const passwordSelector = '#password';       // Most likely ID inside the 2nd input-group
const captchaInputSelector = '#captcha';     // Most likely ID or class inside captcha-group
const loginButtonSelector = 'button[type="submit"]'; // Forms usually use a submit button, or check the ID inside action-group
const errorSelector = '.error-message';     // Check what class/id pops up if login fails

        // 7. Wait for the page form to become active and populate fields dynamically
        await page.waitForSelector(usernameSelector);
        await page.type(usernameSelector, enrollmentNumber);
        await page.type(passwordSelector, password);
        await page.type(captchaInputSelector, captchaText);

        // 8. Click login and wait for the resulting page to load completely
        await Promise.all([
            page.click(loginButtonSelector),
            page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);

        // 9. Check if a validation error message/banner appeared on screen
        const errorElement = await page.$(errorSelector);
        if (errorElement) {
            const errorText = await page.evaluate(el => el.textContent.trim(), errorElement);
            if (errorText) {
                await browser.close();
                return res.status(400).json({ error: 'Login validation failed', details: errorText });
            }
        }

        // 10. Grab the raw HTML content and shut down the browser to save memory
        const html = await page.content();
        await browser.close();

        // 11. Feed the raw HTML structure into Cheerio for parsing
        const $ = cheerio.load(html);
        const scrapedData = [];

        // Generic table row selector (Update this to target the result tables)
        const tableRowsSelector = 'table tr'; 
        
        $(tableRowsSelector).each((index, element) => {
            if (index === 0) return; // Skip headers

            const columns = $(element).find('td');
            if (columns.length >= 5) {
                scrapedData.push({
                    subjectName: $(columns[0]).text().trim(),
                    subjectCode: $(columns[1]).text().trim(),
                    internalMarks: $(columns[2]).text().trim(),
                    externalMarks: $(columns[3]).text().trim(),
                    subjectCredits: $(columns[4]).text().trim()
                });
            }
        });

        // 12. Housekeeping: Remove session cookies from store if no longer required
        delete sessionStore[sessionId];

        // 13. Deliver the extracted array data back to your client
        res.json({
            success: true,
            data: scrapedData
        });

    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: 'An error occurred during processing', details: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});