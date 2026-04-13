import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ClaudeMythos-derived palette. Dark base, eldritch accents.
        void: {
          0: "#030208",
          1: "#070414",
          2: "#0c0820",
          3: "#140d2e",
        },
        eldritch: {
          purple: "#8a4fff",
          violet: "#6a2dc4",
          deep: "#3b1270",
        },
        matrix: {
          green: "#33ff66",
          dim: "#0a6b2e",
        },
        abyss: {
          cyan: "#66e0ff",
          deep: "#0a3a56",
        },
        blood: {
          red: "#ff3366",
          dim: "#7a0f2a",
        },
        amber: {
          signal: "#ffb347",
        },
        bone: "#d8d0e6",
        ink: "#0a0612",
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "IBM Plex Mono",
          "Fira Code",
          "ui-monospace",
          "SFMono-Regular",
          "monospace",
        ],
      },
      keyframes: {
        flicker: {
          "0%,19%,21%,23%,25%,54%,56%,100%": { opacity: "0.99" },
          "20%,24%,55%": { opacity: "0.4" },
        },
        scanline: {
          "0%": { transform: "translateY(-100%)" },
          "100%": { transform: "translateY(100%)" },
        },
        pulseGlow: {
          "0%,100%": { textShadow: "0 0 4px currentColor" },
          "50%": { textShadow: "0 0 12px currentColor, 0 0 24px currentColor" },
        },
        bootType: {
          from: { width: "0" },
          to: { width: "100%" },
        },
      },
      animation: {
        flicker: "flicker 6s infinite",
        scanline: "scanline 8s linear infinite",
        pulseGlow: "pulseGlow 3s ease-in-out infinite",
        bootType: "bootType 1.8s steps(40) 1 forwards",
      },
    },
  },
  plugins: [],
};

export default config;
