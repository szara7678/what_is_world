import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/wiw/",
  plugins: [react()],
  server: { port: 5173 }
});
