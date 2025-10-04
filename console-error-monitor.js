const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs').promises;
const path = require('path');
const cron = require('node-cron');

puppeteer.use(StealthPlugin());

class ConsoleErrorMonitor {
  constructor(config = {}) {
    this.config = {
      baseUrls: config.baseUrls || ['https://www.salesforce.com'],
      confPatterns: config.confPatterns || ['/conf/', '/confirmation/', '/asyncconf'],
      locales: config.locales || ['en-US'],
      maxConcurrent: config.maxConcurrent || 10,
      timeout: config.timeout || 30000,
      outputDir: config.outputDir || './reports',
      retryLimit: config.retryLimit || 2,
      useFirefox: config.useFirefox || false,
      captureNetworkErrors: config.captureNetworkErrors || true,
      captureCorsErrors: config.captureCorsErrors || true
    };
    
    this.errors = new Map();
    this.urlErrors = new Map();
    this.processedUrls = new Set();
    this.errorTypes = {
      console: 0,
      network: 0,
      cors: 0,
      runtime: 0,
      uncaught: 0
    };
  }

  // Generate all possible confirmation page URLs
  generateUrls() {
    const urls = [];
    
    // Example URL patterns - customize based on your needs
    const paths = [
      '/form/signup/conf/asyncconf',
      '/form/signup/conf/freetrial-conf-lb',
      '/form/signup/',
    ];
    
    for (const baseUrl of this.config.baseUrls) {
      for (const path of paths) {
        /*for (const locale of this.config.locales) {
          // Generate locale-specific URLs
          urls.push(`${baseUrl}/${locale}${path}`);
          urls.push(`${baseUrl}${path}?locale=${locale}`);
        }COMMENTED AS LOCALE LOGIC NOT FINAL*/
        // Also add non-locale version
        urls.push(`${baseUrl}${path}`);
      }
    }
    
    return urls;
  }

