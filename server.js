    const express = require('express');
    const puppeteer = require('puppeteer');
    const crypto = require('crypto');
    const cheerio = require('cheerio');

    // Import the Math Engine
    const { calculateResults } = require('./cgpaCalculator');

    const app = express();
    app.use(express.json());
    app.use(express.static('public'));

    const sessionStore = {};
    const TARGET_URL = 'https://examweb.ggsipu.ac.in/web/login.jsp';

    /**
     * STEP 1: Fetch CAPTCHA and keep the browser instance alive
     */
    /**
     * STEP 1: Fetch CAPTCHA and keep the browser instance alive
     */
    app.get('/api/captcha', async (req, res) => {
        let browser;
        try {
            browser = await puppeteer.launch({ headless: true });
            const page = await browser.newPage();
            
            await page.goto(TARGET_URL.trim(), { waitUntil: 'networkidle2' });

            // FIXED: We are now targeting the actual image tag, not the input box.
            // If '#captchaImage' doesn't work, try 'img[src*="captcha"]' which grabs any image with "captcha" in its source link.
            const captchaImageSelector = '#captchaImage'; 
            
            await page.waitForSelector(captchaImageSelector);
            const captchaElement = await page.$(captchaImageSelector);
            
            const captchaBuffer = await captchaElement.screenshot();
            const captchaBase64 = captchaBuffer.toString('base64');

            const sessionId = crypto.randomUUID();
            sessionStore[sessionId] = { browser, page }; 

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
     * STEP 2: Use the existing live page to fill details, select semester, and submit
     */
    app.post('/api/login-and-scrape', async (req, res) => {
        // NOTE: Added 'semester' to the destructured body parameters
        const { enrollmentNumber, password, captchaText, sessionId, semester } = req.body;


        if (!enrollmentNumber || !password || !captchaText || !sessionId) {
            return res.status(400).json({ error: 'Missing required parameters.' });
        }

        const session = sessionStore[sessionId];
        if (!session) {
            return res.status(400).json({ error: 'Invalid or expired session ID.' });
        }

        const { browser, page } = session;

        try {
            const usernameSelector = '#username';       
            const passwordSelector = '#passwd';         
            const captchaInputSelector = '#captcha';     
            const loginButtonSelector = 'input[type="submit"]'; 

            // 1. Fill login details
            await page.type(usernameSelector, enrollmentNumber);
            await page.type(passwordSelector, password);
            await page.type(captchaInputSelector, captchaText);

            // 2. Click login and wait for the Dashboard (studenthome.jsp) to load
            await Promise.all([
                page.click(loginButtonSelector),
                page.waitForNavigation({ waitUntil: 'networkidle2' })
            ]);

            // --- 1. DIAGNOSTIC DUMP (Run immediately after login networkidle2) ---
            const fs = require('fs');
            
            // Catch diagnostics without halting the main script if they fail
            try {
                await page.screenshot({ path: 'dashboard_diagnostic.png', fullPage: true });

                // Extract Dropdowns
                const selects = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('select')).map(s => ({
                        id: s.id,
                        name: s.name,
                        options: Array.from(s.options).map(o => ({ value: o.value, text: o.text }))
                    }));
                });
                console.log("\n=== DIAGNOSTIC: DROPDOWNS ===");
                console.log(JSON.stringify(selects, null, 2));

                // Extract Buttons
                const buttons = await page.evaluate(() => {
                    return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a')).map(b => ({
                        tag: b.tagName,
                        id: b.id,
                        name: b.name,
                        value: b.value || b.textContent.trim(),
                        className: b.className
                    }));
                });
                console.log("\n=== DIAGNOSTIC: BUTTONS ===");
                console.log(JSON.stringify(buttons, null, 2));

                // Save raw HTML before interacting
                const rawContent = await page.content();
                fs.writeFileSync('dashboard.html', rawContent);
                console.log("=== HTML Dumped to dashboard.html ===\n");
            } catch (diagErr) {
                console.log("Diagnostic dump failed, continuing...", diagErr);
            }
            // ------------------------------------------------------------------

            // --- 2. BULLETPROOF DROPDOWN & FETCH LOGIC ---
            // TODO: Update these generic selectors with the exact IDs from the diagnostic dump logs!
            const SEMESTER_DROPDOWN_ID = 'select'; // Change this once you know the exact ID
            const SUBMIT_BUTTON_ID = 'input[type="submit"]'; // Change this to the exact button ID or exact selector

            const targetSemester = semester || 'ALL'; 
            
            // Wait for Dropdown
            await page.waitForSelector(SEMESTER_DROPDOWN_ID, { timeout: 15000 });
            
            // Resilient Dropdown Selection via Native Evaluation (Bypasses rendering/overlap issues)
            await page.evaluate((selector, val) => {
                const selectEl = document.querySelector(selector);
                if (selectEl) {
                    // If the option exists, select it
                    const optionExists = Array.from(selectEl.options).some(opt => opt.value === val);
                    if (optionExists) {
                        selectEl.value = val;
                    } else if (selectEl.options.length > 0) {
                        selectEl.value = selectEl.options[1].value; // fallback
                    }
                    // Trigger Change Events (crucial for ASP.NET / __doPostBack)
                    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, SEMESTER_DROPDOWN_ID, targetSemester);
            
            // Give AJAX a moment if there's a postback after selecting semester
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Wait for Submit button to be present
            await page.waitForSelector(SUBMIT_BUTTON_ID, { timeout: 15000 });

            // Resilient Click and Wait
            console.log("Attempting to click submit button and fetch marks...");
            await Promise.all([
                page.evaluate((selector) => {
                    const btn = document.querySelector(selector);
                    if (btn) btn.click();
                }, SUBMIT_BUTTON_ID),
                // We use a promise race: wait for network payload OR a timeout.
                // This handles BOTH traditional page navigations and AJAX table redraws.
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => console.log('Navigation wait completed or timed out (AJAX update likely).'))
            ]);

            // Explicitly wait for the target table block to render
            await page.waitForSelector('table', { timeout: 15000 }).catch(() => console.log("Warning: No table found immediately after click."));

            // Capture Screenshot of the marks area safely
            const tableElement = await page.$('table'); 
            let imageBase64 = null;
            try {
            const imageBuffer = await page.screenshot({ fullPage: true });
            imageBase64 = imageBuffer.toString('base64');
        } catch (err) {
            console.error('Screenshot failed:', err.message);
        }
            // --- 3. ADVANCED TABLE SCRAPING (Cheerio) ---
            const finalHtml = await page.content();
            const $ = cheerio.load(finalHtml);
            const scrapedData = [];
            
            // --- NEW: STUDENT PROFILE EXTRACTION ---
            const studentProfile = { name: "N/A", enrollment: "N/A", admissionYear: "N/A", institute: "N/A", program: "N/A" };
            
            // Sweep all table cells for the labels and extract the immediate next sibling cell or split by colon
            $('td, th, span').each((i, el) => {
                const rawText = $(el).text();
                const text = rawText.trim().toLowerCase();
                const nextText = $(el).next().text().trim();
                
                const extractValue = (label) => {
                    if (text.includes(label)) {
                        // If value is in the same cell separated by colon
                        if (rawText.includes(':')) {
                            const parts = rawText.split(':');
                            if (parts.length > 1 && parts[1].trim() !== '') return parts[1].trim();
                        }
                        // Otherwise, it's likely in the adjacent cell
                        if (nextText) return nextText;
                    }
                    return null;
                }

                if (extractValue('student name') || extractValue('name of the student')) studentProfile.name = extractValue('student name') || extractValue('name of the student');
                if (extractValue('enrollment no')) studentProfile.enrollment = extractValue('enrollment no');
                if (extractValue('admission year') || extractValue('batch')) studentProfile.admissionYear = extractValue('admission year') || extractValue('batch');
                if (extractValue('institution') || extractValue('institute')) studentProfile.institute = extractValue('institution') || extractValue('institute');
                if (extractValue('programme') || extractValue('program name')) studentProfile.program = extractValue('programme') || extractValue('program name');
            });
            // ----------------------------------------

            // Resilient traversal of tables (handles nested layouts)
            $('table tr').each((index, element) => {
                const columns = $(element).find('td, th');
                
                // Check for >= 6 columns to accommodate the explicit 0-5 index layout.
                if (columns.length >= 6) {
                    // Ensure it's not a header row 
                    const rowText = $(element).text().toLowerCase();
                    if (rowText.includes('paper name') || rowText.includes('sr. no')) return; // Skip headers

                    const code = $(columns[1]).text().trim();
                    const name = $(columns[2]).text().trim();
                    
                    if (!code || code === '') return;

                    scrapedData.push({
                        code: code,
                        name: name,
                        internal: $(columns[3]).text().trim(), // Explicit target [3]
                        external: $(columns[4]).text().trim(), // Explicit target [4]
                        total: $(columns[5]).text().trim()     // Explicit target [5]
                    });
                }
            });

            if (scrapedData.length === 0) {
                console.error("Warning: cheerio extracted 0 elements from the table.");
            }

            // 6. Pass data through the Math Engine
            const finalResult = calculateResults(scrapedData);

            // 7. Return the enriched JSON including the Base64 image and student profile
            res.json({
                success: true,
                studentProfile: studentProfile,
                data: finalResult,
                marksImage: imageBase64 ? `data:image/png;base64,${imageBase64}` : null
            });

        } catch (error) {
            res.status(500).json({ error: 'An error occurred during processing', details: error.message });
        } finally {
            // Enforce STRICT browser memory management
            if (sessionStore[sessionId]) {
                if (sessionStore[sessionId].browser) {
                    await sessionStore[sessionId].browser.close().catch(e => console.error("Memory management issue: ", e));
                }
                delete sessionStore[sessionId];
            }
        }
    });

    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server is LIVE! Go to: http://localhost:${PORT}`);
    });