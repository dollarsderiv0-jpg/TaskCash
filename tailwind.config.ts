import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1rem",
      screens: { "2xl": "1280px" },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        /* Brand tokens */
        navy: {
          50: "#f2f6fb",
          100: "#e3ebf6",
          200: "#c2d3ea",
          300: "#92b0d8",
          400: "#5b86c1",
          500: "#3a67a8",
          600: "#2b508c",
          700: "#244172",
          800: "#1b2f52",
          900: "#0e1a33",
          950: "#070f20",
        },
        /*
         * Brand accent — ORANGE.
         *
         * Used for brand chrome: primary calls to action, active navigation,
         * marketing highlights, brand gradients. It is deliberately a separate
         * scale from `emeraldBrand`, which is now reserved for the one meaning
         * it must never lose in a money app: success and money-in.
         */
        orangeBrand: {
          50: "#fff5ec",
          100: "#ffe7d1",
          200: "#fdcba3",
          300: "#fba76a",
          400: "#f8833b",
          500: "#f26510",
          600: "#d84f06",
          700: "#b33d09",
          800: "#8f330e",
          900: "#742c0f",
        },
        /*
         * Semantic green — NOT brand.
         *
         * Credited amounts, "completed"/"approved" badges, success alerts and
         * toasts. Do not repaint these with the accent: a credit shown in the
         * same colour as a call to action is a genuinely dangerous ambiguity in
         * a wallet UI.
         */
        emeraldBrand: {
          50: "#eafaf1",
          100: "#cff4e0",
          200: "#a0e8c3",
          300: "#6bd6a2",
          400: "#35bd7f",
          500: "#17a065",
          600: "#0e8153",
          700: "#0c6744",
          800: "#0b5138",
          900: "#09432f",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default config;
