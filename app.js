/**
 * CryptoWeeklies - Main Application Script (app.js)
 * Standalone, cached JavaScript module supporting strict CSP and event delegation.
 */

// --- 1. GLOBAL STATE & UTILITIES ---
// MAX_STATIC_QUERIES, staticQueries, chatHistory and chatResizeTimer are still
// declared by the inline block in index.html that this file is being extracted
// from. A classic script shares one global lexical scope, so re-declaring any of
// them here is an early SyntaxError that aborts this entire file before a single
// declaration is installed -- which silently kills the delegated click listener
// below, and with it every data-action control on the page.
//
// Read the existing bindings instead. index.html's inline scripts run during
// parsing and this file is deferred, so they are always initialised by now. When
// the extraction finishes and that block goes away, move the four declarations
// here; tests/test_frontend_bundle.py fails if a duplicate is reintroduced.
staticQueries = parseInt(sessionStorage.getItem('cryptoWeeklyStaticQueries') || '0');
sessionStorage.removeItem('cryptoWeeklyQueries');
sessionStorage.removeItem('cryptoWeeklyGroqQueries');

chatHistory = [];
try {
    const storedChatHistory = JSON.parse(sessionStorage.getItem('cryptoWeeklyChatHistory') || '[]');
    if (Array.isArray(storedChatHistory)) chatHistory = storedChatHistory.slice(-6);
} catch (_) {
    sessionStorage.removeItem('cryptoWeeklyChatHistory');
}

function rememberChatTurn(prompt, answer) {
    chatHistory.push(
        { role: 'user', content: String(prompt || '').slice(0, 900) },
        { role: 'assistant', content: String(answer || '').slice(0, 900) }
    );
    chatHistory = chatHistory.slice(-6);
    sessionStorage.setItem('cryptoWeeklyChatHistory', JSON.stringify(chatHistory));
}

function updateCounterUI() {
    const remainingStatic = Math.max(0, MAX_STATIC_QUERIES - staticQueries);
    const counterEl = document.getElementById('query-counter');
    const inputEl = document.getElementById('user-chat-input');
    const btnEl = document.getElementById('send-chat-btn');

    if (counterEl) counterEl.innerText = `Research ${remainingStatic}`;
    if (remainingStatic === 0 && inputEl && btnEl) {
        inputEl.disabled = true;
        inputEl.placeholder = "Session limit reached.";
        btnEl.disabled = true;
    }
}

// --- 2. MODAL & NAVIGATION FUNCTIONS ---
// Close the mobile install banner for good. Visibility itself is CSS-only, so
// this just parks the class the stylesheet keys off and remembers the choice;
// the inline script at the top of index.html re-applies it before first paint.
function dismissAppBanner() {
    document.body.classList.add('app-banner-dismissed');
    try {
        localStorage.setItem('cwAppBannerDismissed', '1');
    } catch (err) { /* storage blocked: dismissal lasts for this page view */ }
}

// A strip that loaded while its container was hidden measured itself against a
// zero-width viewport and reported the single-column height. Revealing the
// container does not reliably resize the inner document, so ask every strip
// inside it to measure again now that it has its real width.
function remeasureStripsIn(container) {
    if (!container) return;
    container.querySelectorAll('.indicator-strip > iframe').forEach((frame) => {
        frame.contentWindow?.postMessage?.({ action: 'cw_widget_measure' }, '*');
    });
}

const CHART_VIEWER_ID = 'dynamic-chart-viewer';

// Hide the expanded chart and release the document inside it.
//
// Split out of closeChartViewer so switchView can reclaim the surface without
// recursing back into the restore-the-previous-view path.
function closeChartFrame() {
    const viewer = document.getElementById(CHART_VIEWER_ID);
    const iframe = document.getElementById('chart-iframe');
    if (viewer) viewer.style.display = 'none';
    // about:blank, never ''. An empty src resolves against the document, so
    // blanking the frame that way loads this entire page inside itself.
    if (iframe && iframe.getAttribute('src') !== 'about:blank') {
        iframe.src = 'about:blank';
    }
}

