import { describe, expect, it } from 'vitest'

import { decodeJsonlChunks, serializeJsonLine, StrictJsonlDecoder } from '../src/main/pi-rpc'

describe('Pi RPC strict JSONL framing', () => {
  it('reassembles records split across arbitrary chunks', () => {
    const decoder = new StrictJsonlDecoder()

    expect(decoder.push(Buffer.from('{"type":"res'))).toEqual([])
    expect(decoder.push(Buffer.from('ponse","id":"1"}\n{"type":"agent_'))).toEqual([
      '{"type":"response","id":"1"}'
    ])
    expect(decoder.push(Buffer.from('start"}\n'))).toEqual(['{"type":"agent_start"}'])
    expect(decoder.end()).toEqual([])
  })

  it('accepts CRLF and strips only a trailing carriage return', () => {
    expect(decodeJsonlChunks(['one\r\ntwo\nthree\r'])).toEqual(['one', 'two', 'three'])
    expect(decodeJsonlChunks(['embedded\rvalue\n'])).toEqual(['embedded\rvalue'])
  })

  it('preserves a UTF-8 code point split between byte chunks', () => {
    const bytes = Buffer.from('{"message":"Pi 🥧"}\n', 'utf8')
    const emojiOffset = bytes.indexOf(Buffer.from('🥧'))
    const chunks = [bytes.subarray(0, emojiOffset + 1), bytes.subarray(emojiOffset + 1)]

    const [line] = decodeJsonlChunks(chunks)
    expect(JSON.parse(line)).toEqual({ message: 'Pi 🥧' })
  })

  it('does not treat Unicode line and paragraph separators as record boundaries', () => {
    const value = { message: `before\u2028middle\u2029after` }
    const framed = serializeJsonLine(value)

    const lines = decodeJsonlChunks([framed])
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual(value)
  })

  it('rejects an unterminated record that exceeds its safety limit', () => {
    const decoder = new StrictJsonlDecoder(8)
    expect(() => decoder.push('123456789')).toThrow(/safety limit/)
  })
})
