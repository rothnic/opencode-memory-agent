import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightCatppuccin from '@catppuccin/starlight';
import rehypeMermaid from 'rehype-mermaid';
import optimizeMermaidSvg from './src/plugins/rehype-optimize-mermaid-svg.mjs';

export default defineConfig({
  site: 'https://rothnic.github.io',
  base: '/opencode-memory-agent',
  integrations: [
    starlight({
      plugins: [
        starlightCatppuccin({
          dark: { flavor: 'macchiato', accent: 'sky' },
          light: { flavor: 'latte', accent: 'blue' }
        })
      ],
      title: 'Memory Agent',
      description:
        'Installable OpenCode plugin and docs for persistent session memory, backlog processing, and project-doc indexing.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/rothnic/opencode-memory-agent',
        },
      ],
      sidebar: [
        {
          label: 'Guides',
          items: [
            { label: 'OpenCode Memory Agent Outline', slug: 'guides/opencode-memory-agent-outline' },
            { label: 'Install, Develop, Publish', slug: 'guides/install-develop-publish' },
          ],
        },
        {
          label: 'Reference',
          autogenerate: { directory: 'reference' },
        },
        {
          label: 'Examples',
          autogenerate: { directory: 'examples' },
        },
      ],
    }),
  ],
  markdown: {
    syntaxHighlight: {
      excludeLangs: ['mermaid'],
    },
    rehypePlugins: [rehypeMermaid, optimizeMermaidSvg],
  },
});
