import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const practices = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/practices' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    order: z.number(),
    draft: z.boolean().default(true),
  }),
});

export const collections = { practices };
