/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic tokens are defined as CSS variables in src/index.css so that
        // light / dark / system themes share one component vocabulary.
        bg: 'rgb(var(--c-bg) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        raised: 'rgb(var(--c-raised) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        mute: 'rgb(var(--c-mute) / <alpha-value>)',
        brand: 'rgb(var(--c-brand) / <alpha-value>)',
        'brand-ink': 'rgb(var(--c-brand-ink) / <alpha-value>)',
        again: 'rgb(var(--c-again) / <alpha-value>)',
        hard: 'rgb(var(--c-hard) / <alpha-value>)',
        good: 'rgb(var(--c-good) / <alpha-value>)',
        easy: 'rgb(var(--c-easy) / <alpha-value>)',
        newc: 'rgb(var(--c-new) / <alpha-value>)',
        learnc: 'rgb(var(--c-learn) / <alpha-value>)',
        reviewc: 'rgb(var(--c-review) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        display: ['"Fraunces"', 'ui-serif', 'Georgia', 'serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 2px rgb(var(--c-shadow) / 0.06), 0 4px 14px rgb(var(--c-shadow) / 0.07)',
        pop: '0 10px 40px rgb(var(--c-shadow) / 0.22)',
      },
      borderRadius: { xl2: '1.125rem' },
    },
  },
  plugins: [],
};
