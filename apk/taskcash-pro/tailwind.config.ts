import type { Config } from "tailwindcss";

/**
 * The brief names exact hex values, so they live here as named tokens rather
 * than being sprinkled through class names. Anything visual that recurs —
 * surfaces, borders, accents — goes through this file.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* Surfaces, darkest to lightest. */
        base: "#080D1A",
        surface: "#0B1020",
        card: "#151F32",
        cardAlt: "#1B263A",
        raised: "#202D43",
        hairline: "#1E2A44",

        /* Accents. */
        brand: {
          DEFAULT: "#2563EB",
          400: "#3B82F6",
          600: "#1D4ED8",
        },
        flame: {
          DEFAULT: "#F4510B",
          400: "#FF5A00",
          600: "#D8430A",
        },
        cash: {
          DEFAULT: "#22C55E",
          dark: "#15803D",
        },
        muted: "#8D99AE",
      },
      borderRadius: {
        card: "16px",
        tile: "14px",
      },
      boxShadow: {
        /* Deliberately subtle — dark UI reads depth from borders, not glow. */
        card: "0 1px 2px rgba(0,0,0,.45)",
        lift: "0 12px 32px -12px rgba(0,0,0,.75)",
        flame: "0 10px 26px -12px rgba(244,81,11,.75)",
        brand: "0 10px 26px -12px rgba(37,99,235,.75)",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(12px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        "fade-up": "fade-up .22s ease-out both",
        "fade-in": "fade-in .2s ease-out both",
        "scale-in": "scale-in .16s ease-out both",
        "slide-in-right": "slide-in-right .22s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
