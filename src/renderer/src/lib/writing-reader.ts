import { splitPaperSections } from '../../../shared/paper-context'

export interface ReaderChapter { id: string; title: string; raw: string; body: string }
export function readerChapters(text: string, documentTitle = ''): ReaderChapter[] {
  const groups: Array<{ id: string; title: string; start: number; end: number }> = []
  for (const section of splitPaperSections(text)) {
    const id = section.id.split('_').slice(0, 2).join('_')
    const previous = groups.at(-1)
    if (previous?.id === id) previous.end = section.end
    else groups.push({ id, title: section.title, start: section.start, end: section.end })
  }
  return groups.map(group => {
    const raw = text.slice(group.start, group.end)
    const firstBreak = raw.indexOf('\n')
    const firstLine = (firstBreak < 0 ? raw : raw.slice(0, firstBreak)).trim()
    const isHeading = /^#{1,6}\s|^\\(?:chapter|section|subsection|subsubsection)\*?\{/.test(firstLine) || firstLine === group.title
    const latexHeading = /^\s*\\(?:chapter|section|subsection|subsubsection)\*?(?:\[[^\]]*\])?\{[^}]+\}/.exec(raw)
    let body = latexHeading ? raw.slice(latexHeading[0].length).trim() : isHeading && group.title !== '正文' ? (firstBreak < 0 ? '' : raw.slice(firstBreak + 1)).trim() : raw
    if (group.start === 0 && documentTitle && firstLine === documentTitle.trim()) body = (firstBreak < 0 ? '' : raw.slice(firstBreak + 1)).trim()
    return { id: group.id, title: group.title, raw, body }
  })
}
