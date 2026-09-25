/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        'fire-dark': '#0a0e1a',
        'fire-bg': '#0d1320',
        'fire-card': '#111827',
        'fire-border': '#1e2a3f',
        'fire-blue': '#3b82f6',
        'fire-cyan': '#06b6d4',
        'fire-orange': '#f59e0b',
        'fire-red': '#ef4444',
        'fire-green': '#10b981',
        'fire-text': '#e2e8f0',
        'fire-text-dim': '#94a3b8',
      },
      animation: {
        'breathe': 'breathe 2s ease-in-out infinite',
        'blink': 'blink 1s step-start infinite',
        'fade-in': 'fadeIn 0.3s ease-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-ring': 'pulseRing 1.5s ease-out infinite',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '1', boxShadow: '0 0 8px currentColor' },
          '50%': { opacity: '0.5', boxShadow: '0 0 16px currentColor' },
        },
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        pulseRing: {
          '0%': { transform: 'scale(0.8)', opacity: '1' },
          '100%': { transform: 'scale(2)', opacity: '0' },
        },
      },
    },
  },
  plugins: [],
}
