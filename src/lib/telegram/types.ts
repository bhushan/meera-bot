import { z } from 'zod';

/**
 * Deliberately partial models of the Bot API. Everything is `looseObject` so a new
 * Bot API field never turns a legitimate update into a 400.
 */

export const telegramUserSchema = z.looseObject({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
});

export const telegramChatSchema = z.looseObject({
  id: z.number().int(),
  type: z.string().optional(),
  title: z.string().optional(),
});

export const telegramMessageSchema = z.looseObject({
  message_id: z.number().int(),
  date: z.number().int().optional(),
  chat: telegramChatSchema,
  from: telegramUserSchema.optional(),
  sender_chat: telegramChatSchema.optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
});

export const telegramCallbackQuerySchema = z.looseObject({
  id: z.string(),
  from: telegramUserSchema,
  data: z.string().optional(),
  message: telegramMessageSchema.optional(),
});

export const telegramUpdateSchema = z.looseObject({
  update_id: z.number().int(),
  message: telegramMessageSchema.optional(),
  channel_post: telegramMessageSchema.optional(),
  callback_query: telegramCallbackQuerySchema.optional(),
});

export type TelegramUser = z.infer<typeof telegramUserSchema>;
export type TelegramChat = z.infer<typeof telegramChatSchema>;
export type TelegramMessage = z.infer<typeof telegramMessageSchema>;
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

/** Message keys that mean "this is media, not a text note". */
export const MEDIA_KEYS = [
  'photo',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'animation',
  'video_note',
  'poll',
  'location',
  'venue',
  'contact',
  'dice',
  'game',
  'invoice',
  'story',
  'paid_media',
] as const;
