import React from 'react';
import type { Preview } from '@storybook/react';

import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-ext-600.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-ext-400.css';
import '../src/tokens.css';

// Donel Dev is dark-first and single-theme at launch (design-system.md §1.4) —
// every story renders inside the real app surface (bg-app) with the real
// body font instead of Storybook's default white canvas.
const preview: Preview = {
  parameters: {
    backgrounds: {
      default: 'donel-dark',
      values: [{ name: 'donel-dark', value: '#0E1116' }],
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          fontFamily: 'var(--font-ui)',
          color: 'var(--text-primary)',
          background: 'var(--bg-app)',
          minHeight: '100vh',
          padding: 'var(--space-4)',
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default preview;