function switchView(viewId) {
    // The expanded chart is a peer of the views, not a layer above them. It
    // used to survive a view switch, and because it sits above the views in
    // .main-content the newly revealed view rendered below it rather than
    // replacing it -- the reader saw the old chart with the new view stacked
    // underneath. Reclaim the surface before anything is revealed.
    if (viewId === CHART_VIEWER_ID) return;
    closeChartFrame();

    const views = document.querySelectorAll('.app-view');
    views.forEach(v => { v.style.display = 'none'; v.classList.remove('active'); });

    const targetView = document.getElementById(viewId);
    if (targetView) {
        targetView.style.display = 'block';
        targetView.classList.add('active');
        // currentActiveView is declared by the inline block in index.html that
        // this file is being extracted from. Tracking it here is what lets
        // closeChartViewer return to the view the reader actually came from and
        // what restores the view across a reload; dropping the assignment sent
        // every close back to whatever sessionStorage held at page load.
        currentActiveView = viewId;
        try {
            sessionStorage.setItem('quantTerminalActiveView', viewId);
        } catch (_) {}
        loadIframesInView(targetView);
        wakeLazyImagesInView(targetView);
        remeasureStripsIn(targetView);
    }

    const navLinks = document.querySelectorAll('.sidebar-link');
    navLinks.forEach(link => {
        if (link.getAttribute('data-target') === viewId) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });

    // index.html renders the drawer as <aside class="sidebar" id="sidebar-nav">
    // beside #sidebar-overlay, and style.css keys both off the class "open".
    // The class this used to look for exists in neither the markup nor the
    // stylesheet, so the check never fired and tapping a link on a phone
    // switched the view behind a drawer that stayed open over it.
    const sidebar = document.getElementById('sidebar-nav');
    const overlay = document.getElementById('sidebar-overlay');
    const toggleBtn = document.getElementById('mobile-menu-btn');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.setAttribute('aria-label', 'Open Menu');
    }

    // The Classic view is view-cryptos -- there has never been a 'view-classic',
    // so this branch could not fire. Hydration is idempotent (it latches
    // host.dataset.hydrated), so re-running it on entry is free and covers the
    // case where the DOMContentLoaded pass in index.html ran before the tables
    // it clones from were in the DOM.
    if (viewId === 'view-cryptos') {
        hydrateClassicView();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openChartViewer(url, title, sub) {
    try {
        capturedScrollY = window.scrollY;
    } catch (_) {}

    const viewer = document.getElementById(CHART_VIEWER_ID);
    const iframe = document.getElementById('chart-iframe');
    const titleEl = document.getElementById('chart-viewer-title');
    const subEl = document.getElementById('chart-viewer-subtitle');

    // The viewer carries .app-view too, so this hides it as well; it is
    // revealed again below. Sweeping first is what guarantees the chart
    // replaces the whole content area instead of stacking on top of a view.
    document.querySelectorAll('.app-view').forEach(v => { v.style.display = 'none'; });

    if (titleEl) titleEl.textContent = title || 'Chart View';
    if (subEl) subEl.textContent = sub || '';
    if (iframe) {
        // enhanceDeepDiveFrame and addForecastInterpretationPanel are still
        // defined by index.html's inline block. Wiring them here is what the
        // inline openChartViewer did; without it a forecast page opens with no
        // interpretation panel. The retries cover charts that finish rendering
        // after load fires. Guarded so app.js keeps working once the
        // extraction finishes and those helpers move or go away.
        iframe.onload = () => {
            if (typeof enhanceDeepDiveFrame !== 'function') return;
            enhanceDeepDiveFrame(iframe, url, title);
            window.setTimeout(() => enhanceDeepDiveFrame(iframe, url, title), 700);
            window.setTimeout(() => enhanceDeepDiveFrame(iframe, url, title), 2000);
        };
        iframe.src = url;
    }
    if (viewer) viewer.style.display = 'flex';
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function closeChartViewer() {
    closeChartFrame();

    let activeView = (typeof currentActiveView !== 'undefined' && currentActiveView) || '';
    if (!activeView || !document.getElementById(activeView)) {
        activeView = 'view-dashboard';
    }
    switchView(activeView);
    // switchView scrolls to the top; restore the reader's place without racing
    // that smooth scroll.
    if (typeof capturedScrollY !== 'undefined' && capturedScrollY) {
        window.scrollTo({ top: capturedScrollY, behavior: 'instant' });
    }
}


// Reveal the synthesis reading that belongs to the tab being opened.
//
// All six live in the served markup and only their visibility moves. Building
// the sentence from a string here instead would put six readings a crawler
// never sees behind a script, and the whole point of these lines is that they
// are the page's own text -- update_view_flagships rewrites them in place on
// every refresh exactly like the hero.
function updateIndicatorSynthesis(tabName) {
    const host = document.getElementById('indicator-synthesis');
    if (!host) return;

    let matched = false;
    host.querySelectorAll('[data-synthesis]').forEach((panel) => {
        const isActive = panel.getAttribute('data-synthesis') === tabName;
        // The `hidden` property reflects to the attribute, and the panel rule
        // sets display:flex -- a class beats the UA's [hidden] rule, so
        // style.css carries an explicit .indicator-synthesis-panel[hidden].
        // Without it every panel stays visible and they stack.
        panel.hidden = !isActive;
        if (isActive) matched = true;
    });

    // A tab added later with no panel of its own would otherwise blank the
    // banner completely, which reads as a broken header rather than a missing
    // reading. Fall back to the cross-sectional one.
    if (!matched) {
        const fallback = host.querySelector('[data-synthesis="all"]');
        if (fallback) fallback.hidden = false;
    }
}

function switchIndicatorTab(tabName, btnElement) {
    updateIndicatorSynthesis(tabName);

    // A tab click reclaims the content area the same way a sidebar link does.
    // The panels live inside view-indicators, so tapping a tab while an
    // expanded chart was open swapped the panel underneath the chart and left
    // the chart on screen -- the reader pressed a tab and saw nothing happen.
    const host = document.getElementById('view-indicators');
    if (host && getComputedStyle(host).display === 'none') {
        switchView('view-indicators');
    }

    const panels = document.querySelectorAll('.indicator-panel');
    panels.forEach(p => { p.style.display = 'none'; p.classList.remove('active'); });

    const targetPanel = document.getElementById(`indicator-panel-${tabName}`);
    if (targetPanel) {
        targetPanel.style.display = 'block';
        targetPanel.classList.add('active');
        // Order matters: reveal first so the frames have their real width when
        // they load. Frames already loaded on an earlier visit are skipped by
        // iframeNeedsLoading and would otherwise keep a stale height, so ask
        // them to measure again too.
        loadIframesInView(targetPanel);
        wakeLazyImagesInView(targetPanel);
        remeasureStripsIn(targetPanel);
    }

    const container = btnElement ? btnElement.closest('.indicator-universe-group') : null;
    if (container) {
        container.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    }
    if (btnElement) {
        btnElement.classList.add('active');
    }
}

function switchMatrixView(src, btnElement) {
    const iframe = document.getElementById('matrix-iframe');
    if (iframe) {
        iframe.src = src;
    }
    const container = btnElement ? btnElement.closest('.view-btn-group, .matrix-layer-controls') : null;
    if (container) {
        container.querySelectorAll('.view-btn').forEach(btn => btn.classList.remove('active'));
    }
    if (btnElement) {
        btnElement.classList.add('active');
    }
}

// Resolve a ticker to the report row that should answer for it.
//
// A plain first-match scan over `.data-table-view table tr` was wrong for any
// ticker listed in two tables. hydrateClassicView clones the Quantum / AI /
// Bitcoin / ETF sections into #classic-extra-tables at runtime, and
// view-cryptos sits before view-markets in the DOM -- so SPY and QQQ resolved
// to the cloned two-link ETF row and the reader got 2 reports where the U.S.
// Markets table lists 5. Nothing errored; the modal just quietly offered less.
//
// Two rules, in order:
//
//   1. A cloned row is never authoritative. It is a copy of a section that is
//      already on the page, so skipping it can only ever lose a duplicate.
//   2. Prefer the view the reader is actually in. The bubble was clicked in
//      one galaxy, so that galaxy's own table is the right answer whenever it
//      has one. The page-wide fallback is what keeps the chat's "/chart SPY"
//      working from whatever view the reader happens to be on.
function findAssetRow(baseTicker) {
    const namesTicker = (row) => {
        const firstCell = row.querySelector('td, th');
        return !!firstCell && firstCell.textContent.includes(`(${baseTicker})`);
    };
    // Scoped to the id the clone host actually carries, not to "is it inside
    // view-cryptos" -- that view's own crypto table is real markup and must
    // still resolve.
    const isClone = (row) => !!row.closest('#classic-extra-tables');

    const active = (typeof currentActiveView !== 'undefined' && currentActiveView)
        ? document.getElementById(currentActiveView)
        : null;

    const scopes = [];
    // Plain `table tr` here: the .data-table-view class is on the view element
    // itself, so a descendant selector would match nothing.
    if (active) scopes.push(active.querySelectorAll('table tr'));
    scopes.push(document.querySelectorAll('.data-table-view table tr'));

    for (const rows of scopes) {
        for (const row of rows) {
            if (namesTicker(row) && !isClone(row)) return row;
        }
    }
    return null;
}

function openAssetDeepDive(baseTicker) {
    const titleEl = document.getElementById('modal-asset-title');
    const linksContainer = document.getElementById('modal-asset-links');
    const overlayEl = document.getElementById('asset-modal-overlay');

    if (titleEl) titleEl.textContent = `🔎 ${baseTicker} Deep Dive`;
    if (linksContainer) linksContainer.innerHTML = '';

    const targetRow = findAssetRow(baseTicker);

    if (!targetRow) {
        if (linksContainer) linksContainer.innerHTML = `<p style="color: var(--md-sys-color-on-surface-variant);">No detailed reports found for ${baseTicker} in the data tables.</p>`;
        if (overlayEl) overlayEl.style.display = 'flex';
        return;
    }

    const links = targetRow.querySelectorAll('a');
    links.forEach(link => {
        const analysisType = link.textContent.trim();
        const href = link.getAttribute('href');
        if (!href || href === '#') return;

        let icon = "📊"; let color = "#3b82f6"; 
        if (analysisType.includes("Graph")) { icon = "📈"; color = "#3b82f6"; }
        else if (analysisType.includes("TWAP") || analysisType.includes("Gravity")) { icon = "🌌"; color = "#eab308"; } 
        else if (analysisType.includes("Rainbow") || analysisType.includes("Phase") || analysisType.includes("Regression")) { icon = "🌈"; color = "#a855f7"; } 
        else if (analysisType.includes("SMA") || analysisType.includes("Bands")) { icon = "📊"; color = "#22c55e"; } 
        else if (analysisType.includes("Valuation")) { icon = "📐"; color = "#00e5ff"; }
        else if (analysisType.includes("DCA")) { icon = "🎯"; color = "#ec4899"; } 
        else if (analysisType.includes("Model") || analysisType.includes("Eval")) { icon = "🧠"; color = "#00d4aa"; } 

        const btnHtml = `
          <button class="modal-analysis-btn" style="--analysis-color:${color};" 
              data-action="open-chart-modal" data-url="${href}" data-ticker="${baseTicker}" data-sub="- ${analysisType}">
              ${icon} ${analysisType}
          </button>`;

        if (linksContainer) linksContainer.innerHTML += btnHtml;
    });

    if (overlayEl) overlayEl.style.display = 'flex';
}

// --- 3. DEFERRED IFRAME LOADING & INTERSECTION OBSERVER ---
// These frames ship as src="" and are filled in on demand. Test the attribute,
// not iframe.src: the IDL property resolves an empty src against the document,
// so it reads back as the page's own URL and never looks unloaded.
function iframeNeedsLoading(iframe) {
    const current = iframe.getAttribute('src');
    return !current || current === 'about:blank';
}

// A frame inside a display:none subtree has no layout box. getClientRects()
// covers position:fixed, where offsetParent is null but the box is real.
function isRenderable(element) {
    return element.offsetParent !== null || element.getClientRects().length > 0;
}

/**
 * Wake native-lazy images inside a view that has just been revealed.
 *
 * `loading="lazy"` never fires for an image parsed inside a display:none
 * container: it is laid out only once the view is shown, and the browser does
 * not reliably re-run the intersection check afterwards. Measured on the About
 * view -- the portrait sat at its full 140x140 box, in the viewport, and stayed
 * unloaded through a scroll and several seconds.
 *
 * Same shape as the iframe problem this file already solves above: the host has
 * to drive the load when it reveals the container, because nothing else will.
 * Flipping to eager once the view is genuinely on screen costs nothing -- the
 * reader is looking at it -- and keeps the attribute doing its real job, which
 * is staying out of the initial page load.
 */
function wakeLazyImagesInView(container) {
    if (!container) return;
    container.querySelectorAll('img[loading="lazy"]').forEach(img => {
        if (!isRenderable(img)) return;
        img.loading = 'eager';
    });
}

function loadIframesInView(container) {
    if (!container) return;
    const iframes = container.querySelectorAll('iframe[data-src]');
    iframes.forEach(iframe => {
        // Skip frames still inside a hidden panel. The Indicators view holds six
        // stacked panels and only one is shown at a time, so loading the whole
        // view eagerly booted every strip at zero width -- each then reported the
        // single-column height and its tiles were clipped by the CSS fallback
        // until something happened to trigger a re-measure. switchIndicatorTab
        // loads each panel's frames when that panel is actually revealed.
        if (!isRenderable(iframe)) return;
        if (iframeNeedsLoading(iframe)) {
            const targetSrc = iframe.getAttribute('data-src');
            if (targetSrc) {
                iframe.src = targetSrc;
            }
        }
    });
}

function initDeferredIframeLoading() {
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const iframe = entry.target;
                    const targetSrc = iframe.getAttribute('data-src');
                    if (targetSrc && iframeNeedsLoading(iframe)) {
                        iframe.src = targetSrc;
                    }
                    obs.unobserve(iframe);
                }
            });
        }, { rootMargin: '200px 0px' });

        document.querySelectorAll('iframe[data-src]').forEach(iframe => {
            observer.observe(iframe);
        });
    } else {
        document.querySelectorAll('iframe[data-src]').forEach(iframe => {
            const targetSrc = iframe.getAttribute('data-src');
            if (targetSrc) iframe.src = targetSrc;
        });
    }
}

