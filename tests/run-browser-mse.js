'use strict';
/*
 * run-browser-mse.js — 用真实浏览器（Playwright Chromium）跑 test-mse.html。
 * 需要：npm i -D playwright && npx playwright install chromium
 * 运行：node tests/run-browser-mse.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webm': 'video/webm',
};

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/media/')) return serveFile(res, path.join(ROOT, url));
  const rel = url === '/' ? '/test-mse.html' : url;
  return serveFile(res, path.join(ROOT, 'public', rel));
});

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.log('[console]', m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`http://127.0.0.1:${port}/test-mse.html`);
    await page.waitForFunction(
      () => /^MSE-TEST: (PASS|FAIL)/.test(document.title),
      null,
      { timeout: 60000 },
    );
    const title = await page.title();
    console.log(await page.textContent('#out'));
    console.log(title);
    if (!title.includes('PASS')) {
      process.exitCode = 1;
      return;
    }

    // 第二段：主页面冒烟 —— 开始加载后出现可播放标记；跳播段5后段5可播放
    const page2 = await browser.newPage();
    page2.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page2.goto(`http://127.0.0.1:${port}/index.html`);
    await page2.click('#start');
    await page2.waitForFunction(
      () => document.querySelectorAll('td.playable').length >= 1,
      null,
      { timeout: 15000 },
    );
    await page2.evaluate(() => {
      [...document.querySelectorAll('#seekrow button')]
        .find((b) => b.textContent.includes('段5'))
        .click();
    });
    await page2.waitForFunction(
      () => document.getElementById('video').currentTime > 3.5 &&
            document.getElementById('playable').cells[5].className === 'playable' &&
            document.getElementById('playable').cells[1].className !== 'playable',
      null,
      { timeout: 15000 },
    );
    console.log('主页面冒烟通过:', (await page2.textContent('#buftext')).trim());
    const errVisible = await page2.evaluate(
      () => document.getElementById('err').style.display === 'block',
    );
    if (errVisible) {
      console.log('主页面出现错误横幅:', await page2.textContent('#err'));
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  server.close();
  process.exitCode = 1;
});
