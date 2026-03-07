import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import rehypeMermaid from 'rehype-mermaid';
import optimizeMermaidSvg from './src/plugins/rehype-optimize-mermaid-svg.mjs';

export default defineConfig({
  site: 'https://rothnic.github.io',
  base: '/opencode-memory-agent',
  integrations: [
    starlight({
      title: 'OpenCode Memory Agent',
      description:
        'Initial OpenCode-first research, plugin template, and docs for a persistent memory agent workflow.',
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