// --- 4. CHAT & POPUP LOGIC ---
function fitChatPopupToViewport() {
    const popupEl = document.getElementById('chat-popup');
    const outputEl = document.getElementById('chat-response-output');
    if (!popupEl || !outputEl || popupEl.style.display === 'none') return;

    popupEl.classList.remove('cw-fit-compact', 'cw-fit-tight');
    outputEl.style.zoom = '1';
    const popupStyles = window.getComputedStyle(popupEl);
    const verticalPadding = parseFloat(popupStyles.paddingTop) + parseFloat(popupStyles.paddingBottom);
    const toolbarHeight = popupEl.firstElementChild ? popupEl.firstElementChild.offsetHeight : 0;
    const available = Math.max(180, window.innerHeight - 92 - verticalPadding - toolbarHeight);

    outputEl.style.maxHeight = `${available}px`;
    outputEl.style.overflowY = 'auto';
}

// chatResizeTimer is declared by index.html's inline block; see the note at the
// top of this file about why re-declaring it here would abort the whole script.
window.addEventListener('resize', () => {
    window.clearTimeout(chatResizeTimer);
    chatResizeTimer = window.setTimeout(fitChatPopupToViewport, 80);
});

async function handleChatSubmit() {
    const inputEl = document.getElementById('user-chat-input');
    const popupEl = document.getElementById('chat-popup');
    const outputEl = document.getElementById('chat-response-output');
    const btnEl = document.getElementById('send-chat-btn');
    const rawPrompt = inputEl ? inputEl.value.trim() : '';
    if (!rawPrompt) return;

    if (rawPrompt.startsWith('/chart') || rawPrompt.startsWith('/deep') || rawPrompt.startsWith('/asset')) {
        const aliasMap = {
            "NVIDIA": "NVDA", "MICROSOFT": "MSFT", "GOOGLE": "GOOGL", "ALPHABET": "GOOGL",
            "META": "META", "PALANTIR": "PLTR", "SUPERMICRO": "SMCI", "BITCOIN": "BTC",
            "ETHEREUM": "ETH", "SOLANA": "SOL", "IONQ": "IONQ", "RIGETTI": "RGTI"
        };
        const parts = rawPrompt.split(' ');
        let inputTicker = parts[1] ? parts[1].toUpperCase() : 'BTC';
        const targetTicker = aliasMap[inputTicker] || inputTicker;

        if (inputEl) inputEl.value = '';
        if (popupEl) popupEl.style.display = 'none';
        openAssetDeepDive(targetTicker);
        return;
    }

    if (staticQueries >= MAX_STATIC_QUERIES) {
        if (popupEl) popupEl.style.display = 'block';
        if (outputEl) outputEl.innerHTML = '<b>Session Notice:</b> The 50 research questions for this session have been used.';
        return;
    }

    if (btnEl) btnEl.disabled = true; 
    if (inputEl) inputEl.disabled = true;
    if (popupEl) popupEl.style.display = 'block';
    if (outputEl) outputEl.innerHTML = '<em style="color: var(--md-sys-color-primary); animation: pulse 1.5s infinite;">Retrieving knowledge graph...</em>';

    try {
        const response = await fetch("https://falling-credit-5b8d.cryptoweeklies.workers.dev/", { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify({ prompt: rawPrompt, history: chatHistory })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const responseEngine = (response.headers.get('X-CW-Engine') || 'STATIC').toUpperCase();
        if (outputEl) outputEl.innerHTML = "";

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        let answerHtml = "";

        const renderAnswer = () => {
            if (!outputEl) return;
            outputEl.innerHTML = answerHtml;
            // TOP, not bottom. This used to be `scrollTop = scrollHeight`,
            // which pins the container to the end of the answer on every
            // frame. That is right for a chat transcript, where the newest
            // line is the one you want, and wrong for this card: it is a
            // document, and its header, spot price and headline reading are
            // all at the top. The reader landed on the 2040 scenario matrix
            // with the entire snapshot scrolled off above them.
            outputEl.scrollTop = 0;
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('data: ')) {
                    const payload = trimmed.substring(6);
                    if (payload === '[DONE]') break;

                    try {
                        const parsed = JSON.parse(payload);
                        const content = parsed.choices[0]?.delta?.content || "";
                        if (content) {
                            answerHtml += content;
                            renderAnswer();
                        }
                    } catch (e) {
                        if (!payload.includes('{')) {
                            answerHtml += payload;
                            renderAnswer();
                        }
                    }
                }
            }
        }
        if (responseEngine === 'STATIC' || responseEngine === 'GRAPH') {
            staticQueries++;
            sessionStorage.setItem('cryptoWeeklyStaticQueries', staticQueries);
        }
        rememberChatTurn(rawPrompt, outputEl ? outputEl.textContent : '');
        fitChatPopupToViewport();
        updateCounterUI(); 
        if (inputEl) inputEl.value = '';
    } catch (err) { 
        if (outputEl) outputEl.innerHTML = `<span style="color:#ff5555;">Chart data is temporarily unavailable. Please retry.</span>`; 
    } finally { 
        if (staticQueries < MAX_STATIC_QUERIES) { 
            if (btnEl) btnEl.disabled = false; 
            if (inputEl) { inputEl.disabled = false; inputEl.focus(); }
        } 
    }
}

