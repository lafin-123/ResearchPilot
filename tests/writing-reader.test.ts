import test from 'node:test'
import assert from 'node:assert/strict'

test('reader chapters retain complete prose without overlapping chunk repetitions', async () => {
  const { readerChapters } = await import('../src/renderer/src/lib/writing-reader')
  const input = '# 标题\n\n## 方法\n' + '正文。'.repeat(1000) + '\n## 结果\nn=42。'
  const chapters = readerChapters(input)
  assert.deepEqual(chapters.map(c => c.title), ['标题', '方法', '结果'])
  assert.equal(chapters.map(c => c.raw).join(''), input)
  assert.equal(chapters[1].body.match(/正文。/g)?.length, 1000)
})

test('LaTeX heading commands do not swallow same-line prose', async () => {
  const { readerChapters } = await import('../src/renderer/src/lib/writing-reader')
  const chapter = readerChapters('\\section{Methods} The first sentence.\nThe second sentence.')[0]
  assert.equal(chapter.title, 'Methods')
  assert.match(chapter.body, /The first sentence\./)
  assert.match(chapter.body, /The second sentence\./)
})

test('saved DOCX title is not repeated and Chinese limitations remain a chapter', async () => {
  const { readerChapters } = await import('../src/renderer/src/lib/writing-reader')
  const chapters = readerChapters('论文标题\n\n摘要\n\n摘要正文\n\n局限\n\n演示范围。', '论文标题')
  assert.ok(!chapters.map(c => c.body).join('').includes('论文标题'))
  assert.ok(chapters.some(c => c.title === '局限'))
})

test('reader recognizes raw DOCX and LaTeX headings without interpreting HTML', async () => {
  const { readerChapters } = await import('../src/renderer/src/lib/writing-reader')
  assert.deepEqual(readerChapters('Methods\n\n观察。\n\nResults\n\n<script>alert(1)</script>').map(c => c.title), ['Methods', 'Results'])
  assert.deepEqual(readerChapters('\\section{方法}\n实际设计\n\\section{结果}\n实际结果').map(c => c.title), ['方法', '结果'])
  assert.equal(readerChapters('没有章节的正文')[0].body, '没有章节的正文')
})
