import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  convertInchesToTwip
} from 'docx'

// Explicit A4 geometry keeps tables and figures inside the same one-inch margins.
const PAGE_WIDTH_DXA = 11906
const PAGE_HEIGHT_DXA = 16838
const PAGE_MARGIN_DXA = convertInchesToTwip(1)
const CONTENT_WIDTH_DXA = PAGE_WIDTH_DXA - PAGE_MARGIN_DXA * 2
const MAX_IMAGE_WIDTH_PX = CONTENT_WIDTH_DXA / 15 // 96 px/in; 1440 DXA/in
const MAX_IMAGE_HEIGHT_PX = 720 // Leave space for the caption on a portrait page.

export interface ResolvedDocxImage {
  data: Buffer
  type: 'png' | 'jpg'
  /** Intrinsic source dimensions in pixels, not DXA or EMU. */
  width: number
  height: number
}

type Block =
  | { type: 'image'; src: string; caption: string }
  | { type: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string; level: number }
  | { type: 'numbered'; text: string; level: number }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'equation'; text: string }
  | { type: 'rule' }
  | { type: 'table'; rows: string[][] }

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line) && line.includes('-')
}

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let code: string[] | null = null
  let equation: string[] | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', text: paragraph.join(' ').trim() })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()

    if (code !== null) {
      if (trimmed.startsWith('```')) {
        blocks.push({ type: 'code', text: code.join('\n') })
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (trimmed.startsWith('```')) {
      flushParagraph()
      code = []
      continue
    }
    if (equation !== null) {
      if (trimmed.endsWith('$$')) {
        blocks.push({ type: 'equation', text: [...equation, trimmed.slice(0, -2)].join('\n').trim() })
        equation = null
      } else {
        equation.push(line)
      }
      continue
    }
    if (trimmed.startsWith('$$')) {
      flushParagraph()
      if (trimmed.length > 4 && trimmed.endsWith('$$')) {
        blocks.push({ type: 'equation', text: trimmed.slice(2, -2).trim() })
      } else {
        equation = [trimmed.slice(2)]
      }
      continue
    }

    if (!trimmed) {
      flushParagraph()
      continue
    }

    const image = /^!\[((?:\\.|[^\]\\])*)\]\((.+)\)$/.exec(trimmed)
    if (image) {
      flushParagraph()
      // The optional Markdown title is not the figure caption; the alt text is.
      let src = image[2]!.trim().replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '')
      if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1)
      blocks.push({ type: 'image', src, caption: image[1]!.replace(/\\([\[\]\\])/g, '$1') })
      continue
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|') && lines[index + 1] && isTableDivider(lines[index + 1] ?? '')) {
      flushParagraph()
      const rows: string[][] = [splitTableRow(trimmed)]
      index += 2
      while (index < lines.length) {
        const next = (lines[index] ?? '').trim()
        if (!next.startsWith('|') || !next.endsWith('|')) break
        rows.push(splitTableRow(next))
        index += 1
      }
      index -= 1
      blocks.push({ type: 'table', rows })
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      blocks.push({ type: 'heading', level: heading[1]!.length as 1 | 2 | 3 | 4, text: heading[2]!.trim() })
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph()
      blocks.push({ type: 'rule' })
      continue
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      blocks.push({ type: 'bullet', text: bullet[2]!.trim(), level: Math.min(Math.floor(bullet[1]!.length / 2), 3) })
      continue
    }

    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      flushParagraph()
      blocks.push({ type: 'numbered', text: numbered[2]!.trim(), level: Math.min(Math.floor(numbered[1]!.length / 2), 3) })
      continue
    }

    if (trimmed.startsWith('>')) {
      flushParagraph()
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') })
      continue
    }

    paragraph.push(trimmed)
  }

  if (code !== null) blocks.push({ type: 'code', text: code.join('\n') })
  if (equation !== null) blocks.push({ type: 'equation', text: equation.join('\n').trim() })
  flushParagraph()
  return blocks
}