// --- 5. CLASSIC VIEW HYDRATION ---
// Deliberately empty. hydrateClassicView and filterClassicView live in
// index.html, which owns the helpers they need (buildReportTable,
// cloneRowsFromTable) and the real element ids (#classic-extra-tables,
// #classic-search). Copies used to sit here too and, being deferred, won --
// but they addressed #classic-view-tables and #classic-search-input, which
// the markup has never had, so both silently no-opped: the Classic view
// rendered only its crypto table and its search box did nothing. Neither
// threw, because getElementById returning null is the documented guard in
// both. Do not re-add a copy here without deleting the inline one.

// --- 6. TICKER TRACK GENERATOR ---
function initUnifiedTickerTrack() {
    const extractDollar = (str) => {
        if (!str) return '—';
        const match = str.match(/\$[\d,]+(?:\.\d+)?/);
        return match ? match[0] : '—';
    };

    try {
        const bullTable = document.querySelector('.card-bull iframe')?.contentDocument?.querySelector('table');
        const bearTable = document.querySelector('.card-bear iframe')?.contentDocument?.querySelector('table');
        const track = document.getElementById('unified-ticker-track');

        if (!bullTable || !bearTable || !track) return;

        const getColIndices = (table) => {
            const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.toUpperCase().trim());
            return {
                symIdx: headers.findIndex(h => h.includes('SYMBOL') || h.includes('ASSET') || h.includes('TICKER')),
                priceIdx: headers.findIndex(h => h.includes('PRICE') || h.includes('SPOT')),
                baseIdx: headers.findIndex(h => h.includes('BASE')),
                bullIdx: headers.findIndex(h => h.includes('BULL') || h.includes('PEAK')),
                panicIdx: headers.findIndex(h => h.includes('PANIC') || h.includes('BEAR'))
            };
        };

        const bIndices = getColIndices(bullTable);
        const rIndices = getColIndices(bearTable);

        const bRows = Array.from(bullTable.querySelectorAll('tr')).slice(1);
        const rRows = Array.from(bearTable.querySelectorAll('tr')).slice(1);

        const symbols = ['BTC', 'ETH', 'SOL', 'LINK', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOGE', 'DOT', 'NEAR'];
        const logos = { BTC: "bitcoin-btc-logo_48.png", ETH: "ethereum_eth_logo_48.png", SOL: "solana-sol-logo_48.png", LINK:"chainlink-link-logo_48.png", BNB: "bnb-bnb-logo_48.png", XRP: "xrp_reverse_logo_48.png" };

        let itemsHtml = '';
        symbols.forEach(sym => {
            const bullRow = bRows.find(r => r.children[bIndices.symIdx]?.textContent.toUpperCase().includes(sym));
            const bearRow = rRows.find(r => r.children[rIndices.symIdx]?.textContent.toUpperCase().includes(sym));

            if (bullRow && bearRow) {
                const price = bIndices.priceIdx !== -1 && bullRow.children[bIndices.priceIdx] ? extractDollar(bullRow.children[bIndices.priceIdx].textContent) : '—';
                const bullBase = bIndices.baseIdx !== -1 && bullRow.children[bIndices.baseIdx] ? extractDollar(bullRow.children[bIndices.baseIdx].textContent) : '—';
                const bullPeak = bIndices.bullIdx !== -1 && bullRow.children[bIndices.bullIdx] ? extractDollar(bullRow.children[bIndices.bullIdx].textContent) : '—';
                const bearBase = rIndices.baseIdx !== -1 && bearRow.children[rIndices.baseIdx] ? extractDollar(bearRow.children[rIndices.baseIdx].textContent) : '—';
                const bearPanic = rIndices.panicIdx !== -1 && bearRow.children[rIndices.panicIdx] ? extractDollar(bearRow.children[rIndices.panicIdx].textContent) : '—';

                itemsHtml += `<span class="ticker__item item-bull"><img alt="" width="48" height="48" decoding="async" src="${logos[sym]}"><span>${sym}</span><span class="ticker__label"><span style="color:#ffffff;">${price}</span> &nbsp;|&nbsp; Base: ${bullBase} &nbsp;|&nbsp; <span style="color:#4ade80;">Bull: ${bullPeak}</span></span></span>`;
                itemsHtml += `<span class="ticker__item item-bear"><img alt="" width="48" height="48" decoding="async" src="${logos[sym]}"><span>${sym}</span><span class="ticker__label"><span style="color:#ffffff;">${price}</span> &nbsp;|&nbsp; Base: ${bearBase} &nbsp;|&nbsp; <span style="color:#f87171;">Panic: ${bearPanic}</span></span></span>`;
            }
        });

        if (track) track.innerHTML = itemsHtml + itemsHtml;
    } catch (e) {
        console.error("Unified Ticker Error:", e);
    }
}

