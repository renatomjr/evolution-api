import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { generateWAMessageFromContent } from 'baileys';
import { validate } from 'jsonschema';
import ts from 'typescript';

import type { Options } from '../src/api/dto/sendMessage.dto';
import { audioMessageSchema } from '../src/validate/message.schema';

// Isolate the real method: importing the service also starts the server module and its integrations.
const source = ts.createSourceFile(
  'whatsapp.baileys.service.ts',
  readFileSync(path.join(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const service = source.statements.find(
  (statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'BaileysStartupService',
) as ts.ClassDeclaration;
const method = service.members.find(
  (member) => ts.isMethodDeclaration(member) && member.name.getText(source) === 'audioWhatsapp',
)!;
const compiled = ts.transpileModule(`class AudioService { ${method.getText(source)} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2020 },
}).outputText;
const AudioService = runInNewContext(`${compiled}; AudioService`, {
  Buffer,
  isURL: (value: string) => value.startsWith('https://'),
  isBase64: () => true,
  BadRequestException: Error,
  InternalServerErrorException: Error,
});

const NUMBER = '5511999999999';
const MESSAGE_ID = '3EB0123456789012345678';
const AUDIO = Buffer.from('audio');
const CONVERTED_AUDIO = Buffer.from('opus');

for (const { encoding, messageId } of [
  { encoding: undefined, messageId: MESSAGE_ID },
  { encoding: true, messageId: MESSAGE_ID },
  { encoding: false, messageId: MESSAGE_ID },
  { encoding: true, messageId: undefined },
]) {
  test(`sends voice with encoding=${encoding} and ${messageId ? 'a supplied ID' : 'a Baileys-generated ID'}`, async () => {
    const instance = new AudioService();
    const calls: Array<{ number: string; message: { audio: Buffer; ptt: boolean }; options: Options }> = [];
    instance.processAudio = async () => CONVERTED_AUDIO;
    instance.sendMessageWithTyping = async (number: string, message: { audio: Buffer; ptt: boolean }, options: Options) => {
      calls.push({ number, message, options });
      return generateWAMessageFromContent(
        `${number}@s.whatsapp.net`,
        { audioMessage: { ptt: message.ptt } },
        { userJid: `${NUMBER}@s.whatsapp.net`, messageId: options.messageId },
      );
    };
    const quoted = { key: { id: 'reply-source' } };
    const result = await instance.audioWhatsapp({
      number: NUMBER,
      audio: AUDIO.toString('base64'),
      ...(messageId === undefined ? {} : { messageId }),
      encoding,
      delay: 100,
      quoted,
    });

    if (messageId === undefined) {
      assert.match(result.key.id, /^3EB0[0-9A-F]+$/);
    } else {
      assert.equal(result.key.id, messageId);
    }
    assert.equal(calls.length, 1);
    const [{ number, message, options }] = calls;
    assert.equal(number, NUMBER);
    assert.equal(message.ptt, true);
    assert.deepEqual(message.audio, encoding === false ? AUDIO : CONVERTED_AUDIO);
    assert.equal(options.messageId, messageId);
    assert.equal(options.presence, 'recording');
    assert.equal(options.delay, 100);
    assert.equal(options.quoted, quoted);
  });
}

test('accepts an optional string messageId in the audio request', () => {
  const payload = { number: NUMBER, audio: AUDIO.toString('base64') };
  const withMessageId = { ...payload, messageId: MESSAGE_ID };

  assert.equal(validate(withMessageId, audioMessageSchema).valid, true);
  assert.equal(withMessageId.messageId, MESSAGE_ID);
  assert.equal(validate(payload, audioMessageSchema).valid, true);
  assert.equal(validate({ ...payload, messageId: 123 }, audioMessageSchema).valid, false);
});