function inlineRuns(text: string, options: { bold?: boolean; italics?: boolean; size?: number; color?: string } = {}): TextRun[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g).filter(Boolean)
  return parts.map((part) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return new TextRun({ text: part.slice(2, -2), bold: true, italics: options.italics, size: options.size, color: options.color })
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return new TextRun({ text: part.slice(1, -1), italics: true, bold: options.bold, size: options.size, color: options.color })
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return new TextRun({ text: part.slice(1, -1), font: 'Consolas', size: options.size ? options.size - 1 : 20 })
    }
    return new TextRun({ text: part, bold: options.bold, italics: options.italics, size: options.size, color: options.color })
  })
}

function blockToParagraph(block: Block): Paragraph | Table | null {
  switch (block.type) {
    case 'heading': {
      const heading =
        block.level === 1 ? HeadingLevel.TITLE : block.level === 2 ? HeadingLevel.HEADING_1 : block.level === 3 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3
      return new Paragraph({
        heading,
        spacing: { before: block.level === 1 ? 0 : 280, after: 140 },
        alignment: block.level === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
        children: inlineRuns(block.text, { size: block.level === 1 ? 36 : block.level === 2 ? 30 : block.level === 3 ? 26 : 24, color: '1D241F' })
      })
    }
    case 'paragraph':
      return new Paragraph({
        spacing: { line: 360, after: 160 },
        children: inlineRuns(block.text, { size: 22 })
      })
    case 'bullet':
      return new Paragraph({
        bullet: { level: block.level },
        spacing: { line: 340, after: 80 },
        children: inlineRuns(block.text, { size: 22 })
      })
    case 'numbered':
      return new Paragraph({
        numbering: { reference: 'research-numbering', level: block.level },
        spacing: { line: 340, after: 80 },
        children: inlineRuns(block.text, { size: 22 })
      })
    case 'quote':
      return new Paragraph({
        indent: { left: convertInchesToTwip(0.35) },
        spacing: { line: 340, after: 120 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'B7C4B8', space: 12 } },
        children: inlineRuns(block.text, { italics: true, size: 21, color: '4A554D' })
      })
    case 'code':
      return new Paragraph({
        shading: { fill: 'F2F4EF' },
        spacing: { before: 80, after: 160 },
        children: block.text.split('\n').flatMap((line, index) => {
          const runs = [new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })]
          if (index < block.text.split('\n').length - 1) runs.push(new TextRun({ break: 1 }))
          return runs
        })
      })
    case 'equation':
      return new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 160 },
        children: [new TextRun({ text: block.text, font: 'Cambria Math', italics: true, size: 22 })]
      })
    case 'rule':
      return new Paragraph({
        spacing: { before: 120, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D6DCD3', space: 1 } },
        children: []
      })
    case 'table': {
      const columnCount = Math.max(1, ...block.rows.map((row) => row.length))
      const columnWidths = Array.from({ length: columnCount }, (_, index) =>
        Math.floor(CONTENT_WIDTH_DXA / columnCount) + (index < CONTENT_WIDTH_DXA % columnCount ? 1 : 0))
      const rows = block.rows.map((row, rowIndex) => new TableRow({
        tableHeader: rowIndex === 0,
        children: columnWidths.map((width, index) => new TableCell({
          width: { size: width, type: WidthType.DXA },
          shading: rowIndex === 0 ? { fill: 'EEF1EA' } : undefined,
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [new Paragraph({ children: inlineRuns(row[index] ?? '', { bold: rowIndex === 0, size: 19 }) })]
        }))
      }))
      return new Table({
        width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
        columnWidths,
        layout: TableLayoutType.FIXED,
        borders: {
          top: { style: BorderStyle.SINGLE, size: 8, color: 'B9C2B7' },
          bottom: { style: BorderStyle.SINGLE, size: 8, color: 'B9C2B7' },
          left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'D9DED5' },
          insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
        },
        rows
      })
    }
    default:
      return null
  }
}

export interface BuildDocxOptions {
  title: string
  markdown: string
  author?: string
  /**
   * Resolve only trusted project-local assets. The caller must enforce project
   * containment (including symlinks), read the image, and rasterize SVG to PNG.
   * This builder performs no filesystem or network access.
   */
  resolveImage?: (src: string) => Promise<ResolvedDocxImage | undefined>
}

