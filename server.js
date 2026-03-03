import express from 'express'
import cors from 'cors'
import { chromium } from 'playwright'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

// ─── 접근성 검사 API ───────────────────────────────────────────────
app.post('/api/scan', async (req, res) => {
  const { url, level = 'wcag2aa', includeScreenshot = true } = req.body

  if (!url) {
    return res.status(400).json({ error: 'URL이 필요합니다.' })
  }

  let normalizedUrl = url
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'https://' + normalizedUrl
  }

  let browser
  try {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 900 })

    // 페이지 로드
    await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(1500)

    // 페이지 메타 정보
    const pageTitle = await page.title()
    const pageUrl = page.url()

    // 스크린샷
    let screenshotBase64 = null
    if (includeScreenshot) {
      const screenshotBuf = await page.screenshot({ fullPage: false, type: 'png' })
      screenshotBase64 = screenshotBuf.toString('base64')
    }

    // axe-core 삽입 후 실행
    const axeSource = readFileSync(join(__dirname, 'node_modules/axe-core/axe.min.js'), 'utf8')
    await page.addScriptTag({ content: axeSource })

    const axeResults = await page.evaluate(async (runLevel) => {
      return await window.axe.run(document, {
        runOnly: {
          type: 'tag',
          values: runLevel === 'wcag2a' ? ['wcag2a'] :
                  runLevel === 'wcag2aa' ? ['wcag2a', 'wcag2aa'] :
                  ['wcag2a', 'wcag2aa', 'wcag2aaa']
        }
      })
    }, level)

    // 심각도별 분류
    const violations = axeResults.violations.map(v => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      tags: v.tags,
      nodes: v.nodes.map(n => ({
        html: n.html,
        failureSummary: n.failureSummary,
        target: n.target
      }))
    }))

    const passes = axeResults.passes.length
    const incomplete = axeResults.incomplete.length
    const inapplicable = axeResults.inapplicable.length

    // 심각도 집계
    const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 }
    violations.forEach(v => { if (v.impact) impactCounts[v.impact] = (impactCounts[v.impact] || 0) + 1 })

    // 점수 계산 (간단한 알고리즘)
    const total = violations.length + passes
    const score = total === 0 ? 100 : Math.max(0, Math.round(100 - (
      (impactCounts.critical * 10 + impactCounts.serious * 5 + impactCounts.moderate * 2 + impactCounts.minor * 1) / Math.max(1, total) * 100
    )))

    const result = {
      id: Date.now().toString(),
      scannedAt: new Date().toISOString(),
      url: pageUrl,
      pageTitle,
      level,
      score,
      summary: {
        violations: violations.length,
        passes,
        incomplete,
        inapplicable,
        impactCounts
      },
      violations,
      screenshot: screenshotBase64
    }

    await browser.close()
    return res.json(result)

  } catch (err) {
    if (browser) await browser.close().catch(() => {})
    console.error('스캔 오류:', err.message)
    return res.status(500).json({ error: '스캔 중 오류가 발생했습니다: ' + err.message })
  }
})

