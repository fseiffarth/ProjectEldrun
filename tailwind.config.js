/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        "bg-main": "var(--bg-main)",
        "bg-panel": "var(--bg-panel)",
        "bg-header": "var(--bg-header)",
        "border-col": "var(--border-color)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "accent": "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "success": "var(--success)",
        "warning": "var(--warning)",
        "danger": "var(--danger)",
      },
    },
  },
  plugins: [],
};