// --- 7. DELEGATED EVENT LISTENERS & DOM CONTENT LOADED ---
document.addEventListener('DOMContentLoaded', () => {
    initDeferredIframeLoading();
    updateCounterUI();

    const sendBtn = document.getElementById('send-chat-btn');
    const chatInput = document.getElementById('user-chat-input');
    if (sendBtn) sendBtn.addEventListener('click', handleChatSubmit);
    if (chatInput) chatInput.addEventListener('keypress', e => { if (e.key === 'Enter') handleChatSubmit(); });

    // The search box is #classic-search and index.html binds it (input +
    // search, so the clear button fires too). A second binding here on the
    // id that does not exist only looked like coverage.

    // Delegated Global Click Listener
    document.addEventListener('click', (e) => {
        const actionTarget = e.target.closest('[data-action]');
        if (!actionTarget) return;

        const action = actionTarget.getAttribute('data-action');

        switch (action) {
            case 'switch-view': {
                const viewId = actionTarget.getAttribute('data-view') || actionTarget.getAttribute('data-target');
                if (viewId) switchView(viewId);
                break;
            }
            case 'open-chart': {
                const url = actionTarget.getAttribute('data-url');
                const title = actionTarget.getAttribute('data-title');
                const sub = actionTarget.getAttribute('data-sub');
                if (url) {
                    // The model-explanation links ("what does that mean?", the
                    // footer glossary pair) ship as real <a href> on purpose:
                    // a crawler and a reader with no JS have to reach those
                    // pages, which is the entire point of the SEO pass. Once
                    // this handler opens the viewer the browser would still
                    // follow the href a moment later and leave the SPA behind
                    // the chart it just rendered, so the navigation has to be
                    // taken back here. Only anchors -- every other control
                    // carrying this action is a <button> with nothing to
                    // cancel, and calling preventDefault on those would be a
                    // silent no-op that reads as meaningful.
                    if (actionTarget.tagName === 'A') e.preventDefault();
                    openChartViewer(url, title, sub);
                }
                break;
            }
            case 'close-chart': {
                closeChartViewer();
                break;
            }
            case 'open-chart-modal': {
                const url = actionTarget.getAttribute('data-url');
                const ticker = actionTarget.getAttribute('data-ticker');
                const sub = actionTarget.getAttribute('data-sub');
                const overlayEl = document.getElementById('asset-modal-overlay');
                if (overlayEl) overlayEl.style.display = 'none';
                if (url) openChartViewer(url, ticker, sub);
                break;
            }
                        case 'switch-indicator-tab': {
                const tabName = actionTarget.getAttribute('data-tab');
                if (tabName) switchIndicatorTab(tabName, actionTarget);
                break;
            }
            case 'switch-matrix': {
                const src = actionTarget.getAttribute('data-matrix-src');
                if (src) switchMatrixView(src, actionTarget);
                break;
            }
            case 'toggle-drawer': {
                // style.css opens the drawer on `.sidebar.open` and reveals the
                // scrim on `.sidebar-overlay.open`. Both have to move together
                // or the drawer slides out over a page that is still clickable.
                const sidebar = document.getElementById('sidebar-nav');
                const overlay = document.getElementById('sidebar-overlay');
                if (sidebar) {
                    const isOpen = sidebar.classList.toggle('open');
                    if (overlay) overlay.classList.toggle('open', isOpen);
                    actionTarget.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                    actionTarget.setAttribute('aria-label', isOpen ? 'Close Menu' : 'Open Menu');
                }
                break;
            }
            case 'dismiss-app-banner': {
                dismissAppBanner();
                break;
            }
            case 'close-chat-popup': {
                const popupEl = document.getElementById('chat-popup');
                if (popupEl) popupEl.style.display = 'none';
                break;
            }
            case 'close-asset-modal': {
                const overlayEl = document.getElementById('asset-modal-overlay');
                if (overlayEl) overlayEl.style.display = 'none';
                break;
            }
            case 'switch-answer-tab': {
                // The answer card is HTML the Worker returns, so this is scoped
                // to the clicked card rather than the document: a conversation
                // holds several answers at once and each keeps its own tab.
                const card = actionTarget.closest('.cw-answer');
                if (!card) break;
                const wanted = actionTarget.getAttribute('data-answer-tab');
                card.querySelectorAll('[data-answer-tab]').forEach(tab => {
                    const active = tab.getAttribute('data-answer-tab') === wanted;
                    tab.classList.toggle('is-active', active);
                    tab.setAttribute('aria-selected', active ? 'true' : 'false');
                });
                card.querySelectorAll('[data-answer-panel]').forEach(panel => {
                    panel.hidden = panel.getAttribute('data-answer-panel') !== wanted;
                });
                break;
            }
            case 'close-chart-viewer': {
                closeChartViewer();
                break;
            }
        }
    });

    // Cross-Iframe PostMessage Listeners
    let stripMeasureTimer = 0;
    const requestStripMeasure = () => {
        window.clearTimeout(stripMeasureTimer);
        stripMeasureTimer = window.setTimeout(() => {
            document.querySelectorAll('.indicator-strip > iframe').forEach((frame) => {
                frame.contentWindow?.postMessage?.({ action: 'cw_widget_measure' }, '*');
            });
        }, 150);
    };
    window.addEventListener('resize', requestStripMeasure);

    window.addEventListener('message', (event) => {
        if (!event.data || event.data.action !== 'cw_widget_height') return;
        const height = Number(event.data.height);
        if (!Number.isFinite(height) || height < 40 || height > 2000) return;
        document.querySelectorAll('.indicator-strip > iframe').forEach((frame) => {
            if (frame.contentWindow !== event.source) return;
            frame.parentElement.style.height = `${Math.ceil(height)}px`;
        });
    });

    window.addEventListener('message', (event) => {
        if (!event.data) return;
        if (event.data.action === 'open-chart' && event.data.url) {
            openChartViewer(event.data.url, event.data.title, event.data.sub);
        } else if (
            event.data.action === 'open_asset_menu' ||
            event.data.action === 'open_quantum_asset_menu' ||
            event.data.action === 'open_ai_asset_menu' ||
            event.data.action === 'open_bitcoin_asset_menu' ||
            event.data.action === 'open_markets_asset_menu'
        ) {
            openAssetDeepDive(event.data.ticker);
        }
    });

    // Initial Ticker Track load after delay
    setTimeout(initUnifiedTickerTrack, 2500);

    initLivePrice();
});

