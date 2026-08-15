/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{vue,js}"],
  theme: {
    extend: {
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui"] },
      colors: {
        ink: "#050914",
        panel: "#0b1220",
        line: "#1d2a3e",
        cyan: "#27d8e8",
      },
    },
  },
  plugins: [],
};