  // Enhanced error detection for a single URL
  async processUrl(browser, url) {
    let page;
    let retries = 0;
    
    while (retries <= this.config.retryLimit) {
      try {
        page = await browser.newPage();
        const errors = [];
        const networkErrors = [];
        
        // Enhanced console error listener - catches more error types
        page.on('console', msg => {
          const type = msg.type();
          const text = msg.text();
          
          // Capture errors, warnings that look like errors, and failed assertions
          if (type === 'error' || 
              (type === 'warning' && text.includes('Error')) ||
              text.includes('Uncaught') ||
              text.includes('ReferenceError') ||
              text.includes('TypeError') ||
              text.includes('SyntaxError')) {
            
            errors.push({
              type: 'console-error',
              severity: type,
              text: text,
              location: msg.location(),
              stackTrace: msg.stackTrace(),
              timestamp: new Date().toISOString()
            });
          }
        });
        
        // Capture page errors (uncaught exceptions)
        page.on('pageerror', error => {
          errors.push({
            type: 'uncaught-exception',
            severity: 'error',
            text: error.message,
            stack: error.stack,
            name: error.name,
            timestamp: new Date().toISOString()
          });
        });
        
        // Capture request failures (including CORS)
        page.on('requestfailed', request => {
          const failure = request.failure();
          const url = request.url();
          
          // Check if it's a CORS error
          if (failure && failure.errorText) {
            const errorText = failure.errorText;
            const isCors = errorText.includes('CORS') || 
                          errorText.includes('Cross-Origin') ||
                          errorText.includes('net::ERR_FAILED');
            
            networkErrors.push({
              type: isCors ? 'cors-error' : 'network-error',
              severity: 'error',
              text: `${isCors ? 'CORS' : 'Network'} Error: ${url}`,
              errorText: errorText,
              url: url,
              method: request.method(),
              resourceType: request.resourceType(),
              timestamp: new Date().toISOString()
            });
          }
        });
        
        // Capture response errors
        page.on('response', response => {
          const status = response.status();
          const url = response.url();
          
          // Capture 4xx and 5xx errors
          if (status >= 400) {
            networkErrors.push({
              type: 'http-error',
              severity: 'error',
              text: `HTTP ${status} Error: ${url}`,
              status: status,
              statusText: response.statusText(),
              url: url,
              timestamp: new Date().toISOString()
            });
          }
        });
        
        // Inject error catching code into the page
        await page.evaluateOnNewDocument(() => {
          // Capture unhandled promise rejections
          window.addEventListener('unhandledrejection', event => {
            console.error('Unhandled Promise Rejection:', event.reason);
          });
          
          // Capture all errors including those caught by try-catch
          const originalError = window.Error;
          window.Error = function(...args) {
            console.error('Error thrown:', args[0]);
            return originalError.apply(this, args);
          };
          
          // Monitor for specific error patterns
          const originalLog = console.log;
          const originalWarn = console.warn;
          
          console.log = function(...args) {
            const message = args.join(' ');
            if (message.includes('error') || message.includes('Error')) {
              console.error('Possible error in console.log:', message);
            }
            return originalLog.apply(console, args);
          };
          
          console.warn = function(...args) {
            const message = args.join(' ');
            if (message.includes('CORS') || message.includes('Cross-Origin')) {
              console.error('CORS warning detected:', message);
            }
            return originalWarn.apply(console, args);
          };
        });
        
        // Set additional headers to help with CORS detection
        await page.setExtraHTTPHeaders({
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Cache-Control': 'no-cache'
        });
        
        // Navigate to the page with more options
        const response = await page.goto(url, {
          waitUntil: ['networkidle2', 'domcontentloaded'],
          timeout: this.config.timeout
        });
        
        // Check for soft 404s or error pages
        const pageContent = await page.content();
        if (pageContent.includes('404') || 
            pageContent.includes('Page not found') ||
            pageContent.includes('Error') && pageContent.length < 1000) {
          errors.push({
            type: 'page-error',
            severity: 'error',
            text: 'Possible error page detected',
            timestamp: new Date().toISOString()
          });
        }
        
        // Try to trigger any lazy-loaded errors
        await page.evaluate(() => {
          // Scroll to trigger lazy loading
          window.scrollTo(0, document.body.scrollHeight);
          
          // Check for any error messages in the DOM
          const errorElements = document.querySelectorAll('[class*="error"], [id*="error"], [data-error]');
          errorElements.forEach(el => {
            if (el.textContent && el.textContent.trim()) {
              console.error('DOM Error Element:', el.textContent.trim());
            }
          });
          
          // Check for broken images
          const images = document.querySelectorAll('img');
          images.forEach(img => {
            if (!img.complete || img.naturalHeight === 0) {
              console.error('Broken Image:', img.src);
            }
          });
        });
        
        // Combine all errors
        const allErrors = [...errors, ...networkErrors];
        
        // Store errors if any found
        if (allErrors.length > 0) {
          this.storeErrors(url, allErrors);
        }
        
        await page.close();
        return { 
          url, 
          success: true, 
          errorCount: allErrors.length,
          errorTypes: {
            console: errors.length,
            network: networkErrors.length
          }
        };
        
      } catch (error) {
        retries++;
        if (page) await page.close().catch(() => {});
        
        if (retries > this.config.retryLimit) {
          console.error(`Failed to process ${url}: ${error.message}`);
          
          // Log navigation errors as errors too
          this.storeErrors(url, [{
            type: 'navigation-error',
            severity: 'critical',
            text: `Failed to load page: ${error.message}`,
            timestamp: new Date().toISOString()
          }]);
          
          return { url, success: false, error: error.message };
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
      }
    }
  }

  // Store and group errors with better categorization
  storeErrors(url, errors) {
    // Store URL-specific errors
    this.urlErrors.set(url, errors);
    
    // Group similar errors
    for (const error of errors) {
      const errorKey = this.normalizeError(error.text, error.type);
      
      if (!this.errors.has(errorKey)) {
        this.errors.set(errorKey, {
          message: error.text,
          type: error.type,
          severity: error.severity,
          urls: new Set(),
          count: 0,
          firstSeen: new Date(),
          details: error,
          examples: []
        });
      }
      
      const errorGroup = this.errors.get(errorKey);
      errorGroup.urls.add(url);
      errorGroup.count++;
      errorGroup.lastSeen = new Date();
      
      // Store a few examples
      if (errorGroup.examples.length < 3) {
        errorGroup.examples.push({
          url: url,
          timestamp: error.timestamp,
          details: error
        });
      }
      
      // Update error type counts
      if (error.type.includes('cors')) this.errorTypes.cors++;
      else if (error.type.includes('network')) this.errorTypes.network++;
      else if (error.type.includes('uncaught')) this.errorTypes.uncaught++;
      else if (error.type.includes('console')) this.errorTypes.console++;
      else this.errorTypes.runtime++;
    }
  }

  // Enhanced error normalization
  normalizeError(errorText, errorType) {
    let normalized = errorText
      .replace(/https?:\/\/[^\s]+/g, '[URL]')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]')
      .replace(/\b\d{4,}\b/g, '[ID]')
      .replace(/:\d+:\d+/g, ':[LINE]:[COL]')
      .replace(/at line \d+/g, 'at line [LINE]')
      .replace(/\?[^?\s]+/g, '?[PARAMS]')
      .trim();
    
    // Group CORS errors by domain
    if (errorType.includes('cors')) {
      const domainMatch = errorText.match(/https?:\/\/([^\/]+)/);
      if (domainMatch) {
        normalized = `CORS Error: ${domainMatch[1]}`;
      }
    }
    
    return `${errorType}::${normalized}`.substring(0, 250);
  }