function validateImageSource(src: string): void {
  // Do not turn Markdown into a network client or an arbitrary-file reader.
  // URL escaping is intentionally unsupported: pass a literal project path.
  if (!src || /[\\\x00-\x1f\x7f:%?#]/.test(src) || src.startsWith('/') || src.split('/').some((part) => part === '..')) {
    throw new Error(`DOCX image must use a project-relative local path: ${src}`)
  }
}

async function imageParagraphs(block: Extract<Block, { type: 'image' }>, options: BuildDocxOptions): Promise<Paragraph[]> {
  validateImageSource(block.src)
  if (!options.resolveImage) throw new Error(`Cannot embed DOCX image "${block.src}": no project image resolver was supplied`)
  const image = await options.resolveImage(block.src)
  if (!image) throw new Error(`Cannot embed DOCX image "${block.src}": image not found or not permitted in this project`)
  if (!Buffer.isBuffer(image.data) || image.data.length === 0 ||
    !['png', 'jpg'].includes(image.type) ||
    !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error(`Cannot embed DOCX image "${block.src}": resolver must return PNG/JPG bytes and positive pixel dimensions`)
  }
  const matchesType = image.type === 'png'
    ? image.data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : image.data[0] === 0xff && image.data[1] === 0xd8 && image.data[2] === 0xff
  if (!matchesType) throw new Error(`Cannot embed DOCX image "${block.src}": image bytes do not match ${image.type}`)

  const scale = Math.min(1, MAX_IMAGE_WIDTH_PX / image.width, MAX_IMAGE_HEIGHT_PX / image.height)
  const paragraphs = [new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: Boolean(block.caption),
    spacing: { before: 160, after: block.caption ? 80 : 160 },
    children: [new ImageRun({
      type: image.type,
      data: image.data,
      transformation: { width: image.width * scale, height: image.height * scale },
      altText: { title: block.caption, description: block.caption, name: block.src }
    })]
  })]
  if (block.caption) paragraphs.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 180 },
    children: inlineRuns(block.caption, { size: 20 })
  }))
  return paragraphs
}

export async function buildDocx(options: BuildDocxOptions): Promise<Buffer> {
  const blocks = parseMarkdown(options.markdown)
  let title = options.title
  if (blocks[0]?.type === 'heading' && blocks[0].level === 1) {
    title = blocks[0].text
    blocks.shift()
  }

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: title, bold: true, size: 36 })]
    }),
    ...(options.author
      ? [new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 320 }, children: [new TextRun({ text: options.author, size: 22 })] })]
      : [])
  ]
  for (const block of blocks) {
    if (block.type === 'image') {
      children.push(...await imageParagraphs(block, options))
      continue
    }
    // Inline images are outside this Markdown subset. Never claim a figure was
    // embedded by quietly exporting its Markdown path as manuscript prose.
    const texts = block.type === 'table' ? block.rows.flat() : 'text' in block && block.type !== 'code' ? [block.text] : []
    if (texts.some((text) => /!\[[^\]]*\]\(/.test(text))) {
      throw new Error('DOCX figures must appear as standalone Markdown images: ![caption](project-relative/path)')
    }
    const content = blockToParagraph(block)
    if (content) children.push(content)
  }

  const document = new Document({
    creator: 'ResearchPilot',
    title,
    description: 'Draft generated by ResearchPilot',
    numbering: {
      config: [
        {
          reference: 'research-numbering',
          levels: [
            { level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 420, hanging: 260 } } } },
            { level: 1, format: 'lowerLetter', text: '%2.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 780, hanging: 260 } } } }
          ]
        }
      ]
    },
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 22, color: '1D241F' },
          paragraph: { spacing: { line: 360 } }
        },
        title: { run: { color: '1D241F', bold: true, font: 'Times New Roman' } },
        heading1: { run: { color: '1D241F', bold: true, font: 'Times New Roman' } },
        heading2: { run: { color: '1D241F', bold: true, font: 'Times New Roman' } },
        heading3: { run: { color: '1D241F', bold: true, font: 'Times New Roman' } }
      }
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA },
            margin: {
              top: PAGE_MARGIN_DXA,
              right: PAGE_MARGIN_DXA,
              bottom: PAGE_MARGIN_DXA,
              left: PAGE_MARGIN_DXA
            }
          }
        },
        children
      }
    ]
  })

  return Packer.toBuffer(document)
}
