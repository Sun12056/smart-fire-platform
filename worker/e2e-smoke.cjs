// E2E 冒烟：api 模式前端 → Workers → D1 闭环验证（走系统 Edge）
const { chromium } = require('playwright-core')

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage()
  const logs = []
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
  page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure() && r.failure().errorText}`))
  page.on('response', (r) => { if (r.url().includes('8787')) logs.push(`[api] ${r.status()} ${r.request().method()} ${r.url()}`) })

  try {
    await page.goto('http://localhost:5199/', { waitUntil: 'load', timeout: 30000 })
    await page.waitForTimeout(6000)
    const bodyText = await page.evaluate(() => document.body.innerText)
    console.log('=== 浏览器控制台 / API 请求 ===')
    logs.forEach((l) => console.log(l))
    console.log('=== 页面关键内容检查 ===')
    const checks = ['楼宇态势', '1号楼', '设备', '告警']
    checks.forEach((k) => console.log(`${bodyText.includes(k) ? '✓' : '✗'} 包含「${k}」`))
    const numMatch = bodyText.match(/\d{2,}/g)
    console.log('页面数字样本:', numMatch ? numMatch.slice(0, 10).join(', ') : '无')
  } catch (e) {
    console.log('ERROR:', e.message)
    logs.forEach((l) => console.log(l))
  } finally {
    await browser.close()
  }
})()