// ─── 리포트 HTML 생성 API ─────────────────────────────────────────
app.post('/api/report', (req, res) => {
  const result = req.body
  if (!result || !result.url) {
    return res.status(400).json({ error: '검사 결과가 필요합니다.' })
  }

  const impactColor = { critical: '#dc2626', serious: '#ea580c', moderate: '#d97706', minor: '#65a30d' }
  const impactLabel = { critical: '치명적', serious: '심각', moderate: '보통', minor: '경미' }

  const violationsHtml = result.violations.map((v, i) => `
    <div class="violation" style="border-left: 4px solid ${impactColor[v.impact] || '#6b7280'}; margin-bottom: 20px; padding: 12px 16px; background: #fafafa; border-radius: 0 8px 8px 0;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <strong style="font-size:15px; color:#1e293b;">${i + 1}. ${v.help}</strong>
        <span style="background:${impactColor[v.impact] || '#6b7280'}; color:white; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:600;">
          ${impactLabel[v.impact] || v.impact}
        </span>
      </div>
      <p style="color:#475569; font-size:13px; margin-bottom:8px;">${v.description}</p>
      <div style="font-size:12px; color:#64748b; margin-bottom:8px;">
        <strong>규칙 ID:</strong> ${v.id} &nbsp;|&nbsp; 
        <strong>태그:</strong> ${v.tags.join(', ')} &nbsp;|&nbsp;
        <a href="${v.helpUrl}" style="color:#3b82f6;">자세히 보기 →</a>
      </div>
      <div style="background:#f1f5f9; border-radius:6px; padding:10px; font-size:12px;">
        <strong>영향받는 요소 (${v.nodes.length}개):</strong>
        ${v.nodes.slice(0, 3).map(n => `
          <div style="margin-top:6px; font-family:monospace; background:#e2e8f0; padding:4px 8px; border-radius:4px; word-break:break-all;">${escapeHtml(n.html)}</div>
          <div style="color:#64748b; margin-top:2px;">${n.failureSummary || ''}</div>
        `).join('')}
        ${v.nodes.length > 3 ? `<div style="color:#94a3b8; margin-top:4px;">... 외 ${v.nodes.length - 3}개 요소</div>` : ''}
      </div>
    </div>
  `).join('')

  const screenshotSection = result.screenshot ? `
    <div class="section">
      <h2>📸 페이지 스크린샷</h2>
      <img src="data:image/png;base64,${result.screenshot}" style="max-width:100%; border:1px solid #e2e8f0; border-radius:8px; box-shadow: 0 4px 6px rgba(0,0,0,0.07);" />
    </div>
  ` : ''

  const scoreColor = result.score >= 80 ? '#22c55e' : result.score >= 50 ? '#f59e0b' : '#ef4444'

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>접근성 검사 보고서 - ${escapeHtml(result.url)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Apple SD Gothic Neo', 'Malgun Gothic', Arial, sans-serif; background: #f8fafc; color: #1e293b; }
  .header { background: linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%); color: white; padding: 40px; }
  .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 8px; }
  .header .meta { font-size: 13px; opacity: 0.85; margin-top: 4px; }
  .container { max-width: 960px; margin: 0 auto; padding: 32px 20px; }
  .section { background: white; border-radius: 12px; padding: 28px; margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .section h2 { font-size: 18px; font-weight: 700; margin-bottom: 18px; color: #1e293b; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; }
  .score-box { text-align: center; padding: 20px; }
  .score-num { font-size: 72px; font-weight: 800; color: ${scoreColor}; line-height: 1; }
  .score-label { font-size: 16px; color: #64748b; margin-top: 6px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  .stat { text-align: center; padding: 16px; background: #f8fafc; border-radius: 8px; }
  .stat-num { font-size: 32px; font-weight: 700; }
  .stat-label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .impact-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .impact-item { padding: 14px; border-radius: 8px; text-align: center; }
  .impact-item .num { font-size: 28px; font-weight: 700; color: white; }
  .impact-item .lbl { font-size: 12px; color: rgba(255,255,255,0.9); margin-top: 2px; }
  .badge-wcag { display: inline-block; background: #eff6ff; color: #1d4ed8; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
  .footer { text-align: center; color: #94a3b8; font-size: 12px; margin-top: 32px; padding-bottom: 40px; }
  @media print { body { background: white; } .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
<div class="header">
  <div style="max-width:960px; margin:0 auto;">
    <h1>♿ 웹 접근성 검사 보고서</h1>
    <div class="meta">🌐 대상 URL: ${escapeHtml(result.url)}</div>
    <div class="meta">📄 페이지 제목: ${escapeHtml(result.pageTitle || '알 수 없음')}</div>
    <div class="meta">📅 검사 일시: ${new Date(result.scannedAt).toLocaleString('ko-KR')}</div>
    <div class="meta">📋 검사 기준: <span class="badge-wcag">${result.level.toUpperCase()}</span></div>
  </div>
</div>
<div class="container">
  <div class="section">
    <h2>🏆 종합 점수</h2>
    <div style="display:grid; grid-template-columns: 1fr 2fr; gap: 24px; align-items:center;">
      <div class="score-box">
        <div class="score-num">${result.score}</div>
        <div class="score-label">/ 100점</div>
      </div>
      <div>
        <div class="stats">
          <div class="stat">
            <div class="stat-num" style="color:#ef4444;">${result.summary.violations}</div>
            <div class="stat-label">위반 항목</div>
          </div>
          <div class="stat">
            <div class="stat-num" style="color:#22c55e;">${result.summary.passes}</div>
            <div class="stat-label">통과 항목</div>
          </div>
          <div class="stat">
            <div class="stat-num" style="color:#f59e0b;">${result.summary.incomplete}</div>
            <div class="stat-label">검토 필요</div>
          </div>
          <div class="stat">
            <div class="stat-num" style="color:#94a3b8;">${result.summary.inapplicable}</div>
            <div class="stat-label">해당없음</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>⚠️ 심각도별 위반 현황</h2>
    <div class="impact-grid">
      <div class="impact-item" style="background:#dc2626;">
        <div class="num">${result.summary.impactCounts.critical || 0}</div>
        <div class="lbl">치명적 (Critical)</div>
      </div>
      <div class="impact-item" style="background:#ea580c;">
        <div class="num">${result.summary.impactCounts.serious || 0}</div>
        <div class="lbl">심각 (Serious)</div>
      </div>
      <div class="impact-item" style="background:#d97706;">
        <div class="num">${result.summary.impactCounts.moderate || 0}</div>
        <div class="lbl">보통 (Moderate)</div>
      </div>
      <div class="impact-item" style="background:#65a30d;">
        <div class="num">${result.summary.impactCounts.minor || 0}</div>
        <div class="lbl">경미 (Minor)</div>
      </div>
    </div>
  </div>

  ${screenshotSection}

  ${result.violations.length > 0 ? `
  <div class="section">
    <h2>🔍 위반 항목 상세</h2>
    ${violationsHtml}
  </div>
  ` : `
  <div class="section" style="text-align:center; padding: 48px;">
    <div style="font-size:48px; margin-bottom:16px;">🎉</div>
    <h2 style="border:none; color:#22c55e;">위반 항목 없음</h2>
    <p style="color:#64748b; margin-top:8px;">모든 접근성 검사를 통과했습니다!</p>
  </div>
  `}

  <div class="footer">
    <p>본 보고서는 axe-core 기반 자동 접근성 검사 결과입니다.</p>
    <p>자동 검사는 전체 접근성 이슈의 일부만 탐지할 수 있으며, 전문가 수동 검사를 병행하시기 바랍니다.</p>
    <p style="margin-top:8px; color:#cbd5e1;">생성 일시: ${new Date().toLocaleString('ko-KR')}</p>
  </div>
</div>
</body>
</html>`

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="accessibility-report-${Date.now()}.html"`)
  res.send(html)
})

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── 서버 시작 ────────────────────────────────────────────────────
const PORT = 3000
createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 접근성 검사 서버 실행 중: http://0.0.0.0:${PORT}`)
})
