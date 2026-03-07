import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';
import { optimize } from 'svgo';
import { visit } from 'unist-util-visit';

export default function optimizeMermaidSvg() {
  return (tree) => {
    visit(tree, 'element', (node, index, parent) => {
      if (!parent || index === undefined || node.tagName !== 'svg') {
        return;
      }

      const classNames = Array.isArray(node.properties?.className)
        ? node.properties.className.map(String)
        : [];

      if (!classNames.some((className) => className.includes('mermaid'))) {
        return;
      }

      const optimized = optimize(toHtml(node), {
        multipass: true,
        plugins: [
          'preset-default',
          {
            name: 'removeDimensions',
            active: false,
          },
        ],
      });

      const fragment = fromHtml(optimized.data, { fragment: true });
      const replacement = fragment.children.find(
        (child) => child.type === 'element' && child.tagName === 'svg',
      );

      if (replacement) {
        parent.children[index] = replacement;
      }
    });
  };
}
