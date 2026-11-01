import sharp from 'sharp'
import { dirname, extname } from 'node:path'
import { existsSync } from 'node:fs'
import { figurePath, readFigureFile } from './figure-files'
import { figureToSvg } from '../../shared/lib/figure-layout'
import { validateFigureSpec } from '../../shared/figure-spec'
import type { ResolvedDocxImage } from './docx-build'

export async function resolveManuscriptImage(root: string, relative: string): Promise<ResolvedDocxImage> {
  const normalized = relative.replaceAll('\\', '/')
  if (!normalized.startsWith('figures/')) throw new Error('论文插图必须来自本项目 figures 目录。')
  figurePath(root, normalized)
  const extension = extname(normalized).toLowerCase()
  let input: Buffer
  if (extension === '.svg') {
    // Regenerate our declarative figure rather than parsing arbitrary SVG with external resources.
    const source = `${dirname(normalized).replaceAll('\\', '/')}/figure.json`
    if (!existsSync(figurePath(root, source))) throw new Error('SVG 插图缺少对应的结构化 figure.json。')
    const spec = validateFigureSpec(JSON.parse(readFigureFile(root, source, 512 * 1024).toString('utf8')))
    input = Buffer.from(figureToSvg(spec))
  } else if (['.png', '.jpg', '.jpeg'].includes(extension)) {
    input = readFigureFile(root, normalized, 16 * 1024 * 1024)
  } else throw new Error('论文插图仅支持本地 PNG/JPEG 或有结构化源的 SVG。')
  const { data, info } = await sharp(input, { limitInputPixels: 24_000_000, density: 150 }).resize({ width: 1800, height: 1400, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
  return { data, type: 'png', width: info.width, height: info.height }
}