// ---------------------------------------------------------------- live price
//
// The hero's own numbers are baked at build time: "updated 29 August 2026" is
// the refresh date, and the TWAP premium beside it was computed from that
// day's close. Nothing on the page said when the *price* was observed, so a
// reader could not tell a number minutes old from one two days old. This adds
// that one missing fact, next to the build date it should be read against.
//
// Source is the feed the live-prices Cloudflare Worker publishes every 30
// minutes. The site holds no key and makes no provider call: one server-side
// fetch serves every visitor, which is the only shape that fits CoinGecko's
// 10,000-credit month. Attribution is a term of that free plan, not a
// courtesy, so the CoinGecko link below is not optional.
//
// The node is created here rather than written into index.html. The sub-line
// it joins sits between the cw:hero-answer markers, which build_seo_assets.py
// owns and rewrites on disk; nothing else belongs in there. A node built at
// runtime never appears in the file, so that rule holds and the reading still
// lands where it means something.
const LIVE_PRICE_URL = 'https://cryptoweeklies-5b82f-default-rtdb.firebaseio.com/live_prices_v1.json';
const LIVE_PRICE_REFRESH_MS = 5 * 60 * 1000;
// The feed's own contract: three missed 30-minute runs. Past this the reading
// is relabelled rather than removed -- a price whose age the reader can see
// beats a blank space that says nothing at all happened.
const LIVE_PRICE_STALE_MS = 45 * 60 * 1000;
let livePriceTimer = null;
let livePriceLast = null;

