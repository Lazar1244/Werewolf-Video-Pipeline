import { z } from 'zod';

/** `config/names.json` — neutral display-name pool (ruleset §2). */
export const NamesFileSchema = z
  .strictObject({
    names: z.array(z.string().regex(/^[A-Z][A-Za-z]{1,15}$/, 'names must be one capitalised word')).min(10),
  })
  .refine((f) => new Set(f.names.map((n) => n.toLowerCase())).size === f.names.length, {
    message: 'names must be unique (case-insensitive)',
    path: ['names'],
  });

export type NamesFile = z.infer<typeof NamesFileSchema>;