  // Process URLs with browser configuration
  async processUrls(urls) {
    let browser;
    
    // Browser configuration for better error detection
    const browserOptions = {
      headless: false, // Set to false to see the browser for debugging
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security', // Helps detect CORS issues
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--no-first-run',
        '--no-zygote',
        '--deterministic-fetch',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080
      },
      ignoreHTTPSErrors: true
    };
    
    // Use Firefox if specified (better for some error detection)
    if (this.config.useFirefox) {
      browserOptions.product = 'firefox';
      browserOptions.extraPrefsFirefox = {
        'network.cookie.cookieBehavior': 0,
        'dom.webdriver.enabled': false,
        'useAutomationExtension': false
      };
    }
    
    browser = await puppeteer.launch(browserOptions);

    const results = [];
    const batches = [];
    
    // Create batches
    for (let i = 0; i < urls.length; i += this.config.maxConcurrent) {
      batches.push(urls.slice(i, i + this.config.maxConcurrent));
    }
    
    // Process batches
    for (let i = 0; i < batches.length; i++) {
      console.log(`Processing batch ${i + 1}/${batches.length}`);
      
      const batchPromises = batches[i].map(url => 
        this.processUrl(browser, url)
      );
      
      const batchResults = await Promise.allSettled(batchPromises);
      results.push(...batchResults.map(r => r.value || r.reason));
      
      // Small delay between batches
      if (i < batches.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    await browser.close();
    return results;
  }

  // Generate enhanced HTML report
  async generateHtmlReport() {
    const timestamp = new Date().toISOString();
    const sortedErrors = Array.from(this.errors.entries())
      .sort((a, b) => b[1].count - a[1].count);
    
    // Group errors by type
    const errorsByType = {
      cors: [],
      network: [],
      console: [],
      uncaught: [],
      other: []
    };
    
    sortedErrors.forEach(([key, error]) => {
      if (error.type.includes('cors')) errorsByType.cors.push([key, error]);
      else if (error.type.includes('network')) errorsByType.network.push([key, error]);
      else if (error.type.includes('console')) errorsByType.console.push([key, error]);
      else if (error.type.includes('uncaught')) errorsByType.uncaught.push([key, error]);
      else errorsByType.other.push([key, error]);
    });
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Console Error Report - ${timestamp}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      line-height: 1.6;
      color: #333;
      background: #f5f5f5;
      padding: 20px;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
      background: white;
      border-radius: 10px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 30px;
    }
    h1 { font-size: 2em; margin-bottom: 10px; }
    .meta {
      display: flex;
      gap: 30px;
      margin-top: 15px;
      opacity: 0.9;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 20px;
      padding: 30px;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
    }
    .stat {
      text-align: center;
      padding: 20px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 5px rgba(0,0,0,0.05);
    }
    .stat-number {
      font-size: 2.5em;
      font-weight: bold;
      color: #667eea;
    }
    .stat-label {
      color: #666;
      margin-top: 5px;
      font-size: 0.9em;
    }
    .error-tabs {
      display: flex;
      gap: 10px;
      padding: 20px 30px 10px;
      background: #fafafa;
      border-bottom: 2px solid #e0e0e0;
    }
    .tab {
      padding: 10px 20px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 5px 5px 0 0;
      cursor: pointer;
      transition: all 0.3s;
    }
    .tab.active {
      background: #667eea;
      color: white;
      border-color: #667eea;
    }
    .tab-count {
      background: rgba(0,0,0,0.1);
      padding: 2px 8px;
      border-radius: 10px;
      margin-left: 8px;
      font-size: 0.85em;
    }
    .errors { padding: 30px; }
    .error-section {
      display: none;
    }
    .error-section.active {
      display: block;
    }
    .error-group {
      margin-bottom: 20px;
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      overflow: hidden;
    }
    .error-group.cors {
      border-left: 4px solid #ef4444;
    }
    .error-group.network {
      border-left: 4px solid #f59e0b;
    }
    .error-group.console {
      border-left: 4px solid #3b82f6;
    }
    .error-group.uncaught {
      border-left: 4px solid #8b5cf6;
    }
    .error-header {
      background: #f8f8f8;
      padding: 15px 20px;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: background 0.3s;
    }
    .error-header:hover { background: #f0f0f0; }
    .error-title {
      flex: 1;
      font-family: 'Courier New', monospace;
      font-size: 0.95em;
      color: #d73027;
      word-break: break-word;
    }
    .error-type {
      display: inline-block;
      padding: 3px 8px;
      background: #667eea;
      color: white;
      border-radius: 3px;
      font-size: 0.75em;
      margin-right: 10px;
    }
    .error-stats {
      display: flex;
      gap: 15px;
      align-items: center;
    }
    .badge {
      padding: 5px 12px;
      border-radius: 20px;
      font-size: 0.85em;
      font-weight: bold;
    }
    .badge.count {
      background: #fee0e0;
      color: #d73027;
    }
    .badge.urls {
      background: #e0f0ff;
      color: #2166ac;
    }
    .badge.severity-error {
      background: #fee0e0;
      color: #d73027;
    }
    .badge.severity-warning {
      background: #fef3c7;
      color: #d97706;
    }
    .badge.severity-critical {
      background: #dc2626;
      color: white;
    }
    .error-details {
      padding: 20px;
      background: #fafafa;
      display: none;
    }
    .error-details.active { display: block; }
    .url-list {
      margin-top: 15px;
      max-height: 300px;
      overflow-y: auto;
    }
    .url-item {
      padding: 8px 12px;
      background: white;
      margin-bottom: 5px;
      border-radius: 4px;
      border-left: 3px solid #667eea;
      font-size: 0.9em;
    }
    .url-item a {
      color: #2166ac;
      text-decoration: none;
      word-break: break-all;
    }
    .url-item a:hover { text-decoration: underline; }
    .example-box {
      background: #f8f8f8;
      border: 1px solid #ddd;
      border-radius: 5px;
      padding: 10px;
      margin-top: 10px;
      font-size: 0.85em;
    }
    .filter-bar {
      padding: 20px 30px;
      background: #fafafa;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      gap: 15px;
      align-items: center;
    }
    input[type="search"] {
      flex: 1;
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 1em;
    }
    select {
      padding: 10px 15px;
      border: 1px solid #ddd;
      border-radius: 5px;
      font-size: 1em;
      background: white;
    }
    .no-errors {
      text-align: center;
      padding: 60px 30px;
      color: #666;
    }
    .no-errors svg {
      width: 80px;
      height: 80px;
      margin-bottom: 20px;
      color: #4ade80;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🔍 Console Error Monitor Report</h1>
      <div class="meta">
        <div>📅 Generated: ${new Date(timestamp).toLocaleString()}</div>
        <div>🌐 Total URLs Scanned: ${this.processedUrls.size}</div>
        <div>⏱️ Next Run: ${new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleString()}</div>
      </div>
    </header>
    
    <div class="summary">
      <div class="stat">
        <div class="stat-number">${this.errors.size}</div>
        <div class="stat-label">Unique Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number">${errorsByType.cors.length}</div>
        <div class="stat-label">CORS Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number">${errorsByType.network.length}</div>
        <div class="stat-label">Network Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number">${errorsByType.uncaught.length}</div>
        <div class="stat-label">Uncaught Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number">${errorsByType.console.length}</div>
        <div class="stat-label">Console Errors</div>
      </div>
      <div class="stat">
        <div class="stat-number">${this.urlErrors.size}</div>
        <div class="stat-label">Affected Pages</div>
      </div>
      <div class="stat">
        <div class="stat-number">${((this.urlErrors.size / this.processedUrls.size) * 100).toFixed(1)}%</div>
        <div class="stat-label">Error Rate</div>
      </div>
    </div>
    
    <div class="filter-bar">
      <input type="search" id="searchInput" placeholder="Search errors...">
      <select id="sortSelect">
        <option value="count">Sort by Count</option>
        <option value="urls">Sort by URLs Affected</option>
        <option value="recent">Sort by Most Recent</option>
        <option value="severity">Sort by Severity</option>
      </select>
    </div>
    
    <div class="error-tabs">
      <div class="tab active" onclick="showTab('all')">
        All Errors <span class="tab-count">${sortedErrors.length}</span>
      </div>
      <div class="tab" onclick="showTab('cors')">
        CORS <span class="tab-count">${errorsByType.cors.length}</span>
      </div>
      <div class="tab" onclick="showTab('network')">
        Network <span class="tab-count">${errorsByType.network.length}</span>
      </div>
      <div class="tab" onclick="showTab('uncaught')">
        Uncaught <span class="tab-count">${errorsByType.uncaught.length}</span>
      </div>
      <div class="tab" onclick="showTab('console')">
        Console <span class="tab-count">${errorsByType.console.length}</span>
      </div>
    </div>
    
    <div class="errors">
      <!-- All Errors -->
      <div class="error-section active" id="all-errors">
        ${sortedErrors.length === 0 ? this.getNoErrorsHtml() : sortedErrors.map(([key, error], index) => 
          this.getErrorGroupHtml(key, error, `all-${index}`)
        ).join('')}
      </div>
      
      <!-- CORS Errors -->
      <div class="error-section" id="cors-errors">
        ${errorsByType.cors.length === 0 ? this.getNoErrorsHtml('CORS') : errorsByType.cors.map(([key, error], index) => 
          this.getErrorGroupHtml(key, error, `cors-${index}`)
        ).join('')}
      </div>
      
      <!-- Network Errors -->
      <div class="error-section" id="network-errors">
        ${errorsByType.network.length === 0 ? this.getNoErrorsHtml('Network') : errorsByType.network.map(([key, error], index) => 
          this.getErrorGroupHtml(key, error, `network-${index}`)
        ).join('')}
      </div>
      
      <!-- Uncaught Errors -->
      <div class="error-section" id="uncaught-errors">
        ${errorsByType.uncaught.length === 0 ? this.getNoErrorsHtml('Uncaught') : errorsByType.uncaught.map(([key, error], index) => 
          this.getErrorGroupHtml(key, error, `uncaught-${index}`)
        ).join('')}
      </div>
      
      <!-- Console Errors -->
      <div class="error-section" id="console-errors">
        ${errorsByType.console.length === 0 ? this.getNoErrorsHtml('Console') : errorsByType.console.map(([key, error], index) => 
          this.getErrorGroupHtml(key, error, `console-${index}`)
        ).join('')}
      </div>
    </div>
  </div>
  
  <script>
    function toggleDetails(id) {
      const details = document.getElementById('details-' + id);
      details.classList.toggle('active');
    }
    
    function showTab(type) {
      // Update tabs
      document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
      event.target.classList.add('active');
      
      // Update sections
      document.querySelectorAll('.error-section').forEach(section => section.classList.remove('active'));
      document.getElementById(type + '-errors').classList.add('active');
    }
    
    // Search functionality
    document.getElementById('searchInput').addEventListener('input', (e) => {
      const searchTerm = e.target.value.toLowerCase();
      const errorGroups = document.querySelectorAll('.error-group');
      
      errorGroups.forEach(group => {
        const errorText = group.dataset.error.toLowerCase();
        const errorTitle = group.querySelector('.error-title').textContent.toLowerCase();
        
        if (errorText.includes(searchTerm) || errorTitle.includes(searchTerm)) {
          group.style.display = 'block';
        } else {
          group.style.display = 'none';
        }
      });
    });
    
    // Sort functionality
    document.getElementById('sortSelect').addEventListener('change', (e) => {
          const sortBy = e.target.value;
          const container = document.querySelector('.errors');
          const errorGroups = Array.from(document.querySelectorAll('.error-group'));
          
          errorGroups.sort((a, b) => {
            const aCount = parseInt(a.querySelector('.badge.count').textContent);
            const bCount = parseInt(b.querySelector('.badge.count').textContent);
            const aUrls = parseInt(a.querySelector('.badge.urls').textContent);
            const bUrls = parseInt(b.querySelector('.badge.urls').textContent);
            
            switch(sortBy) {
              case 'count': return bCount - aCount;
              case 'urls': return bUrls - aUrls;
              default: return 0;
            }
          });
          
          errorGroups.forEach(group => container.appendChild(group));
        });
      </script>
    </body>
    </html>`;
        
        return html;
      }
    
      // Escape HTML for safe display
      escapeHtml(text) {
        const map = {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
      }
    
      // Generate JSON report
      async generateJsonReport() {
        const report = {
          timestamp: new Date().toISOString(),
          summary: {
            totalUrlsScanned: this.processedUrls.size,
            uniqueErrors: this.errors.size,
            totalOccurrences: Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0),
            affectedPages: this.urlErrors.size,
            errorRate: (this.urlErrors.size / this.processedUrls.size) * 100
          },
          errors: Array.from(this.errors.entries()).map(([key, error]) => ({
            normalizedKey: key,
            message: error.message,
            occurrences: error.count,
            affectedUrls: Array.from(error.urls),
            firstSeen: error.firstSeen,
            lastSeen: error.lastSeen,
            details: error.details
          })),
          urlErrors: Array.from(this.urlErrors.entries()).map(([url, errors]) => ({
            url,
            errors
          }))
        };
        
        return JSON.stringify(report, null, 2);
      }
    
      // Main run method
      async run() {
        console.log(`Starting error monitoring run at ${new Date().toISOString()}`);
        
        // Reset data
        this.errors.clear();
        this.urlErrors.clear();
        this.processedUrls.clear();
        
        // Generate URLs to check
        const urls = this.generateUrls();
        console.log(`Generated ${urls.length} URLs to check`);
        
        // Mark as processed
        urls.forEach(url => this.processedUrls.add(url));
        
        // Process all URLs
        const results = await this.processUrls(urls);
        
        // Generate reports
        await fs.mkdir(this.config.outputDir, { recursive: true });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        
        // Save HTML report
        const htmlReport = await this.generateHtmlReport();
        const htmlPath = path.join(this.config.outputDir, `error-report-${timestamp}.html`);
        await fs.writeFile(htmlPath, htmlReport);
        
        // Save latest report
        const latestHtmlPath = path.join(this.config.outputDir, 'latest-report.html');
        await fs.writeFile(latestHtmlPath, htmlReport);
        
        // Save JSON report
        const jsonReport = await this.generateJsonReport();
        const jsonPath = path.join(this.config.outputDir, `error-report-${timestamp}.json`);
        await fs.writeFile(jsonPath, jsonReport);
        
        console.log(`Reports generated:`);
        console.log(`  HTML: ${htmlPath}`);
        console.log(`  JSON: ${jsonPath}`);
        console.log(`  Latest: ${latestHtmlPath}`);
        
        // Log summary
        console.log(`\nSummary:`);
        console.log(`  - Unique errors found: ${this.errors.size}`);
        console.log(`  - Total occurrences: ${Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0)}`);
        console.log(`  - Affected pages: ${this.urlErrors.size}/${this.processedUrls.size}`);
        
        return {
          htmlPath,
          jsonPath,
          summary: {
            uniqueErrors: this.errors.size,
            totalOccurrences: Array.from(this.errors.values()).reduce((sum, e) => sum + e.count, 0),
            affectedPages: this.urlErrors.size
          }
        };
      }
    
      // Schedule recurring runs
      scheduleRuns() {
        // Run every 2 hours
        cron.schedule('0 */2 * * *', async () => {
          console.log('Starting scheduled error monitoring run...');
          try {
            await this.run();
          } catch (error) {
            console.error('Error during scheduled run:', error);
          }
        });
        
        console.log('Error monitoring scheduled to run every 2 hours');
      }
    }
    
    // Load URLs from external file if needed
    async function loadUrlsFromFile(filePath) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        return content.split('\n').filter(url => url.trim());
      } catch (error) {
        console.error(`Error loading URLs from file: ${error.message}`);
        return [];
      }
    }
    
    // Main execution
    async function main() {
      // Configuration
      const config = {
        baseUrls: [
          'https://www.salesforce.com',
          // Add more base URLs here
        ],
        confPatterns: ['/conf/', '/confirmation/', '/asyncconf'],
        locales: ['en-US'],
        maxConcurrent: 10,
        timeout: 30000,
        outputDir: './reports',
        retryLimit: 2
      };
      
      // You can also load URLs from a file
      // const additionalUrls = await loadUrlsFromFile('./urls.txt');
      
      const monitor = new ConsoleErrorMonitor(config);
      
      // Run immediately
      await monitor.run();
      
      // Schedule recurring runs
      monitor.scheduleRuns();
      
      // Keep the process running
      console.log('Monitor is running. Press Ctrl+C to stop.');
    }
    
    // Handle graceful shutdown
    process.on('SIGINT', () => {
      console.log('\nGracefully shutting down...');
      process.exit(0);
    });
    
    // Run if this is the main module
    if (require.main === module) {
      main().catch(console.error);
    }
    
    module.exports = ConsoleErrorMonitor;