function formatLivePriceAge(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.floor(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
}

function renderLivePrice(payload) {
    const sub = document.querySelector('.hero-answer-sub');
    if (!sub) return;

    // Anything missing or malformed means no reading at all. A wrong price is
    // worse than a missing one, and the hero's build-time numbers stand alone.
    const crypto = payload && payload.crypto;
    const price = crypto && crypto.prices ? crypto.prices.BTC : null;
    const stamp = crypto && crypto.as_of ? Date.parse(crypto.as_of) : NaN;
    if (typeof price !== 'number' || !isFinite(price) || !isFinite(stamp)) return;

    let el = document.getElementById('hero-live-price');
    if (!el) {
        el = document.createElement('span');
        el.id = 'hero-live-price';
        el.className = 'hero-live';
        sub.appendChild(document.createTextNode(' · '));
        sub.appendChild(el);
    }

    const age = Date.now() - stamp;
    el.classList.toggle('is-stale', age > LIVE_PRICE_STALE_MS);
    el.replaceChildren();

    el.appendChild(document.createTextNode('BTC '));
    const amount = document.createElement('strong');
    amount.textContent = '$' + Math.round(price).toLocaleString('en-US');
    el.appendChild(amount);
    el.appendChild(document.createTextNode(' · '));

    const credit = document.createElement('a');
    credit.href = 'https://www.coingecko.com';
    credit.target = '_blank';
    credit.rel = 'noopener';
    credit.textContent = 'CoinGecko';
    el.appendChild(credit);

    el.appendChild(document.createTextNode(' ' + formatLivePriceAge(age)));
    el.title = 'Bitcoin spot price via CoinGecko, observed ' + new Date(stamp).toUTCString();
}

async function fetchLivePrice() {
    try {
        const response = await fetch(LIVE_PRICE_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const payload = await response.json();
        if (payload) livePriceLast = payload;
    } catch (error) {
        // Deliberately silent. On failure the last good payload is re-rendered
        // rather than frozen, so a dead feed visibly ages into "stale" instead
        // of sitting at "3 min ago" forever.
    }
    if (livePriceLast) renderLivePrice(livePriceLast);
}

function initLivePrice() {
    fetchLivePrice();
    if (livePriceTimer) clearInterval(livePriceTimer);
    livePriceTimer = setInterval(function () {
        if (document.visibilityState === 'visible') fetchLivePrice();
    }, LIVE_PRICE_REFRESH_MS);
    // A backgrounded tab needs no fresher price than the moment it is looked at
    // again, and coming back is exactly when the age on screen is most wrong.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') fetchLivePrice();
    });
}

// Expose functions globally for backward compatibility
window.switchView = switchView;
window.openChartViewer = openChartViewer;
window.closeChartViewer = closeChartViewer;
window.switchIndicatorTab = switchIndicatorTab;
window.updateIndicatorSynthesis = updateIndicatorSynthesis;
window.switchMatrixView = switchMatrixView;
window.dismissAppBanner = dismissAppBanner;
window.openAssetDeepDive = openAssetDeepDive;
window.fitChatPopupToViewport = fitChatPopupToViewport;
window.handleChatSubmit = handleChatSubmit;
window.initLivePrice = initLivePrice;
