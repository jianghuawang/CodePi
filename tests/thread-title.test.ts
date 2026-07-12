import { describe, expect, it } from 'vitest'
import { autoThreadTitle, DEFAULT_THREAD_TITLE } from '../src/shared/thread-title'

describe('autoThreadTitle', () => {
  it('uses a short prompt verbatim', () => {
    expect(autoThreadTitle('Fix the login redirect bug')).toBe('Fix the login redirect bug')
  })

  it('collapses whitespace and newlines', () => {
    expect(autoThreadTitle('  Fix the\n\nlogin   bug  ')).toBe('Fix the login bug')
  })

  it('stops at the first sentence when one fits', () => {
    expect(autoThreadTitle('Add dark mode support. Start with the settings window and then update the preview pane.'))
      .toBe('Add dark mode support')
  })

  it('keeps short sentence-like prefixes intact', () => {
    expect(autoThreadTitle('Fix v1.2 regression in the parser')).toBe('Fix v1.2 regression in the parser')
  })

  it('truncates long prompts at a word boundary with an ellipsis', () => {
    const title = autoThreadTitle('Refactor the workspace dock so that the terminal and preview panes share a single lifecycle manager across threads')
    expect(title).toBeDefined()
    expect(title!.length).toBeLessThanOrEqual(65)
    expect(title!.endsWith('…')).toBe(true)
    expect(title).not.toContain('  ')
  })

  it('strips leading markdown decoration', () => {
    expect(autoThreadTitle('## Plan: improve exports')).toBe('Plan: improve exports')
  })

  it('ignores bare slash commands', () => {
    expect(autoThreadTitle('/compact')).toBeUndefined()
  })

  it('ignores empty prompts', () => {
    expect(autoThreadTitle('   \n  ')).toBeUndefined()
  })

  it('exposes the default title used by thread creation', () => {
    expect(DEFAULT_THREAD_TITLE).toBe('New thread')
  })
})
