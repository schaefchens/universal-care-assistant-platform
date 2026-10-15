/**
 * The language model's reply: its shape, and the sentences that can be spoken before it is complete.
 */
import { describe, expect, it } from 'vitest';
import { finishedSay, nothingHappens, parseReply, replySchema } from '../src/ai/llm/reply.ts';

describe('the reply', () => {
  it('a schema every provider takes: objects closed and fully required, tools told apart by name', () => {
    const s = replySchema([{ name: 'notes.search', args: { query: { type: 'string' } } }]) as { properties: { calls: { items: { anyOf: { required: string[]; additionalProperties: boolean }[] } } } };
    expect(s.properties.calls.items.anyOf[0]).toMatchObject({ required: ['tool', 'query'], additionalProperties: false });
    expect(JSON.stringify(s)).not.toMatch(/minLength|maxLength|minimum|maximum/);
  });

  it('parses what is valid and refuses what is not', () => {
    expect(parseReply('{"say":[{"kind":"reply","text":"Hallo","ref":null}],"calls":[{"tool":"notes.search","query":"Arzt"}],"help":false}')).toEqual({
      say: [{ kind: 'reply', text: 'Hallo', ref: null }],
      calls: [{ tool: 'notes.search', query: 'Arzt' }],
      help: false,
    });
    expect(parseReply('{"say":[{"kind":"shout","text":"x"}],"calls":[],"help":false}')).toBeNull();
    expect(parseReply('not json')).toBeNull();
  });

  it('words stream only once the reply has said that nothing happens (no tool, no help)', () => {
    expect(nothingHappens('{"calls": [], "help": false, "say": [{"kind": "reply"')).toBe(true);
    expect(nothingHappens('{"calls": [{"tool": "notes.create"')).toBe(false);
    expect(nothingHappens('{"calls": [], "help": true, "say": [')).toBe(false);
    expect(nothingHappens('{"calls": [], "help": false')).toBe(false);
  });

  it('the first sentences can be spoken while the rest is still written', () => {
    const full = '{\n  "say": [\n    { "kind": "reply", "text": "Es ist \\"halb drei\\"." , "ref": null },\n    { "kind": "summary", "text": "Zwei Notizen", "ref": null }\n  ],\n  "calls": [], "help": false }';
    const cut = full.indexOf('Zwei');
    expect(finishedSay(full.slice(0, cut))).toEqual([{ kind: 'reply', text: 'Es ist "halb drei".', ref: null }]);
    expect(finishedSay(full)).toHaveLength(2);
    expect(finishedSay('{"say": [ {"kind": "reply", "text": "halb')).toEqual([]);
    expect(finishedSay('{"calls": []')).toEqual([]);
  });
});
