import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useMemo, useState } from 'react'

type Highlighter = Awaited<ReturnType<(typeof import('shiki/core'))['createHighlighterCore']>>

let highlighterPromise: Promise<Highlighter> | undefined

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= Promise.all([
    import('shiki/core'),
    import('shiki/engine/javascript'),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }]) =>
    createHighlighterCore({
      themes: [
        import('@shikijs/themes/github-light'),
        import('@shikijs/themes/github-dark'),
      ],
      langs: [
        import('@shikijs/langs/typescript'),
        import('@shikijs/langs/javascript'),
        import('@shikijs/langs/tsx'),
        import('@shikijs/langs/jsx'),
        import('@shikijs/langs/json'),
        import('@shikijs/langs/shellscript'),
        import('@shikijs/langs/python'),
        import('@shikijs/langs/rust'),
        import('@shikijs/langs/go'),
        import('@shikijs/langs/css'),
        import('@shikijs/langs/html'),
        import('@shikijs/langs/markdown'),
        import('@shikijs/langs/yaml'),
        import('@shikijs/langs/sql'),
        import('@shikijs/langs/diff'),
      ],
      engine: createJavaScriptRegexEngine({ target: 'ES2024' }),
    }),
  )
  return highlighterPromise
}

const supportedLanguages = new Set([
  'typescript',
  'ts',
  'javascript',
  'js',
  'tsx',
  'jsx',
  'json',
  'bash',
  'sh',
  'shellscript',
  'python',
  'py',
  'rust',
  'go',
  'css',
  'html',
  'markdown',
  'md',
  'yaml',
  'yml',
  'sql',
  'diff',
])

function parseMarkdown(source: string): string {
  const parsed = marked.parse(source, { gfm: true, breaks: true })
  return DOMPurify.sanitize(typeof parsed === 'string' ? parsed : '')
}

function secureLinks(container: ParentNode): void {
  container.querySelectorAll('a').forEach((anchor) => {
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noreferrer noopener')
  })
}

async function highlightCode(html: string, theme: 'light' | 'dark'): Promise<string> {
  const documentFragment = new DOMParser().parseFromString(html, 'text/html')
  const blocks = Array.from(documentFragment.querySelectorAll('pre code'))
  if (blocks.length === 0) {
    secureLinks(documentFragment)
    return DOMPurify.sanitize(documentFragment.body.innerHTML)
  }

  const highlighter = await getHighlighter()
  for (const block of blocks) {
    const languageClass = Array.from(block.classList).find((name) => name.startsWith('language-'))
    const requestedLanguage = languageClass?.slice('language-'.length) ?? 'text'
    const language = supportedLanguages.has(requestedLanguage) ? requestedLanguage : 'text'
    const highlighted = highlighter.codeToHtml(block.textContent ?? '', {
      lang: language as never,
      theme: theme === 'dark' ? 'github-dark' : 'github-light',
    })
    const highlightedDocument = new DOMParser().parseFromString(highlighted, 'text/html')
    const replacement = highlightedDocument.querySelector('pre')
    if (replacement) {
      replacement.classList.add('highlighted-code')
      replacement.style.removeProperty('background-color')
      block.parentElement?.replaceWith(replacement)
    }
  }
  secureLinks(documentFragment)
  return DOMPurify.sanitize(documentFragment.body.innerHTML)
}

interface MarkdownProps {
  children: string
  theme: 'light' | 'dark'
  className?: string
}

export function Markdown({ children, theme, className = '' }: MarkdownProps): React.JSX.Element {
  const initial = useMemo(() => parseMarkdown(children), [children])
  const [html, setHtml] = useState(initial)

  useEffect(() => {
    let cancelled = false
    setHtml(initial)
    const timer = window.setTimeout(() => {
      void highlightCode(initial, theme).then((value) => {
        if (!cancelled) setHtml(value)
      })
    }, 100)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [initial, theme])

  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}

export async function highlightDiffLines(
  lines: string[],
  language: string,
  theme: 'light' | 'dark',
): Promise<string[]> {
  if (lines.length === 0) return []
  const highlighter = await getHighlighter()
  const lang = supportedLanguages.has(language) ? language : 'text'
  const highlighted = highlighter.codeToHtml(lines.join('\n'), {
    lang: lang as never,
    theme: theme === 'dark' ? 'github-dark' : 'github-light',
  })
  const documentFragment = new DOMParser().parseFromString(highlighted, 'text/html')
  return Array.from(documentFragment.querySelectorAll('.line')).map((line) =>
    DOMPurify.sanitize(line.innerHTML),
  )
}
