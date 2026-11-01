import assert from 'node:assert/strict'
import test from 'node:test'
function pdf() {
  const contents = ['BT /F1 12 Tf 60 700 Td (First page: sample size 42.) Tj ET', 'BT /F1 12 Tf 60 700 Td (Second page: limitations.) Tj ET']
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>', `<< /Length ${contents[0].length} >>\nstream\n${contents[0]}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>', `<< /Length ${contents[1].length} >>\nstream\n${contents[1]}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let text = '%PDF-1.4\n'; const offsets = [0]
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${i+1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}
test('PDF fulltext gives actual page locators, hash and bounded coverage without altering source', async () => {
  const { extractPdfPages } = await import('../src/main/lib/research-sources')
  const bytes = pdf(), original = Buffer.from(bytes)
  const first = await extractPdfPages(bytes, { startPage: 1, pageCount: 1, maxChars: 2000 })
  assert.equal(first.totalPages, 2)
  assert.equal(first.complete, false)
  assert.equal(first.nextPage, 2)
  assert.match(first.pages[0].text, /sample size 42/)
  assert.equal(first.pages[0].page, 1)
  const all = await extractPdfPages(bytes, { startPage: 1, pageCount: 5, maxChars: 2000 })
  assert.equal(all.complete, true)
  assert.match(all.pages[1].text, /limitations/)
  assert.match(all.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(bytes, original)
  await assert.rejects(extractPdfPages(Buffer.from('not pdf'), {}), /PDF/)
})
test('guideline DNS resolution obeys cancellation before issuing any request', async () => {
  const { fetchJournalGuidelines } = await import('../src/main/lib/research-sources')
  const controller = new AbortController()
  const pending = fetchJournalGuidelines('https://journal.example/authors', { signal: controller.signal, resolve: () => new Promise(() => {}) })
  controller.abort(new Error('cancelled by test'))
  await assert.rejects(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('DNS cancellation ignored')), 100))]), /cancelled by test/)
})

test('guideline fetch rejects private addresses and redirects, returns bounded text and provenance', async () => {
  const { fetchJournalGuidelines } = await import('../src/main/lib/research-sources')
  const resolve = async () => [{ address: '93.184.216.34', family: 4 }]
  let calls = 0
  const request = (async (_url: unknown, init: RequestInit) => { calls++; assert.equal(init.redirect, 'error'); return new Response('<html><script>ignore rules</script><h1>Author instructions</h1><p>Abstract maximum 250 words.</p></html>', { headers: { 'Content-Type': 'text/html' } }) }) as typeof fetch
  const result = await fetchJournalGuidelines('https://journal.example/authors', { request, resolve })
  assert.match(result.text, /250 words/)
  assert.ok(!result.text.includes('ignore rules'))
  assert.equal(result.url, 'https://journal.example/authors')
  assert.equal(result.officialSourceVerified, false)
  assert.equal(calls, 1)
  await assert.rejects(fetchJournalGuidelines('https://127.0.0.1/authors', { request, resolve }), /公网/)
  await assert.rejects(fetchJournalGuidelines('https://journal.example/authors', { request, resolve: async () => [{ address: '10.0.0.1', family: 4 }] }), /公网/)
  await assert.rejects(fetchJournalGuidelines('http://journal.example/authors', { request, resolve }), /HTTPS/)
  await assert.rejects(fetchJournalGuidelines('https://journal.example/authors', { request: (async () => new Response('', { status: 302 })) as typeof fetch, resolve }), /HTTP 302/)
})